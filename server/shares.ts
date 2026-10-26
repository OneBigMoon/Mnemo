import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { CloudProvider, DownloadTask, ResolvedShareFile, SearchResult, ShareDirectory, ShareScanCursor, ShareScanFile, ShareScanPage, ShareService, Subscription } from "../shared/types.js";
import { Alipan, type AlipanAdapter, type AlipanPagePosition } from "./alipan.js";
import { Store } from "./store.js";
import { readEnv } from "./env.js";

const KIND = "share-reference";
const TTL = 24 * 60 * 60 * 1000;
const CAPACITY = 10_000;
const PAGE_SIZE = 20;
const MAX_RESOLVE_WAITERS = 4;
const RESOLVE_WAIT_MS = 60_000;
const MAX_SCAN_DIRECTORIES = 256;
const MAX_SCAN_PAGES = 1024;
const MAX_SCAN_ENTRIES = 10_000;
const MAX_SCAN_DEPTH = 64;
const MAX_OFFSET = 2 ** 31 - 1;
const MAX_INPUT = 64 * 1024;
const MAX_OUTPUT = 256 * 1024;
const ACCESS_PARAMETER = /^(password|pwd|receive_code|passcode|access_code)$/i;
const HELPER = fileURLToPath(new URL("../integrations/p115_resolver/main.py", import.meta.url));
const SDK_VERSION = "0.0.9.7.2";
const ERRORS = {
  unavailable: "115 解析 helper 未就绪，请安装固定版本 SDK",
  invalid_input: "115 分享参数无效",
  access_denied: "115 分享拒绝访问，请检查提取码或配置的账号权限",
  expired: "115 分享或本地引用已过期，请重新搜索",
  not_found: "115 分享或文件不存在",
  rate_limited: "115 服务请求过于频繁，请稍后再试",
  upstream_error: "115 解析失败，请检查 helper 和服务状态",
};

export type ShareHelperInput = {
  op: "health" | "list" | "link";
  shareCode?: string;
  receiveCode?: string;
  cookie?: string;
  parentId?: string;
  offset?: number;
  fileId?: string;
};
export type ShareHelperRunner = (input: ShareHelperInput, signal?: AbortSignal) => Promise<unknown>;

class ShareError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

function failure(code: string, message: string, status = 400) {
  return new ShareError(code, message, status);
}

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException(signal.reason?.name === "TimeoutError" ? "分享解析超时" : "分享解析已取消", signal.reason?.name === "TimeoutError" ? "TimeoutError" : "AbortError");
}

// The injection point lets tests own the child; production always uses the bundled script.
export function createShareHelperRunner(spawnHelper: typeof spawn = spawn): ShareHelperRunner {
  return async (input, signal) => {
    aborted(signal);
    const body = Buffer.from(JSON.stringify(input));
    if (body.length > MAX_INPUT) throw failure("invalid_input", "115 helper 输入过大");
    return await new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawnHelper(readEnv("PYTHON") || "python3", [HELPER], {
          stdio: "pipe", shell: false, windowsHide: true,
        });
      } catch {
        reject(failure("unavailable", ERRORS.unavailable, 503));
        return;
      }
      let problem: Error | undefined;
      let size = 0;
      const chunks: Buffer[] = [];
      const stop = (error: Error) => {
        problem ??= error;
        child.kill("SIGKILL");
      };
      const cancel = () => stop(new DOMException("分享解析已取消", "AbortError"));
      const timer = setTimeout(() => stop(new DOMException("115 解析超时", "TimeoutError")), 25_000);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      child.on("error", () => { problem ??= failure("unavailable", ERRORS.unavailable, 503); });
      child.stdin?.on("error", () => { problem ??= failure("upstream_error", ERRORS.upstream_error, 502); });
      child.stdout?.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT) stop(failure("upstream_error", "115 helper 输出过大", 502));
        else chunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT) stop(failure("upstream_error", "115 helper 输出过大", 502));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        if (problem) reject(problem);
        else if (code !== 0) reject(failure("upstream_error", ERRORS.upstream_error, 502));
        else {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { reject(failure("upstream_error", "115 helper 返回格式无效", 502)); }
        }
      });
      child.stdin?.end(body);
    });
  };
}

type Share = { kind: "share"; provider?: CloudProvider; shareCode: string; receiveCode: string };
type Crumb = { id: string; name: string; offset: number; page?: AlipanPagePosition };
type Folder = { kind: "folder"; shareId: string; parentId: string; name: string; offset: number; parents: Crumb[]; page?: AlipanPagePosition };
type File = { kind: "file"; shareId: string; fileId: string; name: string; size: number; sha1?: string; driveId?: string; updatedAt?: string };
type Reference = Share | Folder | File;
type AccessOnly = { kind: "access-only"; url: string; extractionCode?: string };
type StoredReference = Reference | AccessOnly;
type Envelope = { id: string; expiresAt: string; sealed: string };
type Entry = { id: string; name: string; directory: boolean; size: number; sha1?: string; driveId?: string; updatedAt?: string };

function identity(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function ref(id: string) { return `mori-share:${id}`; }
function refId(value: string) {
  const match = typeof value === "string" && /^mori-share:([a-f0-9]{64})$/.exec(value);
  if (!match) throw failure("invalid_reference", "分享引用无效，请重新搜索");
  return match[1];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw failure("upstream_error", "115 helper 返回格式无效", 502);
  return value as Record<string, unknown>;
}
function receiveCode(value: unknown, provider: CloudProvider = "p115") {
  if (typeof value !== "string" || !(provider === "alipan" ? /^(?:[A-Za-z0-9]{4})?$/ : /^[A-Za-z0-9]{0,32}$/).test(value.trim()))
    throw failure("invalid_input", "分享提取码格式无效");
  return value.trim();
}
function fileMetadata(value: unknown) {
  const data = object(value);
  if (
    typeof data.name !== "string" || !data.name.trim() || data.name.length > 512 ||
    /[\u0000-\u001f\u007f/\\]/u.test(data.name) || [".", ".."].includes(data.name) ||
    typeof data.size !== "number" || !Number.isSafeInteger(data.size) || data.size < 0 ||
    (data.sha1 !== undefined && (typeof data.sha1 !== "string" || !/^[a-fA-F0-9]{40}$/.test(data.sha1)))
  )
    throw failure("upstream_error", "115 helper 文件身份无效", 502);
  return { name: data.name, size: data.size, sha1: typeof data.sha1 === "string" ? data.sha1.toUpperCase() : undefined };
}

export class Shares implements ShareService {
  private active = 0;
  private closed = false;
  private closing?: Promise<void>;
  private operations = new Set<{ controller: AbortController; promise: Promise<unknown> }>();
  private resolveWaiters: { promise: Promise<unknown>; start: () => void; cancel: (error: unknown) => void }[] = [];
  constructor(private store: Store, private runner: ShareHelperRunner = createShareHelperRunner(), private alipan: AlipanAdapter = new Alipan(store)) {}

  private ensureOpen() {
    if (this.closed) throw failure("closed", "分享解析已关闭", 503);
  }

  private async operation<T>(action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.ensureOpen();
    aborted(signal);
    if (this.operations.size >= 2) throw failure("busy", "分享解析正忙，请稍后再试", 429);
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    const operation = { controller, promise };
    this.operations.add(operation);
    const finish = (ok: boolean, value: unknown) => {
      signal?.removeEventListener("abort", cancel);
      this.operations.delete(operation);
      this.startResolveWaiters();
      if (!ok) { reject(value); return; }
      try { aborted(controller.signal); this.ensureOpen(); resolve(value as T); }
      catch (error) { reject(error); }
    };
    try { Promise.resolve(action(controller.signal)).then((value) => finish(true, value), (error) => finish(false, error)); }
    catch (error) { finish(false, error); }
    return promise;
  }

  private startResolveWaiters() {
    while (!this.closed && this.operations.size < 2 && this.resolveWaiters.length) this.resolveWaiters[0].start();
  }

  private async resolveOperation<T>(action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.ensureOpen();
    aborted(signal);
    if (this.operations.size < 2) return this.operation(action, signal);
    if (this.resolveWaiters.length >= MAX_RESOLVE_WAITERS) throw failure("busy", "分享解析等待已满，请稍后再试", 429);
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    let waiting = true;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      const index = this.resolveWaiters.indexOf(waiter);
      if (index !== -1) this.resolveWaiters.splice(index, 1);
    };
    const stop = (error: unknown) => {
      if (!waiting) return;
      waiting = false;
      cleanup();
      reject(error);
    };
    const cancel = () => {
      try { aborted(signal); } catch (error) { stop(error); }
    };
    const waiter = {
      promise,
      cancel: stop,
      start: () => {
        if (!waiting) return;
        waiting = false;
        cleanup();
        this.operation(action, signal).then(resolve, reject);
      },
    };
    const timer = setTimeout(() => stop(failure("busy", "分享解析等待超时，请稍后再试", 429)), RESOLVE_WAIT_MS);
    signal?.addEventListener("abort", cancel, { once: true });
    this.resolveWaiters.push(waiter);
    return promise;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const operations = [...this.operations];
    const waiting = [...this.resolveWaiters];
    this.closing = (async () => {
      await Promise.allSettled([...operations.map((operation) => operation.promise), ...waiting.map((waiter) => waiter.promise)]);
      await this.alipan.close?.();
    })();
    for (const waiter of waiting) waiter.cancel(new DOMException("分享解析已关闭", "AbortError"));
    for (const operation of operations) operation.controller.abort(new DOMException("分享解析已关闭", "AbortError"));
    return this.closing;
  }

  private provider(share: Share): CloudProvider {
    const provider = share.provider ?? "p115";
    if (provider !== "p115" && provider !== "alipan") throw failure("invalid_reference", "分享来源无效");
    return provider;
  }
  private referenceId(share: Share, value: Folder | File) { return identity([this.provider(share), share.shareCode, value]); }
  private crumb(folder: Folder): Crumb {
    return { id: folder.parentId, name: folder.name, offset: folder.offset, ...(folder.page ? { page: folder.page } : {}) };
  }
  private file(entry: Entry, shareId: string, provider: CloudProvider): File {
    return { kind: "file", shareId, fileId: entry.id, name: entry.name, size: entry.size, sha1: entry.sha1,
      ...(provider === "alipan" ? { driveId: entry.driveId, ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}) } : {}) };
  }

  private protectedReferences() {
    const ids = new Set<string>();
    const protect = (value: unknown) => {
      const match = typeof value === "string" && /^mori-share:([a-f0-9]{64})$/.exec(value);
      if (match) ids.add(match[1]);
    };
    for (const task of this.store.list<DownloadTask>("task")) protect(task.url);
    for (const subscription of this.store.list<Subscription>("subscription")) {
      protect(subscription.share?.reference);
      protect(subscription.scan?.cursor?.root);
      for (const item of subscription.scan?.cursor?.frontier ?? []) protect(item.reference);
      for (const item of subscription.scan?.pending ?? []) {
        protect(item.resource.url);
        protect(item.resource.shareRef);
      }
    }
    for (const id of ids) {
      const record = this.store.privateRecord<StoredReference>(KIND, id);
      if (record?.kind === "file" || record?.kind === "folder") ids.add(record.shareId);
    }
    return ids;
  }

  private persist(records: Map<string, StoredReference>, signal?: AbortSignal) {
    aborted(signal);
    this.ensureOpen();
    this.store.transaction(() => {
      aborted(signal);
      const protectedIds = this.protectedReferences();
      const existing = new Set<string>();
      for (const record of this.store.list<Envelope>(KIND)) {
        if (Date.parse(record.expiresAt) <= Date.now() && !protectedIds.has(record.id))
          this.store.remove(KIND, record.id);
        else existing.add(record.id);
      }
      if (existing.size + [...records.keys()].filter((id) => !existing.has(id)).length > CAPACITY)
        throw failure("capacity", "分享引用已满，请等待未使用的引用过期", 429);
      const expiresAt = new Date(Date.now() + TTL).toISOString();
      for (const [id, record] of records) this.store.putPrivate(KIND, id, record, expiresAt);
    });
  }

  private load(id: string): Reference {
    const envelope = this.store.record<Envelope>(KIND, id);
    if (!envelope) throw failure("not_found", "分享引用不存在，请重新搜索", 404);
    if (Date.parse(envelope.expiresAt) <= Date.now() && !this.protectedReferences().has(id))
      throw failure("expired", ERRORS.expired, 410);
    const record = this.store.privateRecord<StoredReference>(KIND, id);
    if (!record) throw failure("not_found", "分享引用不存在，请重新搜索", 404);
    if (record.kind === "access-only") throw failure("invalid_reference", "该分享尚不支持浏览或下载");
    return record;
  }

  private folder(reference: string) {
    const id = refId(reference);
    const current = this.load(id);
    if (current.kind === "file") throw failure("invalid_reference", "该引用是文件，请选择下载");
    const shareId = current.kind === "share" ? id : current.shareId;
    const share = this.load(shareId);
    if (share.kind !== "share") throw failure("invalid_reference", "分享上下文无效");
    const folder: Folder = current.kind === "share"
      ? { kind: "folder", shareId, parentId: "0", name: "分享根目录", offset: 0, parents: [] }
      : current;
    return { folder, share };
  }

  private directoryKey(folder: Folder) {
    return this.store.privateId(["share-directory", folder.shareId, folder.parentId]);
  }

  private canonicalDirectory(reference: string) {
    const { folder, share } = this.folder(reference);
    const canonical = { ...folder, offset: 0, name: folder.parentId === "0" ? `${this.provider(share) === "alipan" ? "阿里" : "115"} 分享根目录` : folder.name };
    delete canonical.page;
    const key = this.directoryKey(canonical);
    return { folder: canonical, share, key, reference: ref(key) };
  }

  private publicResult(result: SearchResult, clean: SearchResult, publicUrl: string): SearchResult {
    const codes = new Set<string>();
    if (result.extractionCode?.trim()) codes.add(result.extractionCode.trim());
    try {
      const original = new URL(result.url);
      for (const [key, value] of [...original.searchParams, ...new URLSearchParams(original.hash.slice(1))])
        if (ACCESS_PARAMETER.test(key) && value.trim()) codes.add(value.trim());
      if (original.hash) {
        codes.add(original.hash.slice(1));
        try { codes.add(decodeURIComponent(original.hash.slice(1))); } catch { /* Keep the original fragment value. */ }
      }
    } catch { /* An unsupported non-URL can still carry a separate code. */ }
    const redact = (value: string) => {
      let text = result.url ? value.split(result.url).join(publicUrl) : value;
      for (const code of codes) {
        const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        text = text.replace(new RegExp(`((?:提取码|密码|\\bpwd\\b|\\bpassword\\b|\\breceive_code\\b|\\bpasscode\\b|\\baccess_code\\b)\\s*[:：=]\\s*)${escaped}(?![A-Za-z0-9_])`, "giu"), "$1[已隐藏]");
      }
      return text;
    };
    return {
      ...clean, url: publicUrl,
      id: this.store.privateId(["share-result", result.id, result.url, result.extractionCode ?? null]),
      title: redact(result.title), source: redact(result.source),
    };
  }

  private captureAccess(result: SearchResult, clean: SearchResult, url?: URL): SearchResult {
    if (result.kind !== "share" && result.kind !== "telegram") return clean;
    if (result.extractionCode !== undefined && typeof result.extractionCode !== "string")
      throw failure("invalid_input", "分享提取码格式无效");
    let sensitive = Boolean(result.extractionCode);
    if (url) {
      sensitive ||= Boolean(url.username || url.password);
      url.username = "";
      url.password = "";
      for (const key of [...url.searchParams.keys()]) {
        if (ACCESS_PARAMETER.test(key)) {
          sensitive = true;
          url.searchParams.delete(key);
        }
      }
      sensitive ||= Boolean(url.hash);
      url.hash = "";
    }
    if (!sensitive) return clean;
    const context: AccessOnly = {
      kind: "access-only", url: result.url,
      ...(result.extractionCode !== undefined ? { extractionCode: result.extractionCode } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(context)) > MAX_INPUT)
      throw failure("invalid_input", "分享访问上下文过大");
    const id = this.store.privateId(["share-access", result.url, result.extractionCode ?? null]);
    this.persist(new Map([[id, context]]));
    return this.publicResult(result, clean, url?.href ?? clean.url);
  }

  capture(result: SearchResult): SearchResult {
    this.ensureOpen();
    const clean: SearchResult = {
      id: result.id, title: result.title, url: result.url, source: result.source, kind: result.kind,
      ...(result.size !== undefined ? { size: result.size } : {}),
      ...(result.publishedAt !== undefined ? { publishedAt: result.publishedAt } : {}),
    };
    let url: URL;
    try { url = new URL(result.url); } catch { return this.captureAccess(result, clean); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return this.captureAccess(result, clean, url);
    const provider: CloudProvider = ["aliyundrive.com", "www.aliyundrive.com", "alipan.com", "www.alipan.com"].includes(url.hostname) ? "alipan" : "p115";
    const path = provider === "alipan" ? /^\/s\/([A-Za-z0-9_-]{1,256})\/?$/ : url.hostname === "share.115.com" ? /^\/([A-Za-z0-9]{1,64})\/?$/ : /^\/s\/([A-Za-z0-9]{1,64})\/?$/;
    if (provider === "p115" && !["115.com", "115cdn.com", "share.115.com"].includes(url.hostname)) return this.captureAccess(result, clean, url);
    const match = path.exec(url.pathname);
    if (!match) return this.captureAccess(result, clean, url);
    const shareCode = match[1];
    const id = identity([provider, "share", shareCode]);
    const suppliedCode = result.extractionCode || (provider === "p115" ? url.searchParams.get("password") : [...url.searchParams].find(([key]) => ACCESS_PARAMETER.test(key))?.[1]);
    this.store.transaction(() => {
      const envelope = this.store.record<Envelope>(KIND, id);
      const protectedContext = Boolean(envelope) && this.protectedReferences().has(id);
      const existing = envelope && (Date.parse(envelope.expiresAt) > Date.now() || protectedContext)
        ? this.store.privateRecord<Share>(KIND, id) : undefined;
      const code = protectedContext && existing ? existing.receiveCode
        : suppliedCode ? receiveCode(suppliedCode, provider) : existing?.receiveCode ?? "";
      this.persist(new Map([[id, { kind: "share", shareCode, receiveCode: code, ...(provider === "alipan" ? { provider } : {}) }]]));
    });
    const canonical = `https://${url.hostname}/${url.hostname === "share.115.com" ? "" : "s/"}${shareCode}`;
    return { ...this.publicResult(result, clean, canonical), kind: "share", shareRef: ref(id), provider };
  }

  private config(provider: CloudProvider = "p115", requireAuth = false) {
    const config = this.store.config().sources;
    if (provider === "alipan") {
      if (!config.alipanEnabled) throw failure("not_configured", "请先启用阿里分享解析", 409);
      if (requireAuth && !config.alipanRefreshToken.trim()) throw failure("auth_required", "阿里下载与目录追更需要配置账号授权", 409);
      return config;
    }
    if (!config.p115Enabled) throw failure("not_configured", "请先启用 115 分享解析", 409);
    if (typeof config.p115Cookie !== "string" || config.p115Cookie.length > 8192 || /[^\x20-\x7e]/u.test(config.p115Cookie) || (config.p115Cookie && !config.p115Cookie.trim()))
      throw failure("invalid_input", "115 Cookie 配置无效");
    return config;
  }

  private async limited<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    aborted(signal);
    if (this.active >= 2) throw failure("busy", "分享解析正忙，请稍后再试", 429);
    this.active++;
    try {
      const result = await action();
      aborted(signal);
      return result;
    } finally { this.active--; }
  }

  private async deadline<T>(action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    aborted(signal);
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("分享解析超时", "TimeoutError")), 25_000);
    try { return await action(controller.signal); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  }

  private async call(input: ShareHelperInput, signal?: AbortSignal) {
    aborted(signal);
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT) throw failure("invalid_input", "115 helper 输入过大");
    return this.limited(async () => {
      try {
      const reply = await this.runner(input, signal);
      aborted(signal);
      if (Buffer.byteLength(JSON.stringify(reply) ?? "") > MAX_OUTPUT)
        throw failure("upstream_error", "115 helper 输出过大", 502);
      const response = object(reply);
      if (response.ok === false) {
        const error = object(response.error);
        const code = typeof error.code === "string" && Object.hasOwn(ERRORS, error.code) ? error.code as keyof typeof ERRORS : "upstream_error";
        throw failure(code, ERRORS[code], code === "rate_limited" ? 429 : code === "unavailable" ? 503 : 502);
      }
      if (response.ok !== true) throw failure("upstream_error", "115 helper 返回格式无效", 502);
      return object(response.data);
    } catch (error) {
      aborted(signal);
      if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))
        throw new DOMException(error.name === "AbortError" ? "分享解析已取消" : "115 解析超时", error.name);
      if (error instanceof ShareError) throw error;
      throw failure("upstream_error", ERRORS.upstream_error, 502);
      }
    }, signal);
  }

  directory(reference: string): ShareDirectory {
    this.ensureOpen();
    const directory = this.canonicalDirectory(reference);
    this.persist(new Map([[directory.key, directory.folder]]));
    return { reference: directory.reference, title: directory.folder.name, provider: this.provider(directory.share) };
  }

  private relativeDirectories(folder: Folder, root: Folder) {
    if (folder.shareId !== root.shareId) throw failure("invalid_input", "分享扫描目录不属于订阅范围");
    const bound = root.parentId === "0" ? [] : [root.name];
    if (folder.parentId === root.parentId) return bound;
    const path = [...folder.parents, { id: folder.parentId, name: folder.name, offset: folder.offset }];
    const start = path.findIndex((item) => item.id === root.parentId);
    if (start < 0) throw failure("invalid_input", "分享扫描目录不属于订阅范围");
    return [...bound, ...path.slice(start + 1).map((item) => item.name)];
  }

  scan(reference: string, cursor?: ShareScanCursor, signal?: AbortSignal): Promise<ShareScanPage> {
    return this.operation((currentSignal) => this.scanDirectory(reference, cursor, currentSignal), signal);
  }

  private async scanDirectory(reference: string, cursor?: ShareScanCursor, signal?: AbortSignal): Promise<ShareScanPage> {
    aborted(signal);
    const root = this.canonicalDirectory(reference);
    const provider = this.provider(root.share);
    const config = this.config(provider, true);
    if (provider === "alipan") return this.deadline((currentSignal) => this.scanPage(root, config.p115Cookie, cursor, currentSignal), signal);
    return this.scanPage(root, config.p115Cookie, cursor, signal);
  }

  private async scanPage(root: { folder: Folder; share: Share; key: string; reference: string }, cookie: string, cursor?: ShareScanCursor, signal?: AbortSignal): Promise<ShareScanPage> {
    const invalid = () => failure("invalid_input", "分享扫描游标无效");
    const limit = () => failure("scan_limit", "分享目录扫描达到上限，请缩小订阅目录后重试", 409);
    let state: ShareScanCursor;
    if (cursor !== undefined) {
      if (!cursor || cursor.version !== 1 || cursor.root !== root.reference ||
        !Array.isArray(cursor.frontier) || !cursor.frontier.length || !Array.isArray(cursor.visited) ||
        !Number.isSafeInteger(cursor.pages) || cursor.pages < 0 || !Number.isSafeInteger(cursor.entries) || cursor.entries < 0)
        throw invalid();
      if (cursor.frontier.length > MAX_SCAN_DIRECTORIES || cursor.visited.length > MAX_SCAN_DIRECTORIES || cursor.pages > MAX_SCAN_PAGES || cursor.entries > MAX_SCAN_ENTRIES)
        throw limit();
      const visited = new Set(cursor.visited);
      if (visited.size !== cursor.visited.length || !visited.has(root.key) || cursor.visited.some((key) => typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)))
        throw invalid();
      const frontier = cursor.frontier.map((item) => {
        if (!item || typeof item.reference !== "string" || typeof item.directoryKey !== "string" ||
          !Number.isInteger(item.depth) || item.depth < 0 || !visited.has(item.directoryKey)) throw invalid();
        if (item.depth > MAX_SCAN_DEPTH) throw limit();
        const current = item.reference === root.reference ? root : this.folder(item.reference);
        if (this.directoryKey(current.folder) !== item.directoryKey || this.relativeDirectories(current.folder, root.folder).length - (root.folder.parentId === "0" ? 0 : 1) !== item.depth)
          throw invalid();
        return { reference: item.reference, directoryKey: item.directoryKey, depth: item.depth };
      });
      if (new Set(frontier.map((item) => item.directoryKey)).size !== frontier.length) throw invalid();
      state = { version: 1, root: root.reference, frontier, visited: [...visited], pages: cursor.pages, entries: cursor.entries };
    } else {
      state = { version: 1, root: root.reference, frontier: [{ reference: root.reference, directoryKey: root.key, depth: 0 }], visited: [root.key], pages: 0, entries: 0 };
    }
    if (state.pages >= MAX_SCAN_PAGES || state.entries >= MAX_SCAN_ENTRIES) throw limit();
    if (this.provider(root.share) === "alipan") await this.limited(() => this.alipan.authorize(signal), signal);
    const [head, ...frontier] = state.frontier;
    const current = head.reference === root.reference ? root : this.folder(head.reference);
    const directories = this.relativeDirectories(current.folder, root.folder);
    const page = await this.readPage(current.folder, current.share, cookie, current.share.receiveCode, signal, true);
    aborted(signal);
    const entries = state.entries + page.entries.length;
    if (entries > MAX_SCAN_ENTRIES) throw limit();
    const visited = new Set(state.visited);
    const records = new Map<string, Reference>([[root.key, root.folder], [refId(head.reference), current.folder]]);
    const files: ShareScanFile[] = [];
    for (const entry of page.entries) {
      if (entry.directory) {
        const child: Folder = { kind: "folder", shareId: current.folder.shareId, parentId: entry.id, name: entry.name, offset: 0, parents: [...current.folder.parents, this.crumb(current.folder)] };
        const key = this.directoryKey(child);
        if (visited.has(key) || [current.folder.parentId, ...current.folder.parents.map((item) => item.id)].includes(entry.id)) continue;
        if (visited.size >= MAX_SCAN_DIRECTORIES || head.depth + 1 > MAX_SCAN_DEPTH || child.parents.length > MAX_SCAN_DEPTH) throw limit();
        visited.add(key);
        const childId = this.referenceId(current.share, child);
        records.set(childId, child);
        frontier.push({ reference: ref(childId), directoryKey: key, depth: head.depth + 1 });
      } else {
        const file = this.file(entry, current.folder.shareId, this.provider(current.share));
        const fileId = this.referenceId(current.share, file);
        records.set(fileId, file);
        files.push({ resource: { id: fileId, title: entry.name, source: this.provider(current.share) === "alipan" ? "阿里云盘" : "115", kind: "cloud", provider: this.provider(current.share), url: ref(fileId), shareRef: ref(fileId), size: `${entry.size} B` }, directories: [...directories] });
      }
    }
    if (page.more) {
      const next = { ...current.folder, offset: current.folder.offset + page.entries.length, ...(page.nextPage ? { page: page.nextPage } : {}) };
      const nextId = this.referenceId(current.share, next);
      records.set(nextId, next);
      frontier.push({ reference: ref(nextId), directoryKey: head.directoryKey, depth: head.depth });
    }
    const nextCursor: ShareScanCursor = { version: 1, root: root.reference, frontier, visited: [...visited], pages: state.pages + 1, entries };
    records.set(current.folder.shareId, this.store.privateRecord<Share>(KIND, current.folder.shareId) ?? current.share);
    this.persist(records, signal);
    return { files, ...(frontier.length ? { cursor: nextCursor } : {}), complete: !frontier.length };
  }

  private async readPage(folder: Folder, share: Share, cookie: string, code: string, signal?: AbortSignal, allowRepeatedDirectories = false): Promise<{ entries: Entry[]; more: boolean; nextPage?: AlipanPagePosition }> {
    if (this.provider(share) === "alipan") {
      const data = await this.limited(() => this.alipan.list({ shareCode: share.shareCode, receiveCode: code, parentId: folder.parentId, ...(folder.page ? { page: folder.page } : {}) }, signal), signal);
      if (!Array.isArray(data.entries) || data.entries.length > PAGE_SIZE) throw failure("upstream_error", "阿里分享目录响应无效", 502);
      const opaque = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
      const identifiers = new Map<string, boolean>();
      const entries: Entry[] = data.entries.map((entry) => {
        if (!opaque(entry.id) || typeof entry.directory !== "boolean" || (!entry.directory && !opaque(entry.driveId)) ||
          (entry.updatedAt !== undefined && (typeof entry.updatedAt !== "string" || entry.updatedAt.length > 128 || !Number.isFinite(Date.parse(entry.updatedAt)))))
          throw failure("upstream_error", "阿里分享文件身份或drive ID无效", 502);
        const previous = identifiers.get(entry.id);
        if (previous !== undefined && (!allowRepeatedDirectories || !previous || !entry.directory)) throw failure("upstream_error", "阿里分享返回重复文件标识", 502);
        identifiers.set(entry.id, entry.directory);
        return { ...fileMetadata({ name: entry.name, size: entry.size }), id: entry.id, directory: entry.directory, ...(entry.driveId !== undefined ? { driveId: entry.driveId } : {}), ...(entry.updatedAt ? { updatedAt: new Date(entry.updatedAt).toISOString() } : {}) };
      });
      if (data.next) {
        const current = folder.page ?? { marker: "", index: 0 };
        if (typeof data.next.marker !== "string" || data.next.marker.length > 4096 || /[\u0000-\u001f\u007f]/u.test(data.next.marker) || !Number.isInteger(data.next.index) || data.next.index < 0 || data.next.index > 199 ||
          (data.next.marker === current.marker ? data.next.index <= current.index : !data.next.marker || data.next.index !== 0))
          throw failure("upstream_error", "阿里分享分页未前进", 502);
      }
      return { entries, more: Boolean(data.next), ...(data.next ? { nextPage: { marker: data.next.marker, index: data.next.index } } : {}) };
    }
    const data = await this.call({ op: "list", shareCode: share.shareCode, receiveCode: code, cookie, parentId: folder.parentId, offset: folder.offset }, signal);
    aborted(signal);
    if (!Array.isArray(data.entries) || data.entries.length > 100 ||
      (data.total !== undefined && (typeof data.total !== "number" || !Number.isSafeInteger(data.total) || data.total < 0)) ||
      (data.nextOffset !== undefined && (typeof data.nextOffset !== "number" || !Number.isInteger(data.nextOffset) || data.nextOffset <= folder.offset || data.nextOffset > MAX_OFFSET)))
      throw failure("upstream_error", "115 helper 目录分页无效", 502);
    const entries: Entry[] = data.entries.map((value) => {
      const entry = object(value);
      if (typeof entry.id !== "string" || !/^[1-9]\d{0,31}$/.test(entry.id) || typeof entry.directory !== "boolean")
        throw failure("upstream_error", "115 helper 文件标识无效", 502);
      return { ...fileMetadata(entry), id: entry.id, directory: entry.directory };
    });
    const identifiers = new Map<string, Entry>();
    for (const entry of entries) {
      const previous = identifiers.get(entry.id);
      if (previous && (!allowRepeatedDirectories || !previous.directory || !entry.directory))
        throw failure("upstream_error", "115 helper 返回了重复文件标识", 502);
      identifiers.set(entry.id, entry);
    }
    const visible = entries.slice(0, PAGE_SIZE);
    const more = entries.length > visible.length || (typeof data.total === "number" && folder.offset + visible.length < data.total) || data.nextOffset !== undefined;
    if (more && (!visible.length || folder.offset + visible.length > MAX_OFFSET)) throw failure("upstream_error", "115 helper 目录分页无效", 502);
    return { entries: visible, more };
  }

  browse(reference: string, extractionCode?: string, signal?: AbortSignal): Promise<SearchResult[]> {
    return this.operation((currentSignal) => this.browsePage(reference, extractionCode, currentSignal), signal);
  }

  private async browsePage(reference: string, extractionCode?: string, signal?: AbortSignal): Promise<SearchResult[]> {
    aborted(signal);
    const { folder, share } = this.folder(reference);
    const provider = this.provider(share);
    const config = this.config(provider);
    const shareId = folder.shareId;
    const code = extractionCode === undefined ? share.receiveCode : receiveCode(extractionCode, provider);
    const page = await this.readPage(folder, share, config.p115Cookie, code, signal);
    const records = new Map<string, Reference>();
    const results: SearchResult[] = [];
    const folderResult = (value: Folder, title: string, navigation: "folder" | "parent" | "next") => {
      const targetId = this.referenceId(share, value);
      records.set(targetId, value);
      results.push({ id: targetId, title, source: provider === "alipan" ? "阿里云盘" : "115", kind: "share", provider, url: ref(targetId), shareRef: ref(targetId), navigation });
    };
    for (const entry of page.entries) {
      if (entry.directory) {
        if (folder.parents.length >= 64 || [folder.parentId, ...folder.parents.map((parent) => parent.id)].includes(entry.id))
          throw failure("upstream_error", "115 分享目录层级无效", 502);
        folderResult({ kind: "folder", shareId, parentId: entry.id, name: entry.name, offset: 0, parents: [...folder.parents, this.crumb(folder)] }, entry.name, "folder");
      } else {
        const file = this.file(entry, shareId, provider);
        const fileId = this.referenceId(share, file);
        records.set(fileId, file);
        results.push({ id: fileId, title: entry.name, source: provider === "alipan" ? "阿里云盘" : "115", kind: "cloud", provider, url: ref(fileId), shareRef: ref(fileId), size: `${entry.size} B` });
      }
    }
    const parent = folder.parents.at(-1);
    if (parent) folderResult({ ...folder, parentId: parent.id, name: parent.name, offset: parent.offset, parents: folder.parents.slice(0, -1), ...(provider === "alipan" ? { page: parent.page } : {}) }, "上一级", "parent");
    if (page.more) {
      const offset = folder.offset + page.entries.length;
      folderResult({ ...folder, offset, ...(page.nextPage ? { page: page.nextPage } : {}) }, "下一页", "next");
    }
    const latest = this.store.privateRecord<Share>(KIND, shareId) ?? share;
    records.set(shareId, { ...latest, receiveCode: extractionCode === undefined ? latest.receiveCode : code });
    this.persist(records, signal);
    return results;
  }

  private downloadUrl(value: unknown): string {
    let url: URL;
    try { url = new URL(typeof value === "string" && value.length <= 8192 ? value : ""); }
    catch { throw failure("upstream_error", "分享下载地址无效", 502); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      throw failure("upstream_error", "分享下载地址无效", 502);
    return url.href;
  }

  async resolve(reference: string, signal?: AbortSignal): Promise<ResolvedShareFile> {
    this.ensureOpen();
    aborted(signal);
    this.resolveContext(reference);
    return this.resolveOperation((currentSignal) => this.resolveFile(reference, currentSignal), signal);
  }

  private resolveContext(reference: string) {
    const file = this.load(refId(reference));
    const share = file.kind === "share" ? file : this.load(file.shareId);
    if (share.kind !== "share") throw failure("invalid_reference", "分享上下文无效");
    const provider = this.provider(share);
    const config = this.config(provider, true);
    if (file.kind !== "file") throw failure("invalid_reference", "请选择分享中的具体文件");
    if (provider === "alipan" && !file.driveId) throw failure("upstream_error", "阿里分享文件缺少drive ID", 502);
    return { file, share, provider, config };
  }

  private async resolveFile(reference: string, signal?: AbortSignal): Promise<ResolvedShareFile> {
    aborted(signal);
    const { file, share, provider, config } = this.resolveContext(reference);
    if (provider === "alipan") {
      const data = await this.limited(() => this.alipan.link({ shareCode: share.shareCode, receiveCode: share.receiveCode, fileId: file.fileId, driveId: file.driveId! }, signal), signal);
      return { provider, url: this.downloadUrl(data.url), name: file.name, size: file.size, headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.alipan.com/" }, contentId: `alipan:${identity([share.shareCode, file.driveId, file.fileId, file.name, file.size, file.updatedAt ?? null])}` };
    }
    const data = await this.call({ op: "link", shareCode: share.shareCode, receiveCode: share.receiveCode, cookie: config.p115Cookie, fileId: file.fileId }, signal);
    aborted(signal);
    const metadata = fileMetadata(data);
    if (metadata.name !== file.name || metadata.size !== file.size || (file.sha1 !== undefined && metadata.sha1 !== file.sha1))
      throw failure("identity_changed", "分享文件身份已变化，请重新浏览后选择", 409);
    const headers = data.headers === undefined ? {} : object(data.headers);
    if (Object.entries(headers).some(([key, value]) => key !== "User-Agent" || value !== "Mozilla/5.0"))
      throw failure("upstream_error", "115 helper 返回了不允许的下载请求头", 502);
    return { provider, url: this.downloadUrl(data.url), ...metadata, headers: Object.hasOwn(headers, "User-Agent") ? { "User-Agent": "Mozilla/5.0" } : {}, contentId: `p115:${identity([share.shareCode, file.fileId, metadata])}` };
  }

  testConnection(provider: CloudProvider = "p115") {
    return this.operation((signal) => this.checkConnection(provider, signal));
  }

  private async checkConnection(provider: CloudProvider, signal: AbortSignal) {
    if (provider === "alipan") return this.limited(() => this.alipan.testConnection(signal), signal);
    const config = this.store.config().sources;
    const state = `${config.p115Enabled ? "分享解析已启用" : "分享解析未启用"}；${config.p115Cookie ? "已配置 Cookie" : "未配置 Cookie，可尝试公开分享"}；尚未验证账号或分享访问`;
    try {
      const data = await this.call({ op: "health" }, signal);
      const available = data.available === true && data.version === SDK_VERSION;
      return { ok: available, message: `${available ? `115 SDK ${SDK_VERSION} 已就绪` : ERRORS.unavailable}；${state}` };
    } catch (error) {
      return { ok: false, message: `${error instanceof Error ? error.message : ERRORS.upstream_error}；${state}` };
    }
  }
}
