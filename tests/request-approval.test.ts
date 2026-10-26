import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Requests } from "../server/requests.js";
import { Store } from "../server/store.js";
import type {
  DownloadTask,
  MediaInfo,
  MediaService,
  SearchResult,
  Subscription,
} from "../shared/types.js";

const DIRECT: SearchResult = {
  id: "fixture-direct",
  title: "三体 2023 S01E02 1080p",
  url: "https://example.org/santi-e02.mp4",
  kind: "direct",
  source: "fixture",
};

function fixture(t: TestContext, requireApproval = false) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mori-m8-"));
  const store = new Store(directory, path.join(directory, "files"));
  if (requireApproval) {
    const config = store.config();
    store.setConfig({
      ...config,
      channels: { ...config.channels, requireApproval: true },
    });
  }
  const tasks: { url: string; owner?: string }[] = [];
  const media: MediaService = {
    search: async () => [DIRECT],
    identify: async () => [{ type: "tv", title: "三体", year: 2023, season: 1, episode: 2 }],
    download: async () => {
      throw new Error("fixture download disabled");
    },
    scrape: async () => ({ files: [], warnings: [] }),
    testConnection: async () => ({ ok: true, message: "fixture" }),
  };
  const actions = {
    addTask(input: { title: string; url: string }, owner?: string): DownloadTask {
      tasks.push({ url: input.url, owner });
      const now = new Date().toISOString();
      const task: DownloadTask = {
        id: randomUUID(), title: input.title, url: input.url, kind: "direct",
        media: { type: "tv", title: "三体", year: 2023, season: 1, episode: 2 } satisfies MediaInfo,
        profile: "emby", status: "queued", progress: 0, bytes: 0, total: 0,
        createdAt: now, updatedAt: now,
      };
      store.put("task", task);
      return task;
    },
    subscribe(): Subscription {
      throw new Error("本测试不涉及订阅");
    },
  };
  const requests = new Requests(store, media, actions);
  t.after(async () => {
    await requests.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { requests, tasks, store, owner: "telegram:fixture-user" };
}

/** 推进到资源阶段并选中 DIRECT 资源；若流程自动越过资源阶段则原样返回。 */
async function driveToSelection(f: ReturnType<typeof fixture>, owner: string) {
  let request = await f.requests.begin(owner, "三体", "download");
  for (let guard = 0; guard < 4; guard++) {
    if (request.stage === "media" && request.candidates.length) {
      request = await f.requests.select(owner, request.id, {
        expectedRevision: request.revision,
        candidateId: request.candidates[0].id,
      });
      continue;
    }
    if (request.stage === "details") {
      request = await f.requests.select(owner, request.id, {
        expectedRevision: request.revision,
        season: 1,
        episode: 2,
      });
      continue;
    }
    break;
  }
  if (request.stage !== "resource") return request;
  const resource = request.resources.find((item) => item.url === DIRECT.url);
  assert.ok(resource);
  return f.requests.select(owner, request.id, {
    expectedRevision: request.revision,
    resourceId: resource.id,
  });
}

test("审批开关默认关闭：渠道请求直接建任务", async (t) => {
  const f = fixture(t);
  const request = await driveToSelection(f, f.owner);
  assert.equal(request.stage, "completed");
  assert.equal(f.tasks.length, 1);
  assert.equal(f.tasks[0].owner, f.owner);
});

test("开启审批后渠道请求停在待批准，管理员批准才建任务", async (t) => {
  const f = fixture(t, true);
  const owner = f.owner;
  // 渠道用户选资源 → 待批准（无任务）。
  let request = await driveToSelection(f, owner);
  assert.equal(request.stage, "approval");
  assert.equal(f.tasks.length, 0);
  // 渠道用户不能自行批准（owner 域闸门）。
  await assert.rejects(
    f.requests.select(owner, request.id, { expectedRevision: request.revision, approve: true }),
    (error: Error & { status?: number }) => error.message.includes("等待管理员批准"),
  );
  // 管理员能跨域看到并打开这条渠道请求（列表 + 单条读取）。
  assert.ok(f.requests.listAll().some((item) => item.id === request.id));
  assert.equal(f.requests.getAny(request.id).id, request.id);
  // 管理员拒绝 → completed 且无任务。
  request = await f.requests.adminSelect(request.id, { expectedRevision: request.revision, reject: true });
  assert.equal(request.stage, "completed");
  assert.equal(f.tasks.length, 0);
  assert.match(request.message, /已拒绝/);
  // 重新发起并批准 → 任务创建且归属渠道用户。
  request = await driveToSelection(f, owner);
  assert.equal(request.stage, "approval");
  request = await f.requests.adminSelect(request.id, { expectedRevision: request.revision, approve: true });
  assert.equal(request.stage, "completed");
  assert.ok(request.taskId);
  assert.equal(f.tasks.length, 1);
  assert.equal(f.tasks[0].url, DIRECT.url);
  assert.equal(f.tasks[0].owner, owner, "任务归属渠道用户");
  // 决定写在请求上，并单独留一条历史（谁、何时、批还是拒）。
  assert.equal(request.decision?.outcome, "approved");
  assert.equal(request.decision?.by, "web:admin");
  assert.ok(Date.parse(request.decision?.at ?? "") > 0);
  const history = f.requests.listApprovals();
  assert.equal(history.length, 2, "拒绝与批准各留一条");
  assert.deepEqual(
    history.map((entry) => entry.outcome).sort(),
    ["approved", "rejected"],
  );
  const approvedEntry = history.find((entry) => entry.outcome === "approved")!;
  assert.equal(approvedEntry.requestId, request.id);
  assert.equal(approvedEntry.owner, owner);
  assert.equal(approvedEntry.query, "三体");
  assert.equal(approvedEntry.by, "web:admin");
  assert.equal(f.requests.listApprovals(1).length, 1, "limit 生效");
});

test("web 管理员的请求不受审批闸门影响", async (t) => {
  const f = fixture(t, true);
  const request = await driveToSelection(f, "web:admin");
  assert.equal(request.stage, "completed", "管理员选择直达完成");
  assert.equal(f.tasks.length, 1);
});

test("单渠道覆盖生效：全局关闭时 Telegram 仍需批准，全局开启时 Telegram 可免批准", async (t) => {
  const override = (
    store: ReturnType<typeof fixture>["store"],
    platform: "telegram" | "wechat" | "qq" | "feishu",
    value: "inherit" | "require" | "skip",
  ) => {
    const config = store.config();
    store.setConfig({
      ...config,
      channels: {
        ...config.channels,
        approvalOverrides: { ...config.channels.approvalOverrides!, [platform]: value },
      },
    });
  };

  // 全局关闭 + Telegram require → 渠道请求仍停在待批准。
  const parked = fixture(t);
  override(parked.store, "telegram", "require");
  const waiting = await driveToSelection(parked, parked.owner);
  assert.equal(waiting.stage, "approval");
  assert.equal(parked.tasks.length, 0);

  // 全局开启 + Telegram skip → 该渠道直接建任务。
  const direct = fixture(t, true);
  override(direct.store, "telegram", "skip");
  const done = await driveToSelection(direct, direct.owner);
  assert.equal(done.stage, "completed");
  assert.equal(direct.tasks.length, 1);
});
