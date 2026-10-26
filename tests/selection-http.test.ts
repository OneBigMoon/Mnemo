import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createApp } from "../server/index.js";
import { createMediaService } from "../server/media.js";
import type { AppConfig, MediaInfo, SearchResult } from "../shared/types.js";

test("HTTP title request confirms identity and server-bound resource, downloads actual bytes and survives restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-selection-http-"));
  const payload = Buffer.concat([
    Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex"),
    Buffer.alloc(2048, 4),
  ]);
  const source = createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": payload.length,
    });
    res.end(payload);
  });
  source.listen(0, "127.0.0.1");
  await new Promise<void>((r) => source.once("listening", r));
  const origin = `http://127.0.0.1:${(source.address() as any).port}`;
  let cfg: AppConfig;
  const native = createMediaService(() => cfg);
  const candidates: MediaInfo[] = [
    { type: "movie", title: "Dune", year: 1984, tmdbId: 841 },
    { type: "movie", title: "Dune", year: 2021, tmdbId: 438631 },
  ];
  const resources: SearchResult[] = [
    "Dune.1984.1080p.mkv",
    "Dune.2021.1080p.mkv",
    "Dune.2021.2160p.mkv",
  ].map((title, i) => ({
    id: `upstream-${i}`,
    title,
    url: `${origin}/${i}.mp4`,
    kind: "direct",
    source: "fixture",
  }));
  let instance = createApp({
    dataDirectory: path.join(root, "state"),
    downloadDirectory: path.join(root, "files"),
    startBackground: false,
    media: {
      ...native,
      identify: async () => candidates,
      search: async () => resources,
      searchWithDiagnostics: undefined,
    },
  });
  cfg = instance.store.config();
  cfg.library.artwork = false;
  cfg.channels.bridge = {
    enabled: true,
    secret: "fixture-bridge-signature-material-12345",
    model: "",
  };
  instance.store.setConfig(cfg);
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  let cookie = "";
  let closed = false;
  const api = (
    url: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + url, {
      method,
      headers: {
        cookie,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const setup = await api("/api/setup", "POST", {
      password: "selection-fixture-password",
    });
    assert.equal(setup.status, 200);
    cookie = setup.headers.get("set-cookie")!.split(";")[0];
    const chat = (await (
      await api("/api/chat", "POST", { message: "下载 Dune" })
    ).json()) as any;
    assert.equal(chat.request.stage, "media");
    assert.equal(instance.queue.tasks().length, 0);
    const chosen = chat.request.candidates.find(
      (x: any) => x.media.year === 2021,
    );
    const selected = (await (
      await api(`/api/requests/${chat.request.id}/select`, "POST", {
        candidateId: chosen.id,
        expectedRevision: chat.request.revision,
      })
    ).json()) as any;
    assert.equal(selected.request.stage, "resource");
    const wrong = selected.request.resources.find(
      (x: any) => x.match === "mismatch",
    );
    assert.ok(wrong);
    assert.equal(
      (
        await api(`/api/requests/${chat.request.id}/select`, "POST", {
          resourceId: wrong.id,
          confirmUncertain: true,
          expectedRevision: selected.request.revision,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await api(`/api/requests/${chat.request.id}/select`, "POST", {
          resourceId: "upstream-1",
          url: origin + "/0.mp4",
          expectedRevision: selected.request.revision,
        })
      ).status,
      400,
    );
    const correct = selected.request.resources.find((x: any) =>
      x.title.includes("2021.1080"),
    );
    assert.equal(
      (
        await api(`/api/requests/${chat.request.id}/select`, "POST", {
          resourceId: correct.id,
          expectedRevision: chat.request.revision,
        })
      ).status,
      409,
    );
    const result = (await (
      await api(`/api/requests/${chat.request.id}/select`, "POST", {
        resourceId: correct.id,
        expectedRevision: selected.request.revision,
      })
    ).json()) as any;
    assert.equal(result.request.stage, "completed");
    const replay = (await (
      await api(`/api/requests/${chat.request.id}/select`, "POST", {
        resourceId: correct.id,
        expectedRevision: selected.request.revision,
      })
    ).json()) as any;
    assert.equal(replay.request.taskId, result.request.taskId);
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if (!instance.queue.isBusy()) break;
    }
    const task = instance.queue.tasks()[0];
    assert.equal(task.status, "completed", task.error);
    assert.equal(task.media.tmdbId, 438631);
    assert.equal(task.media.year, 2021);
    assert.deepEqual(await readFile(task.path!), payload);
    assert.equal(instance.queue.tasks().length, 1);
    const sub = instance.queue.subscribe("Dune", true, candidates[1]);
    assert.equal(
      (
        await api(`/api/subscriptions/${sub.id}`, "PATCH", {
          autoDownload: false,
        })
      ).status,
      200,
    );
    await api(`/api/subscriptions/${sub.id}/check`, "POST", {});
    assert.ok(instance.queue.subscriptions()[0].seen.length > 0);
    assert.equal(
      (
        await api(`/api/subscriptions/${sub.id}`, "PATCH", {
          autoDownload: true,
        })
      ).status,
      200,
    );
    assert.deepEqual(instance.queue.subscriptions()[0].seen, []);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = {
      eventId: "bridge-context-fixture",
      peer: "private-peer",
      text: "搜索 Dune",
    };
    const signature = createHmac("sha256", cfg.channels.bridge.secret)
      .update(
        JSON.stringify(["qq", timestamp, body.eventId, body.peer, body.text]),
      )
      .digest("hex");
    const bridge = (await (
      await api("/api/channels/bridge/qq", "POST", body, {
        "X-Mori-Timestamp": timestamp,
        "X-Mori-Signature": signature,
      })
    ).json()) as any;
    assert.ok(bridge.request);
    // M8：管理员（web 会话）可跨域读取渠道请求，用于审批待批准项；
    // 渠道之间的隔离仍由 Requests 的 owner 域校验保证。
    const visible = await api(`/api/requests/${bridge.request.id}`);
    assert.equal(visible.status, 200);
    assert.equal(((await visible.json()) as any).request.id, bridge.request.id);
    assert.equal(instance.queue.tasks().length, 1);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await instance.close();
    closed = true;
    instance = createApp({
      dataDirectory: path.join(root, "state"),
      downloadDirectory: path.join(root, "files"),
      startBackground: false,
    });
    const restored = instance.store.record<any>("request", result.request.id);
    assert.equal(restored.taskId, task.id);
    assert.equal(restored.stage, "completed");
    assert.equal(instance.queue.tasks().length, 1);
    await instance.close();
  } finally {
    if (!closed) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await instance.close();
    }
    source.closeAllConnections();
    await new Promise<void>((r) => source.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
