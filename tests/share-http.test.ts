import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";
import { Shares } from "../server/shares.js";

test("HTTP share navigation preserves encrypted access across restart and publishes verified native bytes and NFO", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-share-http-"));
  const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(8192, 7)]);
  const sha1 = createHash("sha1").update(video).digest("hex");
  const originalCode = "Q7Z9", suppliedCode = "Z9Q8";
  const account = "UID=mori-private-fixture-" + randomUUID();
  const ticket = randomUUID();
  let fileRequests = 0;
  const upstream = createServer((req, res) => {
    if (req.url === "/api/search") {
      req.resume();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ merged_by_type: { "115": [{ url: "https://115.com/s/mori115fixture?password=" + originalCode, password: originalCode, note: "MoriFixture.2026.1080p", source: "isolated source" }] } }));
    } else if (req.url === "/video.mp4?ticket=" + ticket) {
      fileRequests++;
      assert.equal(req.headers["user-agent"], "Mozilla/5.0");
      assert.equal(req.headers.cookie, undefined);
      assert.equal(req.headers.authorization, undefined);
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": video.length, ETag: '"fixture-content"' });
      res.end(video);
    } else res.writeHead(404).end();
  });
  const listen = async (server: Server) => {
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  const closeServer = async (server: Server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const origin = await listen(upstream);
  const calls: string[] = [];
  const runner = async (value: unknown) => {
    const input = value as Record<string, any>;
    calls.push(input.op);
    assert.equal(input.shareCode, "mori115fixture");
    assert.equal(input.receiveCode, suppliedCode);
    assert.equal(input.cookie, account);
    if (input.op === "list") return { ok: true, data: {
      entries: input.parentId === "0"
        ? [{ id: "12", name: "Files", directory: true, size: 0 }]
        : [{ id: "9007199254740993", name: "MoriFixture.2026.1080p.mp4", directory: false, size: video.length, sha1 }],
      total: 1,
    } };
    assert.equal(input.op, "link");
    assert.equal(input.fileId, "9007199254740993");
    return { ok: true, data: { url: origin + "/video.mp4?ticket=" + ticket, name: "MoriFixture.2026.1080p.mp4", size: video.length, sha1, headers: { "User-Agent": "Mozilla/5.0" } } };
  };
  let shares!: Shares;
  const browse = Shares.prototype.browse;
  const resolve = Shares.prototype.resolve;
  const browseMock = mock.method(Shares.prototype, "browse", function (...args: Parameters<Shares["browse"]>) { return browse.apply(shares, args); });
  const resolveMock = mock.method(Shares.prototype, "resolve", function (...args: Parameters<Shares["resolve"]>) { return resolve.apply(shares, args); });
  const options = { dataDirectory: path.join(root, "state"), downloadDirectory: path.join(root, "files"), startBackground: false, testMode: true };
  let instance = createApp(options);
  shares = new Shares(instance.store, runner);
  let server = createServer(instance.app);
  let base = await listen(server);
  let cookie = "";
  let closed = false;
  const api = async (route: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + route, { method, headers: { cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json() as any;
    assert.ok(response.ok, data.error || "HTTP fixture operation failed");
    return { response, data };
  };
  try {
    const setup = await api("/api/setup", "POST", { password: randomUUID() });
    cookie = setup.response.headers.get("set-cookie")!.split(";")[0];
    await api("/api/config", "PUT", { sources: { pansouUrl: origin }, library: { artwork: false } });
    let request = (await api("/api/requests", "POST", { query: "MoriFixture 2026", intent: "download" })).data.request;
    assert.equal(request.stage, "details");
    request = (await api(`/api/requests/${request.id}/select`, "POST", { expectedRevision: request.revision, media: { type: "movie", title: "MoriFixture", year: 2026 } })).data.request;
    assert.equal(request.stage, "resource");
    assert.equal(calls.length, 0, "disabled resolver must not invoke the provider");
    assert.equal(instance.queue.tasks().length, 0);
    assert.ok(request.resources[0].shareRef);
    assert.ok(!JSON.stringify(request).includes(originalCode));
    assert.ok(!request.resources[0].url.includes("password"));
    await api("/api/config", "PUT", { sources: { p115Enabled: true, p115Cookie: account } });
    request = (await api(`/api/requests/${request.id}/select`, "POST", { expectedRevision: request.revision, resourceId: request.resources[0].id, extractionCode: suppliedCode })).data.request;
    const folder = request.resources.find((resource: any) => resource.navigation === "folder");
    assert.ok(folder);
    assert.equal(instance.queue.tasks().length, 0);
    request = (await api(`/api/requests/${request.id}/select`, "POST", { expectedRevision: request.revision, resourceId: folder.id })).data.request;
    const file = request.resources.find((resource: any) => resource.kind === "cloud");
    assert.ok(file);
    assert.equal(instance.queue.tasks().length, 0, "opening a folder cannot create a download");
    assert.equal(file.match, "matched");
    await closeServer(server);
    await instance.close();
    instance = createApp(options);
    shares = new Shares(instance.store, runner);
    server = createServer(instance.app);
    base = await listen(server);
    const restored = (await api(`/api/requests/${request.id}`)).data.request;
    assert.equal(restored.resources.find((resource: any) => resource.kind === "cloud").id, file.id);
    const completed = (await api(`/api/requests/${request.id}/select`, "POST", { expectedRevision: restored.revision, resourceId: file.id })).data.request;
    assert.equal(completed.stage, "completed");
    for (let i = 0; i < 150 && instance.queue.isBusy(); i++) await new Promise((done) => setTimeout(done, 20));
    const task = instance.queue.tasks()[0];
    assert.equal(task.status, "completed", task.error);
    assert.equal(task.kind, "cloud");
    assert.match(task.url, /^mori-share:[a-f0-9]{64}$/);
    assert.deepEqual(await readFile(task.path!), video);
    assert.match(await readFile(task.path!.replace(/\.mp4$/u, ".nfo"), "utf8"), /MoriFixture/);
    assert.equal(fileRequests, 1);
    assert.deepEqual(calls, ["list", "list", "link"]);
    const view = JSON.stringify({ request: completed, tasks: (await api("/api/tasks")).data, notices: (await api("/api/notifications")).data, config: (await api("/api/config")).data });
    for (const value of [originalCode, suppliedCode, account, ticket]) assert.ok(!view.includes(value));
    await closeServer(server);
    await instance.close();
    closed = true;
    const database = await readFile(path.join(root, "state/mori.sqlite"));
    for (const value of [originalCode, suppliedCode, account, ticket]) assert.ok(!database.includes(Buffer.from(value)));
  } finally {
    if (!closed) { await closeServer(server); await instance.close(); }
    browseMock.mock.restore();
    resolveMock.mock.restore();
    await closeServer(upstream);
    await rm(root, { recursive: true, force: true });
  }
});
