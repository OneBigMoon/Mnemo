import { createHash, randomUUID } from "node:crypto";
// link/rename 经 fsp.* 调用（默认导出对象可在测试里替换），其余走命名导入。
import { constants, promises as fsp } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AppConfig,
  DownloadProgress,
  DownloadTask,
  MediaInfo,
  MediaService,
  ProfileId,
  ResolvedShareFile,
  ResourceKind,
  SearchFailureCode,
  SearchReport,
  SearchResult,
  SearchSource,
  SearchSourceDiagnostic,
  ShareService,
} from "../shared/types.ts";
import { searchFailureMessage } from "../shared/search.ts";
import { matchResource } from "./matching.ts";
import { loadRegistry, HealthTracker } from "./source-registry.js";
import { guardEndpoint, registrySearch, settleSearchSources } from "./registry-search.js";
import { detailUrl, parseVodDetail } from "./cms-detail.js";
import { CORE_PAYLOAD_LIMIT, coreEngine, runRustCore, RustCoreError } from "./rust-core.js";

// 注册表源的健康追踪（模块级实例；进程内递增禁用，重启复位）。
const registryHealth = new HealthTracker();
function nowMinutes(): number {
  return Math.floor(Date.now() / 60000);
}

const OUTPUT_FILE_MODE = 0o644;
const OUTPUT_DIRECTORY_MODE = 0o755;
const smallWrites = new Map<string, Promise<void>>(); // concurrent episodes share tvshow.nfo

const MEDIA_EXT = new Set([
  ".mp4",
  ".mkv",
  ".avi",
  ".mov",
  ".webm",
  ".m4v",
  ".ts",
  ".m2ts",
  ".mpg",
  ".mpeg",
  ".wmv",
  ".flv",
  ".vob",
]);
const PROFILES: ProfileId[] = ["emby", "jellyfin", "fnos", "ugreen", "kodi"];
const JSON_LIMIT = 2 * 1024 * 1024;
const MAX_MEDIA_BYTES = 200 * 1024 ** 3;
const REQUEST_TIMEOUT = 20_000;
const MAX_DOWNLOAD_MS = 12 * 60 * 60 * 1000;
type Json = Record<string, unknown>;
type Root = { directory: string; dev: number; ino: number };
type Resume = {
  source: string;
  filename: string;
  validator: string;
  total: number;
};

export class MediaError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function errno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}
function safeError(error: unknown): string {
  if (error instanceof MediaError) return error.message;
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
    return "操作已取消或超时";
  return "连接或文件操作失败，请检查配置、权限和服务日志";
}

function httpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new MediaError("INVALID_URL", "链接不是有效的 HTTP(S) 地址");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new MediaError(
      "INVALID_URL",
      "仅支持不含内嵌账号密码的 HTTP(S) 地址",
    );
  url.hash = "";
  return url;
}

function endpoint(base: string, suffix: string): URL {
  if (!base.trim()) throw new MediaError("NOT_CONFIGURED", "请先配置服务地址");
  const url = httpUrl(base);
  url.search = "";
  const current = url.pathname.replace(/\/+$/, "");
  url.pathname = current.endsWith(suffix) ? current : `${current}${suffix}`;
  return url;
}

async function limitedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body)
    throw new MediaError("EMPTY_RESPONSE", "服务没有返回内容");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit)
        throw new MediaError("RESPONSE_TOO_LARGE", "服务响应超过大小上限");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks, bytes);
}

async function request(
  url: URL,
  init: RequestInit = {},
  limit = JSON_LIMIT,
): Promise<Buffer> {
  const signal = AbortSignal.any([
    init.signal ?? new AbortController().signal,
    AbortSignal.timeout(REQUEST_TIMEOUT),
  ]);
  const response = await fetch(url, { ...init, signal, redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel();
    throw new MediaError(
      "HTTP_ERROR",
      `服务返回 HTTP ${response.status}，请检查地址和凭据`,
    );
  }
  return limitedBody(response, limit);
}

async function jsonRequest(
  url: URL,
  init: RequestInit = {},
  rpcResponse = false,
): Promise<Json> {
  const body = await request(url, init);
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new MediaError(
      "INVALID_RESPONSE",
      "服务没有返回有效 JSON，请检查 API 地址",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MediaError("INVALID_RESPONSE", "服务响应结构不正确");
  const result = object(value);
  if (
    result.success === false ||
    (typeof result.code === "number" && ![0, 200].includes(result.code)) ||
    (result.error && !(rpcResponse && result.jsonrpc === "2.0"))
  )
    throw new MediaError(
      "SERVICE_ERROR",
      "服务拒绝请求，请检查账号、权限和服务日志",
    );
  return result;
}

function post(
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  };
}

function searchFailureCode(error: unknown): SearchFailureCode {
  if (error instanceof RustCoreError) {
    if (error.code === "CORE_BUSY") return "busy";
    if (error.code === "CORE_TIMEOUT") return "timeout";
    if (error.code.startsWith("CORE_")) return "core_unavailable";
    return "invalid_response";
  }
  const name = text(object(error).name);
  const code = text(object(error).code);
  const cause = text(object(object(error).cause).code);
  if (
    name === "TimeoutError" || code === "ETIMEDOUT" ||
    ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(cause)
  )
    return "timeout";
  if (error instanceof MediaError) {
    if (["INVALID_RESPONSE", "EMPTY_RESPONSE", "RESPONSE_TOO_LARGE"].includes(error.code))
      return "invalid_response";
    if (error.code === "HTTP_ERROR") {
      const status = /\bHTTP\s+(\d{3})\b/u.exec(error.message)?.[1];
      if (status === "401" || status === "403") return "auth_required";
      if (status === "429") return "rate_limited";
    }
    if (["INVALID_URL", "INVALID_CHANNEL", "NOT_CONFIGURED"].includes(error.code))
      return "unreachable";
    return "upstream_error";
  }
  return error instanceof TypeError ? "unreachable" : "upstream_error";
}

export function classifyResourceUrl(input: string): ResourceKind {
  if (/^magnet:\?/i.test(input)) return "magnet";
  if (input.startsWith("openlist:")) return "openlist";
  const url = httpUrl(input);
  const host = url.hostname.toLowerCase();
  if (host === "t.me" || host === "telegram.me") return "telegram";
  if (
    [
      "baidu.com",
      "aliyundrive.com",
      "alipan.com",
      "quark.cn",
      "115.com",
      "115cdn.com",
      "123pan.com",
      "123865.com",
      "123684.com",
      "cloud.189.cn",
      "drive.google.com",
      "pan.xunlei.com",
      "pan.uc.cn",
      "caiyun.139.com",
      "pikpak.com",
      "mypikpak.com",
    ].some((domain) => host === domain || host.endsWith(`.${domain}`)) ||
    /lanzou[a-z]*\./i.test(host) ||
    host.startsWith("pan.") ||
    url.pathname.endsWith(".torrent")
  )
    return "share";
  return "direct";
}

function result(
  url: string,
  title: string,
  source: string,
  publishedAt?: string,
  size?: string,
): SearchResult | undefined {
  if (!url || url.length > 8192) return;
  try {
    return {
      id: hash(url).slice(0, 24),
      url,
      title: title.slice(0, 300) || "未命名资源",
      source,
      kind: classifyResourceUrl(url),
      ...(publishedAt ? { publishedAt } : {}),
      ...(size ? { size } : {}),
    };
  } catch {
    return;
  }
}

export function normalizePanSou(payload: unknown): SearchResult[] {
  const root = object(payload);
  const data =
    root.data && typeof root.data === "object" ? object(root.data) : root;
  const found: SearchResult[] = [];
  const add = (entry: Json, fallback: Json = {}) => {
    const item = result(
      text(entry.url),
      text(entry.work_title) ||
        text(entry.note) ||
        text(entry.title) ||
        text(fallback.title) ||
        text(fallback.content),
      `PanSou · ${text(entry.source) || text(fallback.channel) || text(entry.type) || "资源"}`,
      text(entry.datetime) || text(fallback.datetime),
      text(entry.size),
    );
    if (item) {
      item.extractionCode =
        text(entry.password) ||
        text(entry.pwd) ||
        text(entry.passcode) ||
        text(entry.extraction_code) ||
        text(entry.extractionCode) ||
        text(entry["提取码"]) ||
        text(fallback.password) ||
        text(fallback.pwd) ||
        text(fallback.passcode) ||
        text(fallback.extraction_code) ||
        text(fallback.extractionCode) ||
        text(fallback["提取码"]) ||
        undefined;
      found.push(item);
    }
  };
  for (const group of Object.values(object(data.merged_by_type)).slice(0, 30))
    for (const entry of list(group).slice(0, 100)) add(object(entry));
  for (const raw of list(data.results).slice(0, 100)) {
    const entry = object(raw);
    if (entry.url) add(entry);
    for (const item of list(entry.links).slice(0, 30)) add(object(item), entry);
    if (!entry.url && !list(entry.links).length) {
      for (const url of (
        text(entry.content).match(/(?:https?:\/\/|magnet:\?)[^\s<>"']+/g) ?? []
      ).slice(0, 20))
        add({ url }, entry);
    }
  }
  const unique = new Map<string, SearchResult>();
  for (const item of found) {
    const previous = unique.get(item.url);
    unique.set(item.url, {
      ...item,
      extractionCode: item.extractionCode || previous?.extractionCode,
    });
  }
  return [...unique.values()].slice(0, 100);
}

function openListPath(value: string): string {
  const raw = value.replace(/^openlist:/, "");
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new MediaError("INVALID_PATH", "OpenList 路径编码无效");
  }
  if (
    !decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    decoded.includes("\\") ||
    /[\x00-\x1f]/.test(decoded) ||
    decoded.split("/").some((part) => part === ".." || part === ".")
  )
    throw new MediaError(
      "INVALID_PATH",
      "OpenList 路径必须是绝对文件路径，不能包含路径穿越",
    );
  return decoded;
}

function decodeHtml(value: string): string {
  return value.replace(
    /&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[\da-f]+|\d+);/gi,
    (entity) => {
      const names: Record<string, string> = {
        "&amp;": "&",
        "&quot;": '"',
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">",
        "&nbsp;": " ",
      };
      if (names[entity]) return names[entity];
      const code = entity.startsWith("&#x")
        ? parseInt(entity.slice(3), 16)
        : parseInt(entity.slice(2), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    },
  );
}

function telegramChannel(value: string): string {
  const channel = value
    .trim()
    .replace(/^https:\/\/t\.me\/(?:s\/)?/, "")
    .replace(/^@/, "")
    .replace(/\/$/, "");
  if (!/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(channel))
    throw new MediaError(
      "INVALID_CHANNEL",
      "Telegram 公共频道须填写 @频道名或 https://t.me/s/频道名",
    );
  return channel;
}

export function sanitizeFilename(value: string): string {
  let name = value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_")
    .replace(/^\.+|[. ]+$/g, "")
    .trim();
  if (!name) name = "media";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    name = `_${name}`;
  const chars = [...name].slice(0, 160);
  while (Buffer.byteLength(chars.join("")) > 170) chars.pop();
  return chars.join("");
}

function mediaStem(task: DownloadTask, rename: boolean): string {
  const media = task.media;
  let name = rename ? media.title || task.title : task.title;
  if (
    rename &&
    Number.isInteger(media.year) &&
    media.year! > 1800 &&
    media.year! < 2200
  )
    name += ` (${media.year})`;
  if (
    rename &&
    media.type === "tv" &&
    Number.isInteger(media.season) &&
    media.season! >= 0 &&
    Number.isInteger(media.episode) &&
    media.episode! > 0
  )
    name += ` - S${String(media.season).padStart(2, "0")}E${String(media.episode).padStart(2, "0")}`;
  return sanitizeFilename(
    name.replace(
      /\.(?:mp4|mkv|avi|mov|webm|m4v|ts|m2ts|mpg|mpeg|wmv|flv|vob)$/i,
      "",
    ),
  );
}

function episodeFolders(task: DownloadTask): [string, string] | undefined {
  const media = task.media;
  if (
    media.type !== "tv" ||
    !Number.isInteger(media.season) ||
    media.season! < 0 ||
    !Number.isInteger(media.episode) ||
    media.episode! < 1
  )
    return;
  const title = media.title || task.title;
  const year =
    Number.isInteger(media.year) && media.year! > 1800 && media.year! < 2200
      ? ` (${media.year})`
      : "";
  return [
    sanitizeFilename(`${title}${year}`),
    `Season ${String(media.season).padStart(2, "0")}`,
  ];
}

function mediaRelative(task: DownloadTask, rename: boolean, ext: string): string {
  const name = `${mediaStem(task, rename)}${ext}`;
  const folders = episodeFolders(task);
  return folders ? `${folders[0]}/${folders[1]}/${name}` : name;
}

async function downloadRoot(directory: string): Promise<Root> {
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) === path.parse(directory).root
  )
    throw new MediaError(
      "INVALID_DIRECTORY",
      "下载目录必须是专用绝对路径，不能使用文件系统根目录",
    );
  const existed = await lstat(directory).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  await mkdir(directory, { recursive: true, mode: OUTPUT_DIRECTORY_MODE });
  if (!existed) await chmod(directory, OUTPUT_DIRECTORY_MODE);
  const configured = await lstat(directory);
  if (!configured.isDirectory() || configured.isSymbolicLink())
    throw new MediaError("UNSAFE_PATH", "下载目录不能是符号链接");
  const resolved = await realpath(directory);
  const stat = await lstat(resolved);
  return { directory: resolved, dev: stat.dev, ino: stat.ino };
}

async function checkRoot(root: Root): Promise<void> {
  const stat = await lstat(root.directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== root.dev ||
    stat.ino !== root.ino ||
    (await realpath(root.directory)) !== root.directory
  )
    throw new MediaError(
      "UNSAFE_PATH",
      "下载目录在操作期间发生变化，已停止写入",
    );
}

function child(root: Root, name: string): string {
  if (
    name !== path.basename(name) ||
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("\\")
  )
    throw new MediaError("INVALID_PATH", "文件名不能包含路径");
  const target = path.join(root.directory, name);
  if (path.dirname(target) !== root.directory)
    throw new MediaError("INVALID_PATH", "目标文件超出下载目录");
  return target;
}

function relativeTarget(root: Root, relative: string): string {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(relative)
  )
    throw new MediaError("INVALID_PATH", "目标文件路径无效");
  const parts = relative.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part !== path.basename(part) ||
        Buffer.byteLength(part) > 255,
    )
  )
    throw new MediaError("INVALID_PATH", "目标文件超出下载目录");
  const target = path.join(root.directory, ...parts);
  const check = path.relative(root.directory, target);
  if (
    !check ||
    check.startsWith(`..${path.sep}`) ||
    check === ".." ||
    path.isAbsolute(check)
  )
    throw new MediaError("INVALID_PATH", "目标文件超出下载目录");
  return target;
}

async function ensureDirectories(
  root: Root,
  relative: string,
): Promise<void> {
  await checkRoot(root);
  let current = root.directory;
  for (const part of relative.split("/").slice(0, -1)) {
    current = path.join(current, part);
    let created = false;
    try {
      await mkdir(current, { mode: OUTPUT_DIRECTORY_MODE });
      created = true;
    } catch (error) {
      if (!errno(error, "EEXIST")) throw error;
    }
    if (created) await chmod(current, OUTPUT_DIRECTORY_MODE);
    const stat = await lstat(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(current)) !== current
    )
      throw new MediaError("UNSAFE_PATH", "剧集目录不能是符号链接");
  }
  await checkRoot(root);
}

async function checkedRelative(root: Root, file: string): Promise<string> {
  await checkRoot(root);
  const relative = path.relative(root.directory, file);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative.includes("\\")
  )
    throw new MediaError("UNSAFE_PATH", "媒体文件必须位于当前下载目录内");
  let current = root.directory;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink())
      throw new MediaError("UNSAFE_PATH", "媒体文件路径不能包含符号链接");
  }
  return relative;
}

async function regularFile(
  file: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new MediaError("UNSAFE_PATH", "目标必须是普通文件，不能是链接");
    return stat;
  } catch (error) {
    if (errno(error, "ENOENT")) return;
    throw error;
  }
}

async function requireAbsent(file: string): Promise<void> {
  try {
    await lstat(file);
  } catch (error) {
    if (errno(error, "ENOENT")) return;
    throw error;
  }
  throw new MediaError(
    "FILE_EXISTS",
    "目标文件已存在；为保护媒体不会覆盖，请核对文件或更改任务名称",
  );
}

async function removeFile(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if (!errno(error, "ENOENT")) throw error;
  }
}

async function readLocal(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
      throw new MediaError("UNSAFE_PATH", "本地文件类型或大小不符合预期");
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, null);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count > limit)
      throw new MediaError("UNSAFE_PATH", "本地文件在读取期间超过大小上限");
    return bytes.subarray(0, count);
  } finally {
    await handle.close();
  }
}

// link(2) 在不支持硬链接的文件系统上的典型错误：macOS exFAT 报 ENOTSUP，
// Linux 的 vfat/exfat/FUSE 常报 EPERM/ENOSYS。仅这些码触发拷贝回退。
const COPY_PUBLISH_ERRNO = new Set(["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS"]);
// 拷贝回退没有 link(2) 的原子不覆盖语义，改为进程内按目标串行化发布。
const publications = new Map<string, Promise<void>>();

async function copyPublish(
  root: Root,
  temporary: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const previous = publications.get(destination);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  publications.set(destination, current);
  try {
    if (previous) await previous;
    signal?.throwIfAborted();
    await requireAbsent(destination);
    const copy = child(root, `.mori-publish-${randomUUID()}.tmp`);
    try {
      const source = await open(
        temporary,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const target = await open(
          copy,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          OUTPUT_FILE_MODE,
        );
        try {
          await target.chmod(OUTPUT_FILE_MODE);
          const buffer = Buffer.alloc(1024 * 1024);
          for (;;) {
            signal?.throwIfAborted();
            const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            let written = 0;
            while (written < bytesRead) {
              const part = await target.write(buffer, written, bytesRead - written);
              if (!part.bytesWritten)
                throw new MediaError("WRITE_FAILED", "磁盘写入没有进展");
              written += part.bytesWritten;
            }
          }
          await target.sync();
        } finally {
          await target.close();
        }
      } finally {
        await source.close();
      }
      await checkRoot(root);
      signal?.throwIfAborted();
      await requireAbsent(destination);
      await fsp.rename(copy, destination);
    } catch (error) {
      await removeFile(copy);
      throw error;
    }
  } finally {
    release();
    if (publications.get(destination) === current)
      publications.delete(destination);
  }
}

async function publish(
  root: Root,
  temporary: string,
  filename: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  await checkRoot(root);
  const relative = path.relative(root.directory, temporary);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    (await realpath(temporary)) !== temporary ||
    !(await regularFile(temporary))
  )
    throw new MediaError("UNSAFE_PATH", "临时文件超出下载目录或不是普通文件");
  const handle = await open(
    temporary,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    await handle.chmod(OUTPUT_FILE_MODE);
  } finally {
    await handle.close();
  }
  const destination = relativeTarget(root, filename);
  await ensureDirectories(root, filename);
  signal?.throwIfAborted();
  try {
    await fsp.link(temporary, destination);
  } catch (error) {
    if (errno(error, "EEXIST"))
      throw new MediaError(
        "FILE_EXISTS",
        "目标文件已存在，未覆盖；请核对后重试",
      );
    if (!COPY_PUBLISH_ERRNO.has((error as NodeJS.ErrnoException)?.code ?? ""))
      throw error;
    await copyPublish(root, temporary, destination, signal);
  }
  await unlink(temporary);
  return destination;
}

async function writeSmall(
  root: Root,
  filename: string,
  data: Buffer | string,
  signal?: AbortSignal,
): Promise<string> {
  const destination = relativeTarget(root, filename);
  const previous = smallWrites.get(destination);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  smallWrites.set(destination, current);
  try {
    if (previous) await previous;
    return await writeSmallNow(root, filename, data, signal);
  } finally {
    release();
    if (smallWrites.get(destination) === current)
      smallWrites.delete(destination);
  }
}

async function writeSmallNow(
  root: Root,
  filename: string,
  data: Buffer | string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const destination = relativeTarget(root, filename);
  const temporary = child(root, `.mori-${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      await handle.writeFile(bytes, { signal });
      signal?.throwIfAborted();
      await handle.sync();
    } finally {
      await handle.close();
    }
    return await publish(root, temporary, filename, signal);
  } catch (error) {
    if (error instanceof MediaError && error.code === "FILE_EXISTS") {
      if (
        (await regularFile(destination))?.size === bytes.length &&
        (await readLocal(destination, bytes.length)).equals(bytes)
      )
        return destination;
    }
    throw error;
  } finally {
    await removeFile(temporary);
  }
}

function assertMedia(contentType: string, prefix: Buffer): void {
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (
    mime &&
    !mime.startsWith("video/") &&
    ![
      "application/octet-stream",
      "binary/octet-stream",
      "application/x-matroska",
    ].includes(mime)
  )
    throw new MediaError(
      "NOT_MEDIA",
      "链接返回网页或非视频内容；请配置 OpenList 或提供可直接下载的媒体链接",
    );
  const start = prefix
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (
    /^[<\[{]/.test(start) ||
    /^#EXTM3U/.test(start) ||
    (prefix.length > 0 && !start)
  )
    throw new MediaError(
      "NOT_MEDIA",
      "链接实际返回 HTML/JSON 或播放列表，未保存为视频；分享页需要已配置的解析器或 OpenList 直链",
    );
}

function extension(url: URL, headers: Headers): string {
  let fromUrl = "";
  try {
    fromUrl = path.extname(decodeURIComponent(url.pathname)).toLowerCase();
  } catch {
    /* Invalid escaped filenames fall back to the response type. */
  }
  if (MEDIA_EXT.has(fromUrl)) return fromUrl;
  const disposition = headers.get("content-disposition") ?? "";
  const fromHeader = path
    .extname(
      disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1] ?? "",
    )
    .toLowerCase();
  if (MEDIA_EXT.has(fromHeader)) return fromHeader;
  const mime = (headers.get("content-type") ?? "").split(";")[0].toLowerCase();
  const known: Record<string, string> = {
    "video/mp4": ".mp4",
    "video/x-matroska": ".mkv",
    "application/x-matroska": ".mkv",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "video/mp2t": ".ts",
    "video/x-msvideo": ".avi",
    "video/mpeg": ".mpeg",
  };
  if (!known[mime])
    throw new MediaError(
      "UNKNOWN_FORMAT",
      "无法确定视频格式，请使用带媒体扩展名或正确 Content-Type 的直链",
    );
  return known[mime];
}

async function saveResume(
  root: Root,
  filename: string,
  state: Resume,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const target = child(root, filename);
  await regularFile(target);
  const handle = await open(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(state), { signal });
    signal.throwIfAborted();
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertCloudFile(file: ResolvedShareFile): void {
  if (
    !file ||
    (file.provider !== undefined &&
      file.provider !== "p115" &&
      file.provider !== "alipan") ||
    typeof file.name !== "string" ||
    !file.name ||
    file.name.length > 1024 ||
    file.name !== path.basename(file.name) ||
    file.name.includes("\\") ||
    !MEDIA_EXT.has(path.extname(file.name).toLowerCase()) ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > MAX_MEDIA_BYTES ||
    typeof file.contentId !== "string" ||
    !file.contentId ||
    file.contentId.length > 2048 ||
    (file.sha1 !== undefined &&
      (typeof file.sha1 !== "string" || !/^[a-f0-9]{40}$/i.test(file.sha1)))
  )
    throw new MediaError(
      "INVALID_SHARE_FILE",
      "云盘文件信息无效，未开始下载",
    );
  const headers = Object.entries(file.headers ?? {});
  const alipan = file.provider === "alipan";
  if (
    headers.length !== (alipan ? 2 : 1) ||
    headers.filter(([name, value]) =>
      name.toLowerCase() === "user-agent" && value === "Mozilla/5.0",
    ).length !== 1 ||
    (alipan && headers.filter(([name, value]) =>
      name.toLowerCase() === "referer" && value === "https://www.alipan.com/",
    ).length !== 1)
  )
    throw new MediaError(
      "UNSAFE_SHARE_HEADERS",
      alipan
        ? "阿里云盘下载仅允许固定 User-Agent 和 Referer，未发送认证信息"
        : "网盘下载仅允许固定 User-Agent，未发送认证信息",
    );
}

async function verifyCloudFile(
  file: string,
  expected: ResolvedShareFile,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected.size)
      throw new MediaError(
        "SIZE_MISMATCH",
        "下载文件大小与云盘记录不符，未发布媒体",
      );
    if (expected.sha1) {
      const digest = createHash("sha1");
      for await (const chunk of handle.createReadStream({
        autoClose: false,
        signal,
      }))
        digest.update(chunk);
      signal.throwIfAborted();
      if (digest.digest("hex").toLowerCase() !== expected.sha1.toLowerCase())
        throw new MediaError(
          "CHECKSUM_MISMATCH",
          "下载文件 SHA1 与云盘记录不符，未发布媒体",
        );
    }
  } finally {
    await handle.close();
  }
}

export interface DownloadResponseInput {
  status: number;
  offset: number;
  priorTotal?: number | null;
  priorValidator?: string | null;
  contentLength: string;
  contentEncoding: string;
  etag: string;
  lastModified: string;
  contentRange: string;
  expectedSize?: number | null;
}

export function typescriptDownloadResponse(input: DownloadResponseInput): {
  offset: number;
  total: number;
  validator: string;
} {
  let { offset } = input;
  if (input.contentEncoding !== "identity")
    throw new MediaError("INVALID_RANGE", "下载服务返回压缩内容，无法安全校验文件长度");
  let total = Number(input.contentLength);
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_MEDIA_BYTES)
    throw new MediaError("FILE_TOO_LARGE", "媒体文件大小无效或超过 200 GiB 上限");
  const validator = input.etag && !input.etag.startsWith("W/")
    ? input.etag : input.lastModified;
  if (input.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(input.contentRange);
    if (
      !range || Number(range[1]) !== offset || Number(range[2]) < offset ||
      Number(range[3]) <= Number(range[2]) ||
      (offset > 0 && (Number(range[3]) !== input.priorTotal || validator !== input.priorValidator))
    )
      throw new MediaError("INVALID_RANGE", "服务器返回不匹配的断点范围，未追加临时文件");
    if (total && total !== Number(range[2]) - offset + 1)
      throw new MediaError("INVALID_RANGE", "服务器返回的分段长度不匹配");
    total = Number(range[3]);
    if (!Number.isSafeInteger(total) || total > MAX_MEDIA_BYTES)
      throw new MediaError("FILE_TOO_LARGE", "媒体文件超过 200 GiB 上限");
  } else offset = 0;
  if (input.expectedSize != null) {
    if (total && total !== input.expectedSize)
      throw new MediaError("SIZE_MISMATCH", "下载响应大小与云盘记录不符，未写入媒体");
    total = input.expectedSize;
  }
  return { offset, total, validator };
}

export async function downloadResponse(
  input: DownloadResponseInput,
  signal?: AbortSignal,
): Promise<ReturnType<typeof typescriptDownloadResponse>> {
  signal?.throwIfAborted();
  if (coreEngine() === "typescript") return typescriptDownloadResponse(input);
  try {
    return await runRustCore("download_response", JSON.stringify(input), signal);
  } catch (error) {
    if (!(error instanceof RustCoreError)) throw error;
    if (error.code === "INVALID_RANGE") {
      if (input.contentEncoding !== "identity")
        throw new MediaError(error.code, "下载服务返回压缩内容，无法安全校验文件长度");
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(input.contentRange);
      const validator = input.etag && !input.etag.startsWith("W/") ? input.etag : input.lastModified;
      const matchingRange = range && Number(range[1]) === input.offset && Number(range[2]) >= input.offset &&
        Number(range[3]) > Number(range[2]) && (input.offset === 0 ||
          (Number(range[3]) === input.priorTotal && validator === input.priorValidator));
      throw new MediaError(error.code, matchingRange
        ? "服务器返回的分段长度不匹配" : "服务器返回不匹配的断点范围，未追加临时文件");
    }
    if (error.code === "FILE_TOO_LARGE") {
      const total = Number(input.contentLength);
      throw new MediaError(error.code, Number.isSafeInteger(total) && total >= 0 && total <= MAX_MEDIA_BYTES
        ? "媒体文件超过 200 GiB 上限" : "媒体文件大小无效或超过 200 GiB 上限");
    }
    if (error.code === "SIZE_MISMATCH")
      throw new MediaError(error.code, "下载响应大小与云盘记录不符，未写入媒体");
    throw error;
  }
}

async function nativeDownload(
  root: Root,
  task: DownloadTask,
  url: URL,
  rename: boolean,
  signal: AbortSignal,
  progress: (p: DownloadProgress) => void,
  cloud?: ResolvedShareFile,
): Promise<string> {
  const source = cloud
    ? hash(`${cloud.contentId}\0${cloud.size}\0${cloud.sha1?.toLowerCase() ?? ""}`)
    : hash(url.href);
  const prefix = `.mori-${hash(task.id).slice(0, 24)}`;
  const temporary = child(root, `${prefix}.part`);
  const metadata = child(root, `${prefix}.json`);
  let prior: Resume | undefined;
  const stat = await regularFile(temporary);
  if (stat) {
    try {
      prior = JSON.parse(
        (await readLocal(metadata, 8192)).toString("utf8"),
      ) as Resume;
    } catch {
      throw new MediaError(
        "INVALID_PARTIAL",
        "发现无法验证的临时文件，请核对下载目录中的任务残留文件",
      );
    }
    if (
      !prior ||
      prior.source !== source ||
      typeof prior.filename !== "string" ||
      relativeTarget(root, prior.filename) === metadata ||
      !MEDIA_EXT.has(path.extname(prior.filename)) ||
      !Number.isSafeInteger(prior.total) ||
      prior.total < 0 ||
      stat.size > MAX_MEDIA_BYTES ||
      (prior.total > 0 && stat.size > prior.total) ||
      typeof prior.validator !== "string"
    )
      throw new MediaError(
        "INVALID_PARTIAL",
        "临时文件与当前下载不匹配，请人工核对后重试",
      );
    await requireAbsent(relativeTarget(root, prior.filename));
  } else if (await regularFile(metadata))
    throw new MediaError(
      "INVALID_PARTIAL",
      "任务的临时文件缺失，请核对下载目录中的任务记录",
    );
  const localPrefix = Buffer.alloc(1024);
  if (stat?.size) {
    const handle = await open(
      temporary,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const { bytesRead } = await handle.read(localPrefix, 0, 1024, 0);
      assertMedia("", localPrefix.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
    if (prior!.total > 0 && stat.size === prior!.total) {
      signal.throwIfAborted();
      if (cloud) await verifyCloudFile(temporary, cloud, signal);
      const final = await publish(root, temporary, prior!.filename, signal);
      await removeFile(metadata);
      progress({ bytes: stat.size, total: stat.size, progress: 100 });
      return final;
    }
  }
  const partialBytes = stat?.size ?? 0;
  if (typeof partialBytes !== "number" || !Number.isSafeInteger(partialBytes))
    throw new MediaError("INVALID_PARTIAL", "临时文件大小无效，未开始下载");
  let offset = prior?.validator && prior.total > 0 ? partialBytes : 0;
  const idle = new AbortController();
  let timer = setTimeout(
    () =>
      idle.abort(
        new MediaError(
          "DOWNLOAD_TIMEOUT",
          "下载超过 30 秒没有进展，临时文件已保留",
        ),
      ),
    30_000,
  );
  timer.unref();
  const resetIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        idle.abort(
          new MediaError(
            "DOWNLOAD_TIMEOUT",
            "下载超过 30 秒没有进展，临时文件已保留",
          ),
        ),
      30_000,
    );
    timer.unref();
  };
  const combined = AbortSignal.any([
    signal,
    idle.signal,
    AbortSignal.timeout(MAX_DOWNLOAD_MS),
  ]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, {
      headers: {
        "Accept-Encoding": "identity",
        ...(cloud ? cloud.headers : {}),
        ...(offset
          ? { Range: `bytes=${offset}-`, "If-Range": prior!.validator }
          : {}),
      },
      signal: combined,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new MediaError(
        "HTTP_ERROR",
        `媒体下载返回 HTTP ${response.status}`,
      );
    }
    reader = response.body?.getReader();
    if (!reader) throw new MediaError("EMPTY_RESPONSE", "下载没有返回文件内容");
    assertMedia(response.headers.get("content-type") ?? "", Buffer.alloc(0));
    const decision = await downloadResponse({
      status: response.status,
      offset,
      priorTotal: prior?.total,
      priorValidator: prior?.validator,
      contentLength: response.headers.get("content-length") ?? "",
      contentEncoding: response.headers.get("content-encoding") ?? "identity",
      etag: response.headers.get("etag") ?? "",
      lastModified: response.headers.get("last-modified") ?? "",
      contentRange: response.headers.get("content-range") ?? "",
      expectedSize: cloud?.size,
    }, combined);
    offset = decision.offset;
    const { total, validator: responseValidator } = decision;
    const ext = cloud
      ? path.extname(cloud.name).toLowerCase()
      : extension(url, response.headers);
    const filename = mediaRelative(task, rename, ext);
    await requireAbsent(relativeTarget(root, filename));
    await checkRoot(root);
    combined.throwIfAborted();
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_NOFOLLOW |
        (stat
          ? offset
            ? constants.O_APPEND
            : constants.O_TRUNC
          : constants.O_CREAT | constants.O_EXCL),
      0o600,
    );
    let bytes = offset;
    let sniff = offset ? localPrefix : Buffer.alloc(0);
    let lastReport = 0;
    try {
      await saveResume(
        root,
        `${prefix}.json`,
        {
        source,
          filename,
          validator: responseValidator,
          total,
        },
        combined,
      );
      progress({
        bytes,
        total,
        progress: total ? Math.min(99, (bytes / total) * 100) : 0,
      });
      for (;;) {
        combined.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        resetIdle();
        if (sniff.length < 1024)
          sniff = Buffer.concat([
            sniff,
            value.subarray(0, 1024 - sniff.length),
          ]);
        assertMedia("", sniff);
        bytes += value.byteLength;
        if (bytes > MAX_MEDIA_BYTES || (total > 0 && bytes > total))
          throw new MediaError(
            "SIZE_MISMATCH",
            "下载内容超过声明长度或大小上限",
          );
        let written = 0;
        while (written < value.byteLength) {
          const part = await handle.write(
            value,
            written,
            value.byteLength - written,
          );
          if (!part.bytesWritten)
            throw new MediaError("WRITE_FAILED", "磁盘写入没有进展");
          written += part.bytesWritten;
        }
        if (Date.now() - lastReport >= 500) {
          lastReport = Date.now();
          progress({
            bytes,
            total,
            progress: total ? Math.min(99, (bytes / total) * 100) : 0,
          });
        }
      }
      combined.throwIfAborted();
      if (!bytes || (total > 0 && bytes !== total))
        throw new MediaError(
          "SIZE_MISMATCH",
          "下载内容为空或长度不完整，未发布媒体文件",
        );
      assertMedia("", sniff);
      await handle.sync();
    } finally {
      await handle.close();
    }
    combined.throwIfAborted();
    if (cloud) await verifyCloudFile(temporary, cloud, combined);
    const final = await publish(root, temporary, filename, combined);
    await removeFile(metadata);
    progress({ bytes, total: total || bytes, progress: 100 });
    return final;
  } finally {
    clearTimeout(timer);
    if (reader) await reader.cancel();
  }
}

class RpcError extends MediaError {
  constructor(public rpcCode: number) {
    super(
      "ARIA2_ERROR",
      "aria2 拒绝请求，请检查 RPC 凭据、任务状态和 aria2 日志",
    );
  }
}

async function rpc(
  config: AppConfig,
  method: string,
  params: unknown[] = [],
  signal?: AbortSignal,
): Promise<unknown> {
  const secret = config.download.aria2Secret;
  const body = await jsonRequest(
    endpoint(config.download.aria2Url, "/jsonrpc"),
    post(
      {
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params: [...(secret ? [`token:${secret}`] : []), ...params],
      },
      {},
      signal,
    ),
    true,
  );
  if (body.error) throw new RpcError(Number(object(body.error).code));
  if (!("result" in body))
    throw new MediaError("INVALID_RESPONSE", "aria2 响应缺少 result");
  return body.result;
}

async function ariaDownload(
  root: Root,
  task: DownloadTask,
  source: string,
  config: AppConfig,
  signal: AbortSignal,
  progress: (p: DownloadProgress) => void,
): Promise<string> {
  const magnet = source.startsWith("magnet:");
  const identity = hash(`${root.directory}\0${task.id}\0${source}`);
  const gid = identity.slice(0, 16);
  const stageName = `.mori-${identity.slice(0, 24)}-aria2`;
  const staging = child(root, stageName);
  let ext = "";
  if (!magnet) {
    const probe = await fetch(httpUrl(source), {
      headers: { Range: "bytes=0-1023", "Accept-Encoding": "identity" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
    });
    try {
      if (!probe.ok || !probe.body)
        throw new MediaError("HTTP_ERROR", `下载预检返回 HTTP ${probe.status}`);
      const reader = probe.body.getReader();
      let prefix = Buffer.alloc(0);
      try {
        while (prefix.length < 1024) {
          const next = await reader.read();
          if (next.done) break;
          prefix = Buffer.concat([
            prefix,
            next.value.subarray(0, 1024 - prefix.length),
          ]);
        }
      } finally {
        await reader.cancel();
      }
      assertMedia(probe.headers.get("content-type") ?? "", prefix);
      ext = extension(httpUrl(source), probe.headers);
      await requireAbsent(
        relativeTarget(root, mediaRelative(task, config.library.rename, ext)),
      );
    } finally {
      if (!probe.body?.locked) await probe.body?.cancel();
    }
  } else if (
    !/^magnet:\?[^\s]*xt=urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})(?:&|$)/i.test(
      source,
    )
  )
    throw new MediaError("INVALID_MAGNET", "磁力链接缺少有效的 BTIH 标识");
  await checkRoot(root);
  try {
    await mkdir(staging, { mode: 0o700 });
  } catch (error) {
    if (!errno(error, "EEXIST")) throw error;
  }
  const stageStat = await lstat(staging);
  if (
    !stageStat.isDirectory() ||
    stageStat.isSymbolicLink() ||
    (await realpath(staging)) !== staging
  )
    throw new MediaError("UNSAFE_PATH", "aria2 暂存目录不能是符号链接");
  const combined = AbortSignal.any([
    signal,
    AbortSignal.timeout(MAX_DOWNLOAD_MS),
  ]);
  let current = gid;
  let running = false;
  let complete = false;
  try {
    let status: Json | undefined;
    try {
      status = object(await rpc(config, "aria2.tellStatus", [gid], combined));
    } catch (error) {
      if (!(error instanceof RpcError && error.rpcCode === 1)) throw error;
    }
    if (!status) {
      running = true;
      const added = await rpc(
        config,
        "aria2.addUri",
        [
          [source],
          {
            gid,
            dir: staging,
            ...(ext ? { out: `payload${ext}` } : {}),
            "allow-overwrite": "false",
            "auto-file-renaming": "false",
            continue: "true",
            "max-tries": "3",
            "retry-wait": "5",
            timeout: "30",
            "connect-timeout": "15",
            "max-connection-per-server": "2",
            split: "2",
            "bt-max-peers": "20",
            "seed-time": "0",
            "bt-save-metadata": "false",
            "follow-torrent": "true",
          },
        ],
        combined,
      );
      if (added !== gid)
        throw new MediaError(
          "ARIA2_ID_MISMATCH",
          "aria2 未返回指定任务 ID，请核对守护进程中的任务",
        );
    } else {
      if (text(status.dir) !== staging)
        throw new MediaError(
          "ARIA2_ID_MISMATCH",
          "aria2 任务目录不匹配，未接管该任务",
        );
      if (status.status === "paused") {
        running = true;
        await rpc(config, "aria2.unpause", [gid], combined);
        status = undefined;
      }
    }
    const followed = new Set<string>([gid]);
    for (;;) {
      combined.throwIfAborted();
      status ??= object(
        await rpc(
          config,
          "aria2.tellStatus",
          [
            current,
            [
              "status",
              "totalLength",
              "completedLength",
              "files",
              "followedBy",
              "dir",
            ],
          ],
          combined,
        ),
      );
      running = status.status === "active" || status.status === "waiting";
      const bytes = Number(status.completedLength ?? 0);
      const total = Number(status.totalLength ?? 0);
      if (
        ![bytes, total].every(
          (value) =>
            Number.isSafeInteger(value) &&
            value >= 0 &&
            value <= MAX_MEDIA_BYTES,
        )
      )
        throw new MediaError(
          "FILE_TOO_LARGE",
          "aria2 文件大小无效或超过 200 GiB 上限",
        );
      progress({
        bytes,
        total,
        progress: total ? Math.min(99, (bytes / total) * 100) : 0,
      });
      if (status.status === "complete") {
        const children = list(status.followedBy).map(text).filter(Boolean);
        if (children.length) {
          if (
            children.length !== 1 ||
            followed.has(children[0]) ||
            !/^[\da-f]{16}$/i.test(children[0]) ||
            followed.size > 4
          )
            throw new MediaError(
              "ARIA2_METADATA",
              "aria2 返回了无法安全跟踪的磁力元数据任务",
            );
          current = children[0];
          followed.add(current);
          status = undefined;
          running = true;
          continue;
        }
        const files = list(status.files)
          .map(object)
          .filter(
            (file) =>
              file.selected !== "false" &&
              MEDIA_EXT.has(path.extname(text(file.path)).toLowerCase()),
          );
        if (files.length !== 1)
          throw new MediaError(
            "ARIA2_METADATA",
            "aria2 尚无可验证的单个视频文件；元数据或多文件种子不能标记为下载完成",
          );
        const candidate = path.resolve(text(files[0].path));
        const relative = path.relative(staging, candidate);
        if (
          !relative ||
          relative.startsWith("..") ||
          path.isAbsolute(relative) ||
          (await realpath(candidate)) !== candidate
        )
          throw new MediaError(
            "UNSAFE_PATH",
            "aria2 文件超出暂存目录或包含符号链接",
          );
        const fileStat = await regularFile(candidate);
        if (
          !fileStat?.size ||
          fileStat.size > MAX_MEDIA_BYTES ||
          fileStat.size !== Number(files[0].length) ||
          fileStat.size !== Number(files[0].completedLength)
        )
          throw new MediaError(
            "ARIA2_NOT_LOCAL",
            "aria2 文件未在本机完整落盘；请将 aria2 与应用映射到相同目录",
          );
        const handle = await open(
          candidate,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const first = Buffer.alloc(1024);
        try {
          const read = await handle.read(first, 0, 1024, 0);
          assertMedia("", first.subarray(0, read.bytesRead));
          await handle.sync();
        } finally {
          await handle.close();
        }
        combined.throwIfAborted();
        const destination = await publish(
          root,
          candidate,
          mediaRelative(
            task,
            config.library.rename,
            ext || path.extname(candidate).toLowerCase(),
          ),
          combined,
        );
        complete = true;
        await checkRoot(root);
        if ((await realpath(staging)) !== staging)
          throw new MediaError("UNSAFE_PATH", "aria2 暂存目录在清理前发生变化");
        await rm(staging, { recursive: true });
        progress({ bytes: fileStat.size, total: fileStat.size, progress: 100 });
        return destination;
      }
      if (!["active", "waiting"].includes(text(status.status)))
        throw new MediaError(
          "ARIA2_STOPPED",
          "aria2 任务已暂停、移除或失败，请检查下载器状态后重试",
        );
      await delay(1000, undefined, { signal: combined });
      status = undefined;
    }
  } catch (error) {
    if (running && !complete) {
      try {
        await rpc(config, "aria2.pause", [current]);
      } catch {
        throw new MediaError(
          "ARIA2_PAUSE_FAILED",
          `下载已中断，但 aria2 暂停未获确认；请检查任务 ${current} 后重试`,
        );
      }
    }
    throw error;
  }
}

export function escapeXml(value: unknown): string {
  return String(value)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[character]!,
    );
}

function tmdbInfo(
  raw: Json,
  fallbackType?: "movie" | "tv",
): MediaInfo | undefined {
  const type =
    raw.media_type === "movie" || raw.media_type === "tv"
      ? raw.media_type
      : fallbackType;
  const title = text(raw.title) || text(raw.name);
  if (!type || !title || !Number.isSafeInteger(raw.id) || Number(raw.id) <= 0)
    return;
  const date = text(raw.release_date) || text(raw.first_air_date);
  const image = (value: unknown) =>
    typeof value === "string" && /^\/[\w./-]+\.(jpg|png|webp)$/.test(value)
      ? `https://image.tmdb.org/t/p/original${value}`
      : undefined;
  return {
    type,
    title,
    tmdbId: Number(raw.id),
    ...(text(raw.original_title) || text(raw.original_name)
      ? { originalTitle: text(raw.original_title) || text(raw.original_name) }
      : {}),
    ...(/^\d{4}-/.test(date) ? { year: Number(date.slice(0, 4)) } : {}),
    ...(text(raw.overview) ? { overview: text(raw.overview) } : {}),
    ...(image(raw.poster_path) ? { posterUrl: image(raw.poster_path) } : {}),
    ...(image(raw.backdrop_path)
      ? { backdropUrl: image(raw.backdrop_path) }
      : {}),
  };
}

async function tmdb(
  config: AppConfig,
  route: string,
  params: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Json> {
  const key = config.sources.tmdbApiKey;
  if (!key)
    throw new MediaError(
      "TMDB_NOT_CONFIGURED",
      "请先配置 TMDB API Key，再搜索和确认媒体身份",
    );
  const url = new URL(`https://api.themoviedb.org/3${route}`);
  url.search = new URLSearchParams({
    language: config.library.language || "zh-CN",
    ...params,
  }).toString();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key.includes(".")) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set("api_key", key);
  return jsonRequest(url, { headers, signal });
}

async function artwork(
  root: Root,
  filename: string,
  source: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const url = httpUrl(source);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "image.tmdb.org" ||
    !url.pathname.startsWith("/t/p/")
  )
    throw new MediaError("UNTRUSTED_ARTWORK", "仅下载 TMDB 官方图片地址");
  const bytes = await request(url, { signal }, 10 * 1024 * 1024);
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!jpeg && !png)
    throw new MediaError("INVALID_ARTWORK", "图片响应不是可验证的 JPEG/PNG");
  return writeSmall(
    root,
    `${filename}${jpeg ? ".jpg" : ".png"}`,
    bytes,
    signal,
  );
}

export function createMediaService(
  getConfig: () => AppConfig,
  shares?: ShareService,
): MediaService {
  const active = new Set<string>();
  const coreShutdown = new AbortController();
  const coreWork = new Set<Promise<unknown>>();
  const parseCore: typeof runRustCore = (op, payload, signal) => {
    const work = runRustCore(op, payload, signal);
    coreWork.add(work);
    void work.then(() => coreWork.delete(work), () => coreWork.delete(work));
    return work;
  };
  const service: MediaService = {
    async close() {
      coreShutdown.abort(new DOMException("媒体服务已关闭", "AbortError"));
      await Promise.allSettled(coreWork);
      await shares?.close?.();
    },
    async search(query, signal) {
      const report = await service.searchWithDiagnostics!(query, signal);
      if (report.diagnostics.status === "not_configured")
        throw new MediaError(
          "NOT_CONFIGURED",
          "请先配置 PanSou、OpenList、MoviePilot 或 Telegram 公共频道",
        );
      if (report.diagnostics.status === "failed")
        throw new MediaError(
          "SEARCH_FAILED",
          report.diagnostics.sources
            .filter((source) => source.status === "failed")
            .map((source) => `${source.name}: ${searchFailureMessage(source.code)}`)
            .join("；"),
        );
      return report.results;
    },
    async searchWithDiagnostics(query, signal): Promise<SearchReport> {
      signal = AbortSignal.any([signal ?? new AbortController().signal, coreShutdown.signal]);
      signal?.throwIfAborted();
      const keyword = query.trim();
      if (!keyword || keyword.length > 200)
        throw new MediaError("INVALID_QUERY", "搜索词长度须为 1–200 字符");
      const config = getConfig();
      const sources: {
        id: string;
        source: SearchSource;
        name: string;
        run: () => Promise<SearchResult[]>;
      }[] = [];
      // M6：外置源注册表（可选）——CMS V10/RSS 聚合经 registrySearch 并入。
      if (config.sources.registryJson?.trim()) {
        const { registry } = loadRegistry(config.sources.registryJson);
        if (registry) {
          for (const definition of registry.sources.filter((item) => item.enabled !== false)) {
            sources.push({
              id: `registry:${definition.id}`,
              source: "pansou",
              name: definition.name,
              run: async () => {
                const report = await registrySearch(
                  { format: 1, sources: [definition] },
                  keyword,
                  async (url) => (await request(new URL(url), { signal }, CORE_PAYLOAD_LIMIT)).toString("utf8"),
                  registryHealth,
                  nowMinutes(),
                  signal,
                  parseCore,
                );
                const failed = report.sources.find((item) => item.status === "failed");
                if (failed && !report.results.length) {
                  if (failed.code) throw new RustCoreError(failed.code, failed.error ?? "解析失败");
                  throw new MediaError("HTTP_ERROR", failed.error ?? "源查询失败");
                }
                if (report.sources.some((item) => item.status === "skipped_unhealthy"))
                  throw new MediaError("HTTP_ERROR", "来源暂时不可用，请稍后重试");
                return report.results;
              },
            });
          }
        }
      }
      if (config.sources.pansouUrl)
        sources.push({
          id: "pansou",
          source: "pansou",
          name: "PanSou",
          run: async () => {
            const body = await jsonRequest(
              endpoint(config.sources.pansouUrl, "/api/search"),
              post({ kw: keyword, res: "all", conc: 4 }, {}, signal),
            );
            const data = body.data && typeof body.data === "object"
              ? object(body.data) : body;
            const merged = data.merged_by_type;
            const knownResults = Array.isArray(data.results) || data.results === null;
            const knownMerged = merged === null || (
              merged && typeof merged === "object" && !Array.isArray(merged) &&
              (!Object.keys(merged).length || Object.values(merged).some(Array.isArray))
            );
            if (!knownResults && !knownMerged)
              throw new MediaError("INVALID_RESPONSE", "PanSou 搜索响应结构无法识别");
            return normalizePanSou(body);
          },
        });
      if (config.sources.openlistUrl)
        sources.push({
          id: "openlist",
          source: "openlist",
          name: "OpenList",
          run: async () => {
            const body = await jsonRequest(
              endpoint(config.sources.openlistUrl, "/api/fs/search"),
              post(
                {
                  parent: "/",
                  keywords: keyword,
                  scope: 0,
                  page: 1,
                  per_page: 50,
                  password: "",
                },
                { Authorization: config.sources.openlistToken },
                signal,
              ),
            );
            const content = object(body.data).content;
            if (content !== null && !Array.isArray(content))
              throw new MediaError("INVALID_RESPONSE", "OpenList 搜索响应结构无法识别");
            return list(content)
              .slice(0, 100)
              .flatMap((raw) => {
                const entry = object(raw);
                if (
                  entry.is_dir ||
                  !MEDIA_EXT.has(path.extname(text(entry.name)).toLowerCase())
                )
                  return [];
                const file = openListPath(
                  `${text(entry.parent).replace(/\/$/, "")}/${text(entry.name)}`,
                );
                const item = result(
                  `openlist:${file}`,
                  text(entry.name),
                  "OpenList",
                  undefined,
                  typeof entry.size === "number"
                    ? `${entry.size} B`
                    : undefined,
                );
                return item ? [item] : [];
              });
          },
        });
      if (config.sources.moviePilotUrl)
        sources.push({
          id: "moviepilot",
          source: "moviepilot",
          name: "MoviePilot",
          run: async () => {
            const url = endpoint(
              config.sources.moviePilotUrl,
              "/api/v1/search/title",
            );
            url.search = new URLSearchParams({ keyword, page: "0" }).toString();
            const body = await jsonRequest(url, {
              headers: {
                Authorization: `Bearer ${config.sources.moviePilotToken}`,
              },
              signal,
            });
            if (body.data !== null && !Array.isArray(body.data))
              throw new MediaError("INVALID_RESPONSE", "MoviePilot 搜索响应结构无法识别");
            return list(body.data)
              .slice(0, 100)
              .flatMap((raw) => {
                const entry = object(raw);
                const torrent = object(entry.torrent_info ?? entry);
                const item = result(
                  text(torrent.enclosure) ||
                    text(torrent.magnet) ||
                    text(torrent.url),
                  text(torrent.title) || text(object(entry.media_info).title),
                  "MoviePilot",
                );
                return item ? [item] : [];
              });
          },
        });
      const channelOccurrences = new Map<string, number>();
      for (const [channelIndex, channelInput] of config.sources.telegramChannels.slice(0, 5).entries()) {
        const channelId = hash(channelInput.trim().toLowerCase()).slice(0, 24);
        const occurrence = channelOccurrences.get(channelId) ?? 0;
        channelOccurrences.set(channelId, occurrence + 1);
        sources.push({
          id: `telegram:${channelId}${occurrence ? `:${occurrence}` : ""}`,
          source: "telegram",
          name: `Telegram 频道 ${channelIndex + 1}`,
          run: async () => {
            const channel = telegramChannel(channelInput);
            const url = new URL(`https://t.me/s/${channel}`);
            url.searchParams.set("q", keyword);
            const html = (await request(url, { signal }, 1024 * 1024)).toString(
              "utf8",
            );
            if (!/(?:tgme_channel_|tgme_widget_message|data-post=)/iu.test(html))
              throw new MediaError("INVALID_RESPONSE", "Telegram 频道响应结构无法识别");
            const posts = [...html.matchAll(/data-post="([\w]+\/\d+)"/g)].slice(
              0,
              50,
            );
            const items: SearchResult[] = [];
            for (let index = 0; index < posts.length; index++) {
              const block = html.slice(
                posts[index].index,
                posts[index + 1]?.index ?? html.length,
              );
              const content =
                block.match(
                  /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/,
                )?.[1] ?? "";
              if (!content) continue;
              const title = decodeHtml(content.replace(/<[^>]*>/g, " "))
                .trim()
                .slice(0, 300);
              const links = [...content.matchAll(/href="([^"]+)"/g)]
                .map((match) => decodeHtml(match[1]))
                .slice(0, 20);
              const external = links.filter((link) => {
                try {
                  return classifyResourceUrl(link) !== "telegram";
                } catch {
                  return false;
                }
              });
              for (const link of external.length
                ? external
                : [`https://t.me/${posts[index][1]}`]) {
                const item = result(link, title, `Telegram · ${channel}`);
                if (item) items.push(item);
              }
            }
            return items;
          },
        });
      }
      const outcomes = await settleSearchSources(sources, (source) => source.run());
      signal?.throwIfAborted();
      const found: SearchResult[] = [];
      const diagnostics: SearchSourceDiagnostic[] = outcomes.map((outcome, index) => {
        const { id, source, name } = sources[index];
        if (outcome.status === "fulfilled") {
          found.push(...outcome.value);
          return {
            id, source, name,
            status: outcome.value.length ? "success" : "empty",
            resultCount: outcome.value.length,
          };
        }
        return {
          id, source, name, status: "failed", resultCount: 0,
          code: searchFailureCode(outcome.reason),
        };
      });
      const failed = diagnostics.filter((source) => source.status === "failed").length;
      const status = !sources.length ? "not_configured"
        : !failed ? "complete"
        : failed === sources.length ? "failed" : "partial";
      for (const [source, name] of [
        ["pansou", "PanSou"], ["openlist", "OpenList"],
        ["moviepilot", "MoviePilot"], ["telegram", "Telegram"],
      ] as const)
        if (!sources.some((configured) => configured.source === source))
          diagnostics.push({ id: source, source, name, status: "not_configured", resultCount: 0 });
      const captured = [...new Map(found.map((item) => [item.url, item])).values()]
        .slice(0, 100)
        .map((item) => {
          const { extractionCode: _code, ...resource } = shares
            ? shares.capture(item)
            : item;
          return resource;
        });
      signal?.throwIfAborted();
      return {
        results: [...new Map(captured.map((item) => [item.url, item])).values()].slice(0, 100),
        diagnostics: { status, sources: diagnostics },
      };
    },
    async identify(query, type, signal) {
      if (!query.trim() || query.length > 200)
        throw new MediaError("INVALID_QUERY", "媒体名称长度须为 1–200 字符");
      const body = await tmdb(
        getConfig(),
        `/search/${type || "multi"}`,
        { query: query.trim(), include_adult: "false", page: "1" },
        signal,
      );
      return list(body.results)
        .slice(0, 20)
        .flatMap((raw) => {
          const info = tmdbInfo(object(raw), type);
          return info ? [info] : [];
        });
    },
    async browseShare(reference, extractionCode, signal) {
      if (!shares)
        throw new MediaError("RESOLVER_REQUIRED", "云盘分享解析器尚未配置");
      return shares.browse(reference, extractionCode, signal);
    },
    async browseCms(ref, signal) {
      signal = AbortSignal.any([signal ?? new AbortController().signal, coreShutdown.signal]);
      // 注册表 CMS 分集解析：详情接口 → 播放组/分集 → 可下载直链（媒体
      // 扩展名）与 m3u8（暂不支持直接下载，待 M9 在线播放决策）。
      const guarded = guardEndpoint(detailUrl(ref.endpoint, ref.vodId));
      if (!guarded.ok) throw new MediaError("INVALID_URL", `CMS 详情地址无效：${guarded.error}`);
      const payload = (await request(new URL(guarded.url), { signal }, CORE_PAYLOAD_LIMIT)).toString("utf8");
      const parsed: ReturnType<typeof parseVodDetail> = coreEngine() === "rust"
        ? await parseCore("cms_detail", payload, signal) : parseVodDetail(payload);
      const { details, error } = parsed;
      if (error) throw new MediaError("INVALID_RESPONSE", `CMS 详情解析失败：${error}`);
      const detail = details.find((item) => item.id === ref.vodId) ?? details[0];
      if (!detail) throw new MediaError("INVALID_RESPONSE", "CMS 详情没有可解析的条目");
      const downloadable = new Set([".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v", ".ts", ".mpg", ".flv"]);
      const results: SearchResult[] = [];
      for (const group of detail.playGroups) {
        for (const episode of group) {
          let path = episode.url;
          try { path = new URL(episode.url).pathname; } catch { /* 相对或非 URL：按原文判断 */ }
          const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
          const isFile = extension.length > 1 && extension.length <= 5;
          results.push({
            id: `${ref.sourceId}:${detail.id}:${episode.name}:${episode.url}`.slice(0, 300),
            title: `${detail.name} ${episode.name}`,
            url: episode.url,
            kind: isFile && downloadable.has(extension) ? "direct" : "share",
            source: ref.sourceName,
          });
        }
        // 只取第一个播放组（多线路通常同内容；后续线路可在 UI 再选）。
        break;
      }
      return results;
    },
  shareDirectory(reference) {
    if (!shares)
      throw new MediaError("RESOLVER_REQUIRED", "云盘分享解析器尚未配置");
    return shares.directory(reference);
  },
  async scanShare(reference, cursor, signal) {
    if (!shares)
      throw new MediaError("RESOLVER_REQUIRED", "云盘分享解析器尚未配置");
    return shares.scan(reference, cursor, signal);
  },
    async download(task, signal, progress) {
      signal.throwIfAborted();
      const config = getConfig();
      const root = await downloadRoot(config.download.directory);
      const key = `${root.directory}\0${task.id}`;
      if (active.has(key))
        throw new MediaError("ALREADY_RUNNING", "同一下载任务已经在运行");
      active.add(key);
      try {
        if (task.kind === "cloud") {
          if (!shares || !/^mori-share:[a-f0-9]{64}$/.test(task.url))
            throw new MediaError("INVALID_SHARE_REFERENCE", "云盘文件引用无效或解析器尚未配置");
          const file = await shares.resolve(task.url, signal);
          signal.throwIfAborted();
          assertCloudFile(file);
          if (
            matchResource(
              {
                id: task.id,
                title: file.name,
                url: task.url,
                kind: "cloud",
                source: file.provider === "alipan" ? "阿里云盘" : "115",
              },
              task.media,
            ).match === "mismatch"
          )
            throw new MediaError("SHARE_MEDIA_MISMATCH", "云盘实际文件与所选媒体不匹配，未开始下载");
          // shortcut: private cloud links use native resume; add aria2 only with private recovery receipts.
          return await nativeDownload(
            root,
            task,
            httpUrl(file.url),
            config.library.rename,
            signal,
            progress,
            file,
          );
        }
        const kind = classifyResourceUrl(task.url);
        if (
          kind === "share" ||
          kind === "telegram" ||
          task.kind === "share" ||
          task.kind === "telegram"
        )
          throw new MediaError(
            "RESOLVER_REQUIRED",
            "该地址是网盘分享页或 Telegram 消息；请先通过已授权解析器转成直链，或使用 openlist:/文件路径。不会把网页当作下载完成",
          );
        let source = task.url;
        if (kind === "openlist") {
          const body = await jsonRequest(
            endpoint(config.sources.openlistUrl, "/api/fs/get"),
            post(
              { path: openListPath(task.url), password: "" },
              { Authorization: config.sources.openlistToken },
              signal,
            ),
          );
          const data = object(body.data);
          if (data.is_dir || !text(data.raw_url))
            throw new MediaError(
              "OPENLIST_NOT_FILE",
              "OpenList 未返回文件直链",
            );
          source = httpUrl(text(data.raw_url)).href;
          if (classifyResourceUrl(source) !== "direct")
            throw new MediaError(
              "RESOLVER_REQUIRED",
              "OpenList 返回的仍是分享页，未获得文件直链",
            );
        }
        if (config.download.aria2Url)
          return await ariaDownload(
            root,
            task,
            source,
            config,
            signal,
            progress,
          );
        if (kind === "magnet")
          throw new MediaError(
            "ARIA2_REQUIRED",
            "磁力链接需要配置 aria2；目前尚未下载任何文件",
          );
        return await nativeDownload(
          root,
          task,
          httpUrl(source),
          config.library.rename,
          signal,
          progress,
        );
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (task.kind === "cloud" && !(error instanceof MediaError) && !(error instanceof RustCoreError))
          throw new MediaError("CLOUD_DOWNLOAD_FAILED", safeError(error));
        throw error;
      } finally {
        active.delete(key);
      }
    },
    async scrape(file, media, profile, signal) {
      signal?.throwIfAborted();
      if (!PROFILES.includes(profile))
        throw new MediaError("INVALID_PROFILE", "未知的媒体库配置");
      const config = getConfig();
      const root = await downloadRoot(config.download.directory);
      const resolved = await realpath(file);
      const relative = await checkedRelative(root, resolved);
      const segments = relative.split(path.sep);
      if (
        !MEDIA_EXT.has(path.extname(resolved).toLowerCase()) ||
        !(await regularFile(file))?.size ||
        (segments.length > 1 &&
          (media.type !== "tv" ||
            segments.length !== 3 ||
            !/^Season \d{2,3}$/u.test(segments[1])))
      )
        throw new MediaError(
          "UNSAFE_PATH",
          "只允许刮削当前下载目录内已存在的普通媒体文件",
        );
      const warnings: string[] = [];
      let info = { ...media };
      let episodeId: number | undefined;
      let episodeTitle = "";
      let seriesOverview = info.overview;
      if (
        Number.isSafeInteger(media.tmdbId) &&
        media.tmdbId! > 0 &&
        config.sources.tmdbApiKey
      ) {
        try {
          const details = await tmdb(
            config,
            `/${media.type}/${media.tmdbId}`,
            {},
            signal,
          );
          const verified = tmdbInfo(details, media.type);
          if (!verified || verified.tmdbId !== media.tmdbId)
            throw new MediaError(
              "TMDB_ID_MISMATCH",
              "TMDB 返回的媒体身份不匹配",
            );
          info = { ...info, ...verified };
          seriesOverview = info.overview;
          if (
            media.type === "tv" &&
            Number.isInteger(media.season) &&
            media.season! >= 0 &&
            Number.isInteger(media.episode) &&
            media.episode! > 0
          ) {
            const episode = await tmdb(
              config,
              `/tv/${media.tmdbId}/season/${media.season}/episode/${media.episode}`,
              {},
              signal,
            );
            if (text(episode.overview)) info.overview = text(episode.overview);
            if (Number.isSafeInteger(episode.id) && Number(episode.id) > 0)
              episodeId = Number(episode.id);
            episodeTitle = text(episode.name);
          }
        } catch (error) {
          signal?.throwIfAborted();
          warnings.push(
            `TMDB 元数据未更新：${safeError(error)}；仅使用已有信息`,
          );
        }
      } else
        warnings.push(
          "未确认 TMDB 条目或未配置 TMDB Key；NFO 仅包含已提供的信息",
        );
      const stem = path.basename(resolved, path.extname(resolved));
      const nfoRelative = [...segments.slice(0, -1), `${stem}.nfo`].join("/");
      const files: string[] = [];
      if (config.library.artwork)
        for (const [kind, source] of [
          ["poster", info.posterUrl],
          ["fanart", info.backdropUrl],
        ] as const) {
          if (!source) continue;
          try {
            files.push(await artwork(root, `${stem}-${kind}`, source, signal));
          } catch (error) {
            signal?.throwIfAborted();
            warnings.push(`${kind} 图片未写入：${safeError(error)}`);
          }
        }
      const episodic =
        info.type === "tv" &&
        Number.isInteger(info.season) &&
        info.season! >= 0 &&
        Number.isInteger(info.episode) &&
        info.episode! > 0;
      const tag =
        info.type === "movie"
          ? "movie"
          : episodic
            ? "episodedetails"
            : "tvshow";
      const fields: string[] = [
        `  <title>${escapeXml(episodeTitle || info.title)}</title>`,
      ];
      if (episodic)
        fields.push(
          `  <showtitle>${escapeXml(info.title)}</showtitle>`,
          `  <season>${info.season}</season>`,
          `  <episode>${info.episode}</episode>`,
        );
      if (Number.isInteger(info.year))
        fields.push(`  <year>${info.year}</year>`);
      if (info.overview)
        fields.push(`  <plot>${escapeXml(info.overview)}</plot>`);
      const uniqueId = episodic ? episodeId : info.tmdbId;
      if (Number.isSafeInteger(uniqueId) && uniqueId! > 0)
        fields.push(
          `  <uniqueid type="tmdb" default="true">${uniqueId}</uniqueid>`,
        );
      for (const art of files)
        fields.push(
          `  <thumb aspect="${art.includes("-poster.") ? "poster" : "fanart"}">${escapeXml(path.basename(art))}</thumb>`,
        );
      files.unshift(
        await writeSmall(
          root,
          nfoRelative,
          `<?xml version="1.0" encoding="UTF-8"?>\n<${tag}>\n${fields.join("\n")}\n</${tag}>\n`,
          signal,
        ),
      );
      if (episodic && segments.length === 3) {
        const seriesFields = [
          `  <title>${escapeXml(info.title)}</title>`,
        ];
        if (Number.isInteger(info.year))
          seriesFields.push(`  <year>${info.year}</year>`);
        if (seriesOverview)
          seriesFields.push(`  <plot>${escapeXml(seriesOverview)}</plot>`);
        if (Number.isSafeInteger(info.tmdbId) && info.tmdbId! > 0)
          seriesFields.push(
            `  <uniqueid type="tmdb" default="true">${info.tmdbId}</uniqueid>`,
          );
        const seriesRelative = `${segments[0]}/tvshow.nfo`;
        try {
          files.push(
            await writeSmall(
              root,
              seriesRelative,
              `<?xml version="1.0" encoding="UTF-8"?>\n<tvshow>\n${seriesFields.join("\n")}\n</tvshow>\n`,
              signal,
            ),
          );
        } catch (error) {
          if (!(error instanceof MediaError && error.code === "FILE_EXISTS"))
            throw error;
          files.push(relativeTarget(root, seriesRelative));
        }
      }
      return { files, warnings };
    },
    async testConnection(kind) {
      try {
        if (kind === "p115" || kind === "alipan") {
          if (!shares)
            throw new MediaError("RESOLVER_REQUIRED", "云盘分享解析器尚未配置");
          if (kind === "alipan") return await shares.testConnection("alipan");
          return await shares.testConnection();
        }
        const config = getConfig();
        if (kind === "directory") {
          const root = await downloadRoot(config.download.directory);
          await checkRoot(root);
          const probe = await mkdtemp(child(root, ".mori-write-test-"));
          await rm(probe, { recursive: true });
          return {
            ok: true,
            message:
              "下载目录可创建文件；远端 NAS 挂载状态需在实际下载时继续校验",
          };
        }
        if (kind === "pansou") {
          const body = await jsonRequest(
            endpoint(config.sources.pansouUrl, "/api/search"),
            post({ kw: "Mnemo connection test", res: "merge", conc: 1 }),
          );
          const data = object(body.data ?? body);
          if (!data.merged_by_type && !Array.isArray(data.results))
            throw new MediaError(
              "INVALID_RESPONSE",
              "PanSou 返回的不是搜索 API 响应",
            );
        } else if (kind === "openlist") {
          const body = await jsonRequest(
            endpoint(config.sources.openlistUrl, "/api/fs/get"),
            post(
              { path: "/", password: "" },
              { Authorization: config.sources.openlistToken },
            ),
          );
          if (!body.data || !("is_dir" in object(body.data)))
            throw new MediaError(
              "INVALID_RESPONSE",
              "OpenList 返回的不是文件 API 响应",
            );
        } else if (kind === "aria2") {
          const body = object(await rpc(config, "aria2.getVersion"));
          if (!text(body.version))
            throw new MediaError("INVALID_RESPONSE", "aria2 未返回版本信息");
        } else if (kind === "moviepilot") {
          const body = await jsonRequest(
            endpoint(config.sources.moviePilotUrl, "/api/v1/system/ping"),
            {
              headers: {
                Authorization: `Bearer ${config.sources.moviePilotToken}`,
              },
            },
          );
          if (body.success !== true)
            throw new MediaError(
              "INVALID_RESPONSE",
              "MoviePilot 未确认身份；此适配器需要兼容 v2 REST 的访问令牌",
            );
        } else if (kind === "library") {
          const route = ["emby", "jellyfin"].includes(config.library.profile)
            ? "/System/Info/Public"
            : undefined;
          if (!route)
            return {
              ok: false,
              message:
                "该预设输出通用 NFO；尚无厂商专用连接适配器，未验证实际媒体库兼容性",
            };
          const body = await jsonRequest(
            endpoint(config.library.serverUrl, route),
            {
              headers: config.library.serverToken
                ? { "X-Emby-Token": config.library.serverToken }
                : {},
            },
          );
          if (!text(body.ServerName) || !text(body.Version))
            throw new MediaError(
              "INVALID_RESPONSE",
              "地址未返回 Emby/Jellyfin 服务信息",
            );
        } else
          throw new MediaError("UNSUPPORTED_TEST", "不支持该媒体服务连接测试");
        return {
          ok: true,
          message: "API 连接成功；未执行真实下载或媒体库发布",
        };
      } catch (error) {
        return { ok: false, message: safeError(error) };
      }
    },
  };
  return service;
}
