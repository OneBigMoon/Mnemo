import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig, DownloadTask, LibrarySync } from "../shared/types.ts";

const REQUEST_TIMEOUT = 5_000;
const SYNC_TIMEOUT = 25_000;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const POLL_DELAYS = [0, 250, 500, 1_000, 2_000];
const MEDIA_EXTENSIONS = new Set([
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
type Json = Record<string, unknown>;
type Server = {
  base: URL;
  token: string;
  userId?: string;
  profile: "emby" | "jellyfin";
};

class LibraryError extends Error {
  constructor(
    public kind:
      | "config"
      | "auth"
      | "http"
      | "network"
      | "timeout"
      | "response"
      | "path",
    message: string,
  ) {
    super(message);
    this.name = "LibraryError";
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
function identifier(value: unknown): string {
  const id = text(value);
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : "";
}
function tmdbId(value: unknown): string {
  const ids = object(value);
  return String(ids.Tmdb ?? ids.tmdb ?? "");
}

function serverConfig(config: AppConfig): Server {
  const library = config.library;
  if (library.profile !== "emby" && library.profile !== "jellyfin")
    throw new LibraryError("config", "此预设尚无经过核验的媒体库 API 适配器");
  if (!library.serverUrl || !library.serverToken)
    throw new LibraryError("config", "请配置媒体库服务地址和 API 令牌");
  let base: URL;
  try {
    base = new URL(library.serverUrl);
  } catch {
    throw new LibraryError("config", "媒体库服务地址无效");
  }
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new LibraryError(
      "config",
      "媒体库地址须为不含账号、查询参数和片段的 HTTP(S) 服务根地址",
    );
  const userId = library.userId ? identifier(library.userId) : undefined;
  if (library.userId && !userId)
    throw new LibraryError(
      "config",
      "媒体库账户 ID 无效，请重新加载并选择账户",
    );
  base.pathname = base.pathname.replace(/\/+$/, "");
  return { base, token: library.serverToken, userId, profile: library.profile };
}

function api(
  server: Server,
  route: string,
  params: Record<string, string> = {},
): URL {
  const url = new URL(server.base);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${route}`;
  url.search = new URLSearchParams(params).toString();
  return url;
}

async function call(
  server: Server,
  route: string,
  options: {
    method?: "GET" | "POST";
    params?: Record<string, string>;
    signal?: AbortSignal;
    empty?: boolean;
  } = {},
): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  try {
    const response = await fetch(api(server, route, options.params), {
      method: options.method ?? "GET",
      signal,
      redirect: "error",
      headers: { Accept: "application/json", "X-Emby-Token": server.token },
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403)
        throw new LibraryError(
          "auth",
          "媒体库拒绝认证，请检查 API 令牌、账户和访问权限",
        );
      throw new LibraryError(
        "http",
        `媒体库 API 返回 HTTP ${response.status}，请检查服务地址和版本`,
      );
    }
    if (options.empty) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.body)
      throw new LibraryError("response", "媒体库 API 没有返回内容");
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > RESPONSE_LIMIT) {
      await response.body.cancel();
      throw new LibraryError("response", "媒体库 API 响应超过 2 MiB 上限");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > RESPONSE_LIMIT)
          throw new LibraryError("response", "媒体库 API 响应超过 2 MiB 上限");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    signal.throwIfAborted();
    try {
      return JSON.parse(
        Buffer.concat(chunks, size).toString("utf8"),
      ) as unknown;
    } catch {
      throw new LibraryError("response", "媒体库 API 未返回有效 JSON");
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (timeout.aborted)
      throw new LibraryError(
        "timeout",
        "媒体库 API 超时，尚未确认识别和播放来源",
      );
    if (error instanceof LibraryError) throw error;
    throw new LibraryError(
      "network",
      "媒体库连接失败或发生重定向；令牌仅发送给已配置的服务地址",
    );
  }
}

function normalizedServerPath(value: string): string | undefined {
  if (!value || /[\x00-\x1f]/.test(value)) return;
  if (
    path.win32.isAbsolute(value) &&
    (value.includes("\\") || /^[a-z]:/i.test(value))
  )
    return path.win32.normalize(value).toLowerCase();
  if (path.posix.isAbsolute(value) && !value.includes("\\"))
    return path.posix.normalize(value);
}

function sameServerPath(value: unknown, expected: string): boolean {
  const actual = normalizedServerPath(text(value));
  return actual !== undefined && actual === normalizedServerPath(expected);
}

async function targetFile(
  config: AppConfig,
  task: DownloadTask,
): Promise<{ serverPath: string; size: number }> {
  if (
    !task.path ||
    !path.isAbsolute(task.path) ||
    !MEDIA_EXTENSIONS.has(path.extname(task.path).toLowerCase())
  )
    throw new LibraryError("path", "任务没有可验证的本地媒体文件路径");
  const stat = await lstat(task.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0)
    throw new LibraryError("path", "本地媒体文件不存在、为空或是符号链接");
  const local = await realpath(task.path);
  const root = await realpath(config.download.directory);
  const relativeToRoot = path.relative(root, local);
  if (
    !relativeToRoot ||
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  )
    throw new LibraryError("path", "媒体文件必须位于当前配置的下载目录内");
  const { pathFrom, pathTo } = config.library;
  if (!pathFrom && !pathTo) return { serverPath: local, size: stat.size };
  if (
    !pathFrom ||
    !pathTo ||
    !path.isAbsolute(pathFrom) ||
    !normalizedServerPath(pathTo)
  )
    throw new LibraryError(
      "config",
      "媒体库路径映射须同时配置本地绝对目录和服务端绝对目录",
    );
  if (
    pathFrom.split(/[\\/]/).includes("..") ||
    pathTo.split(/[\\/]/).includes("..")
  )
    throw new LibraryError("config", "路径映射不能包含上级路径");
  const from = await realpath(pathFrom);
  const relative = path.relative(from, local);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new LibraryError("path", "媒体文件不在配置的本地映射目录中");
  const join =
    path.win32.isAbsolute(pathTo) &&
    (pathTo.includes("\\") || /^[a-z]:/i.test(pathTo))
      ? path.win32
      : path.posix;
  const serverPath = join.join(pathTo, ...relative.split(path.sep));
  const mappedRelative = join.relative(join.normalize(pathTo), serverPath);
  if (
    !mappedRelative ||
    mappedRelative === ".." ||
    mappedRelative.startsWith(`..${join.sep}`) ||
    join.isAbsolute(mappedRelative)
  )
    throw new LibraryError("path", "媒体文件映射后超出媒体服务器目录");
  return {
    serverPath,
    size: stat.size,
  };
}

async function findItem(
  server: Server,
  expectedPath: string,
  signal: AbortSignal,
): Promise<Json | undefined> {
  const limit = server.profile === "emby" ? 20 : 100;
  const pages = server.profile === "emby" ? 1 : 3;
  for (let page = 0; page < pages; page++) {
    const data = object(
      await call(server, "/Items", {
        params: {
          Recursive: "true",
          IsFolder: "false",
          Fields: "Path,MediaSources,MediaStreams,ProviderIds",
          SortBy: "DateCreated",
          SortOrder: "Descending",
          Limit: String(limit),
          StartIndex: String(page * limit),
          ...(server.profile === "emby" ? { Path: expectedPath } : {}),
          ...(server.userId ? { UserId: server.userId } : {}),
        },
        signal,
      }),
    );
    if (!Array.isArray(data.Items))
      throw new LibraryError("response", "媒体库条目 API 未返回 Items 列表");
    for (const raw of data.Items.slice(0, limit)) {
      const item = object(raw);
      if (sameServerPath(item.Path, expectedPath)) return item;
    }
    if (
      data.Items.length < limit ||
      (typeof data.TotalRecordCount === "number" &&
        data.TotalRecordCount <= (page + 1) * limit)
    )
      return;
  }
}

async function identity(
  server: Server,
  item: Json,
  task: DownloadTask,
  signal: AbortSignal,
): Promise<{ state: "ok" | "pending" | "failed"; message?: string }> {
  const expected = task.media.type === "tv" ? "Episode" : "Movie";
  if (item.Type !== expected)
    return {
      state: "failed",
      message:
        "目标路径的媒体类型与任务不一致，请检查媒体库的电影/剧集类型设置",
    };
  if (item.IsVirtualItem === true || item.LocationType === "Virtual")
    return {
      state: "pending",
      message: "媒体库只有虚拟条目，尚未确认实际文件",
    };
  if (task.media.type === "tv") {
    const { season, episode } = task.media;
    if (
      !Number.isInteger(season) ||
      season! < 0 ||
      !Number.isInteger(episode) ||
      episode! < 1
    )
      return {
        state: "pending",
        message: "任务未提供有效季集信息，无法验收剧集识别",
      };
    if (item.ParentIndexNumber !== season || item.IndexNumber !== episode)
      return {
        state: "failed",
        message: "目标文件已入库，但媒体库识别的季集与任务不一致",
      };
  } else if (
    task.media.year &&
    typeof item.ProductionYear === "number" &&
    item.ProductionYear !== task.media.year
  )
    return {
      state: "failed",
      message: "目标文件已入库，但识别年份与任务不一致",
    };
  if (Number.isSafeInteger(task.media.tmdbId) && task.media.tmdbId! > 0) {
    let providers = item.ProviderIds;
    if (task.media.type === "tv") {
      const seriesId = identifier(item.SeriesId);
      if (!seriesId)
        return {
          state: "pending",
          message: "媒体库尚未关联剧集所属系列，未确认 TMDB 身份",
        };
      const data = object(
        await call(server, "/Items", {
          params: {
            Ids: seriesId,
            Fields: "ProviderIds",
            Limit: "1",
            ...(server.userId ? { UserId: server.userId } : {}),
          },
          signal,
        }),
      );
      const series = Array.isArray(data.Items)
        ? data.Items.map(object).find(
            (value) => value.Id === seriesId && value.Type === "Series",
          )
        : undefined;
      providers = series?.ProviderIds;
    }
    const actual = tmdbId(providers);
    if (!actual)
      return {
        state: "pending",
        message: "媒体库尚未返回目标的 TMDB 身份，等待元数据识别",
      };
    if (actual !== String(task.media.tmdbId))
      return {
        state: "failed",
        message: "媒体库 TMDB 身份与任务不一致，未通过识别验收",
      };
  }
  return { state: "ok" };
}

async function playback(
  server: Server,
  item: Json,
  expectedPath: string,
  size: number,
  signal: AbortSignal,
): Promise<boolean> {
  const id = identifier(item.Id);
  if (!id) throw new LibraryError("response", "媒体库条目 ID 无效");
  const body = object(
    await call(server, `/Items/${id}/PlaybackInfo`, {
      params: server.userId ? { UserId: server.userId } : {},
      signal,
    }),
  );
  if (body.ErrorCode) return false;
  if (!Array.isArray(body.MediaSources))
    throw new LibraryError("response", "播放信息 API 未返回 MediaSources 列表");
  return body.MediaSources.slice(0, 20).some((raw) => {
    const source = object(raw);
    const streams = Array.isArray(source.MediaStreams)
      ? source.MediaStreams.slice(0, 100).map(object)
      : [];
    return (
      sameServerPath(source.Path, expectedPath) &&
      source.Protocol === "File" &&
      source.IsRemote !== true &&
      source.IsInfiniteStream !== true &&
      source.RequiresOpening !== true &&
      source.Size === size &&
      typeof source.RunTimeTicks === "number" &&
      source.RunTimeTicks > 0 &&
      [
        source.SupportsDirectPlay,
        source.SupportsDirectStream,
        source.SupportsTranscoding,
      ].includes(true) &&
      streams.some(
        (stream) =>
          stream.Type === "Video" &&
          /^[a-zA-Z0-9_.+-]{1,64}$/.test(text(stream.Codec)),
      )
    );
  });
}

/** Called only by an explicit account-picker request; syncLibrary never enumerates users. */
export async function listLibraryUsers(
  config: AppConfig,
  signal?: AbortSignal,
): Promise<{ id: string; name: string }[]> {
  signal?.throwIfAborted();
  const server = serverConfig(config);
  const data = await call(server, "/Users", { signal });
  signal?.throwIfAborted();
  if (!Array.isArray(data))
    throw new LibraryError("response", "媒体库账户 API 未返回用户列表");
  if (data.length > 1_000)
    throw new LibraryError("response", "媒体库账户数量超过 1000 上限");
  const found = data.flatMap((raw) => {
    const user = object(raw);
    const id = identifier(user.Id);
    const name = text(user.Name);
    return id &&
      name &&
      name.length <= 200 &&
      object(user.Policy).IsDisabled !== true
      ? [{ id, name }]
      : [];
  });
  return [...new Map(found.map((user) => [user.id, user])).values()];
}

export async function syncLibrary(
  config: AppConfig,
  task: DownloadTask,
  signal?: AbortSignal,
): Promise<LibrarySync> {
  signal?.throwIfAborted();
  const result = (
    status: LibrarySync["status"],
    message: string,
    extra: Partial<LibrarySync> = {},
  ): LibrarySync => ({
    status,
    checkedAt: new Date().toISOString(),
    message,
    ...extra,
  });
  if (!["emby", "jellyfin"].includes(config.library.profile))
    return result(
      "unsupported",
      "此预设目前仅输出通用 NFO，尚未核验厂商刷新和入库 API",
    );
  if (!config.library.serverUrl || !config.library.serverToken)
    return result(
      "not_configured",
      "请配置媒体库服务地址和 API 令牌，再执行入库验收",
    );
  if (config.library.profile === "emby" && !config.library.userId)
    return result(
      "not_configured",
      "Emby 播放信息需要账户，请在媒体库设置中加载并选择账户",
    );
  const deadline = AbortSignal.timeout(SYNC_TIMEOUT);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let dispatched = false;
  let serverPath: string | undefined;
  let itemId: string | undefined;
  try {
    const server = serverConfig(config);
    const target = await targetFile(config, task);
    serverPath = target.serverPath;
    combined.throwIfAborted();
    dispatched = true;
    await call(server, "/Library/Refresh", {
      method: "POST",
      signal: combined,
      empty: true,
    });
    let pendingMessage =
      "刷新已提交，但当前有界查询尚未找到目标文件；请检查媒体库目录和路径映射后重试";
    for (const wait of POLL_DELAYS) {
      if (wait) await delay(wait, undefined, { signal: combined });
      combined.throwIfAborted();
      const item = await findItem(server, serverPath, combined);
      if (!item) continue;
      itemId = identifier(item.Id) || undefined;
      const recognized = await identity(server, item, task, combined);
      if (recognized.state === "failed")
        return result("failed", recognized.message!, {
          serverPath,
          itemId,
          playable: false,
        });
      if (recognized.state === "pending") {
        pendingMessage = recognized.message!;
        continue;
      }
      if (await playback(server, item, serverPath, target.size, combined)) {
        combined.throwIfAborted();
        return result(
          "verified",
          "媒体库已识别目标文件和媒体身份，并返回包含视频流的本地播放来源；尚未测试具体客户端播放",
          { serverPath, itemId, playable: true },
        );
      }
      pendingMessage =
        "已找到目标条目，但尚无与本地文件大小和路径一致的有效视频播放来源";
    }
    combined.throwIfAborted();
    return result("pending", pendingMessage, {
      serverPath,
      itemId,
      playable: false,
    });
  } catch (error) {
    signal?.throwIfAborted();
    const timeout =
      deadline.aborted ||
      (error instanceof LibraryError && error.kind === "timeout");
    const message = deadline.aborted
      ? "入库验收超过 25 秒上限，尚未证明目标已识别和可播放"
      : error instanceof LibraryError
        ? error.message
        : "本地媒体文件不可访问或媒体库验收失败";
    return result(timeout && dispatched ? "pending" : "failed", message, {
      ...(serverPath ? { serverPath } : {}),
      ...(itemId ? { itemId } : {}),
      playable: false,
    });
  }
}
