import type { MediaInfo, SearchResult } from "../shared/types.js";

export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function number(value: string): number {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  let total = 0,
    digit = 0;
  for (const character of value) {
    if (character in digits) digit = digits[character];
    else {
      const unit = { 十: 10, 百: 100, 千: 1000 }[character];
      if (!unit) return NaN;
      total += (digit || 1) * unit;
      digit = 0;
    }
  }
  return total + digit;
}

// M1：罗马数字季（严格校验，非规范写法如 "ILL" 拒绝）。
function romanNumber(value: string): number | undefined {
  const upper = value.toUpperCase();
  const weights: Record<string, number> = {
    I: 1,
    V: 5,
    X: 10,
    L: 50,
    C: 100,
    D: 500,
    M: 1000,
  };
  let total = 0,
    previous = 0;
  for (const character of [...upper].reverse()) {
    const current = weights[character];
    if (!current) return undefined;
    if (current < previous) total -= current;
    else {
      total += current;
      previous = current;
    }
  }
  if (!total) return undefined;
  const table: [number, string][] = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let remaining = total,
    canonical = "";
  for (const [amount, symbol] of table)
    while (remaining >= amount) {
      canonical += symbol;
      remaining -= amount;
    }
  return canonical === upper ? total : undefined;
}

const CHINESE_NUMBER = "[0-9零〇一二两三四五六七八九十百千]+";
const RANGE_SEPARATOR = "[-~至到+&,、/–—−～〜]";
// A dot before a resolution is a separator; before another number it may be a fractional episode.
const EPISODE_END =
  "(?![\\p{L}\\p{N}]|[.,](?!(?:2160|1080|720|480)[pi]\\b)\\d|\\s*[-~至到–—−～〜]\\s*(?!(?:2160|1080|720|480)[pi]\\b)(?:E\\s*)?\\d)";
export function episodeMarkers(title: string): {
  seasons: number[];
  episodes: number[];
  pack: boolean;
} {
  const text = title.normalize("NFKC");
  const seasons: number[] = [],
    episodes: number[] = [];
  let multipleSeasons = false;
  for (const match of text.matchAll(
    new RegExp(
      `\\bS(\\d{1,3})(?:[ ._-]*E(\\d{1,4}))?(?:${EPISODE_END}|v\\d{1,2}\\b)`,
      "giu",
    ),
  )) {
    seasons.push(Number(match[1]));
    if (match[2]) episodes.push(Number(match[2]));
  }
  for (const match of text.matchAll(
    new RegExp(
      `\\b(\\d{1,3})x(\\d{1,4})(?:${EPISODE_END}|v\\d{1,2}\\b)`,
      "giu",
    ),
  )) {
    seasons.push(Number(match[1]));
    episodes.push(Number(match[2]));
  }
  for (const match of text.matchAll(
    new RegExp(`\\bSeasons?[ ._-]*(\\d{1,3})${EPISODE_END}`, "giu"),
  ))
    seasons.push(Number(match[1]));
  for (const match of text.matchAll(
    new RegExp(
      `\\b(?:E|Episode)[ ._-]*(\\d{1,4})(?:${EPISODE_END}|v\\d{1,2}\\b)`,
      "giu",
    ),
  ))
    episodes.push(Number(match[1]));
  for (const match of text.matchAll(/(?:S\d{1,3})?((?:E\d{1,4}){2,})/giu)) {
    for (const episode of match[1].matchAll(/E(\d{1,4})/giu))
      episodes.push(Number(episode[1]));
  }
  for (const match of text.matchAll(
    new RegExp(
      `(?<!(?:不包含|不包括|不含)\\s*)(?<![全共]\\s*)第\\s*(${CHINESE_NUMBER})\\s*季`,
      "gu",
    ),
  ))
    seasons.push(number(match[1]));
  for (const match of text.matchAll(
    new RegExp(
      `(?<!(?:不包含|不包括|不含)\\s*)(?<![全共]\\s*)第\\s*(${CHINESE_NUMBER})\\s*集`,
      "gu",
    ),
  ))
    episodes.push(number(match[1]));
  // M1：完结/Fin 区间记录两端点（含 [01-12Fin] 括号形式）。
  for (const match of text.matchAll(
    new RegExp(
      `第?\\s*(${CHINESE_NUMBER}|\\d{1,4})\\s*${RANGE_SEPARATOR}\\s*(?:第\\s*)?(${CHINESE_NUMBER}|\\d{1,4})\\s*[集话話期幕]?\\s*(?:已)?\\s*(?:完结|Fin\\b)`,
      "giu",
    ),
  )) {
    const first = number(match[1]);
    const last = number(match[2]);
    if (Number.isFinite(first) && Number.isFinite(last)) episodes.push(first, last);
  }
  for (const match of text.matchAll(
    /[【\[]\s*(\d{1,4})\s*-\s*(\d{1,4})\s*Fin\s*[】\]]/giu,
  )) {
    episodes.push(Number(match[1]), Number(match[2]));
  }
  // M1：罗马数字季（严格校验，"Season Live" 等普通词不触发）。
  for (const match of text.matchAll(/\bSeasons?\s+([IVXLC]{1,8})\b/giu)) {
    const value = romanNumber(match[1]);
    if (value !== undefined) seasons.push(value);
  }
  // M1：动画 [TV 01] 记号（括号形式，避免 Apple TV 4 之类误报）。
  for (const match of text.matchAll(/[【\[]\s*TV\s*(\d{1,4})\s*[】\]]/giu)) {
    episodes.push(Number(match[1]));
  }
  // A season range is ambiguous. Record both endpoints so directory context
  // cannot silently collapse it to the final season.
  for (const match of text.matchAll(
    new RegExp(
      `\\bSeasons?[ ._-]*(\\d{1,3})\\s*${RANGE_SEPARATOR}\\s*(?:Seasons?[ ._-]*)?(\\d{1,3})\\b|第\\s*(${CHINESE_NUMBER})\\s*${RANGE_SEPARATOR}\\s*(?:第\\s*)?(${CHINESE_NUMBER})\\s*季|\\bS(\\d{1,3})\\s*${RANGE_SEPARATOR}\\s*(?:S)?(\\d{1,3})\\b`,
      "giu",
    ),
  )) {
    const first = number(match[1] ?? match[3] ?? match[5]);
    const last = number(match[2] ?? match[4] ?? match[6]);
    if (Number.isFinite(first) && Number.isFinite(last)) {
      seasons.push(first, last);
      multipleSeasons = true;
    }
  }
  const compoundChineseEpisodes = new RegExp(
    `第\\s*${CHINESE_NUMBER}\\s*(?:${RANGE_SEPARATOR}\\s*(?:第\\s*)?${CHINESE_NUMBER}\\s*){1,}集`,
    "gu",
  ).test(text);
  const bareSecondEpisode =
    /\b(?:S\d{1,3}[ ._-]*)?E\d{1,4}[ \t]+\d{1,3}(?![\p{L}\p{N}]|[.,]\d)/iu.test(
      text,
    );
  const pack =
    compoundChineseEpisodes ||
    bareSecondEpisode ||
    /(?:全集|全季|整季|合集|全\s*\d+\s*集|全\s*[\d零〇一二两三四五六七八九十百千]+\s*集|共\s*[\d零〇一二两三四五六七八九十百千]+\s*集|\b(?:complete|pack|collection)\b|\b(?:S\d{1,3}[ ._-]*)?E\d+\s*[-~至到+&,、/–—−～〜]\s*(?:S\d{1,3}[ ._-]*)?E?\d+\b|\b\d+x\d+\s*[-~至到+&,、/–—−～〜]\s*(?:\d+x)?\d+\b|第\s*[\d零〇一二两三四五六七八九十百千]+\s*[-~至到+&,、/–—−～〜]\s*(?:第\s*)?[\d零〇一二两三四五六七八九十百千]+\s*集|\b(?:part|cd|dvd|disc|disk)\s*[0-9ab]\b)/iu.test(
      text,
    ) ||
    new Set(episodes).size > 1 ||
    new Set(seasons).size > 1 ||
    multipleSeasons;
  // Ranges can block the single-episode pattern while still naming a season.
  if (pack)
    for (const match of text.matchAll(/\b(?:S(\d{1,3})[ ._-]*E|(\d{1,3})x)\d/giu))
      seasons.push(Number(match[1] ?? match[2]));
  return {
    seasons: [...new Set(seasons)],
    episodes: [...new Set(episodes)],
    pack,
  };
}

const METADATA =
  /^(?:(?:18[89]\d|19\d{2}|20\d{2}|21\d{2})(?:\s|$)|s\d{1,3}(?:e\d{1,4})?(?:\s|$)|e\d{1,4}(?:\s|$)|\d{1,3}x\d{1,4}(?:\s|$)|season\s*\d|episode\s*\d|第[0-9零〇一二两三四五六七八九十百千]+[季集]|(?:2160|1080|720|480)[pi](?:\s|$)|[48]k(?:\s|$)|(?:movie|tv|series|complete|pack|bluray|blu ray|web dl|webrip|h264|h265|hevc|x264|x265|hdr|mkv|mp4)(?:\s|$)|电影|电视剧|剧集|全集|全季|整季|合集)/iu;

export function matchResource(
  resource: SearchResult,
  expected: MediaInfo,
): {
  match: "matched" | "uncertain" | "mismatch";
  reason: string;
  media?: MediaInfo;
} {
  const aliases = [
    ...new Set(
      [expected.title, expected.originalTitle]
        .filter((value): value is string => Boolean(value))
        .map(normalizeTitle),
    ),
  ];
  let title = resource.title.normalize("NFKC").trim();
  let tags = "";
  for (let i = 0; i < 3; i++) {
    const tag = title.match(/^(?:\[([^\]]+)\]|【([^】]+)】)\s*/u);
    if (!tag || aliases.includes(normalizeTitle(tag[1] || tag[2]))) break;
    tags += ` ${tag[1] || tag[2]}`;
    title = title.slice(tag[0].length);
  }
  const normalized = normalizeTitle(title);
  const prefixes = aliases
    .filter((alias) => normalized.startsWith(alias))
    .sort((a, b) => b.length - a.length);
  const alias = prefixes[0];
  const identities = alias ? [alias] : [];
  let suffix = alias ? normalized.slice(alias.length).trim() : normalized;
  if (alias) {
    const other = aliases.find(
      (value) => value !== alias && suffix.startsWith(value),
    );
    if (other) {
      suffix = suffix.slice(other.length).trim();
      identities.push(other);
    }
  }
  if (!alias || (suffix && !METADATA.test(suffix))) {
    const generic =
      METADATA.test(normalized) ||
      /^(?:未命名资源|资源|下载|视频|file|video|episode\s*\d+|e\d+|\d+\s+(?:mkv|mp4|avi))(?:\s|$)/iu.test(
        normalized,
      );
    return {
      match: generic || !normalized ? "uncertain" : "mismatch",
      reason:
        generic || !normalized
          ? "资源标题没有可核验的片名"
          : "资源片名与已确认的完整片名不同",
    };
  }
  const identityPattern = identities
    .map((identity) => identity.split(" ").join("[^\\p{L}\\p{N}]+"))
    .join("[^\\p{L}\\p{N}]*");
  const metadata = title.replace(
    new RegExp(`^[^\\p{L}\\p{N}]*${identityPattern}`, "iu"),
    "",
  );
  const markers = episodeMarkers(metadata);
  const isTv =
    markers.seasons.length > 0 ||
    markers.episodes.length > 0 ||
    /(?:电视剧|剧集|\b(?:tv|series)\b|\bS\d{1,3}[ ._-]*E\d{1,4}|\b\d{1,3}x\d{1,4})/iu.test(
      `${tags} ${metadata}`,
    );
  const isMovie = /(?:电影|\bmovie\b)/iu.test(`${tags} ${suffix}`);
  if (
    (expected.type === "movie" && isTv) ||
    (expected.type === "tv" && isMovie)
  )
    return { match: "mismatch", reason: "资源的电影/剧集类型与已确认身份不同" };
  const years = [
    ...new Set(
      [...suffix.matchAll(/\b(18[89]\d|19\d{2}|20\d{2}|21(?!60)\d{2})\b/gu)].map(
        (match) => Number(match[1]),
      ),
    ),
  ];
  if (
    expected.year !== undefined &&
    years.length &&
    !years.includes(expected.year)
  )
    return {
      match: "mismatch",
      reason: "资源年份不同，可能是同名作品或翻拍版",
    };
  if (expected.type === "movie" && markers.pack)
    return {
      match: "mismatch",
      reason: "资源带合集或整包标记，不能当作所选单片",
    };
  if (expected.type === "tv") {
    if (
      expected.season !== undefined &&
      markers.seasons.length &&
      !markers.seasons.includes(expected.season)
    )
      return { match: "mismatch", reason: "资源季数与所选季数不同" };
    if (
      expected.episode !== undefined &&
      markers.episodes.length &&
      !markers.episodes.includes(expected.episode)
    )
      return { match: "mismatch", reason: "资源集数与所选集数不同" };
    if (
      expected.episode !== undefined &&
      (markers.pack ||
        markers.episodes.length > 1 ||
        markers.seasons.length > 1)
    )
      return {
        match: "mismatch",
        reason: "资源是整季或多集包，不能当作所选单集",
      };
  }
  const media: MediaInfo = {
    ...expected,
    ...(expected.year === undefined && years.length === 1
      ? { year: years[0] }
      : {}),
    ...(expected.type === "tv" && markers.seasons.length === 1
      ? { season: markers.seasons[0] }
      : {}),
    ...(expected.type === "tv" && markers.episodes.length === 1 && !markers.pack
      ? { episode: markers.episodes[0] }
      : {}),
  };
  if (expected.year === undefined || years.length !== 1)
    return {
      match: "uncertain",
      reason: "缺少唯一年份证据，无法排除同名作品",
      media,
    };
  if (
    expected.type === "tv" &&
    (expected.season === undefined ||
      markers.seasons.length !== 1 ||
      markers.episodes.length !== 1 ||
      markers.pack)
  )
    return {
      match: "uncertain",
      reason: markers.pack
        ? "整季或多集包需人工核对内容"
        : "缺少唯一季集证据，需人工确认",
      media,
    };
  return { match: "matched", reason: "完整片名、年份及季集证据一致", media };
}

const DIRECTORY_MEDIA = /\.(?:mp4|mkv|avi|mov|webm|m4v|ts|m2ts|mpg|mpeg|wmv|flv|vob)$/iu;
const RESOLUTION_NAME = /^(?:360|480|576|720|1080|1440|2160|4320)$/u;
const DIRECTORY_METADATA = new RegExp(
  `^(?:(?:s\\d{1,3}(?:\\s*e\\d{1,4})?|e\\d{1,4}|season\\s*\\d{1,3}|episode\\s*\\d{1,4}|\\d{1,3}x\\d{1,4}|第\\s*${CHINESE_NUMBER}\\s*[季集]|18[89]\\d|19\\d{2}|20\\d{2}|21\\d{2}|(?:2160|1080|720|480)[pi]|(?:360|480|576|720|1080|1440|2160|4320)|[48]k|movie|tv|series|complete|pack|collection|bluray|blu ray|web dl|webrip|h264|h265|hevc|x264|x265|hdr|全集|全季|整季|合集|全\\s*${CHINESE_NUMBER}\\s*集|电影|电视剧|剧集|视频|资源|下载)(?:\\s+|$))+$`,
  "iu",
);
const EXTRA_CONTENT = /(?:预告|花絮|特典|幕后|片花|访谈|删减|字幕|\b(?:trailers?|teasers?|featurettes?|extras?|bonus|sample|preview|subtitles?|interviews?)\b|\b(?:behind[ ._-]*the[ ._-]*scenes|deleted[ ._-]*scenes)\b)/iu;

export function matchDirectoryResource(
  resource: SearchResult,
  expected: MediaInfo,
  directories: string[] = [],
): ReturnType<typeof matchResource> {
  const filename = resource.title.normalize("NFKC").trim();
  if (resource.navigation || !DIRECTORY_MEDIA.test(filename))
    return { match: "mismatch", reason: "目录项不是支持的视频文件" };
  const aliases = [expected.title, expected.originalTitle]
    .filter((value): value is string => Boolean(value))
    .map(normalizeTitle)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const describe = (name: string) => {
    let metadata = name.normalize("NFKC").trim();
    let tags = "";
    for (let index = 0; index < 3; index++) {
      const tag = metadata.match(/^(?:\[([^\]]+)\]|【([^】]+)】)\s*/u);
      if (!tag || aliases.includes(normalizeTitle(tag[1] || tag[2]))) break;
      tags += ` ${tag[1] || tag[2]}`;
      metadata = metadata.slice(tag[0].length);
    }
    let identity = false;
    for (let index = 0; index < 2; index++) {
      const alias = aliases.find((value) => normalizeTitle(metadata).startsWith(value));
      if (!alias) break;
      metadata = metadata.replace(
        new RegExp(`^[^\\p{L}\\p{N}]*${alias.split(" ").join("[^\\p{L}\\p{N}]+")}`, "iu"),
        "",
      );
      identity = true;
    }
    return { metadata, tags, identity };
  };
  const seasons = new Set<number>();
  const years = new Set<number>();
  const directoryEpisodes = new Set<number>();
  for (const directory of directories) {
    const info = describe(directory);
    if (EXTRA_CONTENT.test(`${info.tags} ${info.metadata}`))
      return { match: "mismatch", reason: "目录属于预告、花絮或字幕内容" };
    const normalized = normalizeTitle(info.metadata.replace(
      /全集|全季|整季|合集|全\s*[0-9零〇一二两三四五六七八九十百千]+\s*集|\b(?:complete|pack|collection)\b/giu,
      " ",
    ));
    if (normalized && !DIRECTORY_METADATA.test(normalized))
      return { match: "mismatch", reason: "目录含有其他作品身份或无法核验的命名" };
    const markers = episodeMarkers(info.metadata);
    for (const season of markers.seasons) seasons.add(season);
    if (!markers.pack)
      for (const episode of markers.episodes) directoryEpisodes.add(episode);
    for (const year of info.metadata.matchAll(
      /\b(18[89]\d|19\d{2}|20\d{2}|21(?!60)\d{2})\b/gu,
    ))
      years.add(Number(year[1]));
  }
  let stem = filename.replace(DIRECTORY_MEDIA, "");
  if (
    /^\d{1,4}$/u.test(stem) &&
    !/^(?:18[89]\d|19\d{2}|20\d{2}|21(?!60)\d{2})$/u.test(stem) &&
    !RESOLUTION_NAME.test(stem)
  )
    stem = `E${stem}`;
  const info = describe(stem);
  if (EXTRA_CONTENT.test(`${info.tags} ${info.metadata}`))
    return { match: "mismatch", reason: "文件属于预告、花絮或字幕内容" };
  const markers = episodeMarkers(info.metadata);
  if (markers.pack)
    return { match: "mismatch", reason: "文件是整季或多集包" };
  for (const season of markers.seasons) seasons.add(season);
  for (const year of info.metadata.matchAll(
    /\b(18[89]\d|19\d{2}|20\d{2}|21(?!60)\d{2})\b/gu,
  ))
    years.add(Number(year[1]));
  if (expected.season !== undefined) seasons.add(expected.season);
  if (expected.year !== undefined) years.add(expected.year);
  if (seasons.size > 1 || years.size > 1)
    return { match: "mismatch", reason: "目录或文件的年份、季号与绑定作品冲突" };
  if (directoryEpisodes.size > 1 || [...directoryEpisodes].some((episode) =>
    markers.episodes.length === 1 && episode !== markers.episodes[0]))
    return { match: "mismatch", reason: "目录与文件的集号冲突" };
  const strict = matchResource(resource, expected);
  const normalized = normalizeTitle(info.metadata);
  if (strict.match === "mismatch" && (info.identity || !DIRECTORY_METADATA.test(normalized)))
    return strict;
  if (!expected.year || !Number.isInteger(expected.year))
    return { match: "uncertain", reason: "绑定作品的年份仍需确认" };
  if (expected.type === "movie") {
    if (seasons.size || markers.episodes.length)
      return { match: "mismatch", reason: "电影目录中出现剧集季集信息" };
    return strict;
  }
  // Directory trust fills missing identity; unexplained filename tokens still need confirmation.
  if ((info.tags && !info.identity) || !DIRECTORY_METADATA.test(normalized))
    return strict.match === "mismatch"
      ? strict
      : { match: "uncertain", reason: "文件名包含无法核验的身份或版本信息" };
  if (markers.episodes.length !== 1 || seasons.size !== 1)
    return { match: "uncertain", reason: "文件缺少单一明确集号或可信季号" };
  const title = [
    info.identity ? stem : `${expected.title} ${stem}`,
    !/\b(18[89]\d|19\d{2}|20\d{2}|21(?!60)\d{2})\b/u.test(info.metadata)
      ? expected.year
      : "",
    markers.seasons.length ? "" : `S${[...seasons][0]}`,
  ].filter((value) => value !== "").join(" ");
  return matchResource({ ...resource, title }, { ...expected, season: [...seasons][0] });
}

// M1：从简介文本提取分集证据（保守：只认 全/共 计数与完结区间，不认单集）。
// 供后续在请求/订阅流程接入；标题解析仍以 episodeMarkers 为准。
export function episodeMarkersFromDescription(text: string): {
  seasons: number[];
  episodes: number[];
  pack: boolean;
} {
  const normalized = text.normalize("NFKC");
  const seasons: number[] = [];
  const episodes: number[] = [];
  let pack =
    /(?:全|共)\s*(?:\d|零〇一二两三四五六七八九十百千)+\s*集/u.test(normalized);
  for (const match of normalized.matchAll(
    new RegExp(
      `第?\\s*(${CHINESE_NUMBER}|\\d{1,4})\\s*${RANGE_SEPARATOR}\\s*(?:第\\s*)?(${CHINESE_NUMBER}|\\d{1,4})\\s*[集话話期幕]?\\s*(?:已)?\\s*(?:完结|Fin\\b)`,
      "giu",
    ),
  )) {
    const first = number(match[1]);
    const last = number(match[2]);
    if (Number.isFinite(first) && Number.isFinite(last)) {
      episodes.push(first, last);
      pack = true;
    }
  }
  return { seasons: [...new Set(seasons)], episodes: [...new Set(episodes)], pack };
}
