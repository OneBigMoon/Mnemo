// 注册表驱动的聚合搜索（M6 后续）：把外置源注册表接上真实检索。
//
// 语义对齐：
// - LibreTV：单源失败不影响整体（失败源计入诊断并升级禁用）；
// - 主线 SearchDiagnostics 的逐源状态形状（complete/partial/failed）；
// - Mimosa URL 约束：仅 http/https，端点先经守卫（字面内网/环回拒绝；
//   DNS 解析级校验在真实 fetch 实现时生效）。
//
// 本模块纯函数化：fetch 与时钟全部由调用方注入，无真实网络依赖。

import type { SearchResult } from "../shared/types.js";
import { createHash } from "node:crypto";
import { type SourceRegistry, HealthTracker } from "./source-registry.js";
import { coreEngine, runRustCore, RustCoreError } from "./rust-core.js";

export interface RegistrySearchReport {
  results: SearchResult[];
  status: "complete" | "partial" | "failed" | "not_configured";
  sources: { id: string; status: "ok" | "failed" | "skipped_unhealthy" | "empty"; resultCount: number; error?: string; code?: string }[];
}

export type FetchText = (url: string) => Promise<string>;

export async function settleSearchSources<T, R>(sources: readonly T[], run: (source: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(sources.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
    while (next < sources.length) {
      const index = next++;
      try { results[index] = { status: "fulfilled", value: await run(sources[index]) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }));
  return results;
}

/** 端点守卫：仅 http/https 且拒绝字面内网/环回（Mimosa 约束的字面层）。 */
export function guardEndpoint(endpoint: string): { ok: true; url: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { ok: false, error: "地址无效" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "仅支持 http/https" };
  }
  const host = parsed.hostname.toLowerCase();
  const privateLiteral =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host);
  if (privateLiteral) {
    return { ok: false, error: "拒绝内网/环回地址" };
  }
  return { ok: true, url: parsed.toString() };
}

/** CMS V10 列表条目（部分字段的宽松解析）。 */
interface VodListPayload {
  code?: number;
  list?: { vod_id?: number | string; vod_name?: string; vod_remarks?: string }[];
}

/** 解析 V10 列表 JSON（与 lucerna-core cms::parse_vod_list 同语义）。 */
export function parseVodList(payload: string): { items: { id: string; name: string; remarks?: string }[]; error?: string } {
  let parsed: VodListPayload;
  try {
    parsed = JSON.parse(payload) as VodListPayload;
  } catch (error) {
    return { items: [], error: `响应不是合法 JSON：${error instanceof Error ? error.message : error}` };
  }
  if (parsed.code !== undefined && parsed.code !== 0 && parsed.code !== 1) {
    return { items: [], error: `接口返回 code=${parsed.code}` };
  }
  const items: { id: string; name: string; remarks?: string }[] = [];
  for (const entry of parsed.list ?? []) {
    const id = typeof entry.vod_id === "number" ? String(entry.vod_id) : entry.vod_id?.trim();
    const name = entry.vod_name?.trim();
    if (!id || !name) continue;
    const remarks = entry.vod_remarks?.trim();
    items.push({ id, name, ...(remarks ? { remarks } : {}) });
  }
  return { items };
}

/** percent-encode 查询串（安全子集）。 */
function encodeQuery(query: string): string {
  return encodeURIComponent(query);
}

/**
 * 聚合搜索：并发查询全部启用且健康的源，单源失败不影响整体。
 * 返回聚合结果与逐源诊断；失败源经 healthTracker 升级禁用。
 */
export async function registrySearch(
  registry: SourceRegistry,
  query: string,
  fetchText: FetchText,
  health: HealthTracker,
  nowMinutes: number,
  signal?: AbortSignal,
  parse: typeof runRustCore = runRustCore,
): Promise<RegistrySearchReport> {
  signal?.throwIfAborted();
  if (registry.sources.length > 32) throw new Error("源注册表最多支持 32 个来源");
  const sources = registry.sources.filter((source) => source.enabled !== false);
  if (!sources.length) {
    return { results: [], status: "not_configured", sources: [] };
  }
  const diagnostics: RegistrySearchReport["sources"] = [];
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const settled = await settleSearchSources(sources, async (source) => {
      signal?.throwIfAborted();
      if (!health.isAvailable(source.id, nowMinutes)) {
        diagnostics.push({ id: source.id, status: "skipped_unhealthy", resultCount: 0 });
        return;
      }
      const guarded = guardEndpoint(source.endpoint);
      if (!guarded.ok) {
        health.recordFailure(source.id, nowMinutes);
        diagnostics.push({ id: source.id, status: "failed", resultCount: 0, error: guarded.error });
        return;
      }
      const url = new URL(source.endpoint.replaceAll("{query}", encodeQuery(query)));
      if (source.kind === "cms_v10") url.searchParams.set("wd", query);
      try {
        const payload = await fetchText(url.toString());
        signal?.throwIfAborted();
        if (source.kind !== "cms_v10") {
          if (coreEngine() !== "rust") throw new Error("RSS/Atom 来源需要 Rust 解析核心");
          const feed = await parse("feed", payload, signal);
          if (feed.kind !== source.kind) throw new Error("订阅源格式与配置不一致");
          const keyword = query.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, "");
          let count = 0;
          for (const item of feed.items) {
            if (!item.title || !item.url || !item.title.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, "").includes(keyword)) continue;
            let target: URL;
            try { target = new URL(item.url, url); } catch { continue; }
            if (!["http:", "https:", "magnet:"].includes(target.protocol) || target.username || target.password) continue;
            const key = `${source.id}:feed:${createHash("sha256").update(item.guid || target.href).digest("hex")}`;
            if (seen.has(key)) continue;
            seen.add(key);
            results.push({
              id: key, title: item.title, url: target.href, source: source.name,
              kind: target.protocol === "magnet:" ? "magnet"
                : /\.(?:mp4|mkv|avi|mov|webm|m4v|ts|mpg|flv)$/iu.test(target.pathname) ? "direct" : "share",
              ...(item.size_bytes !== null ? { size: `${item.size_bytes} B` } : {}),
              ...(item.published ? { publishedAt: item.published } : {}),
            });
            count++;
          }
          health.recordSuccess(source.id);
          diagnostics.push({ id: source.id, status: count ? "ok" : "empty", resultCount: count });
          return;
        }
        const parsed: ReturnType<typeof parseVodList> = coreEngine() === "rust"
          ? await parse("cms_list", payload, signal) : parseVodList(payload);
        const { items, error } = parsed;
        if (error) {
          health.recordFailure(source.id, nowMinutes);
          diagnostics.push({ id: source.id, status: "failed", resultCount: 0, error });
          return;
        }
        if (!items.length) {
          health.recordSuccess(source.id);
          diagnostics.push({ id: source.id, status: "empty", resultCount: 0 });
          return;
        }
        const detailRoot = source.detailRoot?.replace(/\/+$/, "") ?? "";
        for (const item of items) {
          // 去重键：源 id + vod id（同一源内天然唯一；跨源同名作品保留各自入口）。
          const key = `${source.id}:${item.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({
            id: key,
            title: item.name,
            url: detailRoot ? `${detailRoot}/?${item.id}.html` : guarded.url,
            kind: "share",
            source: source.name,
            ...(item.remarks ? { size: item.remarks } : {}),
            // 分集解析引用：选片流程据此调用 media.browseCms。
            cmsRef: {
              sourceId: source.id,
              vodId: item.id,
              endpoint: source.endpoint,
              sourceName: source.name,
            },
          });
        }
        health.recordSuccess(source.id);
        diagnostics.push({ id: source.id, status: "ok", resultCount: items.length });
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof RustCoreError && error.code.startsWith("CORE_")))
          health.recordFailure(source.id, nowMinutes);
        diagnostics.push({
          id: source.id,
          status: "failed",
          resultCount: 0,
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof RustCoreError ? { code: error.code } : {}),
        });
      }
    });
  signal?.throwIfAborted();
  // Promise.allSettled 保证逐源处理已收敛（异常都在内部捕获）。
  const failed = settled.filter((item) => item.status === "rejected").length;
  // 空结果源按"已完成无结果"计（对齐主线诊断语义）；只有全部源都未完成才是 failed。
  const completed = diagnostics.filter((item) => item.status === "ok" || item.status === "empty").length;
  const anyFailed = failed > 0 || diagnostics.some((item) => item.status === "failed");
  const status: RegistrySearchReport["status"] =
    completed > 0 ? (anyFailed ? "partial" : "complete") : "failed";
  return { results, status, sources: diagnostics };
}
