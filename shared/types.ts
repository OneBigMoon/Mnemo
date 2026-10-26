export type ProfileId = "emby" | "jellyfin" | "fnos" | "ugreen" | "kodi";
export type CloudProvider = "p115" | "alipan";
export type ResourceKind =
  | "direct"
  | "share"
  | "magnet"
  | "openlist"
  | "cloud"
  | "telegram";
export interface AppConfig {
  setupComplete: boolean;
  defaultTitleAction: RequestIntent;
  model: { baseUrl: string; apiKey: string; model: string };
  sources: {
    pansouUrl: string;
    tmdbApiKey: string;
    moviePilotUrl: string;
    moviePilotToken: string;
    openlistUrl: string;
    openlistToken: string;
    p115Enabled: boolean;
    p115Cookie: string;
    alipanEnabled: boolean;
    alipanRefreshToken: string;
    telegramChannels: string[];
    /** M6：外置源注册表 JSON 文本（可选；无效文本按未配置处理并在诊断暴露）。 */
    registryJson?: string;
  };
  download: {
    directory: string;
    concurrency: number;
    aria2Url: string;
    aria2Secret: string;
  };
  library: {
    profile: ProfileId;
    language: string;
    rename: boolean;
    artwork: boolean;
    serverUrl: string;
    serverToken: string;
    pathFrom?: string;
    pathTo?: string;
    userId?: string;
  };
  channels: {
    /** M8：渠道入口的下载先停在「待批准」，由管理员在网页端批准（缺省视为关闭）。 */
    requireApproval?: boolean;
    /**
     * 按渠道覆盖上面的全局开关。缺省或 inherit 表示跟随全局；
     * require 强制该渠道需批准；skip 让该渠道直接下载。
     */
    approvalOverrides?: Record<ChannelPlatform, ApprovalOverride>;
    telegram: {
      enabled: boolean;
      token: string;
      allowedChatIds: string[];
      model: string;
    };
    bridge: { enabled: boolean; secret: string; model: string };
  };
}
export interface MediaInfo {
  type: "movie" | "tv";
  title: string;
  year?: number;
  originalTitle?: string;
  season?: number;
  episode?: number;
  tmdbId?: number;
  overview?: string;
  posterUrl?: string;
  backdropUrl?: string;
}
export interface SearchResult {
  id: string;
  title: string;
  url: string;
  source: string;
  kind: ResourceKind;
  size?: string;
  publishedAt?: string;
  extractionCode?: string;
  shareRef?: string;
  provider?: CloudProvider;
  navigation?: "folder" | "parent" | "next";
  /** 注册表 CMS 条目：详情解析引用（浏览分集用）。 */
  cmsRef?: CmsRef;
}
/** CMS V10 详情引用：源 id + 作品 id + 详情端点。 */
export interface CmsRef {
  sourceId: string;
  vodId: string;
  endpoint: string;
  sourceName: string;
}
export type SearchSource = "pansou" | "openlist" | "moviepilot" | "telegram";
export type SearchFailureCode = "timeout" | "unreachable" | "auth_required" | "rate_limited" | "invalid_response" | "upstream_error" | "core_unavailable" | "busy";
export interface SearchSourceDiagnostic {
 id: string;
 source: SearchSource;
 name: string;
 status: "success" | "empty" | "failed" | "not_configured";
 resultCount: number;
 code?: SearchFailureCode;
}
export interface SearchDiagnostics {
 status: "complete" | "partial" | "failed" | "not_configured";
 sources: SearchSourceDiagnostic[];
}
export interface SearchReport {
 results: SearchResult[];
 diagnostics: SearchDiagnostics;
}
export type TaskStatus =
  | "queued"
  | "downloading"
  | "scraping"
  | "completed"
  | "failed"
  | "paused"
  | "needs_attention"
  | "cancelled";
export interface DownloadTask {
  id: string;
  title: string;
  url: string;
  kind: ResourceKind;
  status: TaskStatus;
  progress: number;
  bytes: number;
  total: number;
  error?: string;
  path?: string;
  downloadRoot?: string;
  media: MediaInfo;
  profile: ProfileId;
  createdAt: string;
  updatedAt: string;
  generation?: number;
  library?: LibrarySync;
}
export interface LibrarySync {
  targetId?: string;
  status: "not_configured" | "pending" | "verified" | "failed" | "unsupported";
  checkedAt: string;
  message: string;
  itemId?: string;
  serverPath?: string;
  playable?: boolean;
}
export interface ShareDirectory {
  reference: string;
  title: string;
  provider?: CloudProvider;
}
export interface ShareSubscriptionInput {
  query: string;
  media: MediaInfo;
  reference: string;
  startEpisode?: number;
}
export interface ShareScanCursor {
  version: 1;
  root: string;
  frontier: { reference: string; directoryKey: string; depth: number }[];
  visited: string[];
  pages: number;
  entries: number;
}
export interface ShareScanFile {
  resource: SearchResult;
  directories: string[];
}
export interface ShareScanPage {
  files: ShareScanFile[];
  cursor?: ShareScanCursor;
  complete: boolean;
}
export interface Subscription {
 searchDiagnostics?: SearchDiagnostics;
  id: string;
  title: string;
  query: string;
  enabled: boolean;
  autoDownload: boolean;
  lastCheckedAt?: string;
  lastError?: string;
  lastSummary?: string;
  createdAt: string;
  seen: string[];
  media?: MediaInfo;
  startEpisode?: number;
  share?: ShareDirectory;
  scan?: { pending: ShareScanFile[]; cursor?: ShareScanCursor; complete: boolean };
  nextCheckAt?: string;
}
export type RequestIntent = "search" | "download" | "subscribe";
export type RequestStage =
  | "media"
  | "details"
  | "resource"
  | "approval"
  | "completed"
  | "failed";
export interface ResourceChoice extends SearchResult {
  match: "matched" | "uncertain" | "mismatch";
  reason: string;
  /** M5：命中规则卡的加权总分（有分数卡时才有；用于候选排序）。 */
  filterScore?: number;
  /** M4：规则卡逐字段检查明细（"为什么没抓取"展示）；无规则卡时缺省。 */
  filterChecks?: {
    card_id: string;
    card_name: string;
    matched: boolean;
    checks: { field: string; passed: boolean; detail: string }[];
  }[];
}
/** 审批决定：谁、在什么时候、批了还是拒了。 */
export interface ApprovalDecision {
  outcome: "approved" | "rejected";
  at: string;
  /** 操作者归属，例如 web:admin。 */
  by: string;
}
/** 任务创建来源。 */
export type AuditOrigin = "web" | "channel" | "subscription";
/**
 * 操作记录条目：任务创建与审批决定的统一视图。
 * 任务类带 origin（来源），审批类带 outcome（批准/拒绝）。
 */
export interface AuditEntry {
  id: string;
  at: string;
  type: "task" | "approval";
  owner: string;
  title: string;
  origin?: AuditOrigin;
  outcome?: "approved" | "rejected";
  /** 任务为资源类型，审批为操作人归属。 */
  detail?: string;
}
/** 审批历史条目：请求过期被清理后仍然保留。 */
export interface ApprovalRecord extends ApprovalDecision {
  id: string;
  requestId: string;
  /** 申请人的归属（渠道侧）。 */
  owner: string;
  query: string;
}
export interface MediaRequest {
 searchDiagnostics?: SearchDiagnostics;
  id: string;
  revision: number;
  owner: string;
  query: string;
  intent: RequestIntent;
  stage: RequestStage;
  candidates: { id: string; media: MediaInfo }[];
  resources: ResourceChoice[];
  selected?: MediaInfo;
  taskId?: string;
  subscriptionId?: string;
  shareDirectory?: ShareDirectory;
  message: string;
  /** 渠道请求的审批结果（批准/拒绝时写入）。 */
  decision?: ApprovalDecision;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
export interface RequestSelection {
  expectedRevision: number;
  candidateId?: string;
  media?: { type: "movie" | "tv"; title: string; year?: number };
  season?: number;
  episode?: number;
  resourceId?: string;
  confirmUncertain?: boolean;
  extractionCode?: string;
  subscribeDirectory?: boolean;
  /** M8：审批阶段动作（仅管理员）。 */
  approve?: boolean;
  reject?: boolean;
}
export interface ChatReply {
 searchDiagnostics?: SearchDiagnostics;
  text: string;
  results?: SearchResult[];
  task?: DownloadTask;
  subscription?: Subscription;
  request?: MediaRequest;
}
export interface DownloadProgress {
  bytes: number;
  total: number;
  progress: number;
}
export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  code?: string;
}
export interface MediaService {
 searchWithDiagnostics?(query: string, signal?: AbortSignal): Promise<SearchReport>;
  browseShare?(reference: string, extractionCode?: string, signal?: AbortSignal): Promise<SearchResult[]>;
  /** 注册表 CMS 条目的分集解析（详情接口 → 分集列表）。 */
  browseCms?(ref: CmsRef, signal?: AbortSignal): Promise<SearchResult[]>;
  shareDirectory?(reference: string): ShareDirectory;
  scanShare?(reference: string, cursor?: ShareScanCursor, signal?: AbortSignal): Promise<ShareScanPage>;
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
  identify(query: string, type?: "movie" | "tv", signal?: AbortSignal): Promise<MediaInfo[]>;
  download(
    task: DownloadTask,
    signal: AbortSignal,
    progress: (p: DownloadProgress) => void,
  ): Promise<string>;
  scrape(
    file: string,
    media: MediaInfo,
    profile: ProfileId,
    signal?: AbortSignal,
  ): Promise<{ files: string[]; warnings: string[] }>;
  testConnection(kind: string): Promise<ConnectionTestResult>;
  close?(): Promise<void>;
}
export interface ResolvedShareFile {
  url: string;
  name: string;
  size: number;
  sha1?: string;
  headers: Record<string, string>;
  contentId: string;
  provider?: CloudProvider;
}
export interface ShareService {
  capture(result: SearchResult): SearchResult;
  browse(reference: string, extractionCode?: string, signal?: AbortSignal): Promise<SearchResult[]>;
  directory(reference: string): ShareDirectory;
  scan(reference: string, cursor?: ShareScanCursor, signal?: AbortSignal): Promise<ShareScanPage>;
  resolve(reference: string, signal?: AbortSignal): Promise<ResolvedShareFile>;
  testConnection(provider?: CloudProvider): Promise<ConnectionTestResult>;
  close?(): Promise<void>;
}
export interface AgentDeps {
 searchWithDiagnostics?(query: string, signal?: AbortSignal): Promise<SearchReport>;
  config(): AppConfig;
  search(query: string): Promise<SearchResult[]>;
  tasks(): DownloadTask[];
  subscribe(query: string): Subscription;
  addTask(input: {
    title: string;
    url: string;
    kind?: ResourceKind;
    media?: MediaInfo;
  }): DownloadTask;
  request?(
    query: string,
    intent: RequestIntent,
    signal?: AbortSignal,
  ): Promise<MediaRequest>;
  selectRequest?(
    id: string,
    selection: RequestSelection,
    signal?: AbortSignal,
  ): Promise<MediaRequest>;
  latestRequest?(): MediaRequest | undefined;
  getRequest?(id: string): MediaRequest;
  /** M8：该入口的下载是否需管理员批准（渠道域且设置已开启时为 true）。 */
  requiresApproval?(): boolean;
  forOwner?(owner: string): AgentDeps;
  notifications?: NotificationService;
}

/** 消息渠道平台（与 owner 前缀一致）。 */
export type ChannelPlatform = "telegram" | "wechat" | "qq" | "feishu";
/** 单个渠道的审批策略：跟随全局 / 强制需批准 / 免批准。 */
export type ApprovalOverride = "inherit" | "require" | "skip";
export interface NotificationDestination {
  platform: "web" | "telegram" | "wechat" | "qq" | "feishu";
  peer: string;
  botId?: string;
}
export type NotificationStatus = "waiting" | "pending" | "dispatching" | "delivered" | "unknown" | "rejected" | "dismissed";
export interface TaskNotification {
  id: string;
  taskId: string;
  generation: number;
  destination: NotificationDestination;
  status: NotificationStatus;
  /** message：与下载任务无关的直发消息（如审批结果）。 */
  event?: "completed" | "failed" | "message";
  text: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  claimToken?: string;
  claimExpiresAt?: string;
  receipt?: string;
  error?: string;
}
export interface NotificationClaim {
  id: string;
  taskId: string;
  text: string;
  claimToken: string;
  expiresAt: string;
}
export interface NotificationService {
  watchTask(task: DownloadTask, destination: NotificationDestination): void;
  watchSubscription(id: string, destination: NotificationDestination): void;
  unwatchSubscription(id: string): void;
  inheritSubscription(id: string, task: DownloadTask): void;
  /** 排入一条非任务类消息（ref 用于去重）。 */
  message(destination: NotificationDestination, ref: string, text: string): void;
  prepare(task: DownloadTask): void;
  terminal(task: DownloadTask): void;
  cancel(task: DownloadTask): void;
  list(): TaskNotification[];
  claim(destination: NotificationDestination, limit?: number): NotificationClaim[];
  acknowledge(destination: NotificationDestination, id: string, claimToken: string, outcome: "delivered" | "unknown" | "rejected", receipt?: string): void;
  retry(id: string, confirmUnknown?: boolean): void;
  dismiss(id: string): void;
  read(id: string): void;
}
