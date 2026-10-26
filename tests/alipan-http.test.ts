import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { Alipan } from "../server/alipan.js";
import { createApp } from "../server/index.js";
import { createMediaService } from "../server/media.js";
import { Shares, type ShareHelperRunner } from "../server/shares.js";
import { ALIPAN_AUTH_ID, ALIPAN_AUTH_KIND } from "../server/store.js";
import type { DownloadTask, MediaInfo, MediaRequest, MediaService, ResourceChoice, Subscription } from "../shared/types.js";

const TITLE = "MoriAlipanFixture";
const MEDIA: MediaInfo = { type: "tv", title: TITLE, year: 2026 };
const FOLDERS = { collection: "ali-collection-fixture", season: "ali-season-fixture" };
const DRIVE = "ali-share-drive-fixture";
const PEER = "fixture:GroupMessage:alipan";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function gate() {
  const entered = deferred<void>(), released = deferred<void>(), cancelled = deferred<void>();
  return {
    started: entered.promise, aborted: cancelled.promise, wait: released.promise,
    signal: undefined as AbortSignal | undefined,
    enter(signal?: AbortSignal) {
      this.signal = signal;
      if (signal?.aborted) cancelled.resolve();
      else signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
      entered.resolve();
    },
    release() { released.resolve(); },
  };
}
type Gate = ReturnType<typeof gate>;
interface FixtureFile { id: string; name: string; bytes: Buffer; episode?: number }
interface ApiReply { response: Response; data: any }

async function bounded<T>(promise: Promise<T>, description: string) {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(description)), 2_000);
      timer.unref();
    })]);
  } finally { clearTimeout(timer); }
}

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve); server.once("error", reject);
  });
  const port = (server.address() as { port: number }).port;
  assert.notEqual(port, 4180);
  return `http://127.0.0.1:${port}`;
}
async function closeServer(server: Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-alipan-http-"));
  const options = { dataDirectory: path.join(root, "state"), downloadDirectory: path.join(root, "files"), startBackground: false, testMode: true };
  const configuredCredential = "fixture-config-" + randomUUID();
  const shareCredential = "fixture-share-" + randomUUID();
  const originalCode = "A7p9", suppliedCode = "B6q8";
  const shareCode = "MoriAliShareFixture", oldShareCode = "Mori115ShareFixture";
  const marker = "fixture-marker-" + randomUUID();
  const ticket = "fixture-ticket-" + randomUUID();
  const bridgeKey = randomUUID();
  const files = new Map<string, FixtureFile>();
  const makeFile = (id: string, name: string, seed: number, episode?: number) => {
    const file = { id, name, episode, bytes: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(4096, seed)]) };
    files.set(id, file);
    return file;
  };
  const episodes = new Map(Array.from({ length: 24 }, (_, index) => {
    const episode = index + 1;
    return [episode, makeFile(`ali-file-${episode}`, `${TITLE}.2026.S01E${String(episode).padStart(2, "0")}.mp4`, episode, episode)] as const;
  }));
  const rejected = [
    makeFile("ali-wrong-season", `${TITLE}.2026.S02E40.mp4`, 40),
    makeFile("ali-wrong-work", "OtherFixture.2026.S01E41.mp4", 41),
    makeFile("ali-trailer", `${TITLE}.2026.S01E42.trailer.mp4`, 42),
    makeFile("ali-featurette", `${TITLE}.2026.S01E43.featurette.mp4`, 43),
    makeFile("ali-notes", "notes.txt", 44),
    makeFile("ali-sample", `${TITLE}.2026.S01E44.sample.mp4`, 45),
  ];
  const oldFile = makeFile("9007199254741990", `${TITLE}.2026.S01E90.mp4`, 90, 90);
  const providerEntry = (file: FixtureFile) => ({ file_id: file.id, name: file.name, type: "file", size: file.bytes.length, drive_id: DRIVE, updated_at: "2026-10-24T00:00:00.000Z" });
  const folder = (id: string, name: string) => ({ file_id: id, name, type: "folder" });
  const byteRequests: { id: string; headers: IncomingHttpHeaders }[] = [];
  let searches = 0;
  const upstream = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://fixture.invalid");
    if (url.pathname === "/api/search") {
      searches++;
      request.resume();
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ merged_by_type: {
        aliyun: [{ url: `https://www.alipan.com/s/${shareCode}?pwd=${originalCode}`, password: originalCode, note: `${TITLE}.2026.S01`, source: "isolated Alipan fixture" }],
        "115": [{ url: `https://115.com/s/${oldShareCode}?password=${originalCode}`, password: originalCode, note: `${TITLE}.2026.S01`, source: "isolated legacy fixture" }],
      } }));
      return;
    }
    const file = files.get(url.pathname.slice("/video/".length));
    if (!url.pathname.startsWith("/video/") || !file || url.searchParams.get("ticket") !== ticket) {
      response.writeHead(404).end(); return;
    }
    if (request.method !== "HEAD") byteRequests.push({ id: file.id, headers: { ...request.headers } });
    response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": file.bytes.length, ETag: `"fixture-${file.id}"` });
    response.end(file.bytes);
  });
  const origin = await listen(upstream);
  const providerCalls: { path: string; body: any; headers: Headers }[] = [];
  const refreshed: { input: string; access: string; refresh: string }[] = [];
  const legacyCalls: string[] = [];
  const gates: Gate[] = [];
  let refreshGate: { gate: Gate; fail: boolean } | undefined;
  let listGate: Gate | undefined;
  let identifyGate: Gate | undefined;
  let failRefresh = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.ok(["auth.alipan.com", "api.alipan.com"].includes(url.hostname));
    assert.equal(url.protocol, "https:");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    providerCalls.push({ path: url.pathname, body, headers });
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/v2/account/token") {
      assert.equal(url.hostname, "auth.alipan.com");
      assert.equal(body.grant_type, "refresh_token");
      const blocked = refreshGate; refreshGate = undefined;
      if (blocked) {
        blocked.gate.enter(init?.signal ?? undefined);
        await blocked.gate.wait;
        if (blocked.fail) throw new TypeError("isolated fixture refresh failure");
      }
      if (failRefresh) { failRefresh = false; throw new TypeError("isolated fixture refresh failure"); }
      const pair = { input: body.refresh_token as string, access: "fixture-access-" + randomUUID(), refresh: "fixture-rotated-" + randomUUID() };
      refreshed.push(pair);
      return json({ access_token: pair.access, refresh_token: pair.refresh, expires_in: 3600 });
    }
    assert.equal(body.share_id, shareCode);
    if (url.pathname === "/v2/share_link/get_share_token") {
      assert.ok([originalCode, suppliedCode].includes(body.share_pwd));
      return json({ share_token: shareCredential });
    }
    assert.equal(headers.get("x-share-token"), shareCredential);
    if (url.pathname === "/adrive/v3/file/list") {
      assert.equal(headers.get("authorization"), null, "anonymous browsing does not borrow account authorization");
      assert.equal(body.limit, 20);
      const blocked = listGate; listGate = undefined;
      if (blocked) { blocked.enter(init?.signal ?? undefined); await blocked.wait; }
      if (body.parent_file_id === "root") return json({ items: [folder(FOLDERS.collection, `${TITLE}.2026`)], next_marker: "" });
      if (body.parent_file_id === FOLDERS.collection) return json({ items: [folder(FOLDERS.season, "Season 01")], next_marker: "" });
      assert.equal(body.parent_file_id, FOLDERS.season);
      if (!body.marker) return json({ items: [...Array.from({ length: 18 }, (_, i) => providerEntry(episodes.get(i + 1)!)), ...rejected.slice(0, 5).map(providerEntry)], next_marker: marker });
      assert.equal(body.marker, marker);
      return json({ items: [...Array.from({ length: 6 }, (_, i) => providerEntry(episodes.get(i + 19)!)), providerEntry(rejected[5])], next_marker: "" });
    }
    assert.equal(url.pathname, "/v2/file/get_share_link_download_url");
    assert.equal(body.drive_id, DRIVE, "download uses the drive carried by the shared item");
    assert.equal(body.expire_sec, 600);
    assert.equal(headers.get("authorization"), "Bearer " + refreshed.at(-1)?.access);
    assert.ok(files.has(body.file_id));
    return json({ download_url: `${origin}/video/${body.file_id}?ticket=${ticket}` });
  };
  const runner: ShareHelperRunner = async (input) => {
    legacyCalls.push(input.op);
    assert.equal(input.shareCode, oldShareCode);
    if (input.op === "list") return { ok: true, data: { entries: [{ id: oldFile.id, name: oldFile.name, directory: false, size: oldFile.bytes.length, sha1: createHash("sha1").update(oldFile.bytes).digest("hex") }], total: 1 } };
    assert.equal(input.op, "link");
    return { ok: true, data: { url: `${origin}/video/${oldFile.id}?ticket=${ticket}`, name: oldFile.name, size: oldFile.bytes.length, sha1: createHash("sha1").update(oldFile.bytes).digest("hex"), headers: { "User-Agent": "Mozilla/5.0" } } };
  };
  let actual!: MediaService;
  const media: MediaService = {
    identify: async (_query, _type, signal) => {
      const blocked = identifyGate; identifyGate = undefined;
      if (blocked) { blocked.enter(signal); await blocked.wait; }
      return [{ ...MEDIA }];
    },
    search: (...args) => actual.search(...args),
    browseShare: (...args) => actual.browseShare!(...args),
    shareDirectory: (...args) => actual.shareDirectory!(...args),
    scanShare: (...args) => actual.scanShare!(...args),
    download: (...args) => actual.download(...args),
    scrape: (...args) => actual.scrape(...args),
    testConnection: (...args) => actual.testConnection(...args),
    close: async () => { await actual.close?.(); },
  };
  let instance!: ReturnType<typeof createApp>, server!: Server, shares!: Shares;
  let base = "", cookie = "", closed = true;
  const responses: unknown[] = [];
  const start = async () => {
    instance = createApp({ ...options, media });
    shares = new Shares(instance.store, runner, new Alipan(instance.store, fetcher));
    actual = createMediaService(() => instance.store.config(), shares);
    server = createServer(instance.app);
    base = await listen(server);
    closed = false;
  };
  const closeApp = async () => {
    if (closed) return;
    await instance.close();
    await closeServer(server);
    closed = true;
  };
  const raw = async (route: string, method = "GET", body?: unknown): Promise<ApiReply> => {
    const response = await fetch(base + route, { method, headers: { cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    responses.push(data);
    return { response, data };
  };
  const api = async (route: string, method = "GET", body?: unknown) => {
    const reply = await raw(route, method, body);
    assert.ok(reply.response.ok, reply.data.error || "isolated Alipan HTTP operation failed");
    return reply;
  };
  t.after(async () => {
    for (const blocked of gates) blocked.release();
    try { await closeApp(); }
    finally {
      if (server?.listening) await closeServer(server);
      await closeServer(upstream);
      await rm(root, { recursive: true, force: true });
      await assert.rejects(readFile(path.join(options.dataDirectory, "mori.sqlite")), { code: "ENOENT" });
    }
  });
  await start();
  const setup = await api("/api/setup", "POST", { password: randomUUID() });
  cookie = setup.response.headers.get("set-cookie")!.split(";")[0];
  await api("/api/config", "PUT", {
    sources: { pansouUrl: origin, p115Enabled: true, p115Cookie: "fixture-115-account", alipanEnabled: true },
    library: { artwork: false }, download: { concurrency: 2, aria2Url: "" },
  });
  const select = async (request: MediaRequest, choice: Record<string, unknown>) =>
    (await api(`/api/requests/${request.id}/select`, "POST", { expectedRevision: request.revision, ...choice })).data.request as MediaRequest;
  const begin = async (episode = 1) => {
    let request = (await api("/api/requests", "POST", { query: `${TITLE} 2026`, intent: "search" })).data.request as MediaRequest;
    assert.equal(request.stage, "details");
    assert.equal(request.selected?.title, TITLE);
    request = await select(request, { season: 1, episode });
    assert.equal(request.stage, "resource");
    assert.equal(request.selected?.season, 1);
    assert.equal(request.selected?.episode, episode);
    return request;
  };
  const open = async (request: MediaRequest) => {
    const source = request.resources.find((item) => item.provider === "alipan" && item.shareRef);
    assert.ok(source, "search must expose the Alipan provider");
    request = await select(request, { resourceId: source.id, extractionCode: suppliedCode });
    for (const title of [`${TITLE}.2026`, "Season 01"]) {
      assert.equal(request.shareDirectory?.provider, "alipan");
      const directory = request.resources.find((item) => item.navigation === "folder" && item.title === title);
      assert.ok(directory);
      request = await select(request, { resourceId: directory.id });
    }
    assert.equal(request.shareDirectory?.provider, "alipan");
    assert.ok(request.resources.every((item) => item.provider === "alipan"));
    return request;
  };
  const subscribe = async (request: MediaRequest) => {
    const completed = await select(request, { subscribeDirectory: true });
    assert.equal(completed.stage, "completed");
    assert.ok(completed.subscriptionId);
    return completed.subscriptionId;
  };
  const check = async (id: string) => (await api(`/api/subscriptions/${id}/check`, "POST")).data.subscription as Subscription;
  const subscription = async (id: string) => ((await api("/api/subscriptions")).data.subscriptions as Subscription[]).find((item) => item.id === id)!;
  const authorize = async () => {
    await api("/api/config", "PUT", { sources: { alipanRefreshToken: configuredCredential } });
    const result = await api("/api/test", "POST", { kind: "alipan" });
    assert.equal(result.data.ok, true);
    assert.equal(instance.store.config().sources.alipanRefreshToken, configuredCredential);
  };
  const drain = async (expected: number) => {
    const deadline = Date.now() + 8_000;
    while (instance.queue.isBusy() && Date.now() < deadline) await delay(10);
    assert.equal(instance.queue.isBusy(), false, "isolated native downloads did not settle");
    const tasks = instance.queue.tasks();
    assert.equal(tasks.length, expected);
    for (const task of tasks) assert.equal(task.status, "completed", task.error);
    return tasks;
  };
  const authSession = () => instance.store.privateRecord<{ phase: string; accessToken: string; refreshToken: string }>(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID)!;
  const privacy = async () => {
    for (const route of ["/api/requests", "/api/subscriptions", "/api/tasks", "/api/notifications", "/api/config"]) await api(route);
    const normal = JSON.stringify({ responses, requests: instance.store.list("request"), tasks: instance.store.list("task"), subscriptions: instance.store.list("subscription"), auth: instance.store.list(ALIPAN_AUTH_KIND) });
    const privateValues = [configuredCredential, shareCredential, suppliedCode, originalCode, ticket, marker, DRIVE, ...Object.values(FOLDERS), ...files.keys(), ...refreshed.flatMap((pair) => [pair.access, pair.refresh])];
    for (const value of privateValues) assert.ok(!normal.includes(value), "private provider material reached a public DTO or ordinary record");
    for (const name of await readdir(options.dataDirectory)) {
      if (name !== "mori.sqlite" && name !== "mori.sqlite-wal") continue;
      const bytes = await readFile(path.join(options.dataDirectory, name));
      for (const value of privateValues.filter((item) => item.length > 4))
        assert.ok(!bytes.includes(Buffer.from(value)), "private provider material was stored without encryption");
    }
  };
  const block = (kind: "refresh" | "list" | "identify", fail = false) => {
    const blocked = gate(); gates.push(blocked);
    if (kind === "refresh") refreshGate = { gate: blocked, fail };
    else if (kind === "list") listGate = blocked;
    else identifyGate = blocked;
    return blocked;
  };
  const bridge = async (text: string) => {
    const body = { eventId: randomUUID(), peer: PEER, text };
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", bridgeKey).update(JSON.stringify(["qq", timestamp, body.eventId, PEER, text])).digest("hex");
    const response = await fetch(base + "/api/channels/bridge/qq", { method: "POST", headers: { "Content-Type": "application/json", "X-Mori-Timestamp": timestamp, "X-Mori-Signature": signature }, body: JSON.stringify(body) });
    const data = await response.json() as any;
    assert.ok(response.ok, "isolated signed QQ operation failed");
    responses.push(data);
    return data;
  };
  return {
    get instance() { return instance; }, get shares() { return shares; }, get searches() { return searches; },
    api, raw, select, begin, open, subscribe, subscription, check, authorize, drain, authSession, privacy, block, bridge,
    episodes, rejected, oldFile, files, byteRequests, providerCalls, refreshed, legacyCalls, configuredCredential, bridgeKey,
    failNextRefresh() { failRefresh = true; },
    async restart() { await closeApp(); await start(); },
    async assertFile(task: DownloadTask) {
      const file = task.media.episode === 90 ? oldFile : episodes.get(task.media.episode!);
      assert.ok(file && task.path);
      assert.deepEqual(await readFile(task.path), file.bytes);
      const nfo = await readFile(task.path.slice(0, -path.extname(task.path).length) + ".nfo", "utf8");
      assert.ok(nfo.includes(`<showtitle>${TITLE}</showtitle>`));
      assert.ok(nfo.includes(`<episode>${file.episode}</episode>`));
      assert.ok(nfo.includes("<year>2026</year>"));
    },
  };
}

test("HTTP Alipan selection, oversized marker pages, encrypted rotation, native files and directory restart remain one flow", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const found = (await f.api(`/api/search?q=${TITLE}`)).data.results as ResourceChoice[];
  assert.ok(found.some((item) => item.provider === "alipan" && item.kind === "share"));
  assert.ok(found.some((item) => (item.provider ?? "p115") === "p115" && item.kind === "share"));
  let directory = await f.open(await f.begin());
  const allTitles = new Set(directory.resources.filter((item) => item.kind === "cloud").map((item) => item.title));
  let browsing = directory;
  for (let page = 0; page < 3; page++) {
    const next = browsing.resources.find((item) => item.navigation === "next");
    if (!next) break;
    browsing = await f.select(browsing, { resourceId: next.id });
    for (const item of browsing.resources.filter((item) => item.kind === "cloud")) allTitles.add(item.title);
    assert.ok(browsing.resources.every((item) => item.provider === "alipan"));
  }
  assert.equal(browsing.resources.some((item) => item.navigation === "next"), false);
  assert.equal(allTitles.size, 30, "23 provider items plus the next marker must all remain browsable");
  directory = browsing;
  const id = await f.subscribe(directory);
  const unauthorized = await f.check(id);
  assert.match(unauthorized.lastError!, /授权/);
  assert.equal(f.instance.queue.tasks().length, 0);
  assert.equal(f.byteRequests.length, 0);
  assert.equal(f.refreshed.length, 0);
  assert.equal(f.providerCalls.some((call) => call.path.endsWith("download_url")), false);

  await f.authorize();
  assert.equal(f.authSession().phase, "ready");
  assert.equal(f.authSession().refreshToken, f.refreshed[0].refresh);
  const envelope = f.instance.store.record<{ sealed: string }>(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID)!;
  assert.equal(typeof envelope.sealed, "string");
  assert.ok(!envelope.sealed.includes(f.refreshed[0].refresh));
  const fileRequest = await f.open(await f.begin());
  const file = fileRequest.resources.find((item) => item.title === f.episodes.get(1)!.name)!;
  const completed = await f.select(fileRequest, { resourceId: file.id });
  assert.ok(completed.taskId);
  await f.drain(1);
  await f.assertFile(f.instance.queue.tasks()[0]);

  const first = await f.check(id);
  assert.equal(f.instance.queue.tasks().length, 10);
  assert.equal(first.scan?.pending.length, 8);
  assert.ok(first.scan?.cursor);
  assert.equal(first.scan?.complete, false);
  const pending = structuredClone(first.scan);
  await f.drain(10);
  const legacy = await f.begin(90);
  const legacySource = legacy.resources.find((item) => (item.provider ?? "p115") === "p115" && item.shareRef)!;
  assert.ok(legacySource);
  const legacyRecord = f.instance.store.privateRecord<any>("share-reference", legacySource.shareRef!.slice("mori-share:".length));
  assert.equal(legacyRecord.provider, undefined, "the persisted legacy 115 root has no provider discriminator");
  await f.restart();
  assert.deepEqual((await f.subscription(id)).scan, pending);
  assert.equal(f.instance.store.config().sources.alipanRefreshToken, f.configuredCredential);
  assert.equal((await f.api("/api/test", "POST", { kind: "alipan" })).data.ok, true);
  assert.equal(f.refreshed[1].input, f.refreshed[0].refresh, "restart uses the rotated cache while the saved configuration remains unchanged");
  const lists = f.providerCalls.filter((call) => call.path.endsWith("/file/list")).length;
  await f.check(id);
  await f.drain(18);
  assert.equal(f.providerCalls.filter((call) => call.path.endsWith("/file/list")).length, lists, "durable pending files drain before another provider read");
  await f.check(id);
  assert.equal(f.instance.queue.tasks().length, 18);
  await f.restart();
  const complete = await f.check(id);
  const tasks = await f.drain(24);
  assert.equal(complete.scan?.complete, true);
  assert.equal(complete.scan?.pending.length, 0);
  assert.deepEqual(tasks.map((task) => task.media.episode).sort((a, b) => a! - b!), Array.from({ length: 24 }, (_, i) => i + 1));
  assert.ok(f.providerCalls.some((call) => call.path.endsWith("/file/list") && call.body.marker));
  for (const task of tasks) await f.assertFile(task);
  for (const bad of f.rejected) assert.ok(!f.byteRequests.some((request) => request.id === bad.id));

  const oldBrowse = await f.select(legacy, { resourceId: legacySource.id });
  const oldResult = oldBrowse.resources.find((item) => item.kind === "cloud")!;
  assert.equal(oldResult.provider ?? "p115", "p115");
  const oldCompleted = await f.select(oldBrowse, { resourceId: oldResult.id });
  assert.ok(oldCompleted.taskId);
  const withLegacy = await f.drain(25);
  await f.assertFile(withLegacy.find((task) => task.id === oldCompleted.taskId)!);
  assert.deepEqual(f.legacyCalls, ["list", "link"]);
  for (const request of f.byteRequests) {
    assert.equal(request.headers["user-agent"], "Mozilla/5.0");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers["x-share-token"], undefined);
    assert.equal(request.headers.referer, request.id === f.oldFile.id ? undefined : "https://www.alipan.com/");
  }
  // Equal local fixture bytes prove native publication and declared size, not a provider SHA1 guarantee.
  assert.ok(!JSON.stringify(withLegacy.filter((task) => task.media.episode !== 90)).includes("sha1"));
  await f.privacy();

  f.failNextRefresh();
  const unknown = await f.api("/api/test", "POST", { kind: "alipan" });
  assert.equal(unknown.data.ok, false);
  assert.equal(unknown.data.code, "alipan_auth_unknown");
  const refreshes = f.providerCalls.filter((call) => call.path === "/v2/account/token").length;
  assert.equal((await f.api("/api/test", "POST", { kind: "alipan" })).data.code, "alipan_auth_unknown");
  assert.equal(f.providerCalls.filter((call) => call.path === "/v2/account/token").length, refreshes);
  assert.equal((await f.raw("/api/config")).response.status, 200, "provider auth failure must retain the Mori session");
});

test("signed QQ searches and selects Alipan directories before joining the same Web subscription", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.authorize();
  const id = await f.subscribe(await f.open(await f.begin()));
  await f.api("/api/config", "PUT", { channels: { bridge: { enabled: true, secret: f.bridgeKey } } });
  let request = (await f.bridge(`搜索 ${TITLE}`)).request as MediaRequest;
  assert.equal(request.stage, "details");
  request = (await f.bridge(`季集 ${request.id} S01E01`)).request;
  assert.equal(request.stage, "resource");
  const choose = async (predicate: (item: ResourceChoice) => boolean, suffix = "") => {
    const index = request.resources.findIndex(predicate);
    assert.ok(index >= 0);
    request = (await f.bridge(`资源 ${request.id} ${index + 1}${suffix}`)).request;
  };
  await choose((item) => item.provider === "alipan" && Boolean(item.shareRef), " 提取码 B6q8");
  for (const title of [`${TITLE}.2026`, "Season 01"]) await choose((item) => item.navigation === "folder" && item.title === title);
  assert.equal(request.shareDirectory?.provider, "alipan");
  assert.ok(request.resources.every((item) => item.provider === "alipan"));
  assert.equal(f.instance.queue.tasks().length, 0);
  request = (await f.bridge(`订阅目录 ${request.id}`)).request;
  assert.equal(request.subscriptionId, id);
  assert.equal(((await f.api("/api/subscriptions")).data.subscriptions as Subscription[]).length, 1);
  await f.check(id);
  const tasks = await f.drain(10);
  for (const task of tasks) {
    const notices = f.instance.queue.notifications.list().filter((notice) => notice.taskId === task.id);
    assert.ok(notices.some((notice) => notice.destination.platform === "web"));
    assert.ok(notices.some((notice) => notice.destination.platform === "qq" && notice.destination.peer === PEER));
  }
  assert.equal(f.searches, 2);
  await f.privacy();
});

test("HTTP close drains an in-flight authorization rotation before closing Store and remains idempotent", { timeout: 20_000 }, async (t) => {
  for (const fail of [false, true]) await t.test(fail ? "unknown rotation" : "late complete credential pair", async (child) => {
    const f = await fixture(child);
    await f.api("/api/config", "PUT", { sources: { alipanRefreshToken: f.configuredCredential } });
    const blocked = f.block("refresh", fail);
    const testing = f.raw("/api/test", "POST", { kind: "alipan" });
    await bounded(blocked.started, "authorization test did not reach the provider fixture");
    const closing = f.instance.close();
    assert.equal(f.instance.close(), closing);
    let settled = false;
    void closing.then(() => { settled = true; });
    await bounded(blocked.aborted, "close did not cancel the authorization transport");
    await setImmediate();
    assert.equal(settled, false, "close cannot dispose Store while a credential receipt may still arrive");
    blocked.release();
    const [result] = await Promise.all([testing, closing]);
    assert.notEqual(result.response.status, 401);
    await f.restart();
    const session = f.authSession();
    assert.equal(session.phase, fail ? "unknown" : "ready");
    assert.equal((await f.api("/api/config")).response.status, 200);
    if (fail) {
      const before = f.providerCalls.length;
      assert.equal((await f.api("/api/test", "POST", { kind: "alipan" })).data.code, "alipan_auth_unknown");
      assert.equal(f.providerCalls.length, before, "an unknown refresh is never replayed after restart");
    } else {
      assert.equal(session.refreshToken, f.refreshed[0].refresh);
      assert.equal(session.accessToken, f.refreshed[0].access);
      assert.equal((await f.api("/api/test", "POST", { kind: "alipan" })).data.ok, true);
      assert.equal(f.refreshed[1].input, f.refreshed[0].refresh);
    }
    await f.privacy();
  });
});

test("HTTP close drains browsing and identification without committing late request results", { timeout: 20_000 }, async (t) => {
  for (const kind of ["list", "identify"] as const) await t.test(kind, async (child) => {
    const f = await fixture(child);
    let request: MediaRequest | undefined;
    if (kind === "list") request = await f.begin();
    const blocked = f.block(kind);
    const pending = kind === "identify"
      ? f.raw("/api/requests", "POST", { query: TITLE, intent: "search" })
      : f.raw(`/api/requests/${request!.id}/select`, "POST", {
        expectedRevision: request!.revision,
        resourceId: request!.resources.find((item) => item.provider === "alipan")!.id,
      });
    await bounded(blocked.started, "request did not reach the deferred boundary");
    const beforeClosing = (await f.api("/api/requests")).data.requests as MediaRequest[];
    if (kind === "identify") {
      assert.equal(beforeClosing.length, 1);
      assert.equal(beforeClosing[0].revision, 0);
      assert.deepEqual(beforeClosing[0].candidates, []);
      assert.deepEqual(beforeClosing[0].resources, []);
    }
    const closing = f.instance.close();
    assert.equal(f.instance.close(), closing);
    let settled = false;
    void closing.then(() => { settled = true; });
    await bounded(blocked.aborted, "close did not cancel the media boundary");
    await setImmediate();
    assert.equal(settled, false);
    blocked.release();
    const [response] = await Promise.all([pending, closing]);
    assert.equal(response.response.ok, false);
    await f.restart();
    const requests = (await f.api("/api/requests")).data.requests as MediaRequest[];
    if (request) {
      const stored = requests.find((item) => item.id === request!.id)!;
      assert.equal(stored.shareDirectory, undefined);
      assert.equal(stored.revision, request.revision);
    } else assert.deepEqual(requests, beforeClosing, "a pre-await request skeleton must not gain late metadata");
    assert.equal(f.instance.queue.tasks().length, 0);
    assert.equal(f.byteRequests.length, 0);
    assert.equal(f.refreshed.length, 0);
    await f.privacy();
  });
});
