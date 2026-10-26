// M6：外置源注册表——"定义即数据，加载即适配"（对齐 LibreTV/autobrr 的
// 站点定义外置思路；本模块只做数据模式与加载/校验/健康，不发起请求）。
//
// 源注册表是一份 JSON 文档（版本化），每条源定义描述一个可聚合的采集端点。
// 生产中由管理员提供；加载器全量校验并一次性返回全部问题（对齐规则卡校验）。

export type SourceKind = "cms_v10" | "rss" | "atom";

export interface SourceDefinition {
  id: string;
  name: string;
  kind: SourceKind;
  /** 端点模板：{query} 占位（CMS V10 为 api.php/provide/vod 基址；RSS 为固定 URL，忽略 {query}）。 */
  endpoint: string;
  /** 可选：详情页根 URL（CMS 源从详情页抓 m3u8 时需要）。 */
  detailRoot?: string;
  enabled?: boolean;
}

export interface SourceRegistry {
  format: 1;
  sources: SourceDefinition[];
}

export interface RegistryIssue {
  field: string;
  message: string;
}

const KINDS: SourceKind[] = ["cms_v10", "rss", "atom"];

/** 全量校验源注册表：一次性返回所有问题。 */
export function validateRegistry(value: unknown): { registry?: SourceRegistry; issues: RegistryIssue[] } {
  const issues: RegistryIssue[] = [];
  const doc = value as Partial<SourceRegistry>;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.sources)) {
    return { issues: [{ field: "registry", message: "源注册表必须是含 sources 数组的 JSON 对象" }] };
  }
  if (doc.format !== 1) {
    issues.push({ field: "format", message: "format 必须是 1" });
  }
  if (doc.sources.length > 32) {
    issues.push({ field: "sources", message: "源注册表最多支持 32 个来源" });
  }
  const seen = new Set<string>();
  doc.sources.forEach((source, index) => {
    const at = `sources[${index}]`;
    if (!source || typeof source !== "object") {
      issues.push({ field: at, message: "源定义必须是对象" });
      return;
    }
    if (typeof source.id !== "string" || !source.id.trim()) {
      issues.push({ field: `${at}.id`, message: "id 不能为空" });
    } else if (seen.has(source.id)) {
      issues.push({ field: `${at}.id`, message: `id 重复：${source.id}` });
    } else {
      seen.add(source.id);
    }
    if (typeof source.name !== "string" || !source.name.trim()) {
      issues.push({ field: `${at}.name`, message: "name 不能为空" });
    }
    if (!KINDS.includes(source.kind)) {
      issues.push({ field: `${at}.kind`, message: `kind 必须是 ${KINDS.join("/")}` });
    }
    if (typeof source.endpoint !== "string" || !/^https?:\/\//i.test(source.endpoint)) {
      issues.push({ field: `${at}.endpoint`, message: "endpoint 必须是 http/https 地址" });
    } else if (/localhost|127\.0\.0\.1|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\./i.test(source.endpoint)) {
      issues.push({ field: `${at}.endpoint`, message: "endpoint 拒绝内网/环回地址" });
    }
  });
  return { registry: issues.length ? undefined : (doc as SourceRegistry), issues };
}

/** 从 JSON 文本加载并校验。 */
export function loadRegistry(text: string): { registry?: SourceRegistry; issues: RegistryIssue[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      issues: [
        { field: "registry", message: `源注册表不是合法 JSON：${error instanceof Error ? error.message : error}` },
      ],
    };
  }
  return validateRegistry(parsed);
}

// ---------------------------------------------------------------------------
// 源健康状态机（对齐 lucerna-core cms::HealthTracker 的递增禁用语义）
// ---------------------------------------------------------------------------

const ESCALATION_MINUTES = [30, 24 * 60, 28 * 24 * 60];

interface SourceHealth {
  consecutiveFailures: number;
  disabledUntil: number | null;
}

/** 健康追踪器：nowMinutes 由调用方注入（不取时钟）。 */
export class HealthTracker {
  private states = new Map<string, SourceHealth>();

  isAvailable(sourceId: string, nowMinutes: number): boolean {
    const state = this.states.get(sourceId);
    return state?.disabledUntil === null || state === undefined || nowMinutes >= (state.disabledUntil ?? 0);
  }

  recordSuccess(sourceId: string): void {
    this.states.delete(sourceId);
  }

  /** 记录失败并返回本次禁用分钟数。 */
  recordFailure(sourceId: string, nowMinutes: number): number {
    const state = this.states.get(sourceId) ?? { consecutiveFailures: 0, disabledUntil: null };
    state.consecutiveFailures += 1;
    const step = Math.min(state.consecutiveFailures, ESCALATION_MINUTES.length) - 1;
    const duration = ESCALATION_MINUTES[step];
    state.disabledUntil = nowMinutes + duration;
    this.states.set(sourceId, state);
    return duration;
  }

  consecutiveFailures(sourceId: string): number {
    return this.states.get(sourceId)?.consecutiveFailures ?? 0;
  }
}
