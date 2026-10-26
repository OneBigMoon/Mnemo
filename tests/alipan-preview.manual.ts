// Start only after integration approval: tsx tests/alipan-preview.manual.ts
// Actual HTTP / Store / Requests / Queue; only MediaService provider operations are fake.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";
import type { CloudProvider, ConnectionTestResult, MediaInfo, MediaService, SearchResult, ShareScanCursor } from "../shared/types.js";

delete process.env.MORI_PANSOU_URL;
const root = await mkdtemp(path.join(os.tmpdir(), "mori-alipan-qa-"));
const files = path.join(root, "files");
await mkdir(files, { recursive: true });
const receiptPath = path.resolve("output/playwright/alipan-fixture.json");
await mkdir(path.dirname(receiptPath), { recursive: true });
const reference = (value: number) => `mori-share:${value.toString(16).padStart(64, "0")}`;
const scopes = {
  alipan: { root: reference(110), child: reference(111), next: reference(112), first: reference(113), second: reference(114), wrong: reference(115), uncertain: reference(116), title: "阿里隔离剧集" },
  p115: { root: reference(210), child: reference(211), next: reference(212), first: reference(213), second: reference(214), wrong: reference(215), uncertain: reference(216), title: "旧115隔离剧集" },
};
const payload = Buffer.from("Mori isolated Alipan UI fixture bytes.\n");
const browsed = new Set<string>();
let base = "";
let closing = false;
type AuthOutcome = "ready" | "unknown" | "invalid" | "changed";
let authOutcome: AuthOutcome = "ready";
let authTransport: "body" | "http" = "http";
const observed = {
  searches: [] as { query: string; providers: CloudProvider[] }[],
  identifies: [] as string[],
  browses: [] as { provider: CloudProvider; view: string; codeProvided: boolean }[],
  scans: [] as { provider: CloudProvider; page: number; signalProvided: boolean }[],
  tests: [] as { kind: string; outcome: string; transport: string; credentialPresent: boolean }[],
  downloads: [] as { taskId: string; provider: CloudProvider; bytes: number; episode?: number }[],
};
function scopeFor(ref: string) {
  for (const provider of ["alipan", "p115"] as const) {
    const scope = scopes[provider];
    const entry = Object.entries(scope).find(([key, value]) => key !== "title" && value === ref);
    if (entry) return { provider, scope, view: entry[0] };
  }
  throw new Error("Unknown isolated share reference");
}
// Missing provider deliberately represents existing 115 records.
const providerFields = (provider: CloudProvider) => provider === "alipan" ? { provider } : {};
function cloudFile(provider: CloudProvider, view: "first" | "second" | "wrong" | "uncertain"): SearchResult {
  const scope = scopes[provider];
  const episode = view === "second" ? 2 : 1;
  const year = view === "wrong" ? "1984 " : view === "uncertain" ? "" : "2026 ";
  return { id: scope[view], title: `${scope.title} ${year}S01E${String(episode).padStart(2, "0")}.mkv`, url: scope[view], shareRef: scope[view], kind: "cloud", source: `${provider === "alipan" ? "阿里云盘" : "115"}隔离假服务`, size: `${payload.length} B`, ...providerFields(provider) };
}
function navigation(provider: CloudProvider, view: "root" | "child" | "next", title: string, kind: "folder" | "parent" | "next"): SearchResult {
  const ref = scopes[provider][view];
  return { id: ref, title, url: ref, shareRef: ref, kind: "share", navigation: kind, source: `${provider === "alipan" ? "阿里云盘" : "115"}隔离假服务`, ...providerFields(provider) };
}
function authFailure(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, status: 409 });
}
function requireSavedAlipanCredential() {
  if (!instance.store.config().sources.alipanRefreshToken) authFailure("alipan_auth_required", "请先在来源设置保存阿里云盘 Web 登录凭据；浏览分享可以不登录。");
}
const media: MediaService = {
  async search(query) {
    const config = instance.store.config();
    const providers: CloudProvider[] = [];
    if (config.sources.alipanEnabled && !query.includes("旧115")) providers.push("alipan");
    if (config.sources.p115Enabled && !query.includes("阿里")) providers.push("p115");
    observed.searches.push({ query, providers });
    return providers.map((provider) => ({ id: `raw-${provider}`, title: `${scopes[provider].title} (2026) 分享`, url: `${base}/fixture-only/${provider}/share`, shareRef: scopes[provider].root, kind: "share", source: `${provider === "alipan" ? "阿里云盘" : "115"}隔离假服务`, ...providerFields(provider) }));
  },
  async identify(query) {
    observed.identifies.push(query);
    const provider = query.includes("旧115") ? "p115" : "alipan";
    const result: MediaInfo = { type: "tv", title: scopes[provider].title, year: 2026, season: 1, tmdbId: provider === "alipan" ? 920001 : 920002 };
    return [result];
  },
  async browseShare(ref, code, signal) {
    signal?.throwIfAborted();
    const { provider, view } = scopeFor(ref);
    assert.ok(["root", "child", "next"].includes(view));
    observed.browses.push({ provider, view, codeProvided: !!code });
    browsed.add(ref);
    return view === "root"
      ? [navigation(provider, "child", "Season 1", "folder"), cloudFile(provider, "first"), cloudFile(provider, "uncertain"), cloudFile(provider, "wrong"), navigation(provider, "next", "下一页", "next")]
      : [cloudFile(provider, "second"), navigation(provider, "root", "返回分享根目录", "parent")];
  },
  shareDirectory(ref) {
    assert.ok(browsed.has(ref), "Only an actually browsed directory may be subscribed");
    const { provider, scope, view } = scopeFor(ref);
    assert.ok(["root", "child", "next"].includes(view));
    return { reference: view === "next" ? scope.root : ref, title: `${scope.title} (2026)${view === "child" ? " / Season 1" : ""}`, ...providerFields(provider) };
  },
  async scanShare(ref, cursor, signal) {
    signal?.throwIfAborted();
    const { provider, scope } = scopeFor(ref);
    if (provider === "alipan") requireSavedAlipanCredential();
    const page = cursor?.pages || 0;
    observed.scans.push({ provider, page, signalProvided: !!signal });
    const directories = [`${scope.title} (2026)`, "Season 1"];
    if (page > 0) return { files: [{ resource: cloudFile(provider, "second"), directories }], complete: true };
    const next: ShareScanCursor = { version: 1, root: ref, frontier: [{ reference: scope.child, directoryKey: `${provider}-fixture-season-one`, depth: 1 }], visited: [`${provider}-fixture-root`], pages: 1, entries: 2 };
    return { files: [{ resource: cloudFile(provider, "first"), directories }, { resource: cloudFile(provider, "wrong"), directories }], cursor: next, complete: false };
  },
  async download(task, signal, progress) {
    signal.throwIfAborted();
    const { provider, view } = scopeFor(task.url);
    assert.ok(["first", "second", "uncertain"].includes(view), "A directory or wrong-year resource is not downloadable");
    if (provider === "alipan") requireSavedAlipanCredential();
    assert.equal(task.kind, "cloud");
    const destination = path.join(files, `${task.id}.mkv`);
    await writeFile(destination, payload, { flag: "wx" });
    assert.deepEqual(await readFile(destination), payload);
    observed.downloads.push({ taskId: task.id, provider, bytes: payload.length, episode: task.media.episode });
    progress({ bytes: payload.length, total: payload.length, progress: 100 });
    return destination;
  },
  scrape: async () => ({ files: [], warnings: [] }),
  async testConnection(kind): Promise<ConnectionTestResult> {
    const present = !!instance.store.config().sources.alipanRefreshToken;
    observed.tests.push({ kind, outcome: kind === "alipan" ? authOutcome : "local", transport: authTransport, credentialPresent: present });
    if (kind === "p115") return { ok: true, message: "隔离本地解析器就绪，不代表账号或真实分享验证通过。" };
    if (kind !== "alipan") throw new Error("此隔离夹具仅支持阿里和115的假服务验证。");
    requireSavedAlipanCredential();
    if (authOutcome === "ready") return { ok: true, message: "隔离样例：网页登录凭据通过，不保证真实分享或会员下载权益。" };
    const codes = { unknown: "alipan_auth_unknown", invalid: "alipan_auth_invalid", changed: "alipan_config_changed" };
    const messages = { unknown: "网页登录授权结果未知，请重新取得并保存新的 Web RefreshToken。", invalid: "网页登录凭据已失效，请重新获取并保存。", changed: "来源配置已变更，请保存后重新验证。" };
    const result = { ok: false, message: messages[authOutcome], code: codes[authOutcome] };
    if (authTransport === "http") authFailure(result.code, result.message);
    return result;
  },
};
const instance = createApp({ dataDirectory: path.join(root, "state"), downloadDirectory: files, testMode: true, startBackground: false, media });
instance.store.setup("Mori-alipan-qa-local-only");
const config = instance.store.config();
assert.equal(config.sources.alipanEnabled, false);
assert.equal(config.sources.alipanRefreshToken, "");
config.setupComplete = true;
config.library.artwork = false;
instance.store.setConfig(config);
const evidence: Record<string, unknown> = { isolated: true, testMode: true, startBackground: false, realProviderCalls: 0, realSdkCalls: 0, realMessagesSent: 0, startedAt: new Date().toISOString(), fixtureBytes: payload.length, fixtureSha256: createHash("sha256").update(payload).digest("hex") };
async function snapshot() {
  const state = instance.store.config();
  Object.assign(evidence, {
    observed,
    sources: { alipanEnabled: state.sources.alipanEnabled, alipanCredentialPresent: !!state.sources.alipanRefreshToken, p115Enabled: state.sources.p115Enabled, p115CookiePresent: !!state.sources.p115Cookie },
    tasks: instance.queue.tasks().map((task) => ({ id: task.id, kind: task.kind, status: task.status, bytes: task.bytes, season: task.media.season, episode: task.media.episode })),
    subscriptions: instance.queue.subscriptions().map((subscription) => ({ id: subscription.id, provider: subscription.share?.provider || "p115", directory: subscription.share?.title, enabled: subscription.enabled, pending: subscription.scan?.pending.length || 0, complete: subscription.scan?.complete ?? null, hasError: !!subscription.lastError })),
  });
  await writeFile(receiptPath, JSON.stringify(evidence, null, 2));
  return evidence;
}
// These controls only change fake provider behavior; all app mutations use actual authenticated APIs.
instance.app.post("/__alipan_fixture/auth-outcome", (req, res) => {
  if (!["ready", "unknown", "invalid", "changed"].includes(req.body?.outcome) || !["body", "http", undefined].includes(req.body?.transport)) return res.status(400).json({ error: "Unknown isolated provider outcome" });
  authOutcome = req.body.outcome;
  authTransport = req.body.transport || "http";
  res.json({ ok: true });
});
instance.app.post("/__alipan_fixture/evidence", async (_req, res) => { res.json(await snapshot()); });
instance.app.post("/__alipan_fixture/stop", (_req, res) => { res.json({ ok: true }); setImmediate(() => void close()); });
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
  assert.ok(path.basename(root).startsWith("mori-alipan-qa-"));
  await rm(root, { recursive: true, force: true });
  evidence.cleanup = { serverClosed: true, queueClosed: true, tempStateRemoved: true };
  await writeFile(receiptPath, JSON.stringify(evidence, null, 2));
  console.log("Isolated Alipan fixture stopped and temporary state removed.");
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
