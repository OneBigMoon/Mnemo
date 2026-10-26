import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createApp } from "../server/index.js";
import { createMediaService } from "../server/media.js";
import type { Store } from "../server/store.js";
import type { MediaRequest, MediaService, SearchReport, SearchResult, Subscription } from "../shared/types.js";

const TITLE = "MoriSearchFixture";
const MEDIA = { type: "tv" as const, title: TITLE, year: 2026 };
const RESOURCE: SearchResult = {
  id: "search-fixture", title: `${TITLE}.2026.S01E01.mp4`,
  url: "https://fixture.invalid/video.mp4", kind: "direct", source: "fixture",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function blockedSearch() {
  const started = deferred<void>(), aborted = deferred<void>(), released = deferred<void>(), ended = deferred<void>();
  return {
    started: started.promise, aborted: aborted.promise, ended: ended.promise,
    signal: undefined as AbortSignal | undefined,
    release() { released.resolve(); },
    async run(signal?: AbortSignal): Promise<SearchReport> {
      assert.ok(signal, "HTTP search must receive a cancellation signal");
      this.signal = signal;
      if (signal.aborted) aborted.resolve();
      else signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      started.resolve();
      try {
        await released.promise;
        return complete();
      } finally { ended.resolve(); }
    },
  };
}
async function bounded<T>(promise: Promise<T>, message: string) {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 2_000);
      timer.unref();
    })]);
  } finally { clearTimeout(timer); }
}
function complete(): SearchReport {
  return { results: [{ ...RESOURCE }], diagnostics: { status: "complete", sources: [
    { id: "pansou", source: "pansou", name: "PanSou", status: "success", resultCount: 1 },
  ] } };
}
function minimalMedia(overrides: Partial<MediaService> = {}): MediaService {
  return {
    search: async () => [{ ...RESOURCE }],
    identify: async () => [{ ...MEDIA }],
    download: async () => { throw new Error("unexpected search fixture download"); },
    scrape: async () => ({ files: [], warnings: [] }),
    testConnection: async () => ({ ok: true, message: "fixture" }),
    ...overrides,
  };
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

async function appFixture(
  t: TestContext,
  factory: (store: Store) => MediaService,
  reporting = true,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-search-http-"));
  const options = { dataDirectory: path.join(root, "state"), downloadDirectory: path.join(root, "files"), startBackground: false, testMode: true };
  let actual!: MediaService;
  const media: MediaService = {
    search: (...args) => actual.search(...args),
    identify: (...args) => actual.identify(...args),
    download: (...args) => actual.download(...args),
    scrape: (...args) => actual.scrape(...args),
    testConnection: (...args) => actual.testConnection(...args),
    close: async () => { await actual.close?.(); },
    ...(reporting ? { searchWithDiagnostics: (query: string, signal?: AbortSignal) => actual.searchWithDiagnostics!(query, signal) } : {}),
  };
  let instance!: ReturnType<typeof createApp>, server!: Server;
  let base = "", cookie = "", closed = true;
  const cleanup: (() => void)[] = [];
  const start = async () => {
    instance = createApp({ ...options, media });
    actual = factory(instance.store);
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
  t.after(async () => {
    for (const release of cleanup) release();
    try { await closeApp(); }
    finally {
      if (server?.listening) await closeServer(server);
      await rm(root, { recursive: true, force: true });
      await assert.rejects(readFile(path.join(options.dataDirectory, "mori.sqlite")), { code: "ENOENT" });
    }
  });
  const raw = async (route: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}) => {
    const response = await fetch(base + route, {
      method: init.method || "GET", signal: init.signal,
      headers: { cookie, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const data = await response.json() as any;
    return { response, data };
  };
  const api = async (route: string, method = "GET", body?: unknown) => {
    const reply = await raw(route, { method, body });
    assert.ok(reply.response.ok, reply.data.error || "isolated search HTTP operation failed");
    return reply;
  };
  await start();
  const setup = await api("/api/setup", "POST", { password: randomUUID() });
  cookie = setup.response.headers.get("set-cookie")!.split(";")[0];
  return {
    get instance() { return instance; },
    raw, api,
    search: (query = TITLE, signal?: AbortSignal) => raw(`/api/search?q=${encodeURIComponent(query)}`, { signal }),
    releaseOnCleanup(release: () => void) { cleanup.push(release); },
    async restart() { await closeApp(); await start(); },
    assertNoSearchWrites() {
      for (const kind of ["request", "task", "subscription"])
        assert.deepEqual(instance.store.list(kind), [], "a direct search must not create persistent work");
    },
  };
}

test("HTTP search preserves complete, partial, empty, failed and unconfigured diagnostics", async (t) => {
  const partial: SearchReport = { ...complete(), diagnostics: { status: "partial", sources: [
    ...complete().diagnostics.sources,
    { id: "openlist", source: "openlist", name: "OpenList", status: "failed", resultCount: 0, code: "upstream_error" },
  ] } };
  const cases: { name: string; report: SearchReport; status: number; code?: string }[] = [
    { name: "complete", report: complete(), status: 200 },
    { name: "partial", report: partial, status: 200 },
    { name: "all sources empty", report: { results: [], diagnostics: { status: "complete", sources: [
      { id: "pansou", source: "pansou", name: "PanSou", status: "empty", resultCount: 0 },
      { id: "openlist", source: "openlist", name: "OpenList", status: "empty", resultCount: 0 },
    ] } }, status: 200 },
    { name: "all failed", report: { results: [], diagnostics: { status: "failed", sources: [
      { id: "pansou", source: "pansou", name: "PanSou", status: "failed", resultCount: 0, code: "unreachable" },
      { id: "openlist", source: "openlist", name: "OpenList", status: "failed", resultCount: 0, code: "auth_required" },
    ] } }, status: 502, code: "search_failed" },
    { name: "not configured", report: { results: [], diagnostics: { status: "not_configured", sources: [
      { id: "pansou", source: "pansou", name: "PanSou", status: "not_configured", resultCount: 0 },
    ] } }, status: 409, code: "search_not_configured" },
  ];
  let report = cases[0].report;
  let calls = 0;
  const f = await appFixture(t, () => minimalMedia({
    search: async () => { throw new Error("diagnostic service must not fall back to the legacy array method"); },
    searchWithDiagnostics: async (query, signal) => {
      calls++;
      assert.equal(query, TITLE);
      assert.ok(signal instanceof AbortSignal);
      return structuredClone(report);
    },
  }));
  for (const scenario of cases) await t.test(scenario.name, async () => {
    report = scenario.report;
    const reply = await f.search();
    assert.equal(reply.response.status, scenario.status);
    assert.deepEqual(reply.data.results, scenario.report.results);
    assert.deepEqual(reply.data.diagnostics, scenario.report.diagnostics);
    assert.equal(reply.data.code, scenario.code);
    if (scenario.code) assert.ok(typeof reply.data.error === "string" && reply.data.error.length > 0);
    else assert.equal(reply.data.error, undefined);
  });
  assert.equal(calls, cases.length);
  f.assertNoSearchWrites();
});

test("HTTP search preserves a legacy array service and passes its cancellation signal", async (t) => {
  let searches = 0;
  const f = await appFixture(t, () => minimalMedia({ search: async (query, signal) => {
    searches++;
    assert.equal(query, TITLE);
    assert.ok(signal instanceof AbortSignal);
    return [{ ...RESOURCE }];
  } }), false);
  const reply = await f.search();
  assert.equal(reply.response.status, 200);
  assert.deepEqual(reply.data, { results: [RESOURCE], diagnostics: { status: "complete", sources: [] } });
  assert.equal(searches, 1);
  f.assertNoSearchWrites();
});

test("HTTP search disconnect cancels its operation and permits later searches after settlement", { timeout: 10_000 }, async (t) => {
  const blocked = blockedSearch();
  let calls = 0;
  const f = await appFixture(t, () => minimalMedia({ searchWithDiagnostics: async (_query, signal) => {
    calls++;
    return calls === 1 ? blocked.run(signal) : complete();
  } }));
  f.releaseOnCleanup(() => blocked.release());
  const client = new AbortController();
  const pending = f.search("disconnect", client.signal);
  const rejection = assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  await bounded(blocked.started, "the disconnected search did not reach its media boundary");
  client.abort();
  await rejection;
  await bounded(blocked.aborted, "HTTP disconnect did not cancel the media operation");
  assert.equal(blocked.signal?.aborted, true);
  blocked.release();
  await bounded(blocked.ended, "the cancelled search did not settle");
  assert.equal((await f.search("after-disconnect")).response.status, 200);
  assert.equal(calls, 2);
  f.assertNoSearchWrites();
});

test("HTTP search caps eight operations, drains close and rejects new work", { timeout: 15_000 }, async (t) => {
  const blocks = Array.from({ length: 9 }, blockedSearch);
  let calls = 0, active = 0, maximum = 0, mediaClosed = false;
  const f = await appFixture(t, (store) => minimalMedia({
    searchWithDiagnostics: async (_query, signal) => {
      const block = blocks[calls++];
      active++;
      maximum = Math.max(maximum, active);
      try { return await block.run(signal); }
      finally { active--; }
    },
    close: async () => {
      assert.equal(active, 0, "media close must follow direct HTTP search settlement");
      assert.deepEqual(store.list("task"), [], "Store remains open until media cleanup finishes");
      mediaClosed = true;
    },
  }));
  for (const block of blocks) f.releaseOnCleanup(() => block.release());
  const pending = Array.from({ length: 8 }, (_, index) => f.search(`blocked-${index}`));
  await bounded(Promise.all(blocks.slice(0, 8).map((block) => block.started)), "eight direct searches did not start");
  const busy = await f.search("over-limit");
  assert.equal(busy.response.status, 429);
  assert.equal(busy.data.code, "search_busy");
  assert.equal(calls, 8);
  blocks[0].release();
  assert.equal((await pending[0]).response.status, 200);
  pending.push(f.search("replacement"));
  await bounded(blocks[8].started, "settled search did not release a slot");
  assert.equal(calls, 9);
  assert.equal(maximum, 8);
  const closing = f.instance.close();
  assert.equal(f.instance.close(), closing);
  let closed = false;
  void closing.then(() => { closed = true; });
  await bounded(Promise.all(blocks.slice(1).map((block) => block.aborted)), "close did not cancel every in-flight search");
  await setImmediate();
  assert.equal(closed, false, "close must drain searches that ignore cancellation until their response arrives");
  assert.equal(mediaClosed, false);
  const afterClose = await f.search("after-close");
  assert.equal(afterClose.response.status, 503);
  assert.equal(calls, 9);
  for (const block of blocks.slice(1)) block.release();
  const [responses] = await Promise.all([Promise.all(pending), closing]);
  for (const reply of responses.slice(1)) {
    assert.equal(reply.response.status, 503);
    assert.equal(reply.data.results, undefined, "late successful results must not become a closed search response");
  }
  assert.equal(active, 0);
  assert.equal(mediaClosed, true);
  await f.restart();
  f.assertNoSearchWrites();
});

test("actual local sources retain diagnostics through HTTP Requests and subscriptions", { timeout: 20_000 }, async (t) => {
  let pansouMode: "success" | "empty" | "failed" = "success";
  let openlistMode: "empty" | "failed" = "failed";
  const credential = "fixture-search-" + randomUUID();
  const privateFailure = "fixture-provider-body-" + randomUUID();
  let sourceReads = 0;
  const successful = createServer((request, response) => {
    assert.equal(request.url, "/api/search");
    sourceReads++;
    request.resume();
    response.setHeader("Content-Type", "application/json");
    if (pansouMode === "failed") { response.writeHead(500).end(JSON.stringify({ error: privateFailure })); return; }
    response.end(JSON.stringify({ merged_by_type: { others: pansouMode === "empty" ? [] : [{
      url: `${successOrigin}/video/fixture.mp4`, note: RESOURCE.title, source: "isolated PanSou fixture",
    }] } }));
  });
  const failing = createServer((request, response) => {
    assert.equal(request.url, "/api/fs/search");
    assert.equal(request.headers.authorization, credential);
    sourceReads++;
    request.resume();
    response.setHeader("Content-Type", "application/json");
    if (openlistMode === "failed") response.writeHead(500).end(JSON.stringify({ message: privateFailure + credential }));
    else response.end(JSON.stringify({ code: 200, data: { content: [] } }));
  });
  const successOrigin = await listen(successful), failureOrigin = await listen(failing);
  t.after(async () => { await closeServer(successful); await closeServer(failing); });
  const f = await appFixture(t, (store) => ({
    ...createMediaService(() => store.config()),
    identify: async () => [{ ...MEDIA }],
  }));
  await f.api("/api/config", "PUT", { sources: {
    pansouUrl: successOrigin, openlistUrl: failureOrigin, openlistToken: credential,
  } });
  const assertReport = (value: SearchReport, status: SearchReport["diagnostics"]["status"]) => {
    assert.equal(value.diagnostics.status, status);
    const bySource = new Map(value.diagnostics.sources.map((source) => [source.source, source]));
    assert.ok(bySource.has("pansou") && bySource.has("openlist"));
    assert.equal(new Set(value.diagnostics.sources.map((source) => source.id)).size, value.diagnostics.sources.length);
    assert.equal(bySource.get("openlist")?.status, openlistMode === "failed" ? "failed" : "empty");
    assert.equal(bySource.get("pansou")?.status, pansouMode === "success" ? "success" : pansouMode === "empty" ? "empty" : "failed");
    assert.equal(bySource.get("pansou")?.resultCount, pansouMode === "success" ? 1 : 0);
    assert.ok(value.diagnostics.sources.every((source) => source.id.length > 0 && source.name.length > 0));
    const serialized = JSON.stringify(value);
    assert.ok(!serialized.includes(credential));
    assert.ok(!serialized.includes(privateFailure));
  };
  const partial = await f.search();
  assert.equal(partial.response.status, 200);
  assertReport(partial.data, "partial");
  assert.equal(partial.data.results.length, 1);
  assert.equal(partial.data.results[0].url, `${successOrigin}/video/fixture.mp4`);
  const select = async (request: MediaRequest) => (await f.api(`/api/requests/${request.id}/select`, "POST", {
    expectedRevision: request.revision, season: 1, episode: 1,
  })).data.request as MediaRequest;
  const begin = async (intent: "search" | "subscribe") => {
    const request = (await f.api("/api/requests", "POST", { query: `${TITLE} 2026`, intent })).data.request as MediaRequest;
    assert.equal(request.stage, "details");
    return select(request);
  };
  const request = await begin("search");
  assert.equal(request.stage, "resource");
  assert.equal(request.resources.length, 1);
  assert.equal(request.resources[0].url, `${successOrigin}/video/fixture.mp4`);
  assert.ok(request.searchDiagnostics);
  assertReport({ results: request.resources, diagnostics: request.searchDiagnostics }, "partial");
  const saved = (await f.api(`/api/requests/${request.id}`)).data.request as MediaRequest;
  assert.deepEqual(saved.searchDiagnostics, request.searchDiagnostics);
  const subscribed = await begin("subscribe");
  assert.ok(subscribed.subscriptionId);
  await f.api(`/api/subscriptions/${subscribed.subscriptionId}`, "PATCH", { autoDownload: false });
  const check = async () => (await f.api(`/api/subscriptions/${subscribed.subscriptionId}/check`, "POST")).data.subscription as Subscription;
  const checked = await check();
  assert.ok(checked.searchDiagnostics);
  assertReport({ results: [], diagnostics: checked.searchDiagnostics }, "partial");
  assert.equal(f.instance.queue.tasks().length, 0);

  pansouMode = "empty";
  const partialEmpty = await f.search();
  assert.equal(partialEmpty.response.status, 200);
  assert.equal(partialEmpty.data.results.length, 0);
  assertReport(partialEmpty.data, "partial");
  pansouMode = "success"; openlistMode = "empty";
  const successfulReport = await f.search();
  assert.equal(successfulReport.response.status, 200);
  assert.equal(successfulReport.data.results.length, 1);
  assertReport(successfulReport.data, "complete");
  pansouMode = "empty"; openlistMode = "empty";
  const empty = await f.search();
  assert.equal(empty.response.status, 200);
  assert.equal(empty.data.results.length, 0);
  assertReport(empty.data, "complete");
  const emptySubscription = await check();
  assert.ok(emptySubscription.searchDiagnostics);
  assertReport({ results: [], diagnostics: emptySubscription.searchDiagnostics }, "complete");

  pansouMode = "failed"; openlistMode = "failed";
  const failed = await f.search();
  assert.equal(failed.response.status, 502);
  assert.equal(failed.data.code, "search_failed");
  assert.equal(failed.data.results.length, 0);
  assertReport(failed.data, "failed");
  const failedRequest = await begin("search");
  assert.ok(failedRequest.searchDiagnostics);
  assertReport({ results: failedRequest.resources, diagnostics: failedRequest.searchDiagnostics }, "failed");
  const seenBefore = emptySubscription.seen;
  const failedSubscription = await check();
  assert.ok(failedSubscription.searchDiagnostics);
  assertReport({ results: [], diagnostics: failedSubscription.searchDiagnostics }, "failed");
  assert.ok(failedSubscription.lastError);
  assert.deepEqual(failedSubscription.seen, seenBefore, "failed sources must not consume subscription results");
  assert.equal(f.instance.queue.tasks().length, 0);
  assert.ok(sourceReads >= 12);
  const reads = sourceReads;
  await f.api("/api/config", "PUT", { sources: { pansouUrl: "", openlistUrl: "" } });
  const notConfigured = await f.search();
  assert.equal(notConfigured.response.status, 409);
  assert.equal(notConfigured.data.code, "search_not_configured");
  assert.deepEqual(notConfigured.data.results, []);
  assert.equal(notConfigured.data.diagnostics.status, "not_configured");
  assert.equal(sourceReads, reads, "unconfigured search must not dispatch to an old source address");
});
