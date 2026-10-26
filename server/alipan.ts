import type { Store } from "./store.js";
import { AlipanAuth, AlipanError, type AlipanCredentials } from "./alipan-auth.js";

export interface AlipanPagePosition { marker: string; index: number }
export interface AlipanEntry {
  id: string;
  name: string;
  directory: boolean;
  size: number;
  driveId?: string;
  updatedAt?: string;
}
export interface AlipanPage { entries: AlipanEntry[]; next?: AlipanPagePosition }
export interface AlipanAdapter {
  list(input: { shareCode: string; receiveCode: string; parentId: string; page?: AlipanPagePosition }, signal?: AbortSignal): Promise<AlipanPage>;
  link(input: { shareCode: string; receiveCode: string; fileId: string; driveId: string }, signal?: AbortSignal): Promise<{ url: string }>;
  authorize(signal?: AbortSignal): Promise<void>;
  testConnection(signal?: AbortSignal): Promise<{ ok: boolean; message: string; code?: string }>;
  close?(): Promise<void>;
}

const ENDPOINT = {
  refresh: "https://auth.alipan.com/v2/account/token",
  share: "https://api.alipan.com/v2/share_link/get_share_token",
  list: "https://api.alipan.com/adrive/v3/file/list",
  link: "https://api.alipan.com/v2/file/get_share_link_download_url",
} as const;
const CANARY = "client=web,app=share,version=v2.3.1";
const MAX_JSON = 1024 * 1024;
const MAX_TOKEN = 16_384;
const HTTP_TIMEOUT = 8000;
const OPERATION_TIMEOUT = 25_000;

function upstream(status = 502) {
  return new AlipanError("alipan_upstream_error", "阿里云盘暂时无法完成请求，请稍后再试", status);
}
function invalidInput() {
  return new AlipanError("alipan_invalid_input", "阿里云盘分享请求无效，请重新浏览分享", 400);
}
function cancelled() {
  return new AlipanError("alipan_cancelled", "阿里云盘分享访问已取消", 409);
}
function closed() {
  return new AlipanError("alipan_closed", "阿里云盘访问已关闭", 409);
}
function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === "string" && value.length <= max && (empty || value.trim().length > 0) && !/[\u0000-\u001f\u007f]/u.test(value);
}
function token(value: unknown): value is string {
  return text(value, MAX_TOKEN) && !/[^\x21-\x7e]/u.test(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw upstream();
  return value as Record<string, unknown>;
}
function shareInput(input: { shareCode: string; receiveCode: string }) {
  if (!input || typeof input.shareCode !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(input.shareCode) ||
      typeof input.receiveCode !== "string" || !/^(?:[A-Za-z0-9]{4})?$/u.test(input.receiveCode)) throw invalidInput();
}

class ResponseError extends Error {
  constructor(readonly status: number, readonly apiCode?: string) { super("阿里云盘返回错误响应"); }
}

function mapped(error: unknown, refresh = false): AlipanError {
  if (error instanceof AlipanError) return error;
  if (error instanceof ResponseError) {
    if (refresh && (error.apiCode === "InvalidParameter.RefreshToken" || error.status === 401 || error.status === 403))
      return new AlipanError("alipan_auth_invalid", "阿里网页登录凭据已失效，请在设置中重新提供凭据", 409);
    if (error.status === 429)
      return new AlipanError("alipan_rate_limited", "阿里云盘请求过于频繁，请稍后再试", 429);
    if (!refresh && (error.status === 404 || error.apiCode === "NotFound.File" || error.apiCode === "NotFound.FileId"))
      return new AlipanError("alipan_file_not_found", "分享中的文件已不存在，请重新浏览", 404);
    if (!refresh && (error.status === 401 || error.status === 403 || ["AccessTokenInvalid", "ShareLinkTokenInvalid", "Forbidden"].includes(error.apiCode || "")))
      return new AlipanError("alipan_share_unavailable", "阿里云盘分享不可用或权限不足，请检查链接和提取码", 403);
  }
  return upstream();
}

async function timed<T>(parent: AbortSignal | undefined, milliseconds: number, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (parent?.aborted) throw cancelled();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  timer.unref();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  try { return await action(signal); }
  catch (error) {
    if (error instanceof AlipanError) throw error;
    if (controller.signal.aborted) throw upstream(504);
    if (parent?.aborted) throw cancelled();
    throw error;
  } finally { clearTimeout(timer); }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/u.test(length) || Number(length) > MAX_JSON)) {
    await response.body?.cancel();
    throw upstream();
  }
  const reader = response.body?.getReader();
  if (!reader) throw upstream();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_JSON) { await reader.cancel(); throw upstream(); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))));
}

function entries(value: unknown): AlipanEntry[] {
  if (!Array.isArray(value) || value.length > 200) throw upstream();
  const ids = new Set<string>();
  return value.map((raw) => {
    const item = object(raw);
    if (!text(item.file_id, 256) || ids.has(item.file_id) || !text(item.name, 512) || /[/\\]/u.test(item.name) ||
        (item.type !== "file" && item.type !== "folder")) throw upstream();
    ids.add(item.file_id);
    const directory = item.type === "folder";
    if (!directory && (typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0)) throw upstream();
    const result: AlipanEntry = { id: item.file_id, name: item.name, directory, size: directory ? 0 : item.size as number };
    if (item.drive_id !== undefined) {
      if (!text(item.drive_id, 256)) throw upstream();
      result.driveId = item.drive_id;
    }
    if (text(item.updated_at, 64) && Number.isFinite(Date.parse(item.updated_at))) result.updatedAt = new Date(item.updated_at).toISOString();
    return result;
  });
}

export class Alipan implements AlipanAdapter {
  private readonly auth: AlipanAuth;
  private stopping = false;
  private readonly controllers = new Set<AbortController>();
  private readonly running = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  constructor(private readonly store: Store, private readonly fetcher: typeof fetch = fetch) {
    this.auth = new AlipanAuth(store, (refreshToken, signal) => this.refresh(refreshToken, signal));
  }

  private enabled() {
    if (this.stopping) throw closed();
    if (!this.store.config().sources.alipanEnabled)
      throw new AlipanError("alipan_unavailable", "阿里云盘分享未启用", 503);
  }

  private operation<T>(signal: AbortSignal | undefined, action: (active: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(closed());
    const controller = new AbortController();
    this.controllers.add(controller);
    const parent = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const pending = (async () => {
      try {
        return await timed(parent, OPERATION_TIMEOUT, async (active) => {
          this.enabled();
          const result = await action(active);
          if (active.aborted) throw new DOMException("分享访问已取消", "AbortError");
          this.enabled();
          return result;
        });
      } catch (error) { throw mapped(error); }
      finally { this.controllers.delete(controller); }
    })();
    this.running.add(pending);
    const done = () => { this.running.delete(pending); };
    void pending.then(done, done);
    return pending;
  }

  private request(url: typeof ENDPOINT[keyof typeof ENDPOINT], body: Record<string, unknown>, signal: AbortSignal, headers: Record<string, string> = {}) {
    return timed(signal, HTTP_TIMEOUT, async (active) => {
      this.enabled();
      const response = await this.fetcher(url, {
        method: "POST", redirect: "error", signal: active,
        headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel();
        throw upstream();
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        throw new ResponseError(response.status);
      }
      let result: Record<string, unknown>;
      try { result = await json(response); }
      catch (error) {
        if (!response.ok && !active.aborted) throw new ResponseError(response.status);
        throw error;
      }
      const code = result.code === undefined || result.code === "" ? undefined : result.code;
      if (!response.ok || code !== undefined) throw new ResponseError(response.status, text(code, 128) ? code : undefined);
      return result;
    });
  }

  private async refresh(refreshToken: string, signal: AbortSignal): Promise<AlipanCredentials> {
    try {
      if (!token(refreshToken)) throw invalidInput();
      const result = await this.request(ENDPOINT.refresh, { refresh_token: refreshToken, grant_type: "refresh_token" }, signal);
      if (!token(result.access_token) || !token(result.refresh_token)) throw upstream();
      const now = Date.now(), expiries: number[] = [];
      if (typeof result.expires_in === "number" && Number.isSafeInteger(result.expires_in) && result.expires_in >= 0 && Number.isSafeInteger(now + result.expires_in * 1000))
        expiries.push(now + result.expires_in * 1000);
      if (text(result.expire_time, 64) && Number.isFinite(Date.parse(result.expire_time))) expiries.push(Date.parse(result.expire_time));
      const expiresAt = expiries.length && Math.min(...expiries) > now ? Math.min(...expiries) : 0;
      // Keep a complete rotated pair even after late cancellation; Auth persists it before releasing waiters.
      return { accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt };
    } catch (error) { throw mapped(error, true); }
  }

  private async shareToken(shareCode: string, receiveCode: string, signal: AbortSignal) {
    const result = await this.request(ENDPOINT.share, { share_id: shareCode, ...(receiveCode ? { share_pwd: receiveCode } : {}) }, signal);
    if (!token(result.share_token)) throw upstream();
    return result.share_token;
  }

  list(input: { shareCode: string; receiveCode: string; parentId: string; page?: AlipanPagePosition }, signal?: AbortSignal): Promise<AlipanPage> {
    return this.operation(signal, async (active) => {
      shareInput(input);
      if (!text(input.parentId, 256)) throw invalidInput();
      if (input.page !== undefined && (!input.page || typeof input.page !== "object" || Array.isArray(input.page) ||
          !text(input.page.marker, 4096, true) || !Number.isInteger(input.page.index))) throw invalidInput();
      const marker = input.page?.marker ?? "", index = input.page?.index ?? 0;
      if (!text(marker, 4096, true) || !Number.isInteger(index) || index < 0 || index > 199) throw invalidInput();
      const share = await this.shareToken(input.shareCode, input.receiveCode, active);
      const result = await this.request(ENDPOINT.list, {
        share_id: input.shareCode, parent_file_id: input.parentId === "0" ? "root" : input.parentId,
        limit: 20, marker, order_by: "name", order_direction: "ASC",
      }, active, { "x-share-token": share, "X-Canary": CANARY });
      const all = entries(result.items);
      const nextMarker = result.next_marker === undefined ? "" : result.next_marker;
      if (!text(nextMarker, 4096, true) || (nextMarker && nextMarker === marker) || (index > 0 && index >= all.length)) throw upstream();
      const page: AlipanPage = { entries: all.slice(index, index + 20) };
      const end = index + page.entries.length;
      if (end < all.length) page.next = { marker, index: end };
      else if (nextMarker) page.next = { marker: nextMarker, index: 0 };
      return page;
    });
  }

  link(input: { shareCode: string; receiveCode: string; fileId: string; driveId: string }, signal?: AbortSignal): Promise<{ url: string }> {
    return this.operation(signal, async (active) => {
      shareInput(input);
      if (!text(input.fileId, 256) || !text(input.driveId, 256)) throw invalidInput();
      let access = await this.auth.access(active);
      const share = await this.shareToken(input.shareCode, input.receiveCode, active);
      const read = () => this.request(ENDPOINT.link, { share_id: input.shareCode, drive_id: input.driveId, file_id: input.fileId, expire_sec: 600 }, active,
        { Authorization: "Bearer " + access, "x-share-token": share, "X-Canary": CANARY });
      let result: Record<string, unknown>;
      try { result = await read(); }
      catch (error) {
        if (!(error instanceof ResponseError) || error.apiCode !== "AccessTokenInvalid") throw error;
        access = await this.auth.access(active, true);
        result = await read();
      }
      if (!text(result.download_url, 8192) || /\s/u.test(result.download_url)) throw upstream();
      const url = new URL(result.download_url);
      if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) throw upstream();
      return { url: url.href };
    });
  }

  authorize(signal?: AbortSignal): Promise<void> {
    return this.operation(signal, async (active) => { await this.auth.access(active); });
  }

  async testConnection(signal?: AbortSignal): Promise<{ ok: boolean; message: string; code?: string }> {
    try {
      await this.operation(signal, async (active) => { await this.auth.access(active, true); });
      return { ok: true, message: "阿里网页登录凭据已验证；尚未验证分享权限或下载权益" };
    } catch (error) {
      const failure = mapped(error);
      return { ok: false, message: failure.message, code: failure.code };
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    for (const controller of this.controllers) controller.abort();
    this.closing = Promise.allSettled([Promise.allSettled([...this.running]), this.auth.close()]).then(([, auth]) => {
      if (auth.status === "rejected") throw auth.reason;
    });
    return this.closing;
  }
}
