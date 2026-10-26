// M2 主线接线：过滤规则卡（与 mnemo-core R2 的 JSON 契约一致）。
// AI 提案规则卡 JSON → validateRuleCard 一次性收集全部问题（回喂修正）→
// evaluateRuleCards 确定性求值（逐字段 Check 明细，解释"为什么没抓取"）。
// 本模块是纯函数；持久化（规则卡表）由服务层决定——当前切片经
// server/index.ts 暴露端点，卡片集由调用方传入。

import type { SearchResult } from "../shared/types.js";
import { episodeMarkers } from "./matching.js";

// ---------------------------------------------------------------------------
// 模型（与 Rust RuleCard/Condition 的 serde JSON 契约一致）
// ---------------------------------------------------------------------------

export type Condition =
  | { type: "title_matches"; patterns: string[]; use_regex?: boolean }
  | { type: "title_excludes"; patterns: string[]; use_regex?: boolean }
  | { type: "group_in"; groups: string[] }
  | { type: "group_not_in"; groups: string[] }
  | { type: "min_size"; bytes: number }
  | { type: "max_size"; bytes: number }
  | { type: "resolution_in"; values: string[] }
  | { type: "source_in"; values: string[] }
  | { type: "codec_in"; values: string[] }
  | { type: "freeleech_only" }
  | { type: "season_in"; values: number[] }
  | { type: "episode_in"; values: number[] }
  | { type: "max_age_minutes"; minutes: number }
  | { type: "extension_in"; values: string[] };

export interface RuleCard {
  id: string;
  name: string;
  enabled?: boolean;
  priority?: number;
  conditions?: Condition[];
  max_downloads?: number;
  quota_period?: "hour" | "day" | "week";
  /** M5：命中本卡时给候选累加的分数（Sonarr CF 打分映射；缺省 0 分）。 */
  score?: number;
}

/** M5：排序选项——minScore 门禁与 upgradeUntil 目标。 */
export interface RankingOptions {
  min_score?: number;
  upgrade_until?: number;
}

/** M5：单个候选的排序结果。 */
export interface Ranked {
  index: number;
  total_score: number;
  matched_cards: string[];
  upgrade_reached: boolean;
}

export interface FilterIssue {
  field: string;
  message: string;
}

export interface Check {
  field: string;
  passed: boolean;
  detail: string;
}

export interface Evaluation {
  card_id: string;
  matched: boolean;
  checks: Check[];
}

export interface Candidate {
  title: string;
  size_bytes?: number;
  group?: string;
  age_minutes?: number;
  freeleech?: boolean;
  extension?: string;
}

export type Expr =
  | { kind: "leaf"; name: string }
  | { kind: "not"; inner: Expr }
  | { kind: "and"; left: Expr; right: Expr }
  | { kind: "or"; left: Expr; right: Expr };

// ---------------------------------------------------------------------------
// 校验（一次性收集所有问题，对齐 Rust collect_issues）
// ---------------------------------------------------------------------------

const QUOTA_PERIODS = new Set(["hour", "day", "week"]);

export function validateRuleCard(value: unknown): { card?: RuleCard; issues: FilterIssue[] } {
  const issues: FilterIssue[] = [];
  const card = value as RuleCard;
  if (!card || typeof card !== "object") {
    return { issues: [{ field: "card", message: "规则卡必须是 JSON 对象" }] };
  }
  if (typeof card.id !== "string" || !card.id.trim()) {
    issues.push({ field: "id", message: "id 不能为空" });
  }
  if (typeof card.name !== "string" || !card.name.trim()) {
    issues.push({ field: "name", message: "name 不能为空" });
  }
  if (card.max_downloads !== undefined) {
    if (typeof card.max_downloads !== "number" || card.max_downloads <= 0) {
      issues.push({
        field: "max_downloads",
        message: "配额必须大于 0；要禁用卡片请把 enabled 置为 false",
      });
    }
    if (!card.quota_period || !QUOTA_PERIODS.has(card.quota_period)) {
      issues.push({
        field: "quota_period",
        message: "设置配额时必须同时指定窗口单位",
      });
    }
  }
  if (card.quota_period && !QUOTA_PERIODS.has(card.quota_period)) {
    issues.push({ field: "quota_period", message: "窗口单位必须是 hour/day/week" });
  }
  if (card.quota_period && card.max_downloads === undefined) {
    issues.push({
      field: "max_downloads",
      message: "设置窗口单位时必须同时指定配额",
    });
  }
  for (const condition of card.conditions ?? []) {
    const check = (patterns: string[], field: string, useRegex: boolean) => {
      for (const pattern of patterns) {
        if (!pattern.trim()) {
          issues.push({ field, message: "模式不能为空字符串" });
          continue;
        }
        if (useRegex) {
          try {
            new RegExp(pattern, "iu");
          } catch (error) {
            issues.push({
              field,
              message: `正则 ${JSON.stringify(pattern)} 无法编译：${error instanceof Error ? error.message : error}`,
            });
          }
        }
      }
    };
    if (condition.type === "title_matches" || condition.type === "title_excludes") {
      if (!Array.isArray(condition.patterns)) {
        issues.push({ field: condition.type, message: "patterns 必须是数组" });
        continue;
      }
      check(condition.patterns, condition.type, condition.use_regex === true);
    }
  }
  return { card: issues.length ? undefined : card, issues };
}

// ---------------------------------------------------------------------------
// 元数据提取（与 Rust parse_metadata 对齐）
// ---------------------------------------------------------------------------

export interface MetaInfo {
  resolutions: string[];
  sources: string[];
  codecs: string[];
  seasons: number[];
  episodes: number[];
  pack: boolean;
}

const RESOLUTION_RE = /(?:^|[^a-z0-9])(2160|1080|720|480)([pi])(?![a-z0-9])/giu;
const SOURCE_RE =
  /(?:^|[^a-z])(blu-?ray|bdremux|remux|bdrip|web-?dl|webrip|web-?hdtv|hdtv|dvdrip|hddvd|web)(?![a-z])/giu;
const CODEC_RE = /(?:^|[^a-z0-9])(x264|h264|avc|x265|h265|hevc|av1|xvid)(?![a-z0-9])/giu;

function normalizeSource(raw: string): string {
  const lowered = raw.toLowerCase().replace(/-/g, "");
  if (lowered === "blu" || lowered === "bluray" || lowered === "bd") return "bluray";
  if (lowered === "bdremux" || lowered === "remux") return "remux";
  if (lowered === "webdl" || lowered === "web" || lowered === "webhdtv") return "webdl";
  if (lowered === "webrip") return "webrip";
  if (lowered === "hdtv") return "hdtv";
  if (lowered === "dvdrip") return "dvdrip";
  if (lowered === "hddvd") return "hddvd";
  if (lowered === "bdrip") return "bdrip";
  return lowered;
}

function normalizeCodec(raw: string): string {
  const lowered = raw.toLowerCase();
  if (lowered === "h264" || lowered === "x264" || lowered === "avc") return "h264";
  if (lowered === "h265" || lowered === "x265" || lowered === "hevc") return "h265";
  if (lowered === "av1") return "av1";
  if (lowered === "xvid") return "xvid";
  return lowered;
}

export function parseMetadata(title: string): MetaInfo {
  const normalized = title.normalize("NFKC");
  const meta: MetaInfo = {
    resolutions: [],
    sources: [],
    codecs: [],
    seasons: [],
    episodes: [],
    pack: false,
  };
  for (const match of normalized.matchAll(RESOLUTION_RE)) {
    const resolution = `${match[1].toLowerCase()}${match[2].toLowerCase()}`;
    if (!meta.resolutions.includes(resolution)) meta.resolutions.push(resolution);
  }
  for (const match of normalized.matchAll(SOURCE_RE)) {
    const source = normalizeSource(match[1]);
    if (!meta.sources.includes(source)) meta.sources.push(source);
  }
  for (const match of normalized.matchAll(CODEC_RE)) {
    const codec = normalizeCodec(match[1]);
    if (!meta.codecs.includes(codec)) meta.codecs.push(codec);
  }
  const markers = episodeMarkers(normalized);
  meta.seasons = markers.seasons;
  meta.episodes = markers.episodes;
  meta.pack = markers.pack;
  return meta;
}

// ---------------------------------------------------------------------------
// 求值（确定性；逐字段 Check 可解释）
// ---------------------------------------------------------------------------

function compilePatterns(
  patterns: string[],
  useRegex: boolean,
): { regexes: RegExp[]; substrings: string[] } {
  if (useRegex) {
    return {
      regexes: patterns.map((pattern) => new RegExp(pattern, "iu")),
      substrings: [],
    };
  }
  return {
    regexes: [],
    substrings: patterns.map((pattern) => pattern.toLowerCase()),
  };
}

export function evaluateRuleCard(
  card: RuleCard,
  candidate: Candidate,
  quotaUsed?: number,
): Evaluation {
  const meta = parseMetadata(candidate.title);
  const titleLower = candidate.title.toLowerCase();
  const groupLower = candidate.group?.toLowerCase();
  const checks: Check[] = [];

  for (const condition of card.conditions ?? []) {
    switch (condition.type) {
      case "title_matches": {
        const { regexes, substrings } = compilePatterns(condition.patterns, condition.use_regex === true);
        const details = condition.patterns.filter((pattern) => {
          if (condition.use_regex === true) {
            return regexes.some((re) => re.test(titleLower));
          }
          return substrings.some((sub) => titleLower.includes(sub));
        });
        checks.push({
          field: "title_matches",
          passed: details.length > 0,
          detail: details.length > 0 ? `命中 ${JSON.stringify(details)}` : "未命中任何模式",
        });
        break;
      }
      case "title_excludes": {
        const { regexes, substrings } = compilePatterns(condition.patterns, condition.use_regex === true);
        const details = condition.patterns.filter((pattern) => {
          if (condition.use_regex === true) {
            return regexes.some((re) => re.test(titleLower));
          }
          return substrings.some((sub) => titleLower.includes(sub));
        });
        checks.push({
          field: "title_excludes",
          passed: details.length === 0,
          detail: details.length > 0 ? `命中排除模式 ${JSON.stringify(details)}` : "未命中排除模式",
        });
        break;
      }
      case "group_in": {
        const lowered = condition.groups.map((g) => g.toLowerCase());
        const passed = groupLower !== undefined && lowered.includes(groupLower);
        checks.push({
          field: "group_in",
          passed,
          detail: `候选发布组 ${JSON.stringify(candidate.group)}，要求 ${JSON.stringify(condition.groups)}`,
        });
        break;
      }
      case "group_not_in": {
        const lowered = condition.groups.map((g) => g.toLowerCase());
        const blocked = groupLower !== undefined && lowered.includes(groupLower);
        checks.push({
          field: "group_not_in",
          passed: !blocked,
          detail: `排除发布组 ${JSON.stringify(condition.groups)}`,
        });
        break;
      }
      case "min_size": {
        checks.push({
          field: "min_size",
          passed: candidate.size_bytes !== undefined && candidate.size_bytes >= condition.bytes,
          detail: `候选 ${JSON.stringify(candidate.size_bytes)} 字节，下限 ${condition.bytes} 字节`,
        });
        break;
      }
      case "max_size": {
        checks.push({
          field: "max_size",
          passed: candidate.size_bytes !== undefined && candidate.size_bytes <= condition.bytes,
          detail: `候选 ${JSON.stringify(candidate.size_bytes)} 字节，上限 ${condition.bytes} 字节`,
        });
        break;
      }
      case "resolution_in": {
        const lowered = condition.values.map((v) => v.toLowerCase());
        const passed =
          lowered.length > 0 && meta.resolutions.some((r) => lowered.includes(r));
        checks.push({
          field: "resolution_in",
          passed,
          detail: `候选分辨率 ${JSON.stringify(meta.resolutions)}，要求 ${JSON.stringify(condition.values)}`,
        });
        break;
      }
      case "source_in": {
        const lowered = condition.values.map((v) => v.toLowerCase());
        const passed = lowered.length > 0 && meta.sources.some((s) => lowered.includes(s));
        checks.push({
          field: "source_in",
          passed,
          detail: `候选来源 ${JSON.stringify(meta.sources)}，要求 ${JSON.stringify(condition.values)}`,
        });
        break;
      }
      case "codec_in": {
        const lowered = condition.values.map((v) => v.toLowerCase());
        const passed = lowered.length > 0 && meta.codecs.some((c) => lowered.includes(c));
        checks.push({
          field: "codec_in",
          passed,
          detail: `候选编码 ${JSON.stringify(meta.codecs)}，要求 ${JSON.stringify(condition.values)}`,
        });
        break;
      }
      case "freeleech_only": {
        checks.push({
          field: "freeleech_only",
          passed: candidate.freeleech === true,
          detail: `候选免费位 ${candidate.freeleech}`,
        });
        break;
      }
      case "season_in": {
        const passed =
          condition.values.length > 0 &&
          meta.seasons.some((season) => condition.values.includes(season));
        checks.push({
          field: "season_in",
          passed,
          detail: `候选季 ${JSON.stringify(meta.seasons)}，要求 ${JSON.stringify(condition.values)}`,
        });
        break;
      }
      case "episode_in": {
        const passed =
          condition.values.length > 0 &&
          meta.episodes.some((episode) => condition.values.includes(episode));
        checks.push({
          field: "episode_in",
          passed,
          detail: `候选集 ${JSON.stringify(meta.episodes)}，要求 ${JSON.stringify(condition.values)}`,
        });
        break;
      }
      case "max_age_minutes": {
        checks.push({
          field: "max_age_minutes",
          passed: candidate.age_minutes !== undefined && candidate.age_minutes <= condition.minutes,
          detail: `候选年龄 ${JSON.stringify(candidate.age_minutes)} 分钟，上限 ${condition.minutes} 分钟`,
        });
        break;
      }
      case "extension_in": {
        const lowered = condition.values.map((v) => v.toLowerCase());
        const passed =
          candidate.extension !== undefined &&
          lowered.includes(candidate.extension.toLowerCase());
        checks.push({
          field: "extension_in",
          passed,
          detail: `候选扩展名 ${JSON.stringify(candidate.extension)}，要求 ${JSON.stringify(condition.values)}`,
        });
        break;
      }
    }
  }
  let matched = checks.every((check) => check.passed);
  if (matched && card.max_downloads !== undefined && card.quota_period && quotaUsed !== undefined) {
    if (quotaUsed >= card.max_downloads) {
      checks.push({
        field: "quota",
        passed: false,
        detail: `配额窗口（${card.quota_period}）用量 ${quotaUsed}/${card.max_downloads}`,
      });
      matched = false;
    }
  }
  return { card_id: card.id, matched, checks };
}

/// 多卡按优先级求值 + 布尔组合表达式求值。
export function evaluateRuleCards(
  cards: RuleCard[],
  candidate: Candidate,
  quotaUsedByCard: Record<string, number> = {},
  expression?: Expr,
): { evaluations: Evaluation[]; expression_matched?: boolean } {
  const sorted = [...cards].filter((card) => card.enabled !== false).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const matched: Record<string, boolean> = {};
  const evaluations = sorted.map((card) => {
    const evaluation = evaluateRuleCard(card, candidate, quotaUsedByCard[card.id]);
    matched[card.id] = evaluation.matched;
    return evaluation;
  });
  let expression_matched: boolean | undefined;
  if (expression) {
    const evalExpr = (expr: Expr): boolean => {
      switch (expr.kind) {
        case "leaf":
          if (!(expr.name in matched)) {
            throw new Error(`组合表达式引用了不存在的卡片：${expr.name}`);
          }
          return matched[expr.name];
        case "not":
          return !evalExpr(expr.inner);
        case "and": {
          // 先行求值两操作数：未知卡片引用必须总是被报告（不短路）。
          const left = evalExpr(expr.left);
          const right = evalExpr(expr.right);
          return left && right;
        }
        case "or": {
          const left = evalExpr(expr.left);
          const right = evalExpr(expr.right);
          return left || right;
        }
      }
    };
    expression_matched = evalExpr(expression);
  }
  return { evaluations, expression_matched };
}

/// 组合表达式解析：`卡A & !(卡B | 卡C)`（与 Rust parse_expr 同语义）。
export function parseExpr(expression: string): Expr {
  const tokens: ({ type: "name"; name: string } | { type: "op"; op: "!" | "&" | "|" | "(" | ")" })[] = [];
  let name = "";
  const flush = () => {
    if (name) {
      tokens.push({ type: "name", name });
      name = "";
    }
  };
  for (const character of expression) {
    if (character === "!" || character === "&" || character === "|" || character === "(" || character === ")") {
      flush();
      tokens.push({ type: "op", op: character });
    } else if (/\s/.test(character)) {
      flush();
    } else {
      name += character;
    }
  }
  flush();
  if (!tokens.length) {
    throw new Error("组合表达式为空");
  }
  let position = 0;
  const peek = (): string | undefined => {
    const token = tokens[position];
    return token?.type === "op" ? token.op : undefined;
  };

  function parseOr(): Expr {
    let left = parseAnd();
    while (peek() === "|") {
      position += 1;
      const right = parseAnd();
      left = { kind: "or", left, right };
    }
    return left;
  }

  function parseAnd(): Expr {
    let left = parseUnary();
    while (peek() === "&") {
      position += 1;
      const right = parseUnary();
      left = { kind: "and", left, right };
    }
    return left;
  }

  function parseUnary(): Expr {
    const op = peek();
    if (op === "!") {
      position += 1;
      return { kind: "not", inner: parseUnary() };
    }
    if (op === "(") {
      position += 1;
      const inner = parseOr();
      if (peek() !== ")") throw new Error("括号不闭合");
      position += 1;
      return inner;
    }
    const token = tokens[position];
    if (token?.type === "name") {
      position += 1;
      return { kind: "leaf", name: token.name };
    }
    throw new Error("期望卡片名或括号");
  }

  const result = parseOr();
  if (position !== tokens.length) {
    throw new Error("组合表达式包含无法解析的剩余内容");
  }
  return result;
}

/// 从搜索结果构造候选（选片流程接线用的便捷入口）。
export function candidateFromResource(resource: Pick<SearchResult, "title" | "size">): Candidate {
  return {
    title: resource.title,
    size_bytes: undefined,
    group: undefined,
  };
}

// ---------------------------------------------------------------------------
// M4：选片流接线——把资源标题/大小转换为候选并对规则卡求值
// ---------------------------------------------------------------------------

const SIZE_RE = /([0-9.]+)\s*(GB|MB|KB|TB)/iu;
const SIZE_MULT: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

/// "1.2 GB" → 字节数；无法解析返回 undefined。
/// （纯字符串解析：不涉及任何子进程或 shell——此前被安全扫描误报为命令
/// 注入，触发词是 RegExp.prototype.exec；改用 String.match 消除模式歧义。）
export function parseSizeBytes(size?: string): number | undefined {
  if (!size) return undefined;
  const match = size.match(SIZE_RE);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return Math.round(value * SIZE_MULT[match[2].toUpperCase()]);
}

/// 对单个资源求值全部启用规则卡（无卡返回空数组）。
export function evaluateResourceAgainstCards(
  resource: { title: string; size?: string },
  cards: RuleCard[],
  quotaUsedByCard: Record<string, number> = {},
): Evaluation[] {
  if (!cards.length) return [];
  const candidate: Candidate = {
    title: resource.title,
    size_bytes: parseSizeBytes(resource.size),
  };
  return evaluateRuleCards(cards, candidate, quotaUsedByCard).evaluations;
}

// ---------------------------------------------------------------------------
// M5：加权排序（与 Rust rank_candidates 同语义）
// ---------------------------------------------------------------------------

export function rankCandidates(
  cards: RuleCard[],
  candidates: Candidate[],
  quotaUsedByCard: Record<string, number> = {},
  options: RankingOptions = {},
): Ranked[] {
  const enabled = cards.filter((card) => card.enabled !== false);
  const ranked: Ranked[] = candidates.map((candidate, index) => {
    const { evaluations } = evaluateRuleCards(enabled, candidate, quotaUsedByCard);
    let total = 0;
    const matched: string[] = [];
    for (const evaluation of evaluations) {
      if (evaluation.matched) {
        const card = enabled.find((item) => item.id === evaluation.card_id);
        total += card?.score ?? 0;
        matched.push(evaluation.card_id);
      }
    }
    return {
      index,
      total_score: total,
      matched_cards: matched,
      upgrade_reached:
        options.upgrade_until !== undefined && total >= options.upgrade_until,
    };
  });
  const min = options.min_score;
  ranked.sort((a, b) => {
    const aOk = min === undefined || a.total_score >= min;
    const bOk = min === undefined || b.total_score >= min;
    if (aOk !== bOk) return aOk ? -1 : 1;
    if (b.total_score !== a.total_score) return b.total_score - a.total_score;
    return a.index - b.index;
  });
  return ranked;
}