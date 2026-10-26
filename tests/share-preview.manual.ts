// Independent UI fixture. Every provider operation below is fake and local.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";
import type { MediaInfo, MediaRequest, MediaService, SearchResult, ShareService } from "../shared/types.js";

delete process.env.MORI_PANSOU_URL;
const root = await mkdtemp(path.join(os.tmpdir(), "mori-share-qa-"));
const files = path.join(root, "files");
await mkdir(files, { recursive: true });
const evidencePath = path.resolve("output/playwright/share-fixture.json");
await mkdir(path.dirname(evidencePath), { recursive: true });
const reference = (id: number) => `mori-share:${id.toString(16).padStart(64, "0")}`;
const ROOT = reference(1), CHILD = reference(2), NEXT = reference(3), UP = reference(4);
const MATCHED = reference(5), UNCERTAIN = reference(6), MISMATCH = reference(7);
const movie: MediaInfo = { type: "movie", title: "隔离分享电影", year: 2026, tmdbId: 900002 };
const payload = Buffer.from("Mori isolated share UI bytes; never real media or provider data.\n");
const cookieMarker = "MORI_SHARE_QA_FAKE_COOKIE_ONLY";
const codeMarker = "Q7a2";
let base = "";
const calls = { search: [] as string[], identify: [] as string[], browse: [] as { target: string; codeLength: number; failed?: boolean }[], resolve: [] as string[], download: 0, tests: [] as string[], casBumps: 0 };
const navigation = (ref: string, title: string, direction: "folder" | "parent" | "next"): SearchResult => ({ id: ref, title, url: ref, shareRef: ref, kind: "share", source: "115隔离假服务", navigation: direction });
const file = (ref: string, title: string): SearchResult => ({ id: ref, title, url: ref, shareRef: ref, kind: "cloud", source: "115隔离假服务", size: `${payload.length} B` });
let rootUnlocked = false;
let failFolderOnce = true;
const shares: ShareService = {
  directory() { throw new Error("Use directory-preview.manual.ts for directory subscription QA"); },
  async scan() { throw new Error("Use directory-preview.manual.ts for directory subscription QA"); },
  capture(result) {
    if (result.id !== "raw-supported" && result.id !== "raw-alternative") return result;
    const { extractionCode: _code, ...publicResult } = result;
    return { ...publicResult, shareRef: ROOT };
  },
  async browse(ref, code, signal) {
    signal?.throwIfAborted();
    const target = ref === ROOT ? "root" : ref === CHILD ? "folder" : ref === NEXT ? "next" : ref === UP ? "parent" : "invalid";
    const call: { target: string; codeLength: number; failed?: boolean } = { target, codeLength: code?.length || 0 };
    calls.browse.push(call);
    if (ref === ROOT && !rootUnlocked) {
      assert.equal(code, codeMarker, "Fake share needs the local four-character code");
      rootUnlocked = true;
    }
    if (ref === CHILD && failFolderOnce) {
      failFolderOnce = false; call.failed = true;
      throw new Error("Isolated temporary folder failure");
    }
    if (ref === ROOT) return [
      navigation(CHILD, "电影文件夹", "folder"),
      ...Array.from({ length: 19 }, (_, i) => file(reference(100 + i), `其他影片 1984 测试项${i + 1}.mkv`)),
      navigation(UP, "返回上级集合", "parent"), navigation(NEXT, "下一页", "next"),
    ];
    if (ref === CHILD || ref === NEXT) return [
      file(UNCERTAIN, "隔离分享电影 1080p.mkv"),
      file(MATCHED, "隔离分享电影 2026 1080p.mkv"),
      file(MISMATCH, "隔离分享电影 1984 1080p.mkv"),
      navigation(ROOT, "返回分享根目录", "parent"),
      ...(ref === CHILD ? [navigation(NEXT, "下一页", "next")] : []),
    ];
    if (ref === UP) return [navigation(ROOT, "隔离分享根目录", "folder")];
    throw new Error("Unknown fake reference");
  },
  async resolve(ref, signal) {
    signal?.throwIfAborted();
    assert.ok(ref === MATCHED || ref === UNCERTAIN, "Navigation cannot resolve to a file");
    calls.resolve.push(ref === MATCHED ? "matched" : "uncertain");
    return { url: `${base}/fixture-only/bytes`, name: "isolated.mkv", size: payload.length, sha1: createHash("sha1").update(payload).digest("hex"), headers: {}, contentId: createHash("sha256").update(payload).digest("hex") };
  },
  async testConnection() { return { ok: true, message: "隔离本地解析器就绪，未验证账号或真实分享" }; },
};
const media: MediaService = {
  async search(query) {
    calls.search.push(query);
    return [
      shares.capture({ id: "raw-supported", title: "隔离分享电影 2026 115分享 很长的来源描述不能代替用户片名", url: `${base}/fixture-only/share`, kind: "share", source: "115隔离假服务" }),
      shares.capture({ id: "raw-alternative", title: "隔离分享电影 2026 第二来源", url: `${base}/fixture-only/alternative`, kind: "share", source: "115隔离假服务" }),
      { id: "raw-unsupported", title: "其他未接入分享", url: `${base}/fixture-only/unsupported`, kind: "share", source: "未接入假来源" },
    ];
  },
  async identify(query) { calls.identify.push(query); return [{ ...movie, year: 2020, tmdbId: 900001 }, movie]; },
  browseShare: (ref, code, signal) => shares.browse(ref, code, signal),
  async download(task, signal, progress) {
    assert.equal(task.kind, "cloud");
    const resolved = await shares.resolve(task.url, signal);
    assert.equal(resolved.size, payload.length);
    const output = path.join(files, `${task.id}.mkv`);
    await writeFile(output, payload, { flag: "wx" });
    assert.deepEqual(await readFile(output), payload);
    calls.download++;
    progress({ bytes: payload.length, total: payload.length, progress: 100 });
    return output;
  },
  scrape: async () => ({ files: [], warnings: [] }),
  async testConnection(kind) { calls.tests.push(kind); return kind === "p115" ? shares.testConnection() : { ok: true, message: "隔离假连接" }; },
};
const instance = createApp({ dataDirectory: path.join(root, "state"), downloadDirectory: files, testMode: true, startBackground: false, media });
instance.store.setup("Mori-share-qa-local-only");
const config = instance.store.config();
assert.equal(config.sources.p115Enabled, false);
assert.equal(config.sources.p115Cookie, "");
config.setupComplete = true;
config.library.artwork = false;
instance.store.setConfig(config);
const evidence: Record<string, unknown> = { isolated: true, testMode: true, startBackground: false, realProviderCalls: 0, realSdkCalls: 0, realMessagesSent: 0, startedAt: new Date().toISOString(), fixtureBytes: payload.length, fixtureSha256: createHash("sha256").update(payload).digest("hex") };
async function summary() {
  const requests = instance.store.list<MediaRequest>("request");
  const publicRecords = JSON.stringify(requests);
  const state = instance.store.config();
  Object.assign(evidence, {
    calls,
    p115Enabled: state.sources.p115Enabled,
    cookiePresent: !!state.sources.p115Cookie,
    fakeCookiePreserved: state.sources.p115Cookie === cookieMarker,
    requestRecordsExcludePasscode: !publicRecords.includes(codeMarker) && !publicRecords.includes("extractionCode"),
    tasks: instance.queue.tasks().map((task) => ({ id: task.id, kind: task.kind, status: task.status, bytes: task.bytes })),
    subscriptions: instance.queue.subscriptions().length,
  });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  return evidence;
}
instance.app.post("/__share_fixture/evidence", async (_req, res) => { res.json(await summary()); });
instance.app.post("/__share_fixture/bump", (req, res) => {
  const request = instance.store.list<MediaRequest>("request").find((item) => item.id === req.body?.id && item.owner === "web:admin" && item.stage === "resource");
  if (!request) return res.status(404).json({ error: "Missing own active fixture request" });
  calls.casBumps++;
  const changed = { ...request, revision: request.revision + 1, updatedAt: new Date().toISOString() };
  instance.store.put("request", changed);
  res.json({ ok: true, revision: changed.revision });
});
instance.app.post("/__share_fixture/subscribe-guard", (_req, res) => {
  const now = new Date().toISOString();
  const request: MediaRequest = {
    id: randomUUID(), revision: 1, owner: "web:admin", query: "分享订阅限制隔离样例", intent: "subscribe", stage: "resource", candidates: [], selected: movie,
    resources: [navigation(ROOT, "订阅分享入口", "folder"), file(MATCHED, "隔离分享电影 2026 1080p.mkv")].map((item) => ({ ...item, id: randomUUID(), match: "matched", reason: "仅验证现有订阅资源视图的UI禁用保护" })),
    message: "隔离夹具：分享订阅入口应禁用，不应创建订阅或下载", createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  instance.store.put("request", request);
  res.json({ ok: true });
});
instance.app.post("/__share_fixture/stop", (_req, res) => { res.json({ ok: true }); setImmediate(() => void close()); });
const server = instance.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
Object.assign(evidence, { base });
await summary();
console.log(JSON.stringify({ ready: true, base, testMode: true, startBackground: false }));
let closing = false;
async function close() {
  if (closing) return;
  closing = true; evidence.closedAt = new Date().toISOString(); await summary();
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await instance.close();
  assert.ok(path.basename(root).startsWith("mori-share-qa-")); await rm(root, { recursive: true, force: true });
  console.log("Isolated share fixture stopped and temporary state removed.");
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
