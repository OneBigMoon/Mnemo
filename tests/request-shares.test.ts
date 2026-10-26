import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runAgent } from "../server/agent.js";
import { Requests } from "../server/requests.js";
import { Store } from "../server/store.js";
import type { AgentDeps, DownloadTask, MediaInfo, MediaService, SearchResult, ShareSubscriptionInput, Subscription } from "../shared/types.js";

const ROOT = `mori-share:${"a".repeat(64)}`;
const CHILD = `mori-share:${"b".repeat(64)}`;
const NEXT = `mori-share:${"c".repeat(64)}`;
const FILE = `mori-share:${"d".repeat(64)}`;
const movie: MediaInfo = { type: "movie", title: "Dune", year: 2021 };
function share(): SearchResult {
  return { id: "provider-share", title: "Dune 2021 1080p", url: "https://115.com/s/fixture", kind: "share", source: "fixture", shareRef: ROOT };
}
function navigation(reference: string, title: string, direction: "folder" | "parent" | "next"): SearchResult {
  return { id: reference, title, url: reference, kind: "share", source: "fixture", shareRef: reference, navigation: direction };
}
function file(reference = FILE, title = "Dune 2021 1080p.mkv"): SearchResult {
  return { id: reference, title, url: reference, shareRef: reference, kind: "cloud", source: "fixture", size: "2 GB" };
}
function fixture(t: TestContext, service: Pick<MediaService, "identify" | "search" | "browseShare" | "shareDirectory">) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mori-request-shares-"));
  const store = new Store(directory, path.join(directory, "files"));
  let taskCalls = 0, subscriptionCalls = 0;
  const directoryCalls: { input: ShareSubscriptionInput; owner: string }[] = [];
  const actions = {
    addTask(input: Parameters<AgentDeps["addTask"]>[0]): DownloadTask {
      taskCalls++;
      const now = new Date().toISOString();
      const task: DownloadTask = { id: randomUUID(), title: input.title, url: input.url, kind: input.kind || "direct", media: input.media!, profile: "emby", status: input.kind === "share" ? "needs_attention" : "queued", progress: 0, bytes: 0, total: 0, createdAt: now, updatedAt: now };
      store.put("task", task);
      return task;
    },
    subscribe(query: string, media: MediaInfo, startEpisode?: number): Subscription {
      subscriptionCalls++;
      const row: Subscription = { id: randomUUID(), query, title: media.title, media, startEpisode, enabled: true, autoDownload: true, seen: [], createdAt: new Date().toISOString() };
      store.put("subscription", row);
      return row;
    },
    subscribeDirectory(input: ShareSubscriptionInput, owner: string): Subscription {
      directoryCalls.push({ input: structuredClone(input), owner });
      const row: Subscription = { id: randomUUID(), query: input.query, title: input.media.title, media: input.media, startEpisode: input.startEpisode, share: service.shareDirectory?.(input.reference) ?? { reference: input.reference, title: "fixture directory" }, enabled: true, autoDownload: true, seen: [], createdAt: new Date().toISOString() };
      store.put("subscription", row);
      return row;
    },
  };
  const open = () => new Requests(store, service, actions);
  const requests = open();
  const owner = "web:fixture";
  const deps: AgentDeps = {
    config: () => store.config(), search: service.search, tasks: () => store.list("task"), addTask: actions.addTask,
    subscribe: () => { throw new Error("legacy subscription bypass"); },
    request: (query, intent, signal) => requests.begin(owner, query, intent, signal),
    selectRequest: (id, choice, signal) => requests.select(owner, id, choice, signal),
    getRequest: (id) => requests.get(owner, id), latestRequest: () => requests.latest(owner),
  };
  t.after(async () => { await requests.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, service, requests, open, owner, deps, actions, directoryCalls, tasks: () => taskCalls, subscriptions: () => subscriptionCalls };
}
function scopedDeps(f: ReturnType<typeof fixture>, owner: string): AgentDeps {
  return {
    ...f.deps,
    request: (query, intent, signal) => f.requests.begin(owner, query, intent, signal),
    selectRequest: (id, choice, signal) => f.requests.select(owner, id, choice, signal),
    getRequest: (id) => f.requests.get(owner, id),
    latestRequest: () => f.requests.latest(owner),
  };
}
function directory(reference: string) {
  if (reference === FILE) throw new Error("fixture file is not a directory");
  return { reference: reference === NEXT ? CHILD : reference, title: reference === ROOT ? "分享根目录" : "第一季目录" };
}

test("share pages retain folder, parent and next choices, and text commands can select all 22 rows", async (t) => {
  const calls: string[] = [];
  const page = [
    ...Array.from({ length: 20 }, (_, index) => file(`mori-share:${(index + 1).toString(16).padStart(64, "0")}`, `Dune 2021 1080p ${"long-name-".repeat(20)}${index}.mkv`)),
    navigation(CHILD, "上级目录", "parent"), navigation(NEXT, "下一页", "next"),
  ];
  const f = fixture(t, { identify: async () => [movie], search: async () => [share()], browseShare: async (reference) => { calls.push(reference); return reference === ROOT ? page : [file()]; } });
  let reply = await runAgent("搜索 Dune", f.deps);
  assert.equal(calls.length, 0);
  assert.match(reply.text, /\[分享\]/u);
  const id = reply.request!.id;
  reply = await runAgent(`资源 ${id} 1`, f.deps);
  assert.equal(reply.request?.resources.length, 22);
  assert.match(reply.text, /21\. \[返回上级\]/u);
  assert.match(reply.text, /22\. \[下一页\]/u);
  assert.ok(reply.text.length < 4000);
  assert.equal(f.tasks(), 0);
  const wrongStage = await runAgent(`选择 ${id} 22`, f.deps);
  assert.match(wrongStage.text, /旧的作品选择指令/u);
  assert.deepEqual(calls, [ROOT]);
  reply = await runAgent(`资源 ${id} 22`, f.deps);
  assert.deepEqual(calls, [ROOT, NEXT]);
  assert.match(reply.text, /\[文件\]/u);
  assert.equal(reply.request?.stage, "resource");
  assert.equal(f.tasks(), 0);
});

test("extraction codes are transient browsing input and never appear in public requests or completion receipts", async (t) => {
  const code = "Q7z9";
  let f: ReturnType<typeof fixture>;
  f = fixture(t, {
    identify: async () => [movie],
    search: async () => [{ ...share(), url: `https://115.com/s/fixture?password=${code}`, extractionCode: code }],
    browseShare: async (reference, supplied) => {
      assert.equal(reference, ROOT);
      assert.equal(supplied, code);
      f.store.putPrivate("fixture-share-code", ROOT, { code: supplied }, new Date(Date.now() + 60_000).toISOString());
      return [file()];
    },
  });
  let request = await f.requests.begin(f.owner, "Dune", "search");
  assert.equal(request.resources[0].url, ROOT);
  assert.equal("extractionCode" in request.resources[0], false);
  request = await f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id, extractionCode: code });
  assert.equal(request.stage, "resource");
  assert.equal(f.tasks(), 0);
  assert.equal(f.store.privateRecord<{ code: string }>("fixture-share-code", ROOT)?.code, code);
  await assert.rejects(f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id, extractionCode: code }), /提取码只能用于分享浏览/u);
  request = await f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id });
  assert.equal(request.stage, "completed");
  const persisted = JSON.stringify(f.store.list("request"));
  assert.equal(JSON.stringify(request).includes(code), false);
  assert.equal(persisted.includes(code), false);
  assert.equal(persisted.includes("extractionCode"), false);
  for (const filename of ["mori.sqlite", "mori.sqlite-wal"]) {
    const location = path.join(f.directory, filename);
    if (existsSync(location)) assert.equal(readFileSync(location).includes(Buffer.from(code)), false);
  }
});

test("download expands a unique matching share only once and folders remain read-only even with one file", async (t) => {
  const calls: string[] = [];
  const f = fixture(t, { identify: async () => [movie], search: async () => [share()], browseShare: async (reference) => { calls.push(reference); return reference === ROOT ? [navigation(CHILD, "电影目录", "folder")] : [file()]; } });
  let request = await f.requests.begin(f.owner, "Dune", "download");
  assert.deepEqual(calls, [ROOT]);
  assert.equal(request.resources[0].navigation, "folder");
  assert.equal(f.tasks(), 0);
  request = await f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id });
  assert.deepEqual(calls, [ROOT, CHILD]);
  assert.equal(request.resources.length, 1);
  assert.equal(request.stage, "resource");
  assert.equal(f.tasks(), 0);
  request = await f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id });
  assert.equal(request.stage, "completed");
  assert.equal(f.store.list<DownloadTask>("task")[0].kind, "cloud");
  const auto = fixture(t, { identify: async () => [movie], search: async () => [share()], browseShare: async () => [file()] });
  assert.equal((await auto.requests.begin(auto.owner, "Dune", "download")).stage, "completed");
  assert.equal(auto.tasks(), 1);
});

test("parent navigation uses only persisted server choices and cloud files retain media matching", async (t) => {
  const calls: string[] = [];
  const f = fixture(t, { identify: async () => [movie], search: async () => [share()], browseShare: async (reference) => {
    calls.push(reference);
    return reference === ROOT ? [navigation(CHILD, "目录", "folder")] : [navigation(ROOT, "返回", "parent"), file(FILE, "Dune 1984 1080p.mkv"), file(NEXT, "Dune 1080p.mkv")];
  } });
  let request = await f.requests.begin(f.owner, "Dune", "search");
  request = await f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id });
  request = await f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id });
  assert.equal(request.resources[1].match, "mismatch");
  assert.equal(request.resources[2].match, "uncertain");
  await assert.rejects(f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[1].id, confirmUncertain: true }), /不匹配/u);
  await assert.rejects(f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[2].id }), /不确定/u);
  const prior = request;
  request = await f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id });
  assert.deepEqual(calls, [ROOT, CHILD, ROOT]);
  assert.equal(f.tasks(), 0);
  await assert.rejects(f.requests.select(f.owner, request.id, { expectedRevision: prior.revision, resourceId: prior.resources[0].id }), (error: any) => error.status === 409);
  request = await f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id });
  request = await f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[2].id, confirmUncertain: true });
  assert.equal(request.stage, "completed");
  assert.equal(f.tasks(), 1);
});

test("malformed or replaced opaque cloud references never enter resource choices", async (t) => {
  const f = fixture(t, { identify: async () => [movie], search: async () => [
    { ...file(), url: "mori-share:short" },
    { ...file(), url: "https://fixture.invalid/forged.mp4" },
    { ...file(), shareRef: ROOT },
    { ...file(), shareRef: undefined },
    { ...navigation(CHILD, "wrong-link", "folder"), url: ROOT },
    file(),
  ] });
  const request = await f.requests.begin(f.owner, "Dune", "search");
  assert.equal(request.resources.length, 1);
  assert.equal(request.resources[0].url, FILE);
  assert.equal(request.resources[0].shareRef, FILE);
  assert.notEqual(request.resources[0].id, FILE);
});

test("share browsing rechecks owner, revision, concurrent updates and cancellation", async (t) => {
  let release!: (value: SearchResult[]) => void;
  let calls = 0;
  const gate = new Promise<SearchResult[]>((resolve) => { release = resolve; });
  const f = fixture(t, { identify: async () => [movie], search: async () => [share()], browseShare: async () => { calls++; return gate; } });
  const request = await f.requests.begin(f.owner, "Dune", "search");
  const choice = { expectedRevision: request.revision, resourceId: request.resources[0].id };
  await assert.rejects(f.requests.select("other-owner", request.id, choice), /无权|不存在/u);
  await assert.rejects(f.requests.select(f.owner, request.id, { ...choice, expectedRevision: request.revision - 1 }), (error: any) => error.status === 409);
  assert.equal(calls, 0);
  const one = f.requests.select(f.owner, request.id, choice);
  const two = f.open().select(f.owner, request.id, choice);
  release([navigation(CHILD, "目录", "folder")]);
  const results = await Promise.allSettled([one, two]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.status === 409).length, 1);
  let releaseCancelled!: (value: SearchResult[]) => void;
  const cancelledGate = new Promise<SearchResult[]>((resolve) => { releaseCancelled = resolve; });
  let browseSignal: AbortSignal | undefined;
  f.service.browseShare = async (_reference, _code, signal) => { browseSignal = signal; return cancelledGate; };
  const before = f.requests.get(f.owner, request.id);
  const controller = new AbortController();
  const pending = f.requests.select(f.owner, request.id, { expectedRevision: before.revision, resourceId: before.resources[0].id }, controller.signal);
  controller.abort();
  assert.equal(browseSignal?.aborted, true);
  releaseCancelled([file()]);
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(f.requests.get(f.owner, request.id), before);
  assert.equal(f.tasks(), 0);
});

test("disabled or missing share browsing preserves a retryable view and legacy unresolved shares stay honest", async (t) => {
  for (const browseShare of [undefined, async () => { throw new Error("fixture disabled"); }]) {
    const f = fixture(t, { identify: async () => [movie], search: async () => [share()], browseShare });
    let request = await f.requests.begin(f.owner, "Dune", "download");
    assert.equal(request.stage, "resource");
    assert.match(request.message, /启用115分享解析/u);
    assert.equal(request.resources[0].shareRef, ROOT);
    assert.equal(f.tasks(), 0);
    f.service.browseShare = async () => [file()];
    request = await f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id });
    assert.equal(request.stage, "resource");
    assert.equal(request.resources[0].kind, "cloud");
    assert.equal(f.tasks(), 0);
  }
  const legacy = fixture(t, { identify: async () => [movie], search: async () => [{ ...share(), shareRef: undefined }] });
  let request = await legacy.requests.begin(legacy.owner, "Dune", "download");
  assert.match(request.message, /尚未解析/u);
  request = await legacy.requests.select(legacy.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id });
  assert.match(request.message, /待处理/u);
  assert.equal(legacy.store.list<DownloadTask>("task")[0].status, "needs_attention");
});

test("aggregate subscriptions remain separate from explicit share-directory subscriptions", async (t) => {
  let calls = 0;
  const f = fixture(t, { identify: async () => [movie], search: async () => [share()], browseShare: async () => { calls++; return [file()]; } });
  const request = await f.requests.begin(f.owner, "Dune", "subscribe");
  assert.equal(request.stage, "completed");
  assert.match(request.message, /按作品聚合/u);
  assert.match(request.message, /分享目录需先浏览/u);
  assert.equal(f.subscriptions(), 1);
  assert.equal(f.tasks(), 0);
  assert.equal(calls, 0);
});

test("text-channel extraction commands stay owner-bound, private and outside the model", async (t) => {
  const code = "N4s8";
  const calls: { reference: string; code?: string }[] = [];
  let f: ReturnType<typeof fixture>;
  f = fixture(t, {
    identify: async () => [movie], search: async () => [share()],
    browseShare: async (reference, supplied) => {
      calls.push({ reference, code: supplied });
      f.store.putPrivate("fixture-channel-code", ROOT, { code: supplied }, new Date(Date.now() + 60_000).toISOString());
      return reference === ROOT ? [navigation(CHILD, "电影目录", "folder")] : [file()];
    },
  });
  const config = f.store.config();
  config.model.baseUrl = "https://model.invalid/v1";
  config.model.model = "fixture-model";
  f.store.setConfig(config);
  const previousFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async () => { modelCalls++; throw new Error("model must not receive extraction commands"); };
  t.after(() => { globalThis.fetch = previousFetch; });
  const owner = "telegram:code-fixture";
  const deps = scopedDeps(f, owner);
  let reply = await runAgent("搜索 Dune", deps);
  assert.match(reply.text, /提取码 <4位字母数字>/u);
  const id = reply.request!.id;
  reply = await runAgent(`资源 ${id} 1 提取码 ${code}`, deps);
  assert.deepEqual(calls, [{ reference: ROOT, code }]);
  assert.equal(reply.request?.stage, "resource");
  assert.equal(f.store.privateRecord<{ code: string }>("fixture-channel-code", ROOT)?.code, code);
  assert.equal(JSON.stringify(reply).includes(code), false);
  assert.equal(JSON.stringify(f.store.list("request")).includes(code), false);
  assert.equal(JSON.stringify(f.store.list("request")).includes("extractionCode"), false);
  const otherOwner = await runAgent(`资源 ${id} 1 code ${code}`, scopedDeps(f, "wechat:other-fixture"));
  assert.match(otherOwner.text, /本会话没有/u);
  assert.equal(JSON.stringify(otherOwner).includes(code), false);
  assert.equal(calls.length, 1);
  for (const command of [
    `资源 ${id} 1 提取码 123`,
    `资源 ${id} 1 code ABCDE`,
    `资源 ${id} 1 code A!2B`,
    `资源 ${id} 1 code １２３４`,
    `资源 ${id} 1 code`,
    `资源 ${id} 1 code ${code} extra`,
    `资源 ${id} 0 code ${code}`,
    `资源 ${id} 23 code ${code}`,
    `选择 ${id} 1 提取码 ${code}`,
    `确认资源 ${id} 1 提取码 ${code}`,
  ]) {
    const invalid = await runAgent(command, deps);
    assert.equal(invalid.request, undefined, command);
    assert.equal(JSON.stringify(invalid).includes(code), false, command);
    assert.equal(calls.length, 1, command);
    assert.equal(modelCalls, 0, command);
  }
  reply = await runAgent(`资源 ${id} 1 CODE ${code}`, deps);
  assert.deepEqual(calls[1], { reference: CHILD, code });
  assert.equal(reply.request?.resources[0].kind, "cloud");
  assert.equal(f.tasks(), 0);
  const fileWithCode = await runAgent(`资源 ${id} 1 提取码 ${code}`, deps);
  assert.match(fileWithCode.text, /文件.*不能附带提取码/u);
  assert.equal(calls.length, 2);
  assert.equal(f.tasks(), 0);
  assert.equal(modelCalls, 0);
  reply = await runAgent(`资源 ${id} 1`, deps);
  assert.equal(reply.request?.stage, "completed");
  assert.equal(f.tasks(), 1);
  assert.equal(JSON.stringify(f.store.list("request")).includes(code), false);
  assert.equal(JSON.stringify(reply).includes(code), false);

  f.service.identify = async () => [movie, { ...movie, year: 1984 }];
  const media = await runAgent("搜索 Dune", deps);
  assert.equal(media.request?.stage, "media");
  const mediaWithCode = await runAgent(`资源 ${media.request!.id} 1 提取码 ${code}`, deps);
  assert.match(mediaWithCode.text, /身份或季集/u);
  assert.equal(calls.length, 2);
  f.service.identify = async () => [{ type: "tv", title: "Dune", year: 2021 }];
  const details = await runAgent("搜索 Dune", deps);
  assert.equal(details.request?.stage, "details");
  const detailsWithCode = await runAgent(`资源 ${details.request!.id} 1 code ${code}`, deps);
  assert.match(detailsWithCode.text, /身份或季集/u);
  assert.equal(calls.length, 2);
  f.service.identify = async () => [movie];
  const pending = await f.requests.begin(owner, "Dune", "search");
  f.store.put("request", { ...f.store.record<any>("request", pending.id), intent: "subscribe" });
  const subscriptionWithCode = await runAgent(`资源 ${pending.id} 1 code ${code}`, deps);
  assert.match(subscriptionWithCode.text, /订阅不能附带提取码/u);
  assert.equal(calls.length, 2);
  assert.equal(f.subscriptions(), 0);
  assert.equal(modelCalls, 0);
});

test("explicit directory subscription binds the successful canonical page and replays one completion receipt", async (t) => {
  const series: MediaInfo = { type: "tv", title: "The Last of Us", year: 2023 };
  const episode = file(FILE, "The Last of Us 2023 S01E05 1080p.mkv");
  const f = fixture(t, {
    identify: async () => [series], search: async () => [{ ...share(), title: "The Last of Us 2023 S01" }],
    browseShare: async (reference) => reference === ROOT ? [navigation(CHILD, "第一季", "folder")] : reference === CHILD ? [episode, navigation(NEXT, "下一页", "next")] : [episode],
    shareDirectory: directory,
  });
  let request = await f.requests.begin(f.owner, "The Last of Us S01E05", "search");
  await assert.rejects(f.requests.select(f.owner, request.id, { expectedRevision: request.revision, subscribeDirectory: true }), /成功浏览/u);
  assert.equal(f.directoryCalls.length, 0);
  request = await f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id });
  assert.equal(request.shareDirectory?.reference, ROOT);
  request = await f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id });
  assert.equal(request.shareDirectory?.reference, CHILD);
  request = await f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[1].id });
  assert.deepEqual(request.shareDirectory, directory(CHILD));
  assert.equal(f.tasks(), 0);
  const choice = { expectedRevision: request.revision, subscribeDirectory: true };
  const completed = await f.requests.select(f.owner, request.id, choice);
  assert.equal(completed.stage, "completed");
  assert.match(completed.message, /包含下级目录/u);
  assert.match(completed.message, /仅匹配.*后台会持续追更/u);
  assert.deepEqual(f.directoryCalls, [{ input: { query: "The Last of Us S01E05", media: { ...series, season: 1 }, reference: CHILD, startEpisode: 5 }, owner: f.owner }]);
  assert.equal((await f.requests.select(f.owner, request.id, choice)).subscriptionId, completed.subscriptionId);
  assert.equal(f.directoryCalls.length, 1);
  assert.equal(f.store.list<Subscription>("subscription")[0].media?.episode, undefined);
  assert.equal(f.subscriptions(), 0);
  assert.equal(f.tasks(), 0);
  const next = await f.requests.begin(f.owner, "Dune", "search");
  assert.equal(next.shareDirectory, undefined);
});

test("directory confirmation rejects mixed fields, stale versions, another owner and missing identity details", async (t) => {
  const f = fixture(t, { identify: async () => [movie], search: async () => [share()], browseShare: async () => [navigation(CHILD, "目录", "folder")], shareDirectory: directory });
  const initial = await f.requests.begin(f.owner, "Dune", "search");
  const request = await f.requests.select(f.owner, initial.id, { expectedRevision: initial.revision, resourceId: initial.resources[0].id });
  const choice = { expectedRevision: request.revision, subscribeDirectory: true };
  await assert.rejects(f.requests.select("another-owner", request.id, choice), /无权|不存在/u);
  await assert.rejects(f.requests.select(f.owner, request.id, { ...choice, expectedRevision: initial.revision }), (error: any) => error.status === 409);
  for (const extra of [
    { resourceId: request.resources[0].id }, { extractionCode: "Q7z9" },
    { media: movie }, { season: 2 }, { episode: 2 }, { confirmUncertain: true },
  ]) await assert.rejects(f.requests.select(f.owner, request.id, { ...choice, ...extra }), /字段/u);
  assert.equal(f.directoryCalls.length, 0);
  assert.deepEqual(f.requests.get(f.owner, request.id), request);
  f.service.identify = async () => [{ type: "movie", title: "Dune" }];
  let noYear = await f.requests.begin(f.owner, "Dune", "search");
  noYear = await f.requests.select(f.owner, noYear.id, { expectedRevision: noYear.revision, resourceId: noYear.resources[0].id });
  await assert.rejects(f.requests.select(f.owner, noYear.id, { expectedRevision: noYear.revision, subscribeDirectory: true }), /补充作品年份/u);
  const yearReply = await runAgent(`订阅目录 ${noYear.id}`, f.deps);
  assert.match(yearReply.text, /补充有效作品年份/u);
  assert.equal(f.directoryCalls.length, 0);
  assert.equal(f.store.list("subscription").length, 0);
});

test("failed or cancelled navigation clears the old subscribable context before dispatch and never commits a new one", async (t) => {
  let normalizations = 0;
  const f = fixture(t, {
    identify: async () => [movie], search: async () => [share()], browseShare: async () => [navigation(CHILD, "目录", "folder")],
    shareDirectory: (reference) => { normalizations++; return directory(reference); },
  });
  let request = await f.requests.begin(f.owner, "Dune", "search");
  request = await f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id });
  assert.equal(request.shareDirectory?.reference, ROOT);
  let release!: (value: SearchResult[]) => void;
  const gate = new Promise<SearchResult[]>((resolve) => { release = resolve; });
  f.service.browseShare = async () => gate;
  const controller = new AbortController();
  const pending = f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id }, controller.signal);
  const invalidated = f.requests.get(f.owner, request.id);
  assert.equal(invalidated.shareDirectory, undefined);
  assert.ok(invalidated.revision > request.revision);
  await assert.rejects(f.open().select(f.owner, request.id, { expectedRevision: invalidated.revision, subscribeDirectory: true }), /成功浏览/u);
  controller.abort();
  release([file()]);
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(f.requests.get(f.owner, request.id), invalidated);
  assert.equal(normalizations, 1);
  f.service.browseShare = async () => { throw new Error("fixture denied"); };
  request = await f.requests.select(f.owner, request.id, { expectedRevision: invalidated.revision, resourceId: invalidated.resources[0].id });
  assert.equal(request.shareDirectory, undefined);
  await assert.rejects(f.requests.select(f.owner, request.id, { expectedRevision: request.revision, subscribeDirectory: true }), /成功浏览/u);
  f.service.browseShare = async () => [file()];
  f.service.shareDirectory = () => { throw new Error("fixture file cannot be subscribed"); };
  request = await f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id });
  assert.equal(request.shareDirectory, undefined);
  assert.equal(f.directoryCalls.length, 0);
  assert.equal(f.tasks(), 0);
});

test("directory subscription creation is cancelled and rolled back with its request receipt", async (t) => {
  const f = fixture(t, { identify: async () => [movie], search: async () => [share()], browseShare: async () => [file()], shareDirectory: directory });
  let request = await f.requests.begin(f.owner, "Dune", "search");
  request = await f.requests.select(f.owner, request.id, { expectedRevision: request.revision, resourceId: request.resources[0].id });
  const choice = { expectedRevision: request.revision, subscribeDirectory: true };
  const controller = new AbortController();
  const original = f.actions.subscribeDirectory;
  f.actions.subscribeDirectory = (input, owner) => { const row = original(input, owner); controller.abort(); return row; };
  await assert.rejects(f.requests.select(f.owner, request.id, choice, controller.signal), { name: "AbortError" });
  assert.equal(f.store.list("subscription").length, 0);
  assert.deepEqual(f.requests.get(f.owner, request.id), request);
  f.actions.subscribeDirectory = original;
  const { subscribeDirectory, ...legacyActions } = f.actions;
  const legacy = new Requests(f.store, f.service, legacyActions);
  await assert.rejects(legacy.select(f.owner, request.id, choice), /尚未配置/u);
  const completed = await f.requests.select(f.owner, request.id, choice);
  assert.equal(completed.stage, "completed");
  assert.equal(f.store.list("subscription").length, 1);
  assert.equal(f.tasks(), 0);
});

test("directory text commands use the same owner-bound explicit action before the model and repeat only the receipt", async (t) => {
  const f = fixture(t, { identify: async () => [movie], search: async () => [share()], browseShare: async () => [file()], shareDirectory: directory });
  const config = f.store.config();
  config.model.baseUrl = "https://model.invalid/v1";
  config.model.model = "fixture-model";
  f.store.setConfig(config);
  const previousFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async () => { modelCalls++; throw new Error("directory commands cannot use the model"); };
  t.after(() => { globalThis.fetch = previousFetch; });
  const owner = "qq:directory-fixture";
  const deps = scopedDeps(f, owner);
  let reply = await runAgent("搜索 Dune", deps);
  const id = reply.request!.id;
  const tooSoon = await runAgent(`订阅目录 ${id}`, deps);
  assert.match(tooSoon.text, /成功浏览/u);
  reply = await runAgent(`资源 ${id} 1`, deps);
  assert.match(reply.text, /当前分享目录：分享根目录/u);
  assert.match(reply.text, new RegExp(`订阅目录 ${id}`));
  assert.equal(f.directoryCalls.length, 0);
  const outsider = await runAgent(`订阅目录 ${id}`, scopedDeps(f, "wechat:other"));
  assert.match(outsider.text, /本会话没有/u);
  for (const command of ["订阅目录", `订阅目录 ${id} 1`, `订阅目录 ${id} 提取码 Q7z9`]) {
    const malformed = await runAgent(command, deps);
    assert.equal(malformed.request, undefined);
    assert.equal(malformed.text.includes("Q7z9"), false);
  }
  reply = await runAgent(`订阅目录 ${id}`, deps);
  assert.equal(reply.request?.stage, "completed");
  assert.equal(f.directoryCalls.length, 1);
  assert.equal(f.directoryCalls[0].owner, owner);
  const duplicate = await runAgent(`订阅目录 ${id}`, deps);
  assert.equal(duplicate.request?.subscriptionId, reply.request?.subscriptionId);
  assert.equal(f.directoryCalls.length, 1);
  const ordinary = await runAgent(`资源 ${id} 1`, deps);
  assert.match(ordinary.text, /已结束/u);
  assert.equal(f.tasks(), 0);
  assert.equal(f.subscriptions(), 0);
  assert.equal(modelCalls, 0);
});

test("Alipan provider survives channel browsing, owner isolation, persistence and completed directory replay", async (t) => {
  const codes: (string | undefined)[] = [];
  const f = fixture(t, {
    identify: async () => [movie],
    search: async () => [{ ...share(), url: "https://www.alipan.com/s/fixture", provider: "alipan" }],
    browseShare: async (reference, code) => {
      codes.push(code);
      return reference === ROOT ? [{ ...navigation(CHILD, "阿里电影目录", "folder"), provider: "alipan" }] : [{ ...file(), provider: "alipan" }];
    },
    shareDirectory: (reference) => ({ ...directory(reference), provider: "alipan" }),
  });
  const owner = "telegram:alipan-fixture";
  const deps = scopedDeps(f, owner);
  let reply = await runAgent("搜索 Dune", deps);
  const id = reply.request!.id;
  assert.match(reply.text, /\[阿里云盘分享\]/u);
  assert.match(reply.text, /匿名浏览/u);
  assert.match(reply.text, /设置.*Web 授权/u);
  assert.equal(reply.text.includes("115"), false);
  assert.equal(reply.request!.resources[0].provider, "alipan");
  reply = await runAgent(`资源 ${id} 1 提取码 Q7z9`, deps);
  assert.deepEqual(codes, ["Q7z9"]);
  assert.match(reply.text, /当前阿里云盘分享目录/u);
  assert.equal(reply.request!.shareDirectory?.provider, "alipan");
  reply = await runAgent(`资源 ${id} 1`, deps);
  const current = f.requests.get(owner, id);
  assert.equal(current.resources[0].provider, "alipan");
  assert.equal(current.shareDirectory?.provider, "alipan");
  assert.equal(f.open().get(owner, id).resources[0].provider, "alipan");
  await assert.rejects(f.requests.select("wechat:other", id, { expectedRevision: current.revision, resourceId: current.resources[0].id }), /无权|不存在/u);
  await assert.rejects(f.requests.select(owner, id, { expectedRevision: current.revision, resourceId: current.resources[0].id, provider: "p115" } as any), /字段/u);
  await assert.rejects(f.requests.select(owner, id, { expectedRevision: current.revision, resourceId: current.resources[0].id, shareRef: ROOT } as any), /字段/u);
  assert.equal(f.tasks(), 0);
  const choice = { expectedRevision: current.revision, subscribeDirectory: true };
  reply = await runAgent(`订阅目录 ${id}`, deps);
  assert.equal(reply.request!.stage, "completed");
  assert.match(reply.text, /阿里云盘自动追更.*设置.*Web 授权/u);
  assert.equal(reply.text.includes("115"), false);
  assert.equal(JSON.stringify(reply).includes("Q7z9"), false);
  assert.equal(f.store.list<Subscription>("subscription")[0].share?.provider, "alipan");
  const refreshedStore = new Store(f.directory);
  try {
    const refreshed = new Requests(refreshedStore, f.service, f.actions);
    const completed = await refreshed.select(owner, id, choice);
    assert.equal(completed.subscriptionId, reply.request!.subscriptionId);
    assert.equal(completed.shareDirectory?.provider, "alipan");
    assert.equal(completed.resources[0].provider, "alipan");
  } finally { refreshedStore.close(); }
  assert.equal(f.directoryCalls.length, 1);
  assert.equal(f.tasks(), 0);
});

test("provider DTOs reject unknown or cross-provider share metadata while legacy missing provider remains 115", async (t) => {
  const f = fixture(t, { identify: async () => [movie], search: async () => [
    { ...share(), provider: "other-provider" } as any,
    { ...file(CHILD), provider: "alipan" },
    { ...file(NEXT), provider: "p115" },
    file(),
  ] });
  const request = await f.requests.begin(f.owner, "Dune", "search");
  assert.deepEqual(request.resources.map((item) => item.provider), ["alipan", "p115", undefined]);
  assert.deepEqual(f.requests.get(f.owner, request.id).resources.map((item) => item.provider), ["alipan", "p115", undefined]);
  for (const invalid of ["p115", "unknown", undefined]) {
    const mixed = fixture(t, {
      identify: async () => [movie], search: async () => [{ ...share(), provider: "alipan" }],
      browseShare: async () => [{ ...file(), provider: "alipan" }],
      shareDirectory: () => ({ ...directory(ROOT), provider: invalid } as any),
    });
    let view = await mixed.requests.begin(mixed.owner, "Dune", "search");
    view = await mixed.requests.select(mixed.owner, view.id, { expectedRevision: view.revision, resourceId: view.resources[0].id });
    assert.equal(view.shareDirectory, undefined);
    assert.equal(view.resources[0].provider, "alipan");
    assert.match(view.message, /阿里云盘/u);
    assert.equal(view.message.includes("115"), false);
    assert.equal(mixed.tasks(), 0);
  }
  const legacy = fixture(t, { identify: async () => [movie], search: async () => [share()], browseShare: async () => [{ ...file(), provider: "alipan" }], shareDirectory: directory });
  let view = await legacy.requests.begin(legacy.owner, "Dune", "search");
  view = await legacy.requests.select(legacy.owner, view.id, { expectedRevision: view.revision, resourceId: view.resources[0].id });
  assert.equal(view.resources.length, 0);
  assert.equal(view.shareDirectory?.provider, undefined);
  assert.equal(legacy.tasks(), 0);
});

test("Alipan authorization errors remain static domain failures with settings guidance and no false completion", async (t) => {
  for (const code of ["alipan_auth_required", "alipan_auth_invalid", "alipan_auth_unknown", "auth_required"]) {
    const f = fixture(t, {
      identify: async () => [movie], search: async () => [{ ...share(), provider: "alipan" }],
      browseShare: async () => [{ ...file(), provider: "alipan" }],
      shareDirectory: (reference) => ({ ...directory(reference), provider: "alipan" }),
    });
    let view = await f.requests.begin(f.owner, "Dune", "search");
    view = await f.requests.select(f.owner, view.id, { expectedRevision: view.revision, resourceId: view.resources[0].id });
    const privateFailure = () => Object.assign(new Error("upstream-private-response"), { code, status: 401 });
    f.actions.subscribeDirectory = () => { throw privateFailure(); };
    await assert.rejects(f.requests.select(f.owner, view.id, { expectedRevision: view.revision, subscribeDirectory: true }), (error: any) => error.status === 409 && error.code === code && /设置.*Web 授权/u.test(error.message) && !error.message.includes("upstream-private-response"));
    const reply = await runAgent(`订阅目录 ${view.id}`, f.deps);
    assert.match(reply.text, /设置.*Web 授权/u);
    assert.equal(reply.text.includes("upstream-private-response"), false);
    assert.equal(reply.request, undefined);
    assert.equal(f.requests.get(f.owner, view.id).stage, "resource");
    assert.equal(f.store.list("subscription").length, 0);
    f.actions.addTask = () => { throw privateFailure(); };
    const fileReply = await runAgent(`资源 ${view.id} 1`, f.deps);
    assert.match(fileReply.text, /设置.*Web 授权/u);
    assert.equal(f.tasks(), 0);
  }
  const anonymous = fixture(t, {
    identify: async () => [movie], search: async () => [{ ...share(), provider: "alipan" }],
    browseShare: async () => [{ ...file(), provider: "alipan" }], shareDirectory: (reference) => ({ ...directory(reference), provider: "alipan" }),
  });
  let view = await anonymous.requests.begin(anonymous.owner, "Dune", "search");
  view = await anonymous.requests.select(anonymous.owner, view.id, { expectedRevision: view.revision, resourceId: view.resources[0].id });
  assert.equal(view.resources[0].provider, "alipan");
  assert.equal(anonymous.tasks(), 0);
  view = await anonymous.requests.select(anonymous.owner, view.id, { expectedRevision: view.revision, resourceId: view.resources[0].id });
  assert.equal(view.stage, "completed");
  assert.match(view.message, /已创建阿里云盘文件下载任务/u);
  assert.match(view.message, /实际进度请查看任务状态/u);
  assert.doesNotMatch(view.message, /下载完成|官方OAuth|内置扫码|已转存/u);
});

test("close aborts and drains owned Alipan navigation and automatic share browsing before Store shutdown", async (t) => {
  for (const automatic of [false, true]) {
    let release!: (value: SearchResult[]) => void, entered!: () => void;
    const gate = new Promise<SearchResult[]>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let browseSignal: AbortSignal | undefined;
    let normalizations = 0;
    const f = fixture(t, {
      identify: async () => [movie], search: async () => [{ ...share(), provider: "alipan" }],
      browseShare: async () => [{ ...navigation(CHILD, "目录", "folder"), provider: "alipan" }],
      shareDirectory: (reference) => { normalizations++; return { ...directory(reference), provider: "alipan" }; },
    });
    let current;
    if (!automatic) {
      current = await f.requests.begin(f.owner, "Dune", "search");
      current = await f.requests.select(f.owner, current.id, { expectedRevision: current.revision, resourceId: current.resources[0].id });
      assert.equal(current.shareDirectory?.provider, "alipan");
    }
    f.service.browseShare = async (_reference, _code, signal) => { browseSignal = signal; entered(); return gate; };
    const operation = automatic
      ? f.requests.begin(f.owner, "Dune", "download")
      : f.requests.select(f.owner, current!.id, { expectedRevision: current!.revision, resourceId: current!.resources[0].id });
    const rejected = assert.rejects(operation, { name: "AbortError" });
    await started;
    const before = f.requests.latest(f.owner)!;
    assert.equal(before.shareDirectory, undefined);
    const normalizedBefore = normalizations;
    const closing = f.requests.close();
    assert.equal(f.requests.close(), closing);
    let drained = false;
    void closing.then(() => { drained = true; });
    try {
      assert.equal(browseSignal?.aborted, true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(drained, false);
      await assert.rejects(f.requests.begin(f.owner, "Dune", "download"), /已关闭/u);
      await assert.rejects(f.requests.select(f.owner, before.id, { expectedRevision: before.revision, subscribeDirectory: true }), /已关闭/u);
    } finally { release([{ ...file(), provider: "alipan" }]); }
    await Promise.all([rejected, closing]);
    assert.deepEqual(f.requests.get(f.owner, before.id), before);
    assert.equal(normalizations, normalizedBefore);
    assert.equal(f.tasks(), 0);
    assert.equal(f.directoryCalls.length, 0);
    assert.equal(f.store.list("subscription").length, 0);
  }
});
