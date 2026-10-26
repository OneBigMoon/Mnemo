// Run only after integration: tsx tests/directory-preview.manual.ts
// Real HTTP / Requests / Queue / Store; only MediaService provider operations are fake.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";
import type { MediaInfo, MediaService, SearchResult, ShareScanCursor, ShareScanPage } from "../shared/types.js";

delete process.env.MORI_PANSOU_URL;
const root = await mkdtemp(path.join(os.tmpdir(), "mori-directory-qa-"));
const files = path.join(root, "files");
await mkdir(files, { recursive: true });
const receiptPath = path.resolve("output/playwright/directory-fixture.json");
await mkdir(path.dirname(receiptPath), { recursive: true });
const ref = (number: number) => `mori-share:${number.toString(16).padStart(64, "0")}`;
const ROOT = ref(201), CHILD = ref(202), NEXT = ref(203);
const EPISODE_ONE = ref(210), EPISODE_TWO = ref(211), WRONG_SEASON = ref(212), WRONG_YEAR = ref(213), LATE_EPISODE = ref(299);
const EPISODE_URLS = Array.from({ length: 12 }, (_, index) => index === 0 ? EPISODE_ONE : index === 1 ? EPISODE_TWO : ref(300 + index));
const EPISODE_THIRTEEN = ref(330);
const DOWNLOAD_EPISODES = new Set([...EPISODE_URLS, EPISODE_THIRTEEN]);
const series: MediaInfo = { type: "tv", title: "隔离目录剧集", year: 2026, season: 1, tmdbId: 910001 };
const bytes = Buffer.from("Mori isolated directory subscription fixture bytes.\n");
const browseSucceeded = new Set<string>();
const directories = new Map([[ROOT, "隔离目录剧集 (2026)"], [CHILD, "隔离目录剧集 (2026) / Season 1"]]);
let base = "";
let closing = false;
let holdNext: "pause" | "delete" | null = null;
let failNext = false;
const providerHolds = new Set<() => void>();
const observed = {
  search: [] as string[],
  identify: [] as string[],
  browse: [] as { directory: string; codeProvided: boolean }[],
  scans: [] as { directory: string; page: number; signalProvided: boolean; heldFor?: string; failed?: boolean }[],
  abortEvents: [] as { label: string; whileFixtureClosing: boolean; latePageReturned: boolean }[],
  fixtureStopReleases: 0,
  downloads: [] as { taskId: string; season?: number; episode?: number; bytes: number }[],
};
const file = (reference: string, title: string): SearchResult => ({ id: reference, title, url: reference, shareRef: reference, kind: "cloud", source: "115目录隔离假服务", size: `${bytes.length} B` });
const folder = (reference: string, title: string, navigation: "folder" | "parent" | "next"): SearchResult => ({ id: reference, title, url: reference, shareRef: reference, kind: "share", source: "115目录隔离假服务", navigation });
const context = ["隔离目录剧集 (2026)", "Season 1"];
function normalPage(reference: string, cursor?: ShareScanCursor): ShareScanPage {
 const page = cursor?.pages || 0;
 if (page === 0) return {
  files: [
   ...EPISODE_URLS.map((url, index) => ({ resource: file(url, `隔离目录剧集 2026 S01E${String(index + 1).padStart(2, "0")}.mkv`), directories: context })),
   { resource: file(WRONG_SEASON, "隔离目录剧集 2026 S02E01.mkv"), directories: context },
  ],
  cursor: { version: 1, root: reference, frontier: [{ reference: CHILD, directoryKey: "fixture-season-one", depth: 1 }], visited: ["fixture-root"], pages: 1, entries: 13 },
  complete: false,
 };
 if (page === 1) return {
  files: [
   { resource: file(EPISODE_THIRTEEN, "隔离目录剧集 2026 S01E13.mkv"), directories: context },
   { resource: file(WRONG_YEAR, "隔离目录剧集 1984 S01E14.mkv"), directories: context },
  ],
  cursor: { version: 1, root: reference, frontier: [{ reference: CHILD, directoryKey: "fixture-season-one-final", depth: 1 }], visited: ["fixture-root", "fixture-season-one"], pages: 2, entries: 15 },
  complete: false,
 };
 return { files: [], complete: true };
}
function latePage(): ShareScanPage {
  return { files: [{ resource: file(LATE_EPISODE, "隔离目录剧集 2026 S01E99.mkv"), directories: context }], complete: true };
}
function holdUntilRealQueueAbort(signal: AbortSignal | undefined, label: "pause" | "delete"): Promise<ShareScanPage> {
  assert.ok(signal, "The real Queue must pass its cancellation signal to the provider");
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { clearTimeout(deadline); signal.removeEventListener("abort", aborted); providerHolds.delete(fixtureStop); };
    const finish = (error?: Error) => { if (settled) return; settled = true; cleanup(); if (error) reject(error); else resolve(latePage()); };
    const aborted = () => {
      observed.abortEvents.push({ label, whileFixtureClosing: closing, latePageReturned: true });
      // Return a valid file after the actual abort, proving the Queue fences late results.
      finish();
    };
    const fixtureStop = () => { observed.fixtureStopReleases++; finish(new Error("Fixture cleanup released an un-aborted provider hold")); };
    const deadline = setTimeout(() => finish(new Error("Fixture timed out waiting for a real Queue abort")), 90_000);
    deadline.unref();
    providerHolds.add(fixtureStop);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
const media: MediaService = {
  async search(query) {
    observed.search.push(query);
    return [{ id: "directory-share", title: "隔离目录剧集 2026 分享目录", url: `${base}/fixture-only/share`, shareRef: ROOT, kind: "share", source: "115目录隔离假服务" }];
  },
  async identify(query) {
    observed.identify.push(query);
    if (query.includes("缺年份")) return [{ ...series, year: undefined, tmdbId: undefined }];
    if (query.includes("缺季数")) return [{ ...series, season: undefined }];
    return [{ ...series, year: 2020, tmdbId: 910000 }, series];
  },
  async browseShare(reference, extractionCode, signal) {
    signal?.throwIfAborted();
    assert.ok(directories.has(reference) || reference === NEXT, "Only fixed fixture references may be browsed");
    observed.browse.push({ directory: reference === ROOT ? "root" : reference === CHILD ? "child" : "next-page", codeProvided: !!extractionCode });
    browseSucceeded.add(reference);
    return reference === ROOT ? [folder(CHILD, "Season 1", "folder"), file(EPISODE_ONE, "隔离目录剧集 2026 S01E01.mkv"), folder(NEXT, "下一页", "next")] : [file(EPISODE_TWO, "隔离目录剧集 2026 S01E02.mkv"), folder(ROOT, "返回根目录", "parent")];
  },
  shareDirectory(reference) {
    assert.ok(browseSucceeded.has(reference), "A directory cannot be subscribed before a successful browse");
    const canonical = reference === NEXT ? ROOT : reference;
    const title = directories.get(canonical);
    assert.ok(title, "Only a known fixture directory may be subscribed");
    return { reference: canonical, title };
  },
  async scanShare(reference, cursor, signal) {
    signal?.throwIfAborted();
    assert.ok(directories.has(reference), "Scan root must come from a trusted browsed directory");
    const call: { directory: string; page: number; signalProvided: boolean; heldFor?: string; failed?: boolean } = { directory: reference === ROOT ? "root" : "child", page: cursor?.pages || 0, signalProvided: !!signal };
    observed.scans.push(call);
    if (failNext) { failNext = false; call.failed = true; throw new Error("隔离扫描临时失败，可保留位置后重试"); }
    if (holdNext) { const label = holdNext; holdNext = null; call.heldFor = label; return holdUntilRealQueueAbort(signal, label); }
    return normalPage(reference, cursor);
  },
  async download(task, signal, progress) {
    signal.throwIfAborted();
    assert.ok(DOWNLOAD_EPISODES.has(task.url), "Wrong-season, wrong-year, or cancelled late file must not be downloaded");
    assert.equal(task.media.season, 1);
    const destination = path.join(files, `${task.id}.mkv`);
    await writeFile(destination, bytes, { flag: "wx" });
    assert.deepEqual(await readFile(destination), bytes);
    observed.downloads.push({ taskId: task.id, season: task.media.season, episode: task.media.episode, bytes: bytes.length });
    progress({ bytes: bytes.length, total: bytes.length, progress: 100 });
    return destination;
  },
  scrape: async () => ({ files: [], warnings: [] }),
  testConnection: async () => ({ ok: true, message: "隔离本地假服务就绪，不涉及真实SDK或分享" }),
};
const instance = createApp({ dataDirectory: path.join(root, "state"), downloadDirectory: files, media, testMode: true, startBackground: false });
instance.store.setup("Mori-directory-qa-local-only");
const config = instance.store.config();
config.setupComplete = true;
config.sources.p115Enabled = true;
config.library.artwork = false;
instance.store.setConfig(config);
const evidence: Record<string, unknown> = { isolated: true, testMode: true, startBackground: false, realProviderCalls: 0, realSdkCalls: 0, realMessagesSent: 0, startedAt: new Date().toISOString(), fixtureBytes: bytes.length, fixtureSha256: createHash("sha256").update(bytes).digest("hex") };
async function snapshot() {
  Object.assign(evidence, {
    observed,
    armedProviderHold: holdNext,
    activeProviderHolds: providerHolds.size,
    tasks: instance.queue.tasks().map((task) => ({ id: task.id, kind: task.kind, status: task.status, season: task.media.season, episode: task.media.episode, bytes: task.bytes })),
    subscriptions: instance.queue.subscriptions().map((subscription) => ({ id: subscription.id, enabled: subscription.enabled, autoDownload: subscription.autoDownload, directory: subscription.share?.title, pendingFiles: subscription.scan?.pending.length || 0, cursorPresent: !!subscription.scan?.cursor, scanComplete: subscription.scan?.complete ?? null, nextCheckAt: subscription.nextCheckAt, hasError: !!subscription.lastError })),
  });
  await writeFile(receiptPath, JSON.stringify(evidence, null, 2));
  return evidence;
}
// Control endpoints change only fake provider behavior. All subscription mutations
// must use the real authenticated PATCH/DELETE/check HTTP endpoints in the UI.
instance.app.post("/__directory_fixture/hold", (req, res) => {
  if (!["pause", "delete"].includes(req.body?.label)) return res.status(400).json({ error: "Choose a fixed fixture hold label" });
  if (holdNext || providerHolds.size) return res.status(409).json({ error: "A provider hold already exists" });
  holdNext = req.body.label; res.json({ ok: true });
});
instance.app.post("/__directory_fixture/fail-next", (_req, res) => { failNext = true; res.json({ ok: true }); });
instance.app.post("/__directory_fixture/evidence", async (_req, res) => { res.json(await snapshot()); });
instance.app.post("/__directory_fixture/stop", (_req, res) => { res.json({ ok: true }); setImmediate(() => void close()); });
const server = instance.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
Object.assign(evidence, { base });
await snapshot();
console.log(JSON.stringify({ ready: true, base, testMode: true, startBackground: false }));
async function close() {
  if (closing) return;
  closing = true; evidence.closedAt = new Date().toISOString(); await snapshot();
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  const stop = instance.close();
  for (const release of [...providerHolds]) release();
  await stop;
  Object.assign(evidence, { observed, activeProviderHolds: providerHolds.size });
  await writeFile(receiptPath, JSON.stringify(evidence, null, 2));
  assert.ok(path.basename(root).startsWith("mori-directory-qa-")); await rm(root, { recursive: true, force: true });
  console.log("Isolated directory fixture stopped and temporary state removed.");
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
