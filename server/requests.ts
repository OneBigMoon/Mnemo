import { randomUUID } from "node:crypto";
import type {
  AgentDeps,
  ApprovalDecision,
  ApprovalRecord,
  CloudProvider,
  MediaInfo,
  MediaRequest,
  MediaService,
  RequestIntent,
  RequestSelection,
  ResourceChoice,
  SearchReport,
  SearchResult,
  ShareDirectory,
  ShareSubscriptionInput,
  Subscription,
} from "../shared/types.js";
import { searchDiagnosticSummary, searchWithDiagnostics } from "../shared/search.js";
import { requiresApproval } from "../shared/approval.js";
import { classifyResourceUrl } from "./media.js";
import { episodeMarkers, matchResource, normalizeTitle } from "./matching.js";
import { Store } from "./store.js";

const DAY = 24 * 60 * 60 * 1000;
const KIND = "request";
const MAX_OWNER_REQUESTS = 100;
const MAX_REQUESTS = 1000;
/** 审批历史单独存一份：请求 1 天后会被清理，历史要能留。 */
const APPROVAL_KIND = "approval";
const MAX_APPROVAL_HISTORY = 200;
const MAX_IN_FLIGHT = 16;
type StoredRequest = MediaRequest & {
  completedSelection?: string;
  completedResourceId?: string;
  /** M8：审批阶段暂存的资源 id（批准后继续下载）。 */
  pendingResourceId?: string;
};
type Actions = {
  addTask(input: Parameters<AgentDeps["addTask"]>[0], owner?: string): ReturnType<AgentDeps["addTask"]>;
  subscribe(
    query: string,
    media: MediaInfo,
    startEpisode?: number,
    owner?: string,
  ): Subscription;
  subscribeDirectory?(input: ShareSubscriptionInput, owner: string): Subscription;
  /**
   * M8 补全：把审批结果回传申请人。渠道侧的批准/拒绝没有网页可看，
   * 不通知就等于永远收不到答复（批准还能靠任务完成通知兜底，拒绝没有任何后续）。
   */
  notifyDecision?(request: MediaRequest, decision: "approved" | "rejected"): void;
};

function text(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(`${label}无效`);
  return value.trim();
}
function integer(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new Error(`${label}无效`);
  return Number(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("请选择有效的请求选项");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("请求选项含不允许的字段");
}
function selection(input: RequestSelection): RequestSelection {
  const value = object(input);
  keys(value, [
    "expectedRevision",
    "candidateId",
    "media",
    "season",
    "episode",
    "resourceId",
    "confirmUncertain",
    "extractionCode",
    "subscribeDirectory",
    "approve",
    "reject",
  ]);
  const result: RequestSelection = {
    expectedRevision: integer(
      value.expectedRevision,
      "请求版本",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
  if (value.candidateId !== undefined)
    result.candidateId = text(value.candidateId, "候选编号", 100);
  if (value.media !== undefined) {
    const media = object(value.media);
    keys(media, ["type", "title", "year"]);
    if (media.type !== "movie" && media.type !== "tv")
      throw new Error("媒体类型必须为电影或剧集");
    result.media = { type: media.type, title: text(media.title, "片名", 200) };
    if (media.year !== undefined)
      result.media.year = integer(media.year, "年份", 1870, 2200);
  }
  if (value.season !== undefined)
    result.season = integer(value.season, "季数", 0, 999);
  if (value.episode !== undefined)
    result.episode = integer(value.episode, "集数", 1, 9999);
  if (value.resourceId !== undefined)
    result.resourceId = text(value.resourceId, "资源编号", 100);
  if (value.confirmUncertain !== undefined) {
    if (typeof value.confirmUncertain !== "boolean")
      throw new Error("人工确认选项无效");
    if (value.confirmUncertain) result.confirmUncertain = true;
  }
  if (value.extractionCode !== undefined) {
    result.extractionCode = text(value.extractionCode, "提取码", 32);
    if (!/^[A-Za-z0-9]{1,32}$/u.test(result.extractionCode))
      throw new Error("提取码格式无效");
  }
  if (value.subscribeDirectory !== undefined) {
    if (typeof value.subscribeDirectory !== "boolean")
      throw new Error("目录订阅选项无效");
    if (value.subscribeDirectory) result.subscribeDirectory = true;
  }
  for (const flag of ["approve", "reject"] as const) {
    const value2 = (value as Record<string, unknown>)[flag];
    if (value2 !== undefined) {
      if (typeof value2 !== "boolean") throw new Error("审批选项无效");
      if (value2) result[flag] = true;
    }
  }
  if (Object.keys(result).length === 1) throw new Error("请选择至少一个选项");
  return result;
}
function visible(record: StoredRequest): MediaRequest {
  const { completedSelection, completedResourceId, pendingResourceId, ...request } = record;
  if (request.shareDirectory === undefined) delete request.shareDirectory;
  if (request.searchDiagnostics === undefined) delete request.searchDiagnostics;
  return structuredClone(request);
}
function hints(query: string): {
  title: string;
  type?: "movie" | "tv";
  year?: number;
  season?: number;
  episode?: number;
} {
  const markers = episodeMarkers(query);
  if (markers.seasons.length > 1 || markers.episodes.length > 1 || markers.pack)
    throw new Error("请一次指定一季或一集，整季订阅可单独指定开始集");
  let title = query
    .replace(
      /\bS\d{1,3}(?:[ ._-]*E\d{1,4})?\b|\b\d{1,3}x\d{1,4}\b|\b(?:Season|Episode|E)[ ._-]*\d{1,4}\b|第\s*[0-9零〇一二两三四五六七八九十百千]+\s*[季集]/giu,
      " ",
    )
    .trim();
  const movie = /^(?:电影|movie(?:\s|$))/iu.test(title);
  const tv =
    markers.seasons.length > 0 ||
    markers.episodes.length > 0 ||
    /^(?:电视剧|剧集|(?:tv|series)(?:\s|$))/iu.test(title);
  if (movie && tv) throw new Error("电影与季集信息冲突，请明确媒体类型");
  title = title
    .replace(/^(?:电影|电视剧|剧集|movie\b|tv\b|series\b)\s*/iu, "")
    .trim();
  const yearMatch = title.match(
    /(?:\s|[（(])((?:18[89]|19|20)\d{2})[）)]?\s*$/u,
  );
  const year =
    yearMatch && Number(yearMatch[1]) <= new Date().getUTCFullYear() + 3
      ? Number(yearMatch[1])
      : undefined;
  if (year !== undefined) title = title.slice(0, yearMatch!.index).trim();
  return {
    title: title || query,
    ...(movie ? { type: "movie" } : tv ? { type: "tv" } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(markers.seasons.length ? { season: markers.seasons[0] } : {}),
    ...(markers.episodes.length ? { episode: markers.episodes[0] } : {}),
  };
}
const SHARE_REFERENCE = /^mori-share:[a-f0-9]{64}$/u;
const ALIPAN_AUTH_MESSAGE = "阿里云盘 Web 授权尚未就绪，请在设置中显式配置或检查 Web 授权后重试；本次操作尚未完成";
function cloudProvider(value: unknown): value is CloudProvider {
  return value === "p115" || value === "alipan";
}
function providerName(provider?: CloudProvider): string {
  return provider === "alipan" ? "阿里云盘" : "115";
}
function alipanAuthorizationError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" &&
    ["auth_required", "alipan_auth_required", "alipan_auth_invalid", "alipan_auth_unknown"].includes(error.code);
}
function browsable(item: SearchResult): item is SearchResult & { shareRef: string } {
  return item.kind === "share" && typeof item.shareRef === "string" && SHARE_REFERENCE.test(item.shareRef);
}
function validCmsRef(value: unknown): value is NonNullable<SearchResult["cmsRef"]> {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return [ref.sourceId, ref.vodId, ref.endpoint, ref.sourceName].every(
    (field) => typeof field === "string" && field.trim().length > 0 && field.length <= 500,
  ) && /^https?:\/\//i.test(ref.endpoint as string);
}
function cmsBrowsable(item: SearchResult): item is SearchResult & { cmsRef: NonNullable<SearchResult["cmsRef"]> } {
  return item.kind === "share" && validCmsRef(item.cmsRef);
}
function resource(result: SearchResult): ResourceChoice | undefined {
  if (!result || typeof result.title !== "string" || !result.title.trim() || result.title.length > 300 || typeof result.url !== "string" || result.url.length > 8192) return;
  let url: URL;
  try { url = new URL(result.url); } catch { return; }
  if (url.username || url.password) return;
  if (result.provider !== undefined && !cloudProvider(result.provider)) return;
  const reference = typeof result.shareRef === "string" && SHARE_REFERENCE.test(result.shareRef) ? result.shareRef : undefined;
  if (result.shareRef !== undefined && !reference) return;
  if (result.navigation !== undefined && !["folder", "parent", "next"].includes(result.navigation)) return;
  const opaque = SHARE_REFERENCE.test(result.url);
  if (opaque) {
    if (!reference || reference !== result.url || !["cloud", "share"].includes(result.kind)) return;
  } else if (!["http:", "https:", "magnet:", "openlist:"].includes(url.protocol) || result.kind === "cloud" || result.navigation !== undefined) return;
  if ((reference || result.navigation !== undefined) && !["cloud", "share"].includes(result.kind)) return;
  if (result.navigation !== undefined && result.kind !== "share") return;
  const kind = result.kind === "cloud" || result.kind === "share" || result.kind === "telegram" ? result.kind : classifyResourceUrl(result.url);
  return {
    id: randomUUID(), title: result.title.trim(), url: kind === "share" && reference ? reference : result.url, kind,
    source: typeof result.source === "string" ? result.source.slice(0, 200) : "资源搜索",
    ...(typeof result.size === "string" ? { size: result.size.slice(0, 100) } : {}),
    ...(typeof result.publishedAt === "string" ? { publishedAt: result.publishedAt.slice(0, 100) } : {}),
    ...(reference ? { shareRef: reference } : {}),
    ...(result.navigation ? { navigation: result.navigation } : {}),
    ...(result.provider !== undefined ? { provider: result.provider } : {}),
    ...(validCmsRef(result.cmsRef) ? { cmsRef: result.cmsRef } : {}),
    match: "uncertain", reason: "等待身份核验",
  };
}
function resourceChoices(found: SearchResult[], selected: MediaInfo, provider?: CloudProvider): ResourceChoice[] {
  const seen = new Set<string>();
  return (Array.isArray(found) ? found : []).slice(0, 100).flatMap((result) => {
    const item = resource(result);
    if (!item || seen.has(item.url)) return [];
    if (provider !== undefined && (item.provider ?? "p115") !== provider) return [];
    seen.add(item.url);
    if (browsable(item)) return [{ ...item, match: "matched" as const, reason: "浏览分享内容，不会创建下载任务；文件身份须另行核验" }];
    const { match, reason } = matchResource(item, selected);
    return [{ ...item, match, reason }];
  });
}

export class Requests {
  private pending = new Map<
    string,
    { owner: string; selection: string; promise: Promise<MediaRequest> }
  >();
  private initializing = new Set<string>();
  private operations = new Set<{ controller: AbortController; finished: Promise<void> }>();
  private closePromise?: Promise<void>;
  constructor(
    private store: Store,
    private media: Pick<MediaService, "identify" | "search" | "searchWithDiagnostics" | "browseShare" | "shareDirectory" | "browseCms">,
    private actions: Actions,
  ) {}

  /**
   * 审批结果回传。失败只记录不抛出：请求已经提交，让调用方看到错误会
   * 误导重试（重试只会得到 409）。
   */
  private notifyDecision(request: StoredRequest, decision: "approved" | "rejected") {
    if (!this.actions.notifyDecision) return;
    try {
      this.actions.notifyDecision(visible(request), decision);
    } catch (error) {
      console.warn(
        `审批结果通知未送达（${decision}）：${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * 记录审批决定：写在请求上（供界面展示）并追加一条独立历史
   * （请求 1 天后会被清理，历史要能跨过期保留）。
   * 调用点在 commit 的事务里，与任务创建同生共死。
   */
  private recordDecision(
    next: StoredRequest,
    outcome: ApprovalDecision["outcome"],
    by: string,
  ) {
    const decision: ApprovalDecision = {
      outcome,
      at: new Date().toISOString(),
      by: by.slice(0, 300),
    };
    next.decision = decision;
    this.store.put<ApprovalRecord>(APPROVAL_KIND, {
      id: next.id,
      requestId: next.id,
      owner: next.owner.slice(0, 300),
      query: next.query.slice(0, 200),
      ...decision,
    });
    this.trimApprovals();
  }

  private trimApprovals() {
    const records = this.store.list<ApprovalRecord>(APPROVAL_KIND);
    if (records.length <= MAX_APPROVAL_HISTORY) return;
    records
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(MAX_APPROVAL_HISTORY)
      .forEach((record) => this.store.remove(APPROVAL_KIND, record.id));
  }

  /** 审批历史，最新的在前。管理员视图用。 */
  listApprovals(limit = 50): ApprovalRecord[] {
    this.assertOpen();
    const size = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_APPROVAL_HISTORY) : 50;
    return this.store
      .list<ApprovalRecord>(APPROVAL_KIND)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, size);
  }

  private assertOpen() {
    if (this.closePromise)
      throw Object.assign(new Error("媒体请求服务已关闭，无法开始或提交请求"), { status: 503 });
  }
  private async own(signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<MediaRequest>): Promise<MediaRequest> {
    this.assertOpen();
    const controller = new AbortController();
    let finish!: () => void;
    const operation = { controller, finished: new Promise<void>((resolve) => { finish = resolve; }) };
    this.operations.add(operation);
    try {
      return await run(AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]));
    } finally {
      this.operations.delete(operation);
      finish();
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const operations = [...this.operations];
    this.closePromise = Promise.allSettled(operations.map((operation) => operation.finished)).then(() => undefined);
    for (const operation of operations) operation.controller.abort();
    return this.closePromise;
  }

  /** 管理员跨域读取（审批用；调用方必须已是 web:admin 会话）。 */
  private recordAny(id: string): StoredRequest {
    const record = this.store.record<StoredRequest>(KIND, id);
    if (!record) throw new Error("请求不存在或无权访问");
    if (!(Date.parse(record.expiresAt) > Date.now()))
      throw new Error("请求已到期，请重新发起");
    return record;
  }
  /** 管理员视角：全部域的请求（含渠道入口）。 */
  listAll(): MediaRequest[] {
    this.assertOpen();
    return this.store
      .list<StoredRequest>(KIND)
      .map(visible)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 50);
  }
  /** 管理员跨域选择（审批）；等价 select 但绕过 owner 域匹配。 */
  adminSelect(id: string, input: RequestSelection, signal?: AbortSignal): Promise<MediaRequest> {
    return this.select("web:admin", id, input, signal, true);
  }
  /** 管理员跨域读取单条请求（渠道入口的待批准项也要能打开）。 */
  getAny(id: string): MediaRequest {
    this.assertOpen();
    return visible(this.recordAny(id));
  }
  private record(owner: string, id: string): StoredRequest {
    text(owner, "请求归属", 300);
    const record =
      typeof id === "string"
        ? this.store.record<StoredRequest>(KIND, id)
        : undefined;
    if (!record || record.owner !== owner)
      throw new Error("请求不存在或无权访问");
    if (!(Date.parse(record.expiresAt) > Date.now()))
      throw new Error("请求已到期，请重新发起");
    return record;
  }
  get(owner: string, id: string): MediaRequest {
    return visible(this.record(owner, id));
  }
  list(owner: string): MediaRequest[] {
    text(owner, "请求归属", 300);
    return this.store
      .list<StoredRequest>(KIND)
      .filter(
        (request) =>
          request.owner === owner && Date.parse(request.expiresAt) > Date.now(),
      )
      .slice(0, MAX_OWNER_REQUESTS)
      .map(visible);
  }
  latest(owner: string): MediaRequest | undefined {
    return this.list(owner)[0];
  }

  private replay(record: StoredRequest, choice?: RequestSelection): boolean {
    if (record.stage !== "completed" || !choice) return false;
    if (record.completedSelection === JSON.stringify(choice)) return true;
    return (
      !record.completedSelection &&
      Object.keys(choice).length === 2 &&
      choice.expectedRevision === record.revision &&
      choice.resourceId === record.completedResourceId
    );
  }
  private commit(
    expected: StoredRequest,
    update: StoredRequest,
    choice?: RequestSelection,
    signal?: AbortSignal,
    action?: (request: StoredRequest) => void,
  ): StoredRequest {
    signal?.throwIfAborted();
    return this.store.transaction(() => {
      signal?.throwIfAborted();
      const current = this.record(expected.owner, expected.id);
      if (current.revision !== expected.revision) {
        if (this.replay(current, choice)) return current;
        throw Object.assign(
          new Error("请求已更新，请刷新后使用当前阶段的选项"),
          { status: 409 },
        );
      }
      const next = {
        ...update,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const summary = searchDiagnosticSummary(next.searchDiagnostics);
      if (summary && !next.message.includes(summary)) next.message += `；${summary}`;
      signal?.throwIfAborted();
      try { if (action) action(next); }
      catch (error) {
        if (alipanAuthorizationError(error))
          throw Object.assign(new Error(ALIPAN_AUTH_MESSAGE), { code: error.code, status: 409 });
        throw error;
      }
      signal?.throwIfAborted();
      if (next.stage === "completed" && choice) {
        const { extractionCode, ...receipt } = choice;
        next.completedSelection = JSON.stringify(receipt);
      }
      this.store.put(KIND, next);
      return next;
    });
  }

  begin(
    owner: string,
    query: string,
    intent: RequestIntent,
    signal?: AbortSignal,
  ): Promise<MediaRequest> {
    return this.own(signal, (ownedSignal) => this.beginRequest(owner, query, intent, ownedSignal));
  }

  private async beginRequest(
    owner: string,
    query: string,
    intent: RequestIntent,
    signal?: AbortSignal,
  ): Promise<MediaRequest> {
    signal?.throwIfAborted();
    owner = text(owner, "请求归属", 300);
    query = text(query, "搜索词", 200);
    if (!["search", "download", "subscribe"].includes(intent))
      throw new Error("请求意图无效");
    if (this.initializing.size + this.pending.size >= MAX_IN_FLIGHT)
      throw new Error("当前请求较多，请稍后重试");
    const hint = hints(query);
    const now = new Date().toISOString();
    let request: StoredRequest = {
      id: randomUUID(),
      owner,
      query,
      intent,
      stage: "details",
      candidates: [],
      resources: [],
      message: "正在查询媒体身份",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + DAY).toISOString(),
      revision: 0,
    };
    this.store.transaction(() => {
      signal?.throwIfAborted();
      const all = this.store.list<StoredRequest>(KIND);
      for (const old of all)
        if (!(Date.parse(old.expiresAt) > Date.now()))
          this.store.remove(KIND, old.id);
      const active = all.filter(
        (old) => Date.parse(old.expiresAt) > Date.now(),
      );
      if (
        active.length >= MAX_REQUESTS ||
        active.filter((old) => old.owner === owner).length >= MAX_OWNER_REQUESTS
      )
        throw new Error("请求记录已达上限，请等待旧请求到期");
      this.store.put(KIND, request);
    });
    this.initializing.add(request.id);
    try {
      let found: MediaInfo[];
      try {
        found = await this.media.identify(hint.title, hint.type, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof Error && error.name === "AbortError") throw error;
        return visible(
          this.commit(
            request,
            {
              ...request,
              message:
                "媒体身份查询不可用，请手动填写电影/剧集、完整片名和年份；尚未创建下载或订阅",
            },
            undefined,
            signal,
          ),
        );
      }
      signal?.throwIfAborted();
      const candidates = (Array.isArray(found) ? found : [])
        .slice(0, 20)
        .filter(
          (media) =>
            media &&
            (media.type === "movie" || media.type === "tv") &&
            typeof media.title === "string" &&
            media.title.length > 0 &&
            media.title.length <= 200 &&
            (!hint.type || media.type === hint.type) &&
            (hint.year === undefined || media.year === hint.year),
        );
      request = this.commit(
        request,
        {
          ...request,
          candidates: candidates.map((media) => ({ id: randomUUID(), media })),
          stage: candidates.length ? "media" : "details",
          message: candidates.length
            ? "请选择正确作品，注意同名作品的年份与类型"
            : "没有找到可确认的身份，请手动填写电影/剧集、完整片名和年份",
        },
        undefined,
        signal,
      );
      const exact = request.candidates.filter(({ media }) =>
        [media.title, media.originalTitle].some(
          (title) =>
            title && normalizeTitle(title) === normalizeTitle(hint.title),
        ),
      );
      if (exact.length !== 1) return visible(request);
      const selected = {
        ...exact[0].media,
        ...(hint.season !== undefined ? { season: hint.season } : {}),
        ...(hint.episode !== undefined ? { episode: hint.episode } : {}),
      };
      return visible(
        await this.advance({ ...request, selected }, undefined, signal),
      );
    } finally {
      this.initializing.delete(request.id);
    }
  }

  async select(
    owner: string,
    id: string,
    input: RequestSelection,
    signal?: AbortSignal,
    asAdmin = false,
  ): Promise<MediaRequest> {
    this.assertOpen();
    signal?.throwIfAborted();
    const choice = selection(input);
    const current = asAdmin ? this.recordAny(id) : this.record(owner, id);
    if (this.replay(current, choice)) return visible(current);
    if (current.revision !== choice.expectedRevision)
      throw Object.assign(
        new Error("请求版本已过期，请刷新后使用当前阶段的选项"),
        { status: 409 },
      );
    if (current.stage === "completed" || current.stage === "failed")
      throw new Error("请求已结束，不能替换已确认的身份或资源");
    // M8：审批阶段只有 web 域（管理员）能批准或拒绝。
    if (current.stage === "approval" && !owner.startsWith("web:") && !asAdmin)
      throw Object.assign(
        new Error("该请求正在等待管理员批准"),
        { status: 403 },
      );
    if (this.initializing.has(id))
      throw new Error("请求正在识别，请稍后再选择");
    const key = JSON.stringify(choice),
      pending = this.pending.get(id);
    if (pending) {
      if (pending.owner === owner && pending.selection === key)
        return pending.promise;
      throw new Error("请求正在处理其他选择，请稍后刷新");
    }
    if (this.pending.size + this.initializing.size >= MAX_IN_FLIGHT)
      throw new Error("当前请求较多，请稍后重试");
    const promise = this.own(signal, async (ownedSignal) => {
      try { return await this.apply(current, choice, ownedSignal, owner); }
      finally { this.pending.delete(id); }
    });
    this.pending.set(id, { owner, selection: key, promise });
    return promise;
  }

  private async apply(
    request: StoredRequest,
    choice: RequestSelection,
    signal?: AbortSignal,
    actor = "web:admin",
  ): Promise<MediaRequest> {
    signal?.throwIfAborted();
    if (choice.subscribeDirectory) {
      keys(choice as unknown as Record<string, unknown>, ["expectedRevision", "subscribeDirectory"]);
      return visible(this.subscribeDirectory(request, choice, signal));
    }
    if (request.stage === "approval") {
      keys(choice as unknown as Record<string, unknown>, [
        "expectedRevision",
        "approve",
        "reject",
      ]);
      if (choice.approve === true && choice.reject === true)
        throw new Error("批准与拒绝不能同时选择");
      if (choice.reject === true) {
        const decided = this.commit(request, {
          ...request,
          stage: "completed",
          pendingResourceId: undefined,
          message: "管理员已拒绝该请求，未创建下载任务",
        }, choice, signal, (next) => this.recordDecision(next, "rejected", actor));
        this.notifyDecision(decided, "rejected");
        return visible(decided);
      }
      if (choice.approve !== true)
        throw new Error("请选择批准或拒绝该请求");
      const resourceId = request.pendingResourceId;
      if (!resourceId)
        throw new Error("审批请求缺少待下载资源，请重新选择资源");
      const approved = this.download(
        { ...request, stage: "resource", pendingResourceId: undefined },
        resourceId,
        { ...choice, confirmUncertain: true },
        signal,
        { outcome: "approved", by: actor },
      );
      // 只在任务真的建出来之后通知；download 抛错时审批保持未决，不谎报已开始。
      this.notifyDecision(approved, "approved");
      return visible(approved);
    }
    if (request.stage === "resource") {
      keys(choice as unknown as Record<string, unknown>, [
        "expectedRevision",
        "resourceId",
        "confirmUncertain",
        "extractionCode",
      ]);
      if (!choice.resourceId) throw new Error("请选择当前请求中的资源");
      const item = request.resources.find((item) => item.id === choice.resourceId);
      if (item && browsable(item))
        return visible(await this.browse(request, item, choice, signal));
      if (item && cmsBrowsable(item))
        return visible(await this.browseCmsEpisodes(request, item, choice, signal));
      if (choice.extractionCode !== undefined)
        throw new Error("提取码只能用于分享浏览，不能附在文件选择中");
      return visible(this.download(request, choice.resourceId, choice, signal));
    }
    keys(
      choice as unknown as Record<string, unknown>,
      request.stage === "media"
        ? ["expectedRevision", "candidateId", "season", "episode"]
        : ["expectedRevision", "media", "season", "episode"],
    );
    let selected = request.selected;
    if (request.stage === "media") {
      const candidate = request.candidates.find(
        (candidate) => candidate.id === choice.candidateId,
      );
      if (!candidate)
        throw new Error("候选作品不存在，请使用当前请求的候选编号");
      selected = candidate.media;
    } else if (choice.media) {
      if (selected || request.candidates.length)
        throw new Error("当前阶段不能替换已经选择的作品");
      selected = choice.media;
    }
    if (!selected) throw new Error("请先填写媒体类型、完整片名和年份");
    if (
      selected.type === "movie" &&
      (choice.season !== undefined || choice.episode !== undefined)
    )
      throw new Error("电影不能选择季数或集数");
    const hint = hints(request.query);
    selected = {
      ...selected,
      ...(hint.season !== undefined && selected.season === undefined
        ? { season: hint.season }
        : {}),
      ...(hint.episode !== undefined && selected.episode === undefined
        ? { episode: hint.episode }
        : {}),
      ...(choice.season !== undefined ? { season: choice.season } : {}),
      ...(choice.episode !== undefined ? { episode: choice.episode } : {}),
    };
    return visible(
      await this.advance({ ...request, selected }, choice, signal),
    );
  }

  private async advance(
    request: StoredRequest,
    choice?: RequestSelection,
    signal?: AbortSignal,
  ): Promise<StoredRequest> {
    signal?.throwIfAborted();
    request = { ...request, shareDirectory: undefined, searchDiagnostics: undefined };
    const selected = request.selected!;
    if (
      selected.type === "tv" &&
      (selected.season === undefined ||
        (request.intent === "download" && selected.episode === undefined))
    )
      return this.commit(
        request,
        {
          ...request,
          stage: "details",
          message:
            request.intent === "download"
              ? "请选择季数和集数，再查找对应单集资源"
              : "请选择订阅或搜索的季数；订阅可选开始集",
        },
        choice,
        signal,
      );
    if (request.intent === "subscribe") {
      const { episode, ...media } = selected;
      return this.commit(
        request,
        {
          ...request,
          stage: "completed",
          message: "已创建按作品聚合的自动订阅；网盘分享目录需先浏览目标目录，再明确订阅目录",
        },
        choice,
        signal,
        (next) => {
          next.subscriptionId = this.actions.subscribe(
            request.query,
            media,
            episode,
          request.owner,
          ).id;
        },
      );
    }
    const query = [
      selected.title,
      selected.year,
      selected.type === "tv"
        ? `S${String(selected.season).padStart(2, "0")}${selected.episode !== undefined ? `E${String(selected.episode).padStart(2, "0")}` : ""}`
        : undefined,
    ]
      .filter((value) => value !== undefined)
      .join(" ");
    let report: SearchReport;
    const searchSignal = AbortSignal.any([
      AbortSignal.timeout(20_000),
      ...(signal ? [signal] : []),
    ]);
    try {
      report = await searchWithDiagnostics(this.media, query, searchSignal);
      searchSignal.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      return this.commit(
        request,
        {
          ...request,
          stage: "failed",
          message: "资源搜索失败，尚未创建下载；请检查数据源后重新发起请求",
        },
        choice,
        signal,
      );
    }
    signal?.throwIfAborted();
    const diagnostics = report.diagnostics;
    const summary = searchDiagnosticSummary(diagnostics);
    if (diagnostics.status === "failed" || diagnostics.status === "not_configured")
      return this.commit(request, { ...request, stage: "failed", resources: [], searchDiagnostics: diagnostics, message: summary }, choice, signal);
    const resources = resourceChoices(report.results, selected);
    request = this.commit(
      request,
      {
        ...request,
        stage: "resource",
        resources,
        searchDiagnostics: diagnostics,
        message: resources.length
          ? "请选择资源；身份不确定的资源必须人工确认，已知不匹配的资源不能下载"
          : diagnostics.status === "partial" ? summary : "没有找到资源，尚未创建下载",
      },
      choice,
      signal,
    );
    if (request.stage === "completed") return request;
    if (request.intent === "download" && resources.length === 1 && browsable(resources[0]) && !resources[0].navigation && matchResource(resources[0], selected).match === "matched")
      return this.browse(request, resources[0], choice, signal, true);
    const downloadable = resources.filter(
      (resource) =>
        resource.match !== "mismatch" &&
        resource.kind !== "share" &&
        resource.kind !== "telegram",
    );
    if (
      request.intent === "download" &&
      downloadable.length === 1 &&
      downloadable[0].match === "matched"
    )
      return this.download(request, downloadable[0].id, choice, signal);
    if (
      resources.length &&
      !downloadable.length &&
      resources.some(
        (resource) => resource.kind === "share" || resource.kind === "telegram",
      )
    )
      request = this.commit(
        request,
        {
          ...request,
          message: resources.some(browsable)
            ? "已找到网盘分享，选择分享可浏览文件和目录；尚未创建下载"
            : "仅找到分享页或 Telegram 资源，尚未解析为文件直链；选择后将记录为待处理任务",
        },
        choice,
        signal,
      );
    return request;
  }

  /** 注册表 CMS 条目的分集浏览：详情解析 → 分集资源（不创建任务）。 */
  private async browseCmsEpisodes(
    request: StoredRequest,
    item: ResourceChoice & { cmsRef: NonNullable<ResourceChoice["cmsRef"]> },
    choice: RequestSelection,
    signal?: AbortSignal,
  ): Promise<StoredRequest> {
    signal?.throwIfAborted();
    if (choice.extractionCode !== undefined)
      throw new Error("提取码不适用于 CMS 源分集浏览");
    const cmsSignal = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
    let episodes: SearchResult[];
    try {
      if (!this.media.browseCms) throw new Error("CMS 分集解析尚未配置");
      episodes = await this.media.browseCms(item.cmsRef, cmsSignal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      return this.commit(request, {
        ...request,
        message: `CMS 源分集解析失败（${error instanceof Error ? error.message : error}）；已保留资源，可稍后重试`,
      }, undefined, signal);
    }
    signal?.throwIfAborted();
    const resources = resourceChoices(episodes.slice(0, 60), request.selected!);
    return this.commit(request, {
      ...request, stage: "resource", resources, shareDirectory: undefined,
      searchDiagnostics: undefined,
      message: resources.length
        ? "已解析 CMS 分集；媒体文件分集可直接创建下载任务，m3u8 分集暂不支持直接下载"
        : "CMS 详情没有可下载的分集",
    }, undefined, signal);
  }

  private async browse(
    request: StoredRequest,
    item: ResourceChoice & { shareRef: string },
    choice?: RequestSelection,
    signal?: AbortSignal,
    automatic = false,
  ): Promise<StoredRequest> {
    signal?.throwIfAborted();
    if (request.shareDirectory)
      request = this.commit(request, { ...request, shareDirectory: undefined }, undefined, signal);
    let found: SearchResult[];
    let directory: ShareDirectory | undefined;
    const browseSignal = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
    try {
      if (!this.media.browseShare) throw new Error("分享浏览尚未配置");
      found = await this.media.browseShare(item.shareRef, choice?.extractionCode, browseSignal);
      browseSignal.throwIfAborted();
      directory = this.media.shareDirectory?.(item.shareRef);
      if (directory && (!SHARE_REFERENCE.test(directory.reference) || typeof directory.title !== "string" || !directory.title.trim() || directory.title.length > 300 || (directory.provider !== undefined && !cloudProvider(directory.provider)) || (directory.provider ?? "p115") !== (item.provider ?? "p115")))
        throw new Error("分享目录信息无效");
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      return this.commit(request, {
        ...request, shareDirectory: undefined,
        message: alipanAuthorizationError(error)
          ? `${ALIPAN_AUTH_MESSAGE}；已保留资源，可稍后重试`
          : item.provider === "alipan"
            ? "阿里云盘分享暂无法浏览，请检查分享有效性、提取码与网络；已保留资源，可稍后重试。下载和自动追更需在设置中显式配置 Web 授权"
            : "115分享暂无法浏览，请检查是否已启用115分享解析、本地助手、提取码与分享权限；已保留资源，可稍后重试，尚未创建下载",
      }, undefined, signal);
    }
    signal?.throwIfAborted();
    const resources = resourceChoices((Array.isArray(found) ? found : []).slice(0, 22), request.selected!, item.provider ?? "p115");
    request = this.commit(request, {
      ...request, stage: "resource", resources, shareDirectory: directory,
      searchDiagnostics: undefined,
      message: resources.length
        ? "请选择文件夹、上级或下一页继续浏览；浏览不会创建任务。文件仍须核验片名、年份及季集后选择下载"
        : "分享当前目录没有可选文件，尚未创建下载",
    }, undefined, signal);
    if (automatic && request.intent === "download" && resources.length === 1 && resources[0].kind === "cloud" && resources[0].match === "matched")
      return this.download(request, resources[0].id, choice, signal);
    return request;
  }

  private subscribeDirectory(request: StoredRequest, choice: RequestSelection, signal?: AbortSignal): StoredRequest {
    signal?.throwIfAborted();
    if (request.stage !== "resource" || !request.selected || !request.shareDirectory || !SHARE_REFERENCE.test(request.shareDirectory.reference))
      throw new Error("请先确认作品并成功浏览目标分享目录，再订阅当前目录");
    if (request.shareDirectory.provider !== undefined && !cloudProvider(request.shareDirectory.provider))
      throw new Error("分享目录来源无效，请重新浏览后确认");
    if (request.selected.year === undefined)
      throw new Error("订阅目录前请补充作品年份并重新确认作品，尚未创建订阅");
    integer(request.selected.year, "作品年份", 1870, 2200);
    if (request.selected.type === "tv") integer(request.selected.season, "剧集季数", 0, 999);
    const { episode, ...media } = request.selected;
    if (episode !== undefined) integer(episode, "开始集数", 1, 9999);
    if (!this.actions.subscribeDirectory)
      throw new Error(`${providerName(request.shareDirectory.provider)}分享目录订阅尚未配置，尚未创建订阅`);
    const input: ShareSubscriptionInput = {
      query: request.query, media, reference: request.shareDirectory.reference,
      ...(episode !== undefined ? { startEpisode: episode } : {}),
    };
    return this.commit(request, {
      ...request, stage: "completed",
      searchDiagnostics: undefined,
      message: `已订阅分享目录“${request.shareDirectory.title.slice(0, 100)}”，包含下级目录；仅匹配已确认作品及所选季集，后台会持续追更${request.shareDirectory.provider === "alipan" ? "；阿里云盘自动追更需在设置中显式配置 Web 授权" : ""}`,
    }, choice, signal, (next) => {
      next.subscriptionId = this.actions.subscribeDirectory!(input, request.owner).id;
    });
  }

  private download(
    request: StoredRequest,
    resourceId: string,
    choice?: RequestSelection,
    signal?: AbortSignal,
    decision?: Pick<ApprovalDecision, "outcome" | "by">,
  ): StoredRequest {
    signal?.throwIfAborted();
    if (choice?.extractionCode !== undefined)
      throw new Error("提取码只能用于分享浏览，不能附在文件选择中");
    if (request.intent === "subscribe")
      throw new Error("订阅不能通过普通资源选择创建下载任务；请使用目录订阅操作");
    // M8 审批闸门（默认关闭，按设置开启）：开启后渠道入口（非 web: 域）的
    // 下载先停在 pending，等管理员批准；web 域与批准续行（choice.approve）放行。
    if (requiresApproval(this.store.config(), request.owner) && choice?.approve !== true) {
      const target = request.resources.find((item) => item.id === resourceId);
      if (target)
        return this.commit(request, {
          ...request,
          stage: "approval",
          pendingResourceId: resourceId,
          message: "已确认资源，等待管理员批准后创建下载任务",
        }, choice, signal);
    }
    const item = request.resources.find(
      (resource) => resource.id === resourceId,
    );
    if (!item || !request.selected)
      throw new Error("资源不存在，请使用当前请求的资源编号");
    const matched = matchResource(item, request.selected);
    if (matched.match === "mismatch")
      throw new Error(`资源不匹配：${matched.reason}`);
    if (matched.match === "uncertain" && !choice?.confirmUncertain)
      throw new Error(`资源身份不确定，请明确确认：${matched.reason}`);
    return this.commit(
      request,
      {
        ...request,
        stage: "completed",
        completedResourceId: item.id,
        message:
          item.kind === "share" || item.kind === "telegram"
            ? "已记录待处理任务；分享页或 Telegram 资源尚未解析为文件直链"
            : item.provider === "alipan"
              ? "已创建阿里云盘文件下载任务；下载需在设置中显式配置 Web 授权，实际进度请查看任务状态"
              : "已创建所选资源的下载任务",
      },
      choice,
      signal,
      (next) => {
        next.taskId = this.actions.addTask({
          title: item.title,
          url: item.url,
          kind: item.kind,
          media: matched.media || request.selected,
        }, request.owner).id;
        // 与建任务同一个事务：不会出现「有任务但没有审批记录」。
        if (decision) this.recordDecision(next, decision.outcome, decision.by);
      },
    );
  }
}
