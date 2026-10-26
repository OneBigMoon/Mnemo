import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../server/index.js";
import { createMediaService } from "../server/media.js";
import { Shares, type ShareHelperInput } from "../server/shares.js";
import type { DownloadTask, MediaRequest, MediaService, Subscription } from "../shared/types.js";

const TITLE = "MoriDirectoryFixture";
const MEDIA = { type: "tv" as const, title: TITLE, year: 2026 };
const FOLDERS = { collection: "8000000000000001", season: "8000000000000002", child: "8000000000000003" };

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const port = (server.address() as { port: number }).port;
  assert.notEqual(port, 4180);
  return `http://127.0.0.1:${port}`;
}

async function closeServer(server: Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

interface FixtureFile { id: string; name: string; bytes: Buffer; sha1: string }
interface Entry { id: string; name: string; directory: boolean; size: number; sha1?: string }
interface ScanGate { started: Promise<void>; wait: Promise<void>; release(): void; signal?: AbortSignal; enter(): void }

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-directory-http-"));
  const originalCode = "G7T9", suppliedCode = "K6P8";
  const account = "UID=mori-directory-private-" + randomUUID();
  const ticket = "directory-private-ticket-" + randomUUID();
  const bridgeKey = randomUUID();
  const shareCode = "mori115directoryfixture";
  const files = new Map<string, FixtureFile>();
  const episodes = new Map<number, FixtureFile>();
  let serial = 1000;
  const makeFile = (name: string, seed: number): FixtureFile => {
    const id = "900719925474" + String(++serial);
    const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(4096, seed)]);
    const file = { id, name, bytes, sha1: createHash("sha1").update(bytes).digest("hex").toUpperCase() };
    files.set(id, file);
    return file;
  };
  for (let episode = 1; episode <= 17; episode++) episodes.set(episode, makeFile(`${TITLE}.S01E${String(episode).padStart(2, "0")}.1080p.mp4`, episode));
  const rejected = [
    makeFile(`${TITLE}.S02E40.1080p.mp4`, 101),
    makeFile("AnotherSeries.S01E41.1080p.mp4", 102),
    makeFile(`${TITLE}.S01E30.trailer.mp4`, 103),
    makeFile(`${TITLE}.S01E31.featurette.mp4`, 104),
    makeFile(`${TITLE}.S01E32.sample.mp4`, 105),
    makeFile("notes.txt", 106),
  ];
  const duplicate = makeFile(`${TITLE}.S01E01.720p.mp4`, 107);
  const entry = (file: FixtureFile): Entry => ({ id: file.id, name: file.name, directory: false, size: file.bytes.length, sha1: file.sha1 });
  const folder = (id: string, name: string): Entry => ({ id, name, directory: true, size: 0 });
  let extended = false, searchRequests = 0;
  const byteRequests: string[] = [];
  const upstream = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://fixture.invalid");
    if (url.pathname === "/api/search") {
      searchRequests++;
      req.resume();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ merged_by_type: { "115": [{ url: `https://115.com/s/${shareCode}?password=${originalCode}`, password: originalCode, note: `${TITLE}.2026.S01.1080p`, source: "isolated directory source" }] } }));
      return;
    }
    const file = url.pathname.startsWith("/video/") ? files.get(url.pathname.slice(7)) : undefined;
    if (!file || url.searchParams.get("ticket") !== ticket) { res.writeHead(404).end(); return; }
    assert.equal(req.headers["user-agent"], "Mozilla/5.0");
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    if (req.method !== "HEAD") byteRequests.push(file.id);
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": file.bytes.length, ETag: `"${file.sha1}"` });
    res.end(file.bytes);
  });
  const origin = await listen(upstream);
  const calls: { op: string; parentId?: string; offset?: number; fileId?: string }[] = [];
  const gates: ScanGate[] = [];
  let nextGate: ScanGate | undefined;
  const runner = async (input: ShareHelperInput, signal?: AbortSignal) => {
    assert.equal(input.shareCode, shareCode);
    assert.equal(input.receiveCode, suppliedCode);
    assert.equal(input.cookie, account);
    calls.push({ op: input.op, parentId: input.parentId, offset: input.offset, fileId: input.fileId });
    if (input.op === "list") {
      if (nextGate && input.parentId === FOLDERS.season && input.offset === 0) {
        const gate = nextGate;
        nextGate = undefined;
        gate.signal = signal;
        gate.enter();
        await gate.wait;
      }
      let entries: Entry[];
      if (input.parentId === "0") entries = [folder(FOLDERS.collection, "Collection")];
      else if (input.parentId === FOLDERS.collection) entries = [folder(FOLDERS.season, "Season 01")];
      else if (input.parentId === FOLDERS.child) entries = [entry(episodes.get(16)!), entry(duplicate)];
      else {
        assert.equal(input.parentId, FOLDERS.season);
        entries = [
          ...Array.from({ length: 13 }, (_, index) => entry(episodes.get(index + 1)!)),
          ...rejected.slice(0, 5).map(entry),
          folder(FOLDERS.child, "Season 01 1080p"), entry(rejected[5]),
          entry(episodes.get(14)!), entry(episodes.get(15)!),
          ...(extended ? [entry(episodes.get(17)!)] : []),
        ];
      }
      const offset = input.offset ?? 0;
      const page = entries.slice(offset, offset + 100);
      return { ok: true, data: { entries: page, total: entries.length, ...(offset + page.length < entries.length ? { nextOffset: offset + page.length } : {}) } };
    }
    assert.equal(input.op, "link");
    const file = files.get(input.fileId!);
    assert.ok(file);
    return { ok: true, data: { url: `${origin}/video/${file.id}?ticket=${ticket}`, name: file.name, size: file.bytes.length, sha1: file.sha1, headers: { "User-Agent": "Mozilla/5.0" } } };
  };
  let shares!: Shares;
  const scans: { titles: string[]; directories: string[][] }[] = [];
  const browse = Shares.prototype.browse, scan = Shares.prototype.scan, resolve = Shares.prototype.resolve;
  const mocks = [
    mock.method(Shares.prototype, "browse", function (...args: Parameters<Shares["browse"]>) { return browse.apply(shares, args); }),
    mock.method(Shares.prototype, "scan", async function (...args: Parameters<Shares["scan"]>) {
      const page = await scan.apply(shares, args);
      scans.push({ titles: page.files.map((item) => item.resource.title), directories: page.files.map((item) => item.directories) });
      return page;
    }),
    mock.method(Shares.prototype, "resolve", function (...args: Parameters<Shares["resolve"]>) { return resolve.apply(shares, args); }),
  ];
  const options = { dataDirectory: path.join(root, "state"), downloadDirectory: path.join(root, "files"), startBackground: false, testMode: true };
  let actual!: MediaService;
  const media: MediaService = {
    identify: async () => [{ ...MEDIA }],
    search: (...args) => actual.search(...args),
    browseShare: (...args) => actual.browseShare!(...args),
    shareDirectory: (...args) => actual.shareDirectory!(...args),
    scanShare: (...args) => actual.scanShare!(...args),
    testConnection: (...args) => actual.testConnection(...args),
    download: (...args) => actual.download(...args),
    scrape: (...args) => actual.scrape(...args),
  };
  let instance!: ReturnType<typeof createApp>;
  let server!: Server;
  let base = "", cookie = "", closed = true;
  const responses: unknown[] = [];
  const start = async () => {
    instance = createApp({ ...options, media });
    shares = new Shares(instance.store, runner);
    actual = createMediaService(() => instance.store.config(), shares);
    server = createServer(instance.app);
    base = await listen(server);
    closed = false;
  };
  const closeApp = async () => {
    if (closed) return;
    await closeServer(server);
    await instance.close();
    closed = true;
  };
  t.after(async () => {
    for (const gate of gates) gate.release();
    await closeApp();
    for (const method of mocks) method.mock.restore();
    await closeServer(upstream);
    await rm(root, { recursive: true, force: true });
  });
  const api = async (route: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + route, { method, headers: { cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json() as any;
    assert.ok(response.ok, data.error || "Directory HTTP fixture operation failed");
    responses.push(data);
    return { response, data };
  };
  await start();
  const setup = await api("/api/setup", "POST", { password: randomUUID() });
  cookie = setup.response.headers.get("set-cookie")!.split(";")[0];
  await api("/api/config", "PUT", { sources: { pansouUrl: origin, p115Enabled: true, p115Cookie: account }, library: { artwork: false }, download: { concurrency: 2 } });
  const openDirectory = async (episode?: number) => {
    let request = (await api("/api/requests", "POST", { query: `${TITLE} 2026`, intent: "search" })).data.request as MediaRequest;
    assert.equal(request.stage, "details");
    assert.equal(request.selected?.title, TITLE);
    assert.equal(request.selected?.type, "tv");
    request = (await api(`/api/requests/${request.id}/select`, "POST", { expectedRevision: request.revision, season: 1, ...(episode ? { episode } : {}) })).data.request;
    assert.equal(request.stage, "resource");
    assert.equal(request.selected?.type, "tv");
    assert.equal(request.selected?.season, 1);
    const source = request.resources.find((resource) => resource.shareRef);
    assert.ok(source);
    request = (await api(`/api/requests/${request.id}/select`, "POST", { expectedRevision: request.revision, resourceId: source.id, extractionCode: suppliedCode })).data.request;
    for (const title of ["Collection", "Season 01"]) {
      const folder = request.resources.find((resource) => resource.navigation === "folder" && resource.title === title);
      assert.ok(folder);
      request = (await api(`/api/requests/${request.id}/select`, "POST", { expectedRevision: request.revision, resourceId: folder.id })).data.request;
    }
    assert.ok(request.shareDirectory);
    assert.match(request.shareDirectory.reference, /^mori-share:[a-f0-9]{64}$/u);
    assert.equal(instance.queue.tasks().length, 0);
    assert.equal(byteRequests.length, 0, "searching and browsing must not fetch file bytes");
    assert.equal(calls.filter((call) => call.op === "link").length, 0);
    return request;
  };
  const subscribe = async (request: MediaRequest) => {
    const completed = (await api(`/api/requests/${request.id}/select`, "POST", { expectedRevision: request.revision, subscribeDirectory: true })).data.request as MediaRequest;
    assert.equal(completed.stage, "completed");
    assert.ok(completed.subscriptionId);
    assert.equal(instance.queue.tasks().length, 0);
    return completed.subscriptionId;
  };
  const subscription = async (id: string) => ((await api("/api/subscriptions")).data.subscriptions as Subscription[]).find((item) => item.id === id);
  const check = async (id: string) => (await api(`/api/subscriptions/${id}/check`, "POST")).data.subscription as Subscription | undefined;
  const drain = async (expected: number) => {
    const deadline = Date.now() + 8000;
    while (instance.queue.isBusy() && Date.now() < deadline) await delay(20);
    assert.equal(instance.queue.isBusy(), false, "native fixture downloads did not settle");
    const tasks = instance.queue.tasks();
    assert.equal(tasks.length, expected);
    for (const task of tasks) assert.equal(task.status, "completed", task.error);
    return tasks;
  };
  const privacy = async () => {
    await api("/api/requests"); await api("/api/subscriptions"); await api("/api/tasks"); await api("/api/notifications"); await api("/api/config");
    const visible = JSON.stringify({ responses, requests: instance.store.list("request"), subscriptions: instance.store.list("subscription"), tasks: instance.store.list("task") });
    const sensitive = [originalCode, suppliedCode, account, ticket, ...Object.values(FOLDERS), ...files.keys()];
    for (const value of sensitive) assert.ok(!visible.includes(value), "provider access data or raw IDs leaked in an ordinary DTO/record");
    await closeApp();
    for (const name of await readdir(options.dataDirectory)) {
      if (name !== "mori.sqlite" && name !== "mori.sqlite-wal") continue;
      const database = await readFile(path.join(options.dataDirectory, name));
      for (const value of sensitive) {
        // Four-character codes may occur by chance inside ciphertext; plaintext JSON values are framed.
        const marker = value === originalCode || value === suppliedCode ? JSON.stringify(value) : value;
        assert.ok(!database.includes(Buffer.from(marker)), "provider access data or raw IDs leaked in SQLite");
      }
    }
  };
  return {
    get instance() { return instance; }, api, openDirectory, subscribe, subscription, check, drain, privacy,
    calls, scans, byteRequests, episodes, rejected, duplicate, responses, suppliedCode, bridgeKey,
    get searchRequests() { return searchRequests; },
    extend() { extended = true; },
    async restart() { await closeApp(); await start(); },
    blockScan() {
      let enter!: () => void, release!: () => void;
      const gate: ScanGate = { started: new Promise((done) => { enter = done; }), wait: new Promise((done) => { release = done; }), enter: () => enter(), release: () => release() };
      nextGate = gate;
      gates.push(gate);
      return gate;
    },
    async bridge(text: string) {
      const peer = "fixture:GroupMessage:directory";
      const body = { eventId: randomUUID(), peer, text };
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", bridgeKey).update(JSON.stringify(["qq", timestamp, body.eventId, peer, text])).digest("hex");
      const response = await fetch(base + "/api/channels/bridge/qq", { method: "POST", headers: { "Content-Type": "application/json", "X-Mori-Timestamp": timestamp, "X-Mori-Signature": signature }, body: JSON.stringify(body) });
      const data = await response.json() as any;
      assert.ok(response.ok, "signed QQ HTTP fixture failed");
      responses.push(data);
      return data;
    },
  };
}

test("HTTP directory subscriptions retain capped pending files over restart and publish only new matching episodes", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const request = await f.openDirectory();
  const id = await f.subscribe(request);
  let current = (await f.subscription(id))!;
  assert.equal(current.share?.reference, request.shareDirectory?.reference);
  assert.equal(current.media?.season, 1);
  assert.equal(current.media?.episode, undefined);
  assert.equal(current.enabled, true);
  assert.equal(current.autoDownload, true);
  const firstStart = Date.now();
  current = (await f.check(id))!;
  assert.equal(f.instance.queue.tasks().length, 10);
  assert.ok(current.scan?.pending.length);
  assert.equal(current.scan?.complete, false);
  assert.ok(current.scan?.cursor);
  assert.ok(Date.parse(current.nextCheckAt!) >= firstStart + 14_000);
  assert.ok(Date.parse(current.nextCheckAt!) <= Date.now() + 16_000);
  const pending = current.scan!.pending.map((item) => item.resource.id);
  await f.drain(10);
  await f.restart();
  current = (await f.subscription(id))!;
  assert.deepEqual(current.scan?.pending.map((item) => item.resource.id), pending);
  assert.equal(f.instance.queue.tasks().length, 10);
  const listBeforePending = f.calls.filter((call) => call.op === "list").length;
  await f.check(id);
  assert.equal(f.calls.filter((call) => call.op === "list").length, listBeforePending, "persisted pending must be consumed before any new SDK page");
  await f.drain(13);
  const child = (await f.check(id))!;
  assert.equal(f.calls.filter((call) => call.op === "list").at(-1)?.parentId, FOLDERS.child);
  assert.ok(f.scans.at(-1)?.titles.includes(`${TITLE}.S01E16.1080p.mp4`));
  assert.ok(f.scans.at(-1)?.directories.some((names) => names.includes("Season 01 1080p")));
  assert.equal(f.instance.queue.tasks().length, 14, child.lastError || child.lastSummary);
  await f.drain(14);
  const completeStart = Date.now();
  current = (await f.check(id))!;
  assert.equal(f.calls.filter((call) => call.op === "list").at(-1)?.offset, 20);
  await f.drain(16);
  assert.equal(current.scan?.complete, true);
  assert.equal(current.scan?.pending.length, 0);
  assert.ok(Date.parse(current.nextCheckAt!) >= completeStart + 1_799_000);
  assert.ok(Date.parse(current.nextCheckAt!) <= Date.now() + 1_801_000);
  f.extend();
  for (let step = 0; step < 8; step++) {
    current = (await f.check(id))!;
    if (current.scan?.complete && current.scan.pending.length === 0) break;
  }
  assert.equal(current.scan?.complete, true);
  assert.equal(current.scan?.pending.length, 0);
  const tasks = await f.drain(17);
  assert.deepEqual(tasks.map((task) => task.media.episode).sort((a, b) => a! - b!), Array.from({ length: 17 }, (_, index) => index + 1));
  assert.equal(new Set(tasks.map((task) => `${task.media.title}:${task.media.season}:${task.media.episode}`)).size, 17);
  for (const task of tasks) {
    assert.equal(task.kind, "cloud");
    assert.equal(task.media.title, TITLE);
    assert.equal(task.media.season, 1);
    assert.match(task.url, /^mori-share:[a-f0-9]{64}$/u);
    const expected = f.episodes.get(task.media.episode!)!;
    const bytes = await readFile(task.path!);
    assert.deepEqual(bytes, expected.bytes);
    assert.equal(createHash("sha1").update(bytes).digest("hex").toUpperCase(), expected.sha1);
    const nfo = await readFile(task.path!.replace(/\.mp4$/u, ".nfo"), "utf8");
    assert.match(nfo, new RegExp(TITLE, "u"));
    assert.match(nfo, /<season>1<\/season>/u);
    assert.match(nfo, new RegExp(`<episode>${task.media.episode}</episode>`, "u"));
  }
  assert.equal(f.searchRequests, 1, "directory checks cannot fall back to broad source searches");
  assert.equal(f.byteRequests.length, 17);
  for (const file of [...f.rejected, f.duplicate]) assert.ok(!f.byteRequests.includes(file.id));
  for (const task of tasks) assert.ok(f.instance.queue.notifications.list().some((notice) => notice.taskId === task.id && notice.destination.platform === "web"));
  await f.privacy();
});

test("HTTP disabling or deleting a directory subscription cancels an in-flight scan without admitting its late result", { timeout: 20_000 }, async (t) => {
  for (const action of ["disable", "delete"] as const) await t.test(action, async (child) => {
    const f = await fixture(child);
    const id = await f.subscribe(await f.openDirectory());
    const gate = f.blockScan();
    const checking = f.check(id);
    await gate.started;
    assert.ok(gate.signal);
    if (action === "disable") await f.api(`/api/subscriptions/${id}`, "PATCH", { enabled: false });
    else await f.api(`/api/subscriptions/${id}`, "DELETE");
    assert.equal(gate.signal.aborted, true);
    gate.release();
    await checking;
    const current = await f.subscription(id);
    if (action === "disable") {
      assert.equal(current?.enabled, false);
      assert.equal(current?.seen.length, 0);
      assert.equal(current?.lastCheckedAt, undefined);
      assert.equal(current?.lastError, undefined);
    } else assert.equal(current, undefined);
    assert.equal(f.instance.queue.tasks().length, 0);
    assert.equal(f.calls.filter((call) => call.op === "link").length, 0);
    assert.equal(f.byteRequests.length, 0);
    await f.privacy();
  });
});

test("signed QQ HTTP directory selection joins the Web subscription and inherits task notifications", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const id = await f.subscribe(await f.openDirectory(1));
  await f.api("/api/config", "PUT", { channels: { bridge: { enabled: true, secret: f.bridgeKey } } });
  let request = (await f.bridge(`搜索 ${TITLE}`)).request as MediaRequest;
  assert.equal(request.stage, "details");
  request = (await f.bridge(`季集 ${request.id} S01E01`)).request;
  assert.equal(request.stage, "resource");
  let index = request.resources.findIndex((resource) => resource.shareRef);
  assert.ok(index >= 0);
  request = (await f.bridge(`资源 ${request.id} ${index + 1} 提取码 ${f.suppliedCode}`)).request;
  for (const title of ["Collection", "Season 01"]) {
    index = request.resources.findIndex((resource) => resource.navigation === "folder" && resource.title === title);
    assert.ok(index >= 0);
    request = (await f.bridge(`资源 ${request.id} ${index + 1}`)).request;
  }
  assert.ok(request.shareDirectory);
  assert.equal(f.instance.queue.tasks().length, 0);
  assert.equal(f.byteRequests.length, 0);
  request = (await f.bridge(`订阅目录 ${request.id}`)).request;
  assert.equal(request.subscriptionId, id);
  assert.equal(((await f.api("/api/subscriptions")).data.subscriptions as Subscription[]).length, 1);
  await f.check(id);
  const tasks: DownloadTask[] = await f.drain(10);
  const notices = f.instance.queue.notifications.list();
  for (const task of tasks) {
    assert.ok(notices.some((notice) => notice.taskId === task.id && notice.destination.platform === "web"));
    assert.ok(notices.some((notice) => notice.taskId === task.id && notice.destination.platform === "qq" && notice.destination.peer === "fixture:GroupMessage:directory"));
  }
  assert.equal(f.searchRequests, 2);
  await f.privacy();
});
