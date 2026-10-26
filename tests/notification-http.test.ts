import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";
import type { MediaService, NotificationDestination } from "../shared/types.js";

test("notification HTTP actions require admin, hide claims, and preserve unknown delivery confirmation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-notification-http-"));
  const media: MediaService = {
    identify: async () => [],
    search: async () => [],
    testConnection: async () => ({ ok: true, message: "fixture" }),
    download: async (task) => {
      const file = path.join(root, `${task.id}.mp4`);
      await writeFile(file, "isolated notification fixture");
      return file;
    },
    scrape: async () => ({ files: [], warnings: [] }),
  };
  const instance = createApp({
    dataDirectory: path.join(root, "state"),
    downloadDirectory: path.join(root, "files"),
    startBackground: false,
    testMode: true,
    media,
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let cookie = "";
  const api = (route: string, body?: unknown) => fetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    assert.equal((await api("/api/notifications")).status, 401);
    assert.equal((await api("/api/notifications/missing/action", { action: "retry" })).status, 401);
    const setup = await api("/api/setup", { password: randomUUID() });
    assert.equal(setup.status, 200);
    cookie = setup.headers.get("set-cookie")!.split(";")[0];
    const dest: NotificationDestination = { platform: "qq", peer: "fixture:FriendMessage:42" };
    const input = {
      title: "通知验证",
      url: "https://fixture.invalid/media.mp4",
      kind: "direct" as const,
      media: { type: "movie" as const, title: "通知验证", year: 2026 },
    };
    const created = await api("/api/tasks", { ...input, owner: "bridge:qq:forged", destination: dest });
    assert.equal(created.status, 201);
    assert.deepEqual(instance.queue.notifications.list().map((n) => n.destination), [{ platform: "web", peer: "admin" }]);
    const task = instance.queue.add(input, dest);
    for (let i = 0; i < 100 && instance.queue.isBusy(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(instance.queue.tasks()[0].status, "completed");
    const outbox = instance.queue.notifications;
    const [claim] = outbox.claim(dest);
    assert.ok(claim);
    outbox.acknowledge(dest, claim.id, claim.claimToken, "unknown");
    instance.queue.add({ title: "待解析分享", url: "https://fixture.invalid/share", kind: "share" });
    const response = await api("/api/notifications");
    assert.equal(response.status, 200);
    const data = await response.json() as any;
    assert.equal(data.notifications.length, 2);
    assert.ok(data.notifications.every((n: any) => n.taskId === task.id && n.status !== "waiting"));
    assert.ok(data.notifications.every((n: any) => !Object.hasOwn(n, "claimToken")));
    assert.ok(!JSON.stringify(data).includes(claim.claimToken));
    const web = data.notifications.find((n: any) => n.destination.platform === "web");
    assert.equal((await api(`/api/notifications/${claim.id}/action`, { action: "read" })).status, 409);
    assert.equal((await api(`/api/notifications/${claim.id}/action`, { action: "retry" })).status, 409);
    assert.equal((await api(`/api/notifications/${claim.id}/action`, { action: "retry", confirmUnknown: "true" })).status, 409);
    assert.equal(outbox.list().find((n) => n.id === claim.id)?.status, "unknown");
    assert.equal((await api(`/api/notifications/${claim.id}/action`, { action: "retry", confirmUnknown: true })).status, 200);
    assert.throws(() => outbox.acknowledge(dest, claim.id, claim.claimToken, "delivered"), /不匹配/);
    const [replacement] = outbox.claim(dest);
    assert.notEqual(replacement.claimToken, claim.claimToken);
    outbox.acknowledge(dest, replacement.id, replacement.claimToken, "delivered", "fixture-receipt");
    assert.equal((await api(`/api/notifications/${web.id}/action`, { action: "read" })).status, 200);
    assert.equal((await api(`/api/notifications/${web.id}/action`, { action: "read" })).status, 200);
    assert.equal(outbox.list().find((n) => n.id === web.id)?.status, "delivered");
    assert.equal((await api("/api/notifications/missing/action", { action: "dismiss" })).status, 404);
    assert.equal((await api(`/api/notifications/${web.id}/action`, { action: "nonsense" })).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await instance.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("app shutdown waits for cancelled channel delivery to persist unknown before closing SQLite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-notification-close-"));
  const originalFetch = globalThis.fetch;
  let releaseSend!: () => void;
  let signalSending!: () => void;
  const sendStarted = new Promise<void>((resolve) => { signalSending = resolve; });
  globalThis.fetch = (async (input, init) => {
    if (!String(input).startsWith("https://api.telegram.org/")) return originalFetch(input, init);
    const signal = init?.signal;
    assert.ok(signal);
    if (String(input).endsWith("/sendMessage")) {
      signalSending();
      return new Promise<Response>((_resolve, reject) => {
        releaseSend = () => reject(new Error("isolated transport aborted"));
      });
    }
    assert.ok(String(input).endsWith("/getUpdates"));
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  const instance = createApp({
    dataDirectory: path.join(root, "state"),
    downloadDirectory: path.join(root, "files"),
    testMode: true,
    media: {
      identify: async () => [], search: async () => [],
      testConnection: async () => ({ ok: true, message: "fixture" }),
      download: async (task) => {
        const file = path.join(root, `${task.id}.mp4`);
        await writeFile(file, "isolated shutdown fixture");
        return file;
      },
      scrape: async () => ({ files: [], warnings: [] }),
    },
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let closed = false;
  try {
    instance.queue.add({ title: "关机通知验证", url: "https://fixture.invalid/shutdown.mp4", kind: "direct" }, { platform: "telegram", botId: "12345", peer: "42" });
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 100 && instance.queue.isBusy(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(instance.queue.tasks()[0].status, "completed");
    const setup = await originalFetch(base + "/api/setup", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: randomUUID() }),
    });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.get("set-cookie")!.split(";")[0];
    const cfg = instance.store.config();
    cfg.channels.telegram = { ...cfg.channels.telegram, enabled: true, token: "12345:fixture", allowedChatIds: ["42"] };
    const saved = await originalFetch(base + "/api/config", {
      method: "PUT", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(cfg),
    });
    assert.equal(saved.status, 200);
    await Promise.race([sendStarted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fixture sender did not start")), 2000).unref())]);
    let stateBeforeClose = "";
    const closeStore = instance.store.close.bind(instance.store);
    instance.store.close = () => {
      stateBeforeClose = instance.queue.notifications.list().find((n) => n.destination.platform === "telegram")!.status;
      closeStore();
    };
    let settled = false;
    const stopping = instance.close().then(() => { settled = true; closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, "SQLite must stay open until the aborted send records its outcome");
    releaseSend();
    await stopping;
    assert.equal(stateBeforeClose, "unknown");
  } finally {
    releaseSend?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!closed) await instance.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
