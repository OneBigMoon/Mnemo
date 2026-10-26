import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runAgent } from "../server/agent.js";
import { Queue } from "../server/queue.js";
import { Requests } from "../server/requests.js";
import { Store } from "../server/store.js";
import { searchDiagnosticSummary } from "../shared/search.js";
import type { AgentDeps, MediaInfo, MediaService, SearchDiagnostics, SearchReport, SearchResult, Subscription } from "../shared/types.js";

const movie: MediaInfo = { type: "movie", title: "Dune", year: 2021 };
const series: MediaInfo = { type: "tv", title: "The Last of Us", year: 2023, season: 1 };
const resource = (id = "one", title = "Dune 2021 1080p.mp4"): SearchResult => ({ id, title, url: `https://fixture.invalid/${id}.mp4`, kind: "direct", source: "fixture" });
const shareReference = `mori-share:${"c".repeat(64)}`;
const shareResource = (): SearchResult => ({ id: "share-one", title: "Dune 2021 share", url: shareReference, kind: "share", source: "fixture", shareRef: shareReference });
function report(status: SearchDiagnostics["status"], results: SearchResult[] = []): SearchReport {
  return {
    results,
    diagnostics: {
      status,
      sources: status === "not_configured" ? [
        { id: "pansou", source: "pansou", name: "PanSou", status: "not_configured", resultCount: 0 },
      ] : [
        { id: "pansou", source: "pansou", name: "PanSou", status: status === "failed" ? "failed" : results.length ? "success" : "empty", resultCount: results.length, ...(status === "failed" ? { code: "timeout" as const } : {}) },
        { id: "openlist", source: "openlist", name: "OpenList", status: status === "partial" || status === "failed" ? "failed" : "empty", resultCount: 0, ...(status === "partial" || status === "failed" ? { code: "unreachable" as const } : {}) },
      ],
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(t: TestContext, initial: SearchReport) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mori-search-consumers-"));
  const state = {
    report: initial, detailedCalls: 0, legacyCalls: 0,
    store: new Store(directory, path.join(directory, "files")),
    queue: undefined as unknown as Queue, requests: undefined as unknown as Requests,
    media: undefined as unknown as MediaService,
  };
  state.media = {
    identify: async () => [movie],
    search: async () => { state.legacyCalls++; return structuredClone(state.report.results); },
    searchWithDiagnostics: async () => { state.detailedCalls++; return structuredClone(state.report); },
    download: async (task, signal) => {
      signal.throwIfAborted();
      const file = path.join(directory, `${task.id}.mp4`);
      writeFileSync(file, "isolated fixture bytes");
      return file;
    },
    scrape: async () => ({ files: [], warnings: [] }),
    testConnection: async () => ({ ok: true, message: "fixture" }),
  };
  const attach = () => {
    state.queue = new Queue(state.store, state.media);
    state.requests = new Requests(state.store, state.media, {
      addTask: (input) => state.queue.add(input),
      subscribe: (query, media, startEpisode) => state.queue.subscribe(query, true, media, startEpisode),
      subscribeDirectory: (input) => state.queue.subscribeDirectory(input),
    });
  };
  attach();
  t.after(async () => {
    await state.requests.close();
    await state.queue.stop();
    state.store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    state,
    restart: async () => {
      await state.requests.close(); await state.queue.stop(); state.store.close();
      state.store = new Store(directory, path.join(directory, "files"));
      attach();
    },
  };
}
function legacyDeps(state: ReturnType<typeof fixture>["state"]): AgentDeps {
  return {
    config: () => state.store.config(), search: (query) => state.media.search(query),
    tasks: () => state.queue.tasks(), addTask: (input) => state.queue.add(input),
    subscribe: (query) => state.queue.subscribe(query),
  };
}

test("Requests persists partial diagnostics across restart and keeps warnings after explicit and automatic admissions", async (t) => {
  const partial = report("partial", [resource("one"), resource("two", "Dune 2021 2160p.mp4")]);
  const f = fixture(t, partial);
  let request = await f.state.requests.begin("web:fixture", "Dune", "search");
  const summary = searchDiagnosticSummary(partial.diagnostics);
  assert.equal(request.stage, "resource");
  assert.deepEqual(request.searchDiagnostics, partial.diagnostics);
  assert.match(request.message, /OpenList/u);
  assert.equal(request.resources.length, 2);
  assert.equal(f.state.queue.tasks().length, 0);
  const ids = request.resources.map((item) => item.id);
  await f.restart();
  request = f.state.requests.get("web:fixture", request.id);
  assert.deepEqual(request.searchDiagnostics, partial.diagnostics);
  assert.deepEqual(request.resources.map((item) => item.id), ids);
  request = await f.state.requests.select("web:fixture", request.id, { expectedRevision: request.revision, resourceId: ids[0] });
  assert.equal(request.stage, "completed");
  assert.ok(request.message.includes(summary));
  assert.equal(request.searchDiagnostics?.status, "partial");
  assert.equal(f.state.queue.tasks().length, 1);
  f.state.report = report("partial", [resource("three")]);
  const automatic = await f.state.requests.begin("web:fixture", "Dune", "download");
  assert.equal(automatic.stage, "completed");
  assert.match(automatic.message, /部分来源/u);
  assert.equal(automatic.searchDiagnostics?.status, "partial");
});

test("partial empty, failed and unconfigured requests never claim resources are absent, and a full new search clears the warning", async (t) => {
  for (const status of ["partial", "failed", "not_configured"] as const) {
    const current = report(status);
    const { state } = fixture(t, current);
    const request = await state.requests.begin("web:fixture", "Dune", "download");
    assert.equal(request.stage, status === "partial" ? "resource" : "failed");
    assert.deepEqual(request.searchDiagnostics, current.diagnostics);
    assert.ok(request.message.includes(searchDiagnosticSummary(current.diagnostics)));
    assert.doesNotMatch(request.message, /没有找到|没有资源/u);
    assert.equal(state.queue.tasks().length, 0);
    state.report = report("complete");
    const recovered = await state.requests.begin("web:fixture", "Dune", "search");
    assert.equal(recovered.stage, "resource");
    assert.equal(recovered.searchDiagnostics?.status, "complete");
    assert.match(recovered.message, /没有找到/u);
    assert.doesNotMatch(recovered.message, /OpenList|尚未配置|部分来源/u);
  }
});

test("aggregate subscriptions admit good partial results once and preserve source failures until a full recovery", async (t) => {
  const good = resource("episode-one", "The Last of Us 2023 S01E01 1080p.mp4");
  const { state } = fixture(t, report("partial", [good]));
  const subscription = state.queue.subscribe("The Last of Us", true, series);
  let checked = (await state.queue.check(subscription.id))!;
  assert.equal(state.queue.tasks().length, 1);
  const taskId = state.queue.tasks()[0].id;
  assert.equal(state.queue.tasks()[0].media.episode, 1);
  assert.equal(checked.searchDiagnostics?.status, "partial");
  assert.match(checked.lastError!, /OpenList/u);
  assert.match(checked.lastSummary!, /新增 1 个下载任务.*部分来源/u);
  assert.deepEqual(checked.seen, [good.id]);
  state.report = report("failed");
  checked = (await state.queue.check(subscription.id))!;
  assert.equal(checked.searchDiagnostics?.status, "failed");
  assert.match(checked.lastError!, /本次搜索未完成/u);
  assert.deepEqual(checked.seen, [good.id]);
  assert.equal(state.queue.tasks().length, 1);
  state.report = report("partial");
  checked = (await state.queue.check(subscription.id))!;
  assert.doesNotMatch(checked.lastSummary!, /找到 0|没有找到/u);
  assert.match(checked.lastSummary!, /部分来源/u);
  state.report = report("complete", [good]);
  checked = (await state.queue.check(subscription.id))!;
  assert.equal(checked.lastError, undefined);
  assert.equal(checked.searchDiagnostics?.status, "complete");
  assert.doesNotMatch(checked.lastSummary!, /OpenList|部分来源/u);
  assert.deepEqual(state.queue.tasks().map((task) => task.id), [taskId]);
});

test("unconfigured aggregate searches record a diagnostic error without consuming seen resources", async (t) => {
  const { state } = fixture(t, report("not_configured"));
  const subscription = state.queue.subscribe("Dune", false, movie);
  let checked = (await state.queue.check(subscription.id))!;
  assert.equal(checked.searchDiagnostics?.status, "not_configured");
  assert.match(checked.lastError!, /尚未配置片名搜索源/u);
  assert.deepEqual(checked.seen, []);
  state.report = report("complete");
  checked = (await state.queue.check(subscription.id))!;
  assert.equal(checked.lastError, undefined);
  assert.match(checked.lastSummary!, /找到 0 个新结果/u);
});

test("legacy array stubs preserve search behavior without requiring detailed interfaces", async (t) => {
  const { state } = fixture(t, report("complete", [resource()]));
  delete state.media.searchWithDiagnostics;
  const request = await state.requests.begin("web:fixture", "Dune", "search");
  assert.equal(request.stage, "resource");
  assert.equal(request.resources.length, 1);
  assert.doesNotMatch(request.message, /来源.*失败|未完成/u);
  const subscription = state.queue.subscribe("Dune", false, movie);
  assert.equal((await state.queue.check(subscription.id))?.lastError, undefined);
  const reply = await runAgent("搜索 Dune", legacyDeps(state));
  assert.match(reply.text, /找到 1 项/u);
  assert.equal(reply.searchDiagnostics, undefined);
  assert.equal(state.legacyCalls, 3);
  assert.equal(state.detailedCalls, 0);
});

test("legacy and production assistant text surface source failures and expose diagnostics without duplicate summaries", async (t) => {
  const partial = report("partial", [resource()]);
  const { state } = fixture(t, partial);
  const deps: AgentDeps = { ...legacyDeps(state), searchWithDiagnostics: (query, signal) => state.media.searchWithDiagnostics!(query, signal) };
  let reply = await runAgent("搜索 Dune", deps);
  assert.deepEqual(reply.searchDiagnostics, partial.diagnostics);
  assert.match(reply.text, /OpenList.*无法连接/u);
  assert.equal(reply.results?.length, 1);
  const production: AgentDeps = { ...deps, request: (query, intent, signal) => state.requests.begin("telegram:fixture", query, intent, signal) };
  reply = await runAgent("搜索 Dune", production);
  assert.equal(reply.request?.searchDiagnostics?.status, "partial");
  assert.equal(reply.searchDiagnostics?.status, "partial");
  assert.equal(reply.text.split(searchDiagnosticSummary(partial.diagnostics)).length - 1, 1);
  state.report = report("failed");
  reply = await runAgent("搜索 Dune", deps);
  assert.doesNotMatch(reply.text, /没有找到/u);
  assert.match(reply.text, /暂时无法判断是否有资源/u);
  state.report = report("complete");
  reply = await runAgent("搜索 Dune", deps);
  assert.match(reply.text, /没有找到/u);
  assert.doesNotMatch(reply.text, /OpenList|部分来源/u);
});

test("directory scans clear old aggregate diagnostics and never invoke the aggregate search helper", async (t) => {
  const { state } = fixture(t, report("partial"));
  const reference = `mori-share:${"a".repeat(64)}`;
  state.media.shareDirectory = () => ({ reference, title: "fixture directory" });
  state.media.scanShare = async () => ({ files: [], complete: true });
  const subscription = state.queue.subscribeDirectory({ query: series.title, media: series, reference });
  const stale = report("partial").diagnostics;
  const summary = searchDiagnosticSummary(stale);
  state.store.put("subscription", { ...subscription, searchDiagnostics: stale, lastError: summary, lastSummary: summary });
  let checked = (await state.queue.check(subscription.id))!;
  assert.equal(checked.searchDiagnostics, undefined);
  assert.equal(checked.lastError, undefined);
  assert.doesNotMatch(checked.lastSummary!, /OpenList|部分来源/u);
  state.store.put("subscription", { ...checked, searchDiagnostics: stale, lastError: summary, lastSummary: summary });
  state.media.scanShare = async () => { throw new Error("fixture directory read failure"); };
  checked = (await state.queue.check(subscription.id))!;
  assert.equal(checked.searchDiagnostics, undefined);
  assert.equal(checked.lastError, "fixture directory read failure");
  assert.equal(checked.lastSummary, undefined);
  assert.equal(state.detailedCalls, 0);
  assert.equal(state.legacyCalls, 0);
});

test("cancelled Requests and stopped subscriptions never save late diagnostics or admit returned resources", async (t) => {
  const requestFixture = fixture(t, report("complete"));
  const requestGate = deferred<SearchReport>(), requestEntered = deferred<void>();
  let requestSignal: AbortSignal | undefined;
  requestFixture.state.media.searchWithDiagnostics = async (_query, signal) => { requestSignal = signal; requestEntered.resolve(); return requestGate.promise; };
  const controller = new AbortController();
  const pendingRequest = requestFixture.state.requests.begin("web:fixture", "Dune", "download", controller.signal);
  const rejected = assert.rejects(pendingRequest, { name: "AbortError" });
  await requestEntered.promise;
  const beforeRequest = requestFixture.state.requests.latest("web:fixture")!;
  controller.abort();
  assert.equal(requestSignal?.aborted, true);
  requestGate.resolve(report("partial", [resource()]));
  await rejected;
  assert.deepEqual(requestFixture.state.requests.get("web:fixture", beforeRequest.id), beforeRequest);
  assert.equal(requestFixture.state.queue.tasks().length, 0);

  const subscriptionFixture = fixture(t, report("complete"));
  const subscriptionGate = deferred<SearchReport>(), subscriptionEntered = deferred<void>();
  let subscriptionSignal: AbortSignal | undefined;
  subscriptionFixture.state.media.searchWithDiagnostics = async (_query, signal) => { subscriptionSignal = signal; subscriptionEntered.resolve(); return subscriptionGate.promise; };
  const subscription = subscriptionFixture.state.queue.subscribe("Dune", true, movie);
  const pendingCheck = subscriptionFixture.state.queue.check(subscription.id);
  await subscriptionEntered.promise;
  const beforeSubscription = subscriptionFixture.state.store.record<Subscription>("subscription", subscription.id)!;
  const stopped = subscriptionFixture.state.queue.stop();
  assert.equal(subscriptionSignal?.aborted, true);
  subscriptionGate.resolve(report("partial", [resource()]));
  await Promise.all([pendingCheck, stopped]);
  assert.deepEqual(subscriptionFixture.state.store.record("subscription", subscription.id), beforeSubscription);
  assert.equal(subscriptionFixture.state.queue.tasks().length, 0);
});

test("failed share browsing keeps the aggregate warning while successful browsing and directory subscription drop it", async (t) => {
  const partial = report("partial", [shareResource()]);
  const { state } = fixture(t, partial);
  const summary = searchDiagnosticSummary(partial.diagnostics);
  state.media.shareDirectory = () => ({ reference: shareReference, title: "Dune share directory" });
  state.media.scanShare = async () => ({ files: [], complete: true });
  state.media.browseShare = async () => { throw new Error("fixture browse failure"); };
  let request = await state.requests.begin("web:fixture", "Dune", "search");
  assert.equal(request.stage, "resource");
  assert.equal(request.resources.length, 1);
  assert.equal(request.searchDiagnostics?.status, "partial");
  request = await state.requests.select("web:fixture", request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id });
  assert.equal(request.stage, "resource");
  assert.equal(request.searchDiagnostics?.status, "partial");
  assert.ok(request.message.includes(summary));
  assert.match(request.message, /暂无法浏览/u);
  assert.equal(request.resources.length, 1);
  assert.equal(state.queue.tasks().length, 0);
  state.media.browseShare = async () => [resource("inside", "Dune 2021 1080p.mp4")];
  request = await state.requests.select("web:fixture", request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id });
  assert.equal(request.stage, "resource");
  assert.ok(request.shareDirectory);
  assert.equal(request.searchDiagnostics, undefined);
  assert.deepEqual(request.resources.map((item) => item.title), ["Dune 2021 1080p.mp4"]);
  assert.doesNotMatch(request.message, /部分来源|OpenList|结果不完整/u);
  state.store.put("request", { ...request, searchDiagnostics: partial.diagnostics });
  request = await state.requests.select("web:fixture", request.id, { expectedRevision: request.revision, subscribeDirectory: true });
  assert.equal(request.stage, "completed");
  assert.ok(request.subscriptionId);
  assert.equal(request.searchDiagnostics, undefined);
  assert.doesNotMatch(request.message, /部分来源|OpenList|结果不完整/u);
});

test("aggregate exceptions clear stale source diagnostics without touching committed state while explicit failures persist", async (t) => {
  const good = resource("episode-one", "The Last of Us 2023 S01E01 1080p.mp4");
  const { state } = fixture(t, report("partial", [good]));
  const subscription = state.queue.subscribe("The Last of Us", true, series);
  let checked = (await state.queue.check(subscription.id))!;
  assert.equal(checked.searchDiagnostics?.status, "partial");
  const taskId = state.queue.tasks()[0].id;
  assert.deepEqual(checked.seen, [good.id]);
  state.media.searchWithDiagnostics = async () => { throw new Error("fixture aggregate failure"); };
  checked = (await state.queue.check(subscription.id))!;
  assert.equal(checked.searchDiagnostics, undefined);
  assert.equal(checked.lastError, "fixture aggregate failure");
  assert.deepEqual(checked.seen, [good.id]);
  assert.deepEqual(state.queue.tasks().map((task) => task.id), [taskId]);
  state.media.searchWithDiagnostics = async () => structuredClone(state.report);
  state.report = report("failed");
  checked = (await state.queue.check(subscription.id))!;
  assert.equal(checked.searchDiagnostics?.status, "failed");
  assert.match(checked.lastError!, /本次搜索未完成/u);
  assert.deepEqual(checked.seen, [good.id]);
  state.report = report("not_configured");
  checked = (await state.queue.check(subscription.id))!;
  assert.equal(checked.searchDiagnostics?.status, "not_configured");
  assert.match(checked.lastError!, /尚未配置/u);
  assert.deepEqual(checked.seen, [good.id]);
  assert.deepEqual(state.queue.tasks().map((task) => task.id), [taskId]);
});

test("a stopped aggregate check that throws late leaves the recorded subscription untouched", async (t) => {
  const { state } = fixture(t, report("complete"));
  const entered = deferred<void>();
  state.media.searchWithDiagnostics = async (_query, signal) => {
    entered.resolve();
    await new Promise<void>((resolve) => {
      if (!signal || signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("fixture late failure");
  };
  const subscription = state.queue.subscribe("Dune", true, movie);
  const pending = state.queue.check(subscription.id);
  await entered.promise;
  const summary = searchDiagnosticSummary(report("partial").diagnostics);
  const seeded = {
    ...state.store.record<Subscription>("subscription", subscription.id)!,
    searchDiagnostics: report("partial").diagnostics,
    lastError: summary,
    lastSummary: summary,
  };
  state.store.put("subscription", seeded);
  const stopped = state.queue.stop();
  await pending;
  await stopped;
  assert.deepEqual(state.store.record("subscription", subscription.id), seeded);
  assert.equal(state.queue.tasks().length, 0);
});
