// M9：HLS 播放列表的解析、广告分片过滤与代理改写（纯函数）。
//
// 过滤启发式（保守——只剔除高置信广告，宁可放过不可错杀）：
// 1. 跨域分片组：分片 URL 的 host 与播放列表 host 不同的连续段组且总时长 < 60 秒
//    （采集站广告几乎都由第三方 CDN 注入）；
// 2. 短不连续段组：EXT-X-DISCONTINUITY 分隔且总时长 ≤ 8 秒的段组
//    （正片极少出现这种形态）；
// 3. 明确的广告标记行（EXT-X-CUE / SCTE-35 / EXT-X-ASSET）包裹的段。
// 改写：把保留段的绝对 URL 改写为经服务端代理的地址，
// 并在列表头注入 #EXT-X-LUCERNA-FILTERED: <n> 注释（诚实可观测）。
// 主播放列表（master）不做过滤，只改写变体地址。

/** 一个媒体分片/变体条目。 */
export interface PlaylistItem {
  url: string;
  durationSeconds: number;
  /** 条目前的标签行（含 EXTINF 值与 DISCONTINUITY 等）。 */
  precedingTags: string[];
}

export interface ParsedPlaylist {
  kind: "master" | "media";
  items: PlaylistItem[];
}

export interface FilterResult {
  playlist: string;
  kept: number;
  dropped: number;
  kind: "master" | "media";
}

const AD_MARKER = /EXT-X-(CUE|ASSET|DATERANGE.*(CLASS="(scte35|ad)"))/i;
const EXTINF = /^#EXTINF:([\d.]+)/;

/** 解析 m3u8 文本（不处理加密——加密列表由 isEncryptedPlaylist 拒绝）。 */
export function parsePlaylist(text: string, baseUrl: string): ParsedPlaylist {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const isMaster = lines.some((line) => line.startsWith("#EXT-X-STREAM-INF"));
  const items: PlaylistItem[] = [];
  let pendingTags: string[] = [];
  let duration = 0;
  for (const line of lines) {
    if (line.startsWith("#")) {
      pendingTags.push(line);
      const inf = EXTINF.test(line) ? Number((line.match(EXTINF) ?? [])[1]) : 0;
      if (inf) duration = inf;
      continue;
    }
    items.push({
      url: new URL(line, baseUrl).toString(),
      durationSeconds: duration,
      precedingTags: pendingTags,
    });
    pendingTags = [];
    duration = 0;
  }
  return { kind: isMaster ? "master" : "media", items };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

function hasDiscontinuity(tags: string[]): boolean {
  return tags.some((tag) => tag.startsWith("#EXT-X-DISCONTINUITY"));
}

function hasAdMarker(tags: string[]): boolean {
  return tags.some((tag) => AD_MARKER.test(tag));
}

/**
 * 过滤并改写媒体播放列表：返回可直接作为 HTTP 响应体的 m3u8 文本。
 * proxyUrl(absolute) 由调用方提供（生产为 /api/cms/segment?url=…）。
 */
export function filterMediaPlaylist(
  text: string,
  playlistUrl: string,
  proxyUrl: (absolute: string) => string,
  options: { shortRunSeconds?: number } = {},
): FilterResult {
  const shortRun = options.shortRunSeconds ?? 8;
  const parsed = parsePlaylist(text, playlistUrl);
  if (parsed.kind === "master") {
    const body = rewriteMaster(text, playlistUrl, proxyUrl);
    return { playlist: body, kept: parsed.items.length, dropped: 0, kind: "master" };
  }
  const playlistHost = hostOf(playlistUrl);
  // 按 DISCONTINUITY 边界分组；广告标记的段自成一组（标记只作用于该段）；
  // 无边界时全部段同组（仅跨域判定生效）。
  const groups: PlaylistItem[][] = [];
  let current: PlaylistItem[] = [];
  for (const item of parsed.items) {
    if (hasAdMarker(item.precedingTags)) {
      if (current.length) groups.push(current);
      groups.push([item]);
      current = [];
      continue;
    }
    const startsNewRun = hasDiscontinuity(item.precedingTags);
    if (startsNewRun && current.length) {
      groups.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length) groups.push(current);

  const keptLines: string[] = ["#EXTM3U"];
  let kept = 0;
  let dropped = 0;
  for (const group of groups) {
    const runSeconds = group.reduce((total, item) => total + item.durationSeconds, 0);
    const crossDomain = group.some((item) => hostOf(item.url) !== playlistHost);
    const marked = group.some((item) => hasAdMarker(item.precedingTags));
    const drop =
      marked ||
      (crossDomain && runSeconds < 60) ||
      (group.length >= 2 && runSeconds > 0 && runSeconds <= shortRun);
    if (drop) {
      dropped += group.length;
      continue;
    }
    for (const item of group) {
      for (const tag of item.precedingTags) {
        // 剔除被过滤组残留的边界/广告标记，保留 EXTINF/KEY 等必要行。
        if (tag.startsWith("#EXT-X-DISCONTINUITY")) continue;
        if (AD_MARKER.test(tag)) continue;
        keptLines.push(tag);
      }
      keptLines.push(proxyUrl(item.url));
      kept += 1;
    }
  }
  keptLines.push("#EXT-X-ENDLIST");
  const header = dropped > 0 ? `#EXT-X-LUCERNA-FILTERED: ${dropped}` : null;
  const body = (header ? ["#EXTM3U", header, ...keptLines.slice(1)] : keptLines).join("\n") + "\n";
  return { playlist: body, kept, dropped, kind: "media" };
}

function rewriteMaster(
  text: string,
  baseUrl: string,
  proxyUrl: (absolute: string) => string,
): string {
  const lines = text.split(/\r?\n/);
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const absolute = new URL(trimmed, baseUrl).toString();
    return proxyUrl(absolute);
  });
  return out.join("\n");
}

/** 是否加密列表（含密钥的列表不做代理——密钥请求无法安全转发）。 */
export function isEncryptedPlaylist(text: string): boolean {
  return /^#EXT-X-KEY:(?!METHOD=NONE)/im.test(text);
}

/** 端点 URL 守卫（仅 http/https + 字面内网/环回拒绝）。 */
export { guardEndpoint } from "./registry-search.js";
