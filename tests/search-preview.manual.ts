// Start only after integration approval: tsx tests/search-preview.manual.ts
// Actual HTTP / Store / Requests / Queue; fake operations stop at MediaService.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";
import type { MediaRequest, MediaService, SearchReport, SearchResult, SearchSourceDiagnostic } from "../shared/types.js";

delete process.env.MORI_PANSOU_URL;
const root = await mkdtemp(path.join(os.tmpdir(), "mori-search-qa-"));
const files = path.join(root, "files");
await mkdir(files, { recursive: true });
const receiptPath = path.resolve("output/playwright/search-fixture.json");
await mkdir(path.dirname(receiptPath), { recursive: true });
const scenarios = ["not_configured", "failed", "partial", "partial_empty", "empty", "complete"] as const;
type Scenario = typeof scenarios[number];
let scenario: Scenario = "not_configured";
let base = "";
let closing = false;
const payload = Buffer.from("Mori isolated search diagnostic fixture bytes.\n");
const observed = {
  searches: [] as { query: string; scenario: Scenario; signalProvided: boolean }[],
  identifies: [] as string[],
  tests: [] as string[],
  downloads: [] as { taskId: string; bytes: number }[],
};
function source(source: SearchSourceDiagnostic["source"], status: SearchSourceDiagnostic["status"], resultCount = 0, code?: SearchSourceDiagnostic["code"]): SearchSourceDiagnostic {
  const names = { pansou: "PanSou", openlist: "OpenList", moviepilot: "MoviePilot", telegram: "Telegram 公开频道" };
  return { id: source, source, name: names[source], status, resultCount, ...(code ? { code } : {}) };
}
function fakeReport(): SearchReport {
  const useful: SearchResult = { id: "fixture-useful", title: "隔离搜索电影 (2026) 1080p.mkv", url: `${base}/fixture-only/resource.mkv`, source: "PanSou 隔离样例", kind: "direct", size: `${payload.length} B` };
  const unused = [source("moviepilot", "not_configured"), source("telegram", "not_configured")];
  if (scenario === "not_configured") return { results: [], diagnostics: { status: "not_configured", sources: [source("pansou", "not_configured"), source("openlist", "not_configured"), ...unused] } };
  if (scenario === "failed") return { results: [], diagnostics: { status: "failed", sources: [source("pansou", "failed", 0, "unreachable"), source("openlist", "failed", 0, "auth_required"), ...unused] } };
  if (scenario === "partial" || scenario === "partial_empty") return { results: scenario === "partial" ? [useful] : [], diagnostics: { status: "partial", sources: [source("pansou", scenario === "partial" ? "success" : "empty", scenario === "partial" ? 1 : 0), source("openlist", "failed", 0, "auth_required"), ...unused] } };
  return { results: scenario === "complete" ? [useful] : [], diagnostics: { status: "complete", sources: [source("pansou", scenario === "complete" ? "success" : "empty", scenario === "complete" ? 1 : 0), source("openlist", "not_configured"), ...unused] } };
}
async function search(query: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  observed.searches.push({ query, scenario, signalProvided: !!signal });
  return fakeReport();
}
const media: MediaService = {
  search: async (query, signal) => (await search(query, signal)).results,
  searchWithDiagnostics: search,
  async identify(query) {
    observed.identifies.push(query);
    return [{ type: "movie", title: "隔离搜索电影", year: 2026, tmdbId: 930001 }];
  },
  async download(task, signal, progress) {
    signal.throwIfAborted();
    assert.equal(task.url, `${base}/fixture-only/resource.mkv`);
    assert.equal(task.kind, "direct");
    const destination = path.join(files, `${task.id}.mkv`);
    await writeFile(destination, payload, { flag: "wx" });
    assert.deepEqual(await readFile(destination), payload);
    observed.downloads.push({ taskId: task.id, bytes: payload.length });
    progress({ bytes: payload.length, total: payload.length, progress: 100 });
    return destination;
  },
  scrape: async () => ({ files: [], warnings: [] }),
  async testConnection(kind) {
    observed.tests.push(kind);
    return { ok: true, message: "隔离假服务测试通过，不代表真实来源可用。" };
  },
};
const instance = createApp({ dataDirectory: path.join(root, "state"), downloadDirectory: files, media, testMode: true, startBackground: false });
instance.store.setup("Mori-search-qa-local-only");
const config = instance.store.config();
assert.equal(config.sources.pansouUrl, "");
assert.equal(config.sources.openlistUrl, "");
assert.equal(config.sources.moviePilotUrl, "");
assert.deepEqual(config.sources.telegramChannels, []);
config.setupComplete = true;
config.defaultTitleAction = "search";
config.library.artwork = false;
instance.store.setConfig(config);
const evidence: Record<string, unknown> = { isolated: true, testMode: true, startBackground: false, realProviderCalls: 0, realSdkCalls: 0, realMessagesSent: 0, startedAt: new Date().toISOString(), fixtureBytes: payload.length, fixtureSha256: createHash("sha256").update(payload).digest("hex") };
async function snapshot() {
  const current = instance.store.config();
  Object.assign(evidence, {
    scenario, observed,
    configuredSources: { pansou: !!current.sources.pansouUrl, openlist: !!current.sources.openlistUrl, moviepilot: !!current.sources.moviePilotUrl, telegram: current.sources.telegramChannels.length > 0 },
    requests: instance.store.list<MediaRequest>("request").map((request) => ({ id: request.id, intent: request.intent, query: request.query, stage: request.stage, revision: request.revision, diagnostics: request.searchDiagnostics, resources: request.resources.length, taskCreated: !!request.taskId, subscriptionCreated: !!request.subscriptionId })),
    subscriptions: instance.queue.subscriptions().map((subscription) => ({ id: subscription.id, enabled: subscription.enabled, autoDownload: subscription.autoDownload, diagnostics: subscription.searchDiagnostics, lastErrorPresent: !!subscription.lastError })),
    tasks: instance.queue.tasks().map((task) => ({ id: task.id, kind: task.kind, status: task.status, bytes: task.bytes })),
  });
  await writeFile(receiptPath, JSON.stringify(evidence, null, 2));
  return evidence;
}
// The only behavior control affects the fake provider, never Queue/Requests state.
instance.app.post("/__search_fixture/scenario", (req, res) => {
  if (!scenarios.includes(req.body?.scenario)) return res.status(400).json({ error: "Unknown isolated search scenario" });
  scenario = req.body.scenario;
  res.json({ ok: true, scenario });
});
instance.app.post("/__search_fixture/evidence", async (_req, res) => { res.json(await snapshot()); });
instance.app.post("/__search_fixture/stop", (_req, res) => { res.json({ ok: true }); setImmediate(() => void close()); });
const server = instance.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
Object.assign(evidence, { base });
await snapshot();
console.log(JSON.stringify({ ready: true, base, testMode: true, startBackground: false }));
async function close() {
  if (closing) return;
  closing = true;
  evidence.closedAt = new Date().toISOString();
  await snapshot();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await instance.close();
  assert.ok(path.basename(root).startsWith("mori-search-qa-"));
  await rm(root, { recursive: true, force: true });
  evidence.cleanup = { serverClosed: true, queueClosed: true, tempStateRemoved: true };
  await writeFile(receiptPath, JSON.stringify(evidence, null, 2));
  console.log("Isolated search fixture stopped and temporary state removed.");
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
