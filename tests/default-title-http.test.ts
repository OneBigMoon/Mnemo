import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";

test("saved title defaults drive Web and signed bridge identity flows through actual files and subscriptions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-title-http-"));
  const payload = Buffer.from("isolated default-title file fixture");
  const instance = createApp({
    dataDirectory: path.join(root, "state"),
    downloadDirectory: path.join(root, "files"),
    startBackground: false,
    testMode: true,
    media: {
      identify: async (query) => query.includes("三体")
        ? [{ type: "tv", title: "三体", year: 2023, tmdbId: 100 }]
        : [{ type: "movie", title: "沙丘", year: 2021, tmdbId: 438631 }],
      search: async (query) => [{
        id: query.includes("三体") ? "episode-one" : "movie",
        title: query.includes("三体") ? "三体.2023.S01E01.1080p" : "沙丘.2021.1080p",
        url: query.includes("三体") ? "https://fixture.invalid/episode.mp4" : "https://fixture.invalid/movie.mp4",
        kind: "direct", source: "local fixture",
      }],
      testConnection: async () => ({ ok: true, message: "fixture" }),
      download: async (task) => {
        const file = path.join(root, task.id + ".mp4");
        await writeFile(file, payload);
        return file;
      },
      scrape: async () => ({ files: [], warnings: [] }),
    },
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let cookie = "";
  const api = (route: string, method = "GET", body?: unknown, headers = {}) => fetch(base + route, {
    method, headers: { cookie, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const chat = async (message: string, extra = {}) => {
    const reply = await api("/api/chat", "POST", { message, ...extra });
    assert.equal(reply.status, 200);
    return await reply.json() as any;
  };
  const configure = async (body: unknown) => {
    const reply = await api("/api/config", "PUT", body);
    assert.equal(reply.status, 200);
    return await reply.json() as any;
  };
  const settle = async () => {
    for (let i = 0; i < 100 && instance.queue.isBusy(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(instance.queue.isBusy(), false);
  };
  try {
    assert.equal((await api("/api/config", "PUT", { defaultTitleAction: "download" })).status, 401);
    const setup = await api("/api/setup", "POST", { password: randomUUID() });
    assert.equal(setup.status, 200);
    cookie = setup.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await (await api("/api/config")).json() as any).defaultTitleAction, "search");
    const searched = await chat("沙丘 2021", { defaultTitleAction: "download", intent: "download" });
    assert.equal(searched.request.intent, "search");
    assert.equal(instance.queue.tasks().length, 0);
    assert.equal((await configure({ defaultTitleAction: "download" })).defaultTitleAction, "download");
    assert.equal((await chat("搜索 沙丘 2021")).request.intent, "search");
    assert.equal(instance.queue.tasks().length, 0);
    const downloaded = await chat("沙丘 2021");
    assert.equal(downloaded.request.intent, "download");
    assert.equal(downloaded.request.stage, "completed");
    await settle();
    assert.equal(instance.queue.tasks().length, 1);
    assert.equal(instance.queue.tasks()[0].status, "completed");
    assert.deepEqual(await readFile(instance.queue.tasks()[0].path!), payload);
    assert.equal(instance.queue.notifications.list().filter((n) => n.event === "completed").length, 1);
    const bridgeKey = randomUUID() + randomUUID();
    await configure({ defaultTitleAction: "subscribe", channels: { bridge: { enabled: true, secret: bridgeKey } } });
    const subscribed = await chat("三体 S01");
    assert.equal(subscribed.request.intent, "subscribe");
    assert.equal(subscribed.request.stage, "completed");
    assert.equal(instance.queue.subscriptions().length, 1);
    assert.equal(instance.queue.subscriptions()[0].autoDownload, true);
    const body = { peer: "qq-fixture:FriendMessage:42", eventId: randomUUID(), text: "三体 S01" };
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", bridgeKey).update(JSON.stringify(["qq", timestamp, body.eventId, body.peer, body.text])).digest("hex");
    const channel = await api("/api/channels/bridge/qq", "POST", body, { "X-Mori-Timestamp": timestamp, "X-Mori-Signature": signature });
    assert.equal(channel.status, 200);
    const channelReply = await channel.json() as any;
    assert.equal(channelReply.request.intent, "subscribe");
    assert.equal(channelReply.request.subscriptionId, subscribed.request.subscriptionId);
    assert.equal(instance.queue.subscriptions().length, 1);
    assert.equal((await api(`/api/subscriptions/${subscribed.request.subscriptionId}/check`, "POST", {})).status, 200);
    await settle();
    const episode = instance.queue.tasks().find((task) => task.media.type === "tv")!;
    assert.equal(episode.status, "completed");
    assert.equal(episode.media.season, 1);
    assert.equal(episode.media.episode, 1);
    assert.deepEqual(await readFile(episode.path!), payload);
    assert.deepEqual(new Set(instance.queue.notifications.list().filter((n) => n.taskId === episode.id && n.event === "completed").map((n) => n.destination.platform)), new Set(["web", "qq"]));
    assert.equal((await (await api("/api/config")).json() as any).defaultTitleAction, "subscribe");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await instance.close();
    await rm(root, { recursive: true, force: true });
  }
});
