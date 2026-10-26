import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";

/**
 * M8 补全：渠道请求被批准或拒绝后，申请人必须收到一条消息。
 * 这里走真实 HTTP：签名桥接发起下载 → 管理员在网页端决定 → 渠道侧 poll 取回答复。
 */
test("channel approval decisions reach the requester through the signed bridge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-approval-notify-"));
  const secret = randomUUID();
  const instance = createApp({
    dataDirectory: path.join(root, "state"),
    downloadDirectory: path.join(root, "files"),
    startBackground: false,
    testMode: true,
    media: {
      identify: async () => [{ type: "movie", title: "沙丘", year: 2021, tmdbId: 438631 }],
      search: async () => [{
        id: "movie-direct",
        title: "沙丘.2021.1080p",
        url: "https://fixture.invalid/movie.mp4",
        kind: "direct",
        source: "local fixture",
      }],
      testConnection: async () => ({ ok: true, message: "fixture" }),
      download: async () => path.join(root, "unused.mp4"),
      scrape: async () => ({ files: [], warnings: [] }),
    },
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let cookie = "";
  const api = (route: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + route, {
      method,
      headers: { cookie, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const sign = (fields: unknown[]) =>
    createHmac("sha256", secret).update(JSON.stringify(fields), "utf8").digest("hex");
  const bridge = async (
    route: string,
    fields: (timestamp: string) => unknown[],
    body: unknown,
  ) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return api(
      route,
      "POST",
      body,
      { "X-Mori-Timestamp": timestamp, "X-Mori-Signature": sign(fields(timestamp)) },
    );
  };
  const say = (peer: string, text: string) => {
    const eventId = randomUUID();
    return bridge(
      "/api/channels/bridge/qq",
      (timestamp) => ["qq", timestamp, eventId, peer, text],
      { eventId, peer, text },
    );
  };
  const poll = (peer: string) => {
    const nonce = randomUUID();
    return bridge(
      "/api/channels/bridge/qq/notifications/poll",
      (timestamp) => ["notifications.poll", "qq", timestamp, peer, nonce],
      { peer, nonce },
    );
  };
  const parked = async (peer: string) => {
    const reply = await say(peer, "下载 沙丘");
    assert.equal(reply.status, 200, await reply.text());
    const listed = await api("/api/requests");
    assert.equal(listed.status, 200);
    const { requests } = (await listed.json()) as {
      requests: { id: string; owner: string; stage: string; revision: number }[];
    };
    const request = requests.find(
      (item) => item.owner === `bridge:qq:${peer}` && item.stage === "approval",
    );
    assert.ok(request, `渠道请求应停在待批准：${JSON.stringify(requests)}`);
    return request;
  };
  const texts = async (peer: string) => {
    const reply = await poll(peer);
    const raw = await reply.text();
    assert.equal(reply.status, 200, raw);
    const { notifications } = JSON.parse(raw) as { notifications: { text: string }[] };
    return notifications.map((item) => item.text);
  };

  try {
    // 历史属于管理员视图：未登录必须拒绝。
    assert.equal((await api("/api/approvals")).status, 401);
    assert.equal((await api("/api/audit")).status, 401);
    const setup = await api("/api/setup", "POST", { password: randomUUID() });
    assert.equal(setup.status, 200, await setup.text());
    cookie = setup.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert.ok(cookie);

    const config = await api("/api/config", "PUT", {
      channels: {
        requireApproval: true,
        bridge: { enabled: true, secret, model: "" },
        telegram: { enabled: false, token: "", allowedChatIds: [], model: "" },
      },
    });
    assert.equal(config.status, 200, await config.text());

    // 批准：申请人应收到「已批准」而不是只有下载完成通知。
    const approved = await parked("family-a");
    const approve = await api(`/api/requests/${approved.id}/select`, "POST", {
      expectedRevision: approved.revision,
      approve: true,
    });
    assert.equal(approve.status, 200, await approve.text());
    const afterApprove = await texts("family-a");
    const approvedText = afterApprove.filter((item) => /管理员已批准/.test(item));
    assert.equal(approvedText.length, 1, JSON.stringify(afterApprove));
    assert.match(approvedText[0], /沙丘/);

    // 拒绝：这条路径以前完全静默，现在必须有答复且说明未创建任务。
    const rejected = await parked("family-b");
    const reject = await api(`/api/requests/${rejected.id}/select`, "POST", {
      expectedRevision: rejected.revision,
      reject: true,
    });
    assert.equal(reject.status, 200, await reject.text());
    const afterReject = await texts("family-b");
    const rejectedText = afterReject.filter((item) => /管理员已拒绝/.test(item));
    assert.equal(rejectedText.length, 1, JSON.stringify(afterReject));
    assert.match(rejectedText[0], /未创建下载任务/);

    // 隔离：没发过请求的 peer 领不到任何消息。
    assert.deepEqual(await texts("family-c"), []);

    // 审批历史：两条决定都留档，含操作人、申请人、片名与时间。
    const historyReply = await api("/api/approvals");
    assert.equal(historyReply.status, 200, await historyReply.clone().text());
    const { approvals } = (await historyReply.json()) as {
      approvals: {
        id: string;
        requestId: string;
        owner: string;
        query: string;
        outcome: string;
        by: string;
        at: string;
      }[];
    };
    assert.equal(approvals.length, 2, JSON.stringify(approvals));
    assert.deepEqual(
      Object.fromEntries(approvals.map((row) => [row.owner, row.outcome])),
      { "bridge:qq:family-a": "approved", "bridge:qq:family-b": "rejected" },
    );
    for (const row of approvals) {
      assert.equal(row.by, "web:admin");
      assert.equal(row.query, "沙丘");
      assert.ok(Date.parse(row.at) > 0);
      assert.equal(row.id, row.requestId);
    }

    // 操作审计：任务创建与审批决定合并成一条时间线。
    const webTask = await api("/api/tasks", "POST", {
      title: "沙丘 2021 网页手动",
      url: "https://fixture.invalid/web-manual.mp4",
    });
    assert.equal(webTask.status, 201, await webTask.clone().text());
    const auditReply = await api("/api/audit");
    assert.equal(auditReply.status, 200, await auditReply.clone().text());
    const { entries } = (await auditReply.json()) as {
      entries: {
        type: "task" | "approval";
        owner: string;
        origin?: string;
        title: string;
        outcome?: string;
        at: string;
      }[];
    };
    const taskEntries = entries.filter((entry) => entry.type === "task");
    const approvalEntries = entries.filter((entry) => entry.type === "approval");
    assert.equal(approvalEntries.length, 2, JSON.stringify(approvalEntries));
    assert.ok(
      taskEntries.some(
        (entry) => entry.origin === "channel" && entry.owner === "bridge:qq:family-a",
      ),
      "渠道批准后建的任务要留痕",
    );
    assert.ok(
      taskEntries.some(
        (entry) => entry.origin === "web" && entry.owner === "web:admin",
      ),
      "网页手动建的任务要留痕",
    );
    for (const entry of entries) assert.ok(Date.parse(entry.at) > 0);

    // 重复批准（同一请求再提交一次）不会重复排消息。
    const replay = await api(`/api/requests/${approved.id}/select`, "POST", {
      expectedRevision: approved.revision + 1,
      approve: true,
    });
    assert.notEqual(replay.status, 200);
    const decisions = instance.queue.notifications
      .list()
      .filter((record) => record.event === "message");
    assert.equal(decisions.length, 2, JSON.stringify(decisions.map((r) => r.text)));
  } finally {
    await instance.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
