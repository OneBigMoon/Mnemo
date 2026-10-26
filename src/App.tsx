import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Bot,
  Bell,
  Cable,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clapperboard,
  Clock3,
  Download,
  ExternalLink,
  Film,
  FolderOpen,
  Globe2,
  HardDrive,
  KeyRound,
  Layers3,
  Leaf,
  Link2,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  MessageCircle,
  MonitorPlay,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Rss,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Tv,
  X,
  Zap,
} from "lucide-react";
import { CHANNEL_PLATFORMS } from "../shared/approval";
import type {
  AppConfig,
  ApprovalOverride,
  AuditEntry,
  ChannelPlatform,
  ChatReply,
  CloudProvider,
  ConnectionTestResult,
  DownloadTask,
  MediaInfo,
  MediaRequest,
  ProfileId,
  RequestIntent,
  RequestSelection,
  SearchDiagnostics,
  SearchReport,
  SearchResult,
  Subscription,
  TaskNotification,
} from "../shared/types";

/** 操作记录里任务来源的中文名。 */
const ORIGIN_LABELS: Record<"web" | "channel" | "subscription", string> = {
  web: "网页创建",
  channel: "渠道创建",
  subscription: "订阅创建",
};

/** 渠道平台的中文名；与 owner 前缀、审批覆盖表一一对应。 */
const CHANNEL_LABELS: Record<ChannelPlatform, string> = {
  telegram: "Telegram",
  wechat: "微信",
  qq: "QQ",
  feishu: "飞书",
};
import { searchDiagnosticSummary, searchFailureMessage } from "../shared/search";

type Page =
  | "overview"
  | "assistant"
  | "subscriptions"
  | "downloads"
  | "library"
  | "notifications"
  | "settings";
type SettingGroup = "model" | "sources" | "download" | "library" | "channels";
type ConfigResponse = AppConfig & { secretStatus?: Record<string, boolean> };
type Dashboard = {
  tasks: DownloadTask[];
  subscriptions: Subscription[];
  stats: { active: number; completed: number; subscriptions: number };
  warnings: string[];
};
type Capability = {
  id: string;
  name: string;
  status: string;
  description: string;
};
type Conversation = {
  role: "user" | "assistant";
  text: string;
  results?: SearchResult[];
  searchDiagnostics?: SearchDiagnostics;
};
type SelectionInput = Omit<RequestSelection, "expectedRevision">;
const titleActionChoices: { id: RequestIntent; label: string; description: string }[] = [
  { id: "search", label: "先搜索", description: "先找作品与资源，不自动下载或追更。" },
  { id: "download", label: "找到后下载", description: "作品身份与资源确认后，自动创建下载任务。" },
  { id: "subscribe", label: "持续追更", description: "确认目标作品与季数，持续寻找并下载匹配的新资源。" },
];

function TitleActionControl({ value = "search", onChange }: { value?: RequestIntent; onChange: (value: RequestIntent) => void }) {
  return <fieldset className="title-action-control"><legend>只说片名时</legend><p className="title-action-description">告诉 Mnemo，你希望只输入一个片名后发生什么。</p><div className="title-action-options">{titleActionChoices.map((choice) => <label key={choice.id} className={`title-action-option ${value === choice.id ? "selected" : ""}`}><input type="radio" name="defaultTitleAction" value={choice.id} checked={value === choice.id} onChange={() => onChange(choice.id)} /><span><strong>{choice.label}{choice.id === "search" && <small>默认</small>}</strong><span>{choice.description}</span></span></label>)}</div><p className="title-action-help">自动下载或追更仅在作品身份与资源已确认后执行；遇到同名、季集或资源歧义时，仍需你选择。明确说「搜索 / 下载 / 订阅」时，优先按明确指令执行。</p></fieldset>;
}

function TitleActionHint({ action = "search", mode }: { action?: RequestIntent; mode: "chat" | "search" }) {
  return <div className="composer-action-hint"><span><Settings2 size={13} />{mode === "search" ? "资源搜索模式：只搜索" : <>只说片名：<strong>{titleActionChoices.find((choice) => choice.id === action)?.label || "先搜索"}</strong><small>已保存</small></>}</span><p>{mode === "search" ? "不使用默认自动动作，不自动创建下载或订阅。" : "明确命令优先；有歧义时仍需确认。"}</p></div>;
}

const navigation: { id: Page; label: string; icon: typeof Film }[] = [
  { id: "overview", label: "我的空间", icon: Layers3 },
  { id: "assistant", label: "Mnemo 助手", icon: Sparkles },
  { id: "subscriptions", label: "追剧订阅", icon: Rss },
  { id: "downloads", label: "下载中心", icon: ArrowDownToLine },
  { id: "library", label: "媒体库", icon: Clapperboard },
  { id: "notifications", label: "通知中心", icon: Bell },
];
const groups: {
  id: SettingGroup;
  label: string;
  icon: typeof Film;
  subtitle: string;
}[] = [
  {
    id: "model",
    label: "模型与智能",
    icon: Sparkles,
    subtitle: "连接你自己的模型，让 Mnemo 更懂你的喜好。",
  },
  {
    id: "sources",
    label: "搜索与资源",
    icon: Globe2,
    subtitle: "把常用的资源入口，汇集到一次搜索里。",
  },
  {
    id: "download",
    label: "下载与存储",
    icon: HardDrive,
    subtitle: "选择收藏的落脚处，管理下载方式与并发。",
  },
  {
    id: "library",
    label: "媒体库",
    icon: Clapperboard,
    subtitle: "选择你的播放器，按通用 NFO 规范整理影视。",
  },
  {
    id: "channels",
    label: "消息渠道",
    icon: MessageCircle,
    subtitle: "在熟悉的聊天工具中，向 Mnemo 发出指令。",
  },
];
const profiles: {
  id: ProfileId;
  name: string;
  mark: string;
  color: string;
  detail: string;
}[] = [
  { id: "emby", name: "Emby", mark: "E", color: "#65a93a", detail: "家庭影音" },
  {
    id: "jellyfin",
    name: "Jellyfin",
    mark: "J",
    color: "#9471ce",
    detail: "开源媒体库",
  },
  {
    id: "fnos",
    name: "飞牛影视",
    mark: "f",
    color: "#5d8cec",
    detail: "fnOS NAS",
  },
  {
    id: "ugreen",
    name: "绿联影视",
    mark: "U",
    color: "#6d975a",
    detail: "UGREEN NAS",
  },
  {
    id: "kodi",
    name: "Kodi",
    mark: "K",
    color: "#4a9bb7",
    detail: "本地播放器",
  },
];
const taskLabels: Record<DownloadTask["status"], string> = {
  queued: "等待下载",
  downloading: "下载中",
  scraping: "整理中",
  completed: "文件已完成",
  failed: "下载失败",
  paused: "已暂停",
  needs_attention: "需要处理",
  cancelled: "已取消",
};
const libraryLabels = {
  not_configured: "媒体库未配置",
  pending: "媒体库待确认",
  verified: "媒体库已识别",
  failed: "媒体库检查失败",
  unsupported: "此媒体库暂不支持识别检查",
};
const kindLabels: Record<SearchResult["kind"], string> = {
  direct: "下载直链",
  share: "网盘分享",
  magnet: "磁力链接",
  openlist: "OpenList",
  cloud: "云盘文件",
  telegram: "Telegram",
};

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public diagnostics?: SearchDiagnostics,
    public results?: SearchResult[],
  ) {
    super(message);
  }
}
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      body?.error || `请求失败（${response.status}）`,
      response.status,
      typeof body?.code === "string" ? body.code : undefined,
      body?.diagnostics,
      Array.isArray(body?.results) ? body.results : undefined,
    );
  if (body === null) throw new Error("服务返回了无法读取的内容，请稍后重试。");
  return body as T;
}
const post = <T,>(path: string, body: unknown = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
function bytes(value: number) {
  if (!value) return "0 B";
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}
function relativeTime(value?: string) {
  if (!value) return "尚未检查";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : date.toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`}>
      <div className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 36 36">
          <path d="M12 7v22h13" />
        </svg>
      </div>
      {!compact && (
        <div>
          <span className="brand-word">
            mnemo<span className="brand-dot">.</span>
          </span>
          <span className="brand-sub">影 视 管 家</span>
        </div>
      )}
    </div>
  );
}
function Spinner({ label = "加载中" }: { label?: string }) {
  return <LoaderCircle className="spin" size={17} aria-label={label} />;
}
function EmptyState({
  icon: Icon = Film,
  title,
  children,
  action,
}: {
  icon?: typeof Film;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={27} strokeWidth={1.5} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? "on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = `modal-${title}`;
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal${wide ? " wide" : ""}`}
      aria-labelledby={titleId}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-header">
        <div>
          <span className="eyebrow">MAKE ROOM FOR A GOOD STORY</span>
          <h2 id={titleId}>{title}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭窗口"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

const BROWSER_VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".webm", ".mov", ".ogv"]);

function browserCanPlay(file?: string) {
  const extension = file?.toLowerCase().match(/\.[^./\\]+$/)?.[0] || "";
  return BROWSER_VIDEO_EXTENSIONS.has(extension);
}

function PlaybackDialog({
  task,
  onClose,
}: {
  task: DownloadTask;
  onClose: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const playable = browserCanPlay(task.path);
  return (
    <Modal title={task.title} onClose={onClose} wide>
      <div className="playback-modal">
        {failed ? (
          <div className="playback-fallback" role="alert">
            <MonitorPlay size={30} />
            <strong>浏览器无法播放这个文件</strong>
            <p>
              {playable
                ? "文件可能已移动，或浏览器缺少对应的解码器。"
                : "MKV、AVI、TS 等格式通常无法由浏览器直接解码。"}
              可改用已配置的媒体库或本地播放器打开。
            </p>
          </div>
        ) : (
          <video
            key={task.id}
            src={`/api/tasks/${encodeURIComponent(task.id)}/stream`}
            controls
            autoPlay
            playsInline
            preload="metadata"
            onError={() => setFailed(true)}
          >
            你的浏览器不支持 HTML 视频播放。
          </video>
        )}
        <div className="playback-meta">
          <span>
            <FolderOpen size={13} />
            {task.path}
          </span>
          {!playable && !failed && (
            <span className="playback-hint">
              <CircleAlert size={13} />
              此格式在浏览器中可能无法解码；播放失败时请使用媒体库或本地播放器。
            </span>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** M9：CMS m3u8 在线播放（经服务端代理，广告分片已过滤）。 */
function CmsPlaybackDialog({
  title,
  url,
  onClose,
}: {
  title: string;
  url: string;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [filtered, setFiltered] = useState<number | null>(null);
  const src = `/api/cms/stream?url=${encodeURIComponent(url)}`;
  useEffect(() => {
    let destroy: (() => void) | undefined;
    let cancelled = false;
    // Safari 原生支持 HLS；其余浏览器经 hls.js（MSE）。
    const video = videoRef.current;
    if (!video) return;
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      fetch(`/api/cms/stream?url=${encodeURIComponent(url)}`, { method: "HEAD" })
        .then((response) => {
          if (!cancelled) setFiltered(Number(response.headers.get("x-lucerna-filtered")) || null);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }
    void import("hls.js")
      .then(({ default: Hls }) => {
        if (cancelled || !videoRef.current) return;
        if (!Hls.isSupported()) return;
        const hls = new Hls({ xhrSetup: undefined });
        hls.on(Hls.Events.MANIFEST_LOADED, (_event, data) => {
          const stats = data.levels?.length;
          if (stats !== undefined && !cancelled) setFiltered(null);
        });
        hls.loadSource(src);
        hls.attachMedia(videoRef.current);
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) setFailed(true);
        });
        destroy = () => hls.destroy();
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [src, url]);
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="playback-modal">
        {failed ? (
          <div className="playback-fallback" role="alert">
            <MonitorPlay size={30} />
            <strong>在线播放失败</strong>
            <p>源可能在线失效或列表不可解析；可稍后重试或选择可下载分集。</p>
          </div>
        ) : (
          <video ref={videoRef} controls autoPlay playsInline onError={() => setFailed(true)}>
            你的浏览器不支持 HTML 视频播放。
          </video>
        )}
        <div className="playback-meta">
          <span className="playback-hint">
            <ShieldCheck size={13} />
            在线播放经本服务代理，广告分片已在服务端过滤{filtered ? `（已剔除 ${filtered} 段）` : ""}；不计入下载任务。
          </span>
        </div>
      </div>
    </Modal>
  );
}

function Auth({
  needsSetup,
  onSuccess,
}: {
  needsSetup: boolean;
  onSuccess: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (needsSetup && password !== confirm) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await post(needsSetup ? "/setup" : "/login", {
        password,
        ...(needsSetup && setupToken ? { setupToken } : {}),
      });
      setPassword("");
      setConfirm("");
      setSetupToken("");
      onSuccess();
    } catch (error) {
      setError(error instanceof Error ? error.message : "暂时无法连接服务。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-story">
        <Logo />
        <div className="auth-story-content">
          <span className="eyebrow">A LITTLE PLACE FOR BIG STORIES</span>
          <h1>
            好故事，
            <br />
            值得好好收藏<span>。</span>
          </h1>
          <p>
            从第一眼心动，到随时按下播放。
            <br />让 Mnemo 打理你的私人影视世界。
          </p>
          <div className="cinema-art" aria-hidden="true">
            <div className="art-orbit" />
            <div className="art-frame art-frame-back">
              <div className="art-sun" />
              <div className="art-hill" />
              <div className="art-label">
                THE ART OF
                <br />
                COLLECTING.
              </div>
            </div>
            <div className="art-frame art-frame-front">
              <span>mnemo cinema</span>
              <div className="art-moon" />
              <div className="art-film-line" />
              <strong>
                STORIES
                <br />
                STAY.
              </strong>
              <small>你的私人影院 · 始终为你</small>
            </div>
            <div className="art-ticket">
              <Film size={18} />
              <span>
                ONE TICKET
                <br />
                <strong>ENDLESS STORIES</strong>
              </span>
            </div>
            <span className="art-star">✳</span>
          </div>
        </div>
        <div className="auth-story-footer">
          <span>
            <ShieldCheck size={14} /> 自主托管，收藏由你掌握
          </span>
          <span>MADE FOR YOUR LOVE OF CINEMA</span>
        </div>
      </div>
      <div className="auth-form-side">
        <div className="auth-mobile-brand">
          <Logo />
        </div>
        <form onSubmit={submit} className="auth-form">
          <div className="mini-icon">
            <KeyRound size={22} />
          </div>
          <span className="eyebrow">WELCOME TO MNEMO</span>
          <h2>
            {needsSetup
              ? "为你的私人影院，留一把钥匙。"
              : "欢迎回到你的影视空间。"}
          </h2>
          <p>
            {needsSetup
              ? "设置管理员密码，保护你的配置与收藏。只需这一次，之后就能安心交给 Mnemo。"
              : "输入管理员密码，接着发现、收藏与热爱。"}
          </p>
          <label className="field">
            <span>{needsSetup ? "管理员密码" : "密码"}</span>
            <div className="input-icon">
              <LockKeyhole size={17} />
              <input
                autoFocus
                type="password"
                name="password"
                autoComplete={needsSetup ? "new-password" : "current-password"}
                minLength={needsSetup ? 12 : undefined}
                required
                maxLength={256}
                placeholder={
                  needsSetup
                    ? "至少 12 位，建议使用独特的密码"
                    : "输入你的管理员密码"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </label>
          {needsSetup && (
            <>
              <label className="field">
                <span>确认密码</span>
                <input
                  type="password"
                  name="confirmPassword"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={256}
                  placeholder="再次输入密码"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </label>
              <details className="setup-token-details">
                <summary>远程 / NAS 首次初始化</summary>
                <label className="field">
                  <span>初始化令牌（可选）</span>
                  <input
                    type="password"
                    name="setupToken"
                    autoComplete="off"
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    placeholder="部署时设置的 MORI_SETUP_TOKEN"
                  />
                  <small>
                    远程首次初始化需填部署时设置的令牌。本机访问可留空。
                  </small>
                </label>
              </details>
            </>
          )}
          {error && (
            <div className="alert error" role="alert">
              <CircleAlert size={17} />
              {error}
            </div>
          )}
          <button className="button primary auth-submit" disabled={busy}>
            {busy ? (
              <Spinner />
            ) : (
              <>
                {needsSetup ? "创建我的空间" : "进入我的空间"}
                <ArrowRight size={18} />
              </>
            )}
          </button>
          <div className="auth-note">
            <ShieldCheck size={15} />
            <span>密钥保存在服务端，不会存入浏览器存储。</span>
          </div>
        </form>
        <span className="auth-copyright">Mnemo · 把时间留给好故事</span>
      </div>
    </div>
  );
}

function mergeRequests(previous: MediaRequest[], incoming: MediaRequest[]) {
  const records = new Map(previous.map((request) => [request.id, request]));
  for (const request of incoming) {
    const existing = records.get(request.id);
    if (
      !existing ||
      existing.revision < request.revision ||
      (existing.revision === request.revision &&
        existing.updatedAt <= request.updatedAt)
    )
      records.set(request.id, request);
  }
  return [...records.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 12);
}

function resourceViewOptions(resources: MediaRequest["resources"]) {
  let items = 0;
  let navigation = 0;
  return resources.filter((resource) =>
    resource.navigation === "parent" || resource.navigation === "next"
      ? navigation++ < 2
      : items++ < 20,
  );
}

function configuredSearchEntries(sources?: AppConfig["sources"]) {
  if (!sources) return [];
  return [sources.pansouUrl.trim() ? "PanSou" : "", sources.openlistUrl.trim() ? "OpenList" : "", sources.moviePilotUrl.trim() ? "MoviePilot" : "", sources.telegramChannels.some((name) => name.trim()) ? "Telegram 公开频道" : ""].filter(Boolean);
}

function SearchReadiness({ sources, dirty }: { sources?: AppConfig["sources"]; dirty: boolean }) {
  const entries = configuredSearchEntries(sources);
  return <div className="search-readiness" role="note" data-search-readiness={entries.length ? "configured" : "not_configured"}><span className="service-icon sage">{entries.length ? <Search size={19} /> : <CircleAlert size={19} />}</span><div><strong>{entries.length ? "已配置片名搜索入口" : "尚未配置片名搜索入口"}</strong><p>{entries.length ? `已保存：${entries.join("、")}。配置存在不代表连接成功，实际结果以本次搜索或手动测试为准。` : "请先保存 PanSou、OpenList、MoviePilot 地址或 Telegram 公开频道，再按片名搜索。仍可先使用已有下载链接。"}</p><p>115 / 阿里云盘用于浏览和下载已找到的分享，TMDB 用于识别作品；它们不能代替片名搜索入口。{dirty ? "当前修改尚未保存，保存后才会生效。" : ""}</p></div></div>;
}

function SearchDiagnosticNotice({ diagnostics, onSettings, onRetry, retryBusy = false, retryLabel = "重新搜索", compact = true }: {
  diagnostics?: SearchDiagnostics;
  onSettings?: () => void;
  onRetry?: () => void;
  retryBusy?: boolean;
  retryLabel?: string;
  compact?: boolean;
}) {
  if (!diagnostics || compact && diagnostics.status === "complete") return null;
  const title = { complete: "本次搜索已完成", partial: "部分来源未完成，结果可能不完整", failed: "本次搜索未完成", not_configured: "尚未配置片名搜索入口" }[diagnostics.status];
  const summary = searchDiagnosticSummary(diagnostics);
  const sources = diagnostics.sources.filter((source) => diagnostics.status === "not_configured" || source.status !== "not_configured");
  return <section className={`search-diagnostics ${compact ? "compact" : ""}`} data-search-status={diagnostics.status} aria-label="本次片名搜索诊断" role={diagnostics.status === "failed" ? "alert" : "status"}><div className="search-diagnostics-heading">{diagnostics.status === "complete" ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}<strong>{title}</strong></div>{!compact && summary && <p>{summary}</p>}{sources.length > 0 && <ul>{sources.map((source) => <li key={source.id} data-source-status={source.status}><strong>{source.name}</strong><span>{source.status === "failed" ? searchFailureMessage(source.code) : source.status === "not_configured" ? "尚未配置" : source.status === "empty" ? "已搜索，未找到匹配结果" : `找到 ${source.resultCount} 条结果`}</span></li>)}</ul>}<div className="search-diagnostics-actions">{onSettings && diagnostics.status !== "complete" && <button type="button" className="text-button" onClick={onSettings}><Settings2 size={14} />设置搜索入口<ArrowUpRight size={13} /></button>}{onRetry && <button type="button" className="text-button" disabled={retryBusy} onClick={onRetry}>{retryBusy ? <Spinner /> : <RefreshCw size={14} />}{retryLabel}</button>}</div></section>;
}

function cloudProviderName(provider?: CloudProvider) {
  return provider === "alipan" ? "阿里云盘" : "115";
}

const alipanUnknownMessage = "网页登录授权结果未知。请重新取得并保存新的 Web RefreshToken 后再验证；不要重复验证旧凭据。";

function ShareAccountGuide({ onConfigure }: { onConfigure?: () => void }) {
  return <div className="share-account-guide" role="note"><p>阿里云盘分享可不登录先浏览；下载文件和自动追更需要先保存网页登录授权。</p>{onConfigure && <button type="button" className="text-button" onClick={onConfigure}><KeyRound size={14} />去设置阿里网页登录授权<ArrowUpRight size={13} /></button>}</div>;
}

function ResourceOption({ resource, intent, locked, busy, onSelect, alipanCredentialsSaved = false, onConfigureSources, onPlayStream }: {
  resource: MediaRequest["resources"][number];
  intent: RequestIntent;
  locked: boolean;
  busy: boolean;
  onSelect: (selection: SelectionInput) => void;
  alipanCredentialsSaved?: boolean;
  onConfigureSources?: () => void;
  onPlayStream?: (target: { title: string; url: string }) => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [extractionCode, setExtractionCode] = useState("");
  const browsable = resource.kind === "share" && (!!resource.shareRef || !!resource.cmsRef);
  const navigation = browsable ? resource.navigation : undefined;
  const unsupportedShare = resource.kind === "share" && !browsable;
  const blockedSubscription = intent === "subscribe" && resource.kind === "cloud";
  const providerName = cloudProviderName(resource.provider);
  const missingAlipanAccount = resource.provider === "alipan" && !alipanCredentialsSaved;
  const blockedDownload = missingAlipanAccount && intent === "download" && resource.kind === "cloud";
  const browseLabel = navigation === "folder" ? "打开文件夹" : navigation === "parent" ? "返回上级" : navigation === "next" ? "下一页" : resource.cmsRef ? "浏览分集" : `浏览${providerName}分享`;
  const NavigationIcon = navigation === "parent" ? ChevronLeft : navigation === "next" ? ChevronRight : navigation === "folder" ? FolderOpen : Layers3;
  const validCode = !extractionCode || /^[A-Za-z0-9]{4}$/.test(extractionCode);
  return <div className={`request-resource ${resource.match}${browsable ? " share-navigation" : ""}`}>
    <div className="request-resource-title"><strong>{browsable && <NavigationIcon size={16} className="share-resource-icon" />}{resource.title}</strong><span className={`badge ${browsable ? "neutral" : resource.match === "matched" ? "positive" : "warning"}`}>{browsable ? navigation === "folder" ? "文件夹" : navigation === "parent" ? "上级目录" : navigation === "next" ? "分页导航" : resource.cmsRef ? "可浏览分集" : "可浏览分享" : resource.match === "matched" ? "身份匹配" : resource.match === "uncertain" ? "需要核对" : "不匹配"}</span></div>
    <p>{resource.reason}</p>
    {typeof resource.filterScore === "number" && (
      <span className="badge neutral filter-score">评分 {resource.filterScore}</span>
    )}
    {resource.filterChecks?.length ? (
      <details className="request-filter-checks">
        <summary>
          过滤规则{" "}
          {resource.filterChecks.every((card) => card.matched) ? "通过" : "有卡片未通过"}
        </summary>
        <ul>
          {resource.filterChecks.map((card) => (
            <li key={card.card_id}>
              <strong>{card.card_name}</strong>
              <span className={`badge ${card.matched ? "positive" : "warning"}`}>
                {card.matched ? "通过" : "未通过"}
              </span>
              <ul>
                {card.checks
                  .filter((check) => !check.passed || card.matched)
                  .map((check, index) => (
                    <li key={index}>
                      {check.field}: {check.detail}
                    </li>
                  ))}
              </ul>
            </li>
          ))}
        </ul>
        <small>规则卡只是筛选建议，不自动改变你的选择。</small>
      </details>
    ) : null}
    <div className="result-meta"><span>{kindLabels[resource.kind]}</span>{(browsable || resource.kind === "cloud") && <span>{providerName}</span>}<span>{resource.source}</span>{resource.size && <span>{resource.size}</span>}</div>
    {browsable ? <form className="share-browse-form" onSubmit={(event) => {
      event.preventDefault();
      if (!validCode || locked) return;
      onSelect({ resourceId: resource.id, ...(!navigation && extractionCode ? { extractionCode } : {}) });
    }}>
      {!navigation && <><p className="request-help">先浏览{providerName}分享内容。浏览只更新目录视图，不会自动下载或建立订阅。</p><label className="field share-code-field"><span>提取码（可选，4位）</span><input type="password" autoComplete="off" minLength={4} maxLength={4} pattern="[A-Za-z0-9]{4}" title="请输入4位英文字母或数字" value={extractionCode} disabled={locked} onChange={(event) => setExtractionCode(event.target.value)} placeholder="分享需要时填写" /><small>仅在本次浏览提交；换到新的目录或页面后，此输入会清空。</small></label></>}
      <button type="submit" className="button secondary small" aria-label={`${browseLabel} ${resource.title}`} disabled={locked || !validCode}>{busy ? <Spinner /> : <NavigationIcon size={14} />}{browseLabel}</button>
    </form> : <>
      {unsupportedShare && <p className="request-help">当前分享未接入浏览能力，不能直接解析为媒体文件。请使用已支持的分享入口或可下载文件。</p>}
      {resource.kind === "telegram" && <p className="request-help">这是频道消息，不等于可直接下载的媒体文件。</p>}
      {/\.m3u8$/i.test(resource.url) && onPlayStream && (
        <button
          type="button"
          className="button secondary small"
          onClick={() => onPlayStream({ title: resource.title, url: resource.url })}
        >
          <Play size={14} />
          在线播放
        </button>
      )}
      {resource.kind === "cloud" && !blockedSubscription && <p className="request-help">{providerName}文件使用内置下载器保存到已配置目录，不会转存到云端。</p>}
      {blockedSubscription && <p className="request-help">单个文件不会建立目录订阅。请先浏览目标目录，再使用上方「订阅此目录」。</p>}
      {!unsupportedShare && resource.match === "uncertain" && <label className="checkbox-label"><input type="checkbox" checked={confirmed} disabled={locked || blockedSubscription || blockedDownload} onChange={(event) => setConfirmed(event.target.checked)} /><span>我已核对作品与季集，确认使用这份不确定资源。</span></label>}
      <button type="button" className="button secondary small" disabled={locked || unsupportedShare || blockedSubscription || blockedDownload || resource.match === "mismatch" || resource.match === "uncertain" && !confirmed} onClick={() => onSelect({ resourceId: resource.id, ...(resource.match === "uncertain" ? { confirmUncertain: true } : {}) })}>{busy ? <Spinner /> : <Check size={14} />}{unsupportedShare ? "此分享暂不支持浏览" : blockedSubscription ? "请使用目录订阅" : resource.match === "mismatch" ? "不匹配，无法使用" : blockedDownload ? "请先设置网页登录授权" : intent === "download" ? "确认资源并创建任务" : "确认此资源"}</button>
    </>}
    {missingAlipanAccount && (browsable || resource.kind === "cloud") && <ShareAccountGuide onConfigure={onConfigureSources} />}
  </div>;
}

function DirectorySubscribeAction({ request, locked, busy, onSelect, alipanCredentialsSaved = false, onConfigureSources }: {
  request: MediaRequest;
  locked: boolean;
  busy: boolean;
  onSelect: (selection: SelectionInput) => void;
  alipanCredentialsSaved?: boolean;
  onConfigureSources?: () => void;
}) {
  if (request.stage !== "resource" || !request.shareDirectory || !request.selected) return null;
  const providerName = cloudProviderName(request.shareDirectory.provider);
  const missingAlipanAccount = request.shareDirectory.provider === "alipan" && !alipanCredentialsSaved;
  const missing: string[] = [];
  if (!Number.isInteger(request.selected.year) || !request.selected.year || request.selected.year < 1) missing.push("作品年份");
  if (request.selected.type === "tv" && (!Number.isInteger(request.selected.season) || request.selected.season === undefined || request.selected.season < 0)) missing.push("季数");
  return <section className="directory-subscribe-action" aria-label={`订阅已浏览的${providerName}目录`}><div className="directory-subscribe-heading"><span className="service-icon sage"><FolderOpen size={20} /></span><div><h4>订阅此目录</h4><strong>{providerName} · {request.shareDirectory.title}</strong></div></div><p>持续检查此目录及下级目录，仅下载与已确认作品、年份{request.selected.type === "tv" ? "和季集" : ""}匹配的新{request.selected.type === "tv" ? "集" : "文件"}，通过内置下载器保存到已配置目录，不会转存到云端。</p><p>浏览不会自动建立订阅；点击下方按钮才会开启目录追更。</p>{missing.length > 0 && <p className="directory-identity-warning" role="status"><CircleAlert size={15} />请先在选片流程补充{missing.join("和")}，重新确认作品身份后再订阅目录。</p>}{missingAlipanAccount && <ShareAccountGuide onConfigure={onConfigureSources} />}<button type="button" className="button primary small" disabled={locked || missing.length > 0 || missingAlipanAccount} onClick={() => onSelect({ subscribeDirectory: true })}>{busy ? <Spinner /> : <Rss size={14} />}订阅此目录</button></section>;
}

function DirectorySubscriptionStatus({ subscription, checking, alipanCredentialsSaved = false, onConfigureSources }: { subscription: Subscription; checking: boolean; alipanCredentialsSaved?: boolean; onConfigureSources?: () => void }) {
  if (!subscription.share) return null;
  const pending = subscription.scan?.pending.length || 0;
  const continuing = pending > 0 || (!!subscription.scan?.cursor && !subscription.scan.complete);
  const status = !subscription.enabled ? "paused" : checking ? "checking" : subscription.lastError ? "failed" : continuing ? "continuing" : subscription.scan?.complete ? "complete" : "waiting";
  const label = { paused: "已暂停检查", checking: "正在检查目录", failed: "最近检查失败", continuing: "等待继续检查", complete: "本轮检查完成", waiting: "等待检查目录" }[status];
  const providerName = cloudProviderName(subscription.share.provider);
  return <div className="directory-subscription-status" data-scan-status={status}><div className="directory-subscription-heading"><FolderOpen size={17} /><strong>{providerName}目录追更</strong><span className={`badge ${status === "failed" ? "warning" : status === "complete" ? "positive" : "neutral"}`}>{checking && subscription.enabled && <Spinner />}{label}</span></div><p className="directory-subscription-title">{subscription.share.title}</p><p>持续检查此目录及下级目录。{pending > 0 ? `还有 ${pending} 个已发现文件待核验。` : continuing ? "将从已保存的位置继续检查。" : ""}</p>{subscription.enabled && subscription.nextCheckAt && <p>下次计划检查：{relativeTime(subscription.nextCheckAt)}</p>}{!subscription.autoDownload && <p>自动下载已关闭，匹配资源不会自动创建新下载任务。</p>}{subscription.share.provider === "alipan" && !alipanCredentialsSaved && <ShareAccountGuide onConfigure={onConfigureSources} />}</div>;
}

function RequestCard({
  request,
  busy,
  problem,
  needsRefresh,
  onSelect,
  onRefresh,
  onNavigate,
  alipanCredentialsSaved = false,
  onConfigureSources,
  onRetrySearch,
  onPlayStream,
}: {
  request: MediaRequest;
  busy: boolean;
  problem?: string;
  needsRefresh: boolean;
  onSelect: (selection: SelectionInput) => void;
  onRefresh: () => void;
  onNavigate: (page: Page) => void;
  alipanCredentialsSaved?: boolean;
  onConfigureSources?: () => void;
  onRetrySearch?: () => void;
  onPlayStream?: (target: { title: string; url: string }) => void;
}) {
  const [mediaType, setMediaType] = useState<"movie" | "tv">(
    request.selected?.type || (request.intent === "subscribe" ? "tv" : "movie"),
  );
  const [title, setTitle] = useState(request.selected?.title || request.query);
  const [year, setYear] = useState(request.selected?.year?.toString() || "");
  const [season, setSeason] = useState(
    request.selected?.season?.toString() || "",
  );
  const [episode, setEpisode] = useState(
    request.selected?.episode?.toString() || "",
  );
  const stageLabel = {
    media: "选择作品",
    details: "补充作品信息",
    resource: "确认资源",
    approval: "待批准",
    completed: "已处理",
    failed: "需要处理",
  }[request.stage];
  const selectedType = request.selected?.type || mediaType;
  const locked = busy || needsRefresh;
  const canRetrySearch = request.stage === "failed" && !request.taskId && !request.subscriptionId && (request.searchDiagnostics?.status === "failed" || request.searchDiagnostics?.status === "not_configured");
  const resourceOptions = resourceViewOptions(request.resources);
  function identityForm() {
    return (
      <form
        className="request-identity-form"
        onSubmit={(event) => {
          event.preventDefault();
          const selection: SelectionInput = {};
          if (!request.selected)
            selection.media = {
              type: mediaType,
              title: title.trim(),
              ...(year ? { year: Number(year) } : {}),
            };
          if (selectedType === "tv") {
            if (season !== "") selection.season = Number(season);
            if (episode !== "") selection.episode = Number(episode);
          }
          onSelect(selection);
        }}
      >
        <fieldset disabled={locked}>
          {!request.selected && (
            <>
              <div className="form-grid">
                <label className="field">
                  <span>作品类型</span>
                  <select
                    value={mediaType}
                    onChange={(event) =>
                      setMediaType(event.target.value as "movie" | "tv")
                    }
                  >
                    <option value="movie">电影</option>
                    <option value="tv">电视剧</option>
                  </select>
                </label>
                <label className="field">
                  <span>年份（可选）</span>
                  <input
                    type="number"
                    min={1880}
                    max={2100}
                    value={year}
                    onChange={(event) => setYear(event.target.value)}
                    placeholder="同名作品建议填写年份"
                  />
                </label>
              </div>
              <label className="field">
                <span>确认作品名称</span>
                <input
                  required
                  maxLength={200}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="输入准确的电影或电视剧名"
                />
                <small>
                  手工填写表示你已核对作品身份，不会被当作已验证的元数据。
                </small>
              </label>
            </>
          )}
          {selectedType === "tv" && (
            <div className="form-grid">
              <label className="field">
                <span>
                  季数{request.intent === "search" ? "（可选）" : "（必填）"}
                </span>
                <input
                  type="number"
                  min={0}
                  max={999}
                  required={request.intent !== "search"}
                  value={season}
                  onChange={(event) => setSeason(event.target.value)}
                  placeholder="例如：1"
                />
              </label>
              <label className="field">
                <span>
                  {request.intent === "subscribe"
                    ? "开始集（可选）"
                    : request.intent === "download"
                      ? "集数（必填）"
                      : "集数（可选）"}
                </span>
                <input
                  type="number"
                  min={1}
                  max={9999}
                  required={request.intent === "download"}
                  value={episode}
                  onChange={(event) => setEpisode(event.target.value)}
                  placeholder={
                    request.intent === "subscribe"
                      ? "留空从本季开始追更"
                      : "例如：1"
                  }
                />
              </label>
            </div>
          )}
          {request.intent === "subscribe" && (
            <p className="request-help">
              确认后将为这部作品开启自动追更。同关键词的旧订阅会原位升级并保留记录。
            </p>
          )}
          <button
            type="submit"
            className="button primary small"
            disabled={locked}
          >
            {busy ? <Spinner /> : <Check size={14} />}
            {request.intent === "subscribe"
              ? "确认作品并开启追更"
              : "确认作品信息"}
          </button>
        </fieldset>
      </form>
    );
  }
  return (
    <article className="request-card">
      <div className="request-card-header">
        <span className="service-icon sage">
          <Film size={19} />
        </span>
        <div>
          <span className="eyebrow">
            {request.intent === "subscribe"
              ? "SUBSCRIBE"
              : request.intent === "download"
                ? "DOWNLOAD"
                : "DISCOVER"}
          </span>
          <h3>{request.query}</h3>
        </div>
        <span
          className={`badge ${request.stage === "completed" ? "positive" : request.stage === "failed" ? "warning" : "neutral"}`}
        >
          {stageLabel}
        </span>
      </div>
      {request.message && <p className="request-message">{request.message}</p>}
      <SearchDiagnosticNotice diagnostics={request.searchDiagnostics} onSettings={onConfigureSources} onRetry={canRetrySearch ? onRetrySearch : undefined} retryBusy={locked} retryLabel="重新选片再搜索" />
      {canRetrySearch && <p className="request-help">重新搜索会保留原片名和动作，建立新的选片流程，请按提示重新确认作品。</p>}
      {request.selected && (
        <div className="request-selected">
          <CheckCircle2 size={15} />
          <strong>{request.selected.title}</strong>
          <span>
            {request.selected.type === "tv" ? "电视剧" : "电影"}
            {request.selected.year ? ` · ${request.selected.year}` : ""}
            {request.selected.season !== undefined
              ? ` · 第 ${request.selected.season} 季`
              : ""}
            {request.selected.episode !== undefined
              ? ` · 第 ${request.selected.episode} 集`
              : ""}
          </span>
        </div>
      )}
      <DirectorySubscribeAction request={request} locked={locked} busy={busy} onSelect={onSelect} alipanCredentialsSaved={alipanCredentialsSaved} onConfigureSources={onConfigureSources} />
      {request.stage === "media" && (
        <>
          {request.candidates.length > 0 && (
            <div className="request-candidates">
              {request.candidates.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  disabled={locked}
                  onClick={() => onSelect({ candidateId: candidate.id })}
                >
                  <span className="request-candidate-icon">
                    {candidate.media.type === "tv" ? (
                      <Tv size={21} />
                    ) : (
                      <Film size={21} />
                    )}
                  </span>
                  <span>
                    <strong>{candidate.media.title}</strong>
                    <small>
                      {candidate.media.type === "tv" ? "电视剧" : "电影"} ·{" "}
                      {candidate.media.year || "年份未知"}
                    </small>
                    {candidate.media.overview && (
                      <p>{candidate.media.overview}</p>
                    )}
                  </span>
                  <span className="request-choice-label">
                    选择这部作品
                    <ChevronRight size={14} />
                  </span>
                </button>
              ))}
            </div>
          )}
          {request.candidates.length ? (
            <details className="request-manual">
              <summary>没有找到目标作品？手工确认身份</summary>
              {identityForm()}
            </details>
          ) : (
            identityForm()
          )}
        </>
      )}
      {request.stage === "details" && identityForm()}
      {request.stage === "resource" && (
        <div className="request-resources">
          {resourceOptions.length ? (
            resourceOptions.map((resource) => <ResourceOption key={resource.id} resource={resource} intent={request.intent} locked={locked} busy={busy} onSelect={onSelect} alipanCredentialsSaved={alipanCredentialsSaved} onConfigureSources={onConfigureSources} onPlayStream={onPlayStream} />)
          ) : (
            <p className="request-help">
              当前没有可选择的资源。可配置来源后重新发起搜索，或订阅作品等待更新。
            </p>
          )}
        </div>
      )}
      {request.stage === "approval" && (
        <div className="request-approval">
          <p className="request-message">{request.message}</p>
          <div className="modal-actions">
            <button
              type="button"
              className="button primary small"
              disabled={locked}
              onClick={() => onSelect({ approve: true })}
            >
              {busy ? <Spinner /> : <Check size={14} />}
              批准并创建任务
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={locked}
              onClick={() => onSelect({ reject: true })}
            >
              {busy ? <Spinner /> : <X size={14} />}
              拒绝
            </button>
          </div>
        </div>
      )}
      {request.stage === "completed" && (
        <div className="request-completion">
          {request.taskId && (
            <p>
              <CheckCircle2 size={15} />
              <span>
                已创建任务：<code>{request.taskId}</code>
              </span>
              <button
                type="button"
                className="text-button"
                onClick={() => onNavigate("downloads")}
              >
                查看任务
                <ArrowRight size={13} />
              </button>
            </p>
          )}
          {request.subscriptionId && (
            <p>
              <Rss size={15} />
              <span>
                已确认订阅：<code>{request.subscriptionId}</code>
              </span>
              <button
                type="button"
                className="text-button"
                onClick={() => onNavigate("subscriptions")}
              >
                查看订阅
                <ArrowRight size={13} />
              </button>
            </p>
          )}
          {!request.taskId && !request.subscriptionId && (
            <p>本次选择已处理；没有创建下载或订阅记录。</p>
          )}
        </div>
      )}
      {problem && (
        <div className="alert error" role="alert">
          <CircleAlert size={15} />
          <span>
            {problem}
            {needsRefresh && " 请先重新读取请求状态，再决定下一步。"}
          </span>
        </div>
      )}
      <div className="request-card-footer">
        <small>请求保存在服务器 · {relativeTime(request.updatedAt)}</small>
        <button
          type="button"
          className="text-button muted"
          disabled={busy}
          onClick={onRefresh}
        >
          {busy ? <Spinner /> : <RefreshCw size={13} />}重新读取状态
        </button>
      </div>
    </article>
  );
}

type NotificationAction = "read" | "retry" | "dismiss";
function notificationText(text: string) {
  const safe = text
    .replace(/\b(?:https?|ftp|magnet|file|smb|nfs|rtsp):[^\s<>]+/gi, "[链接已隐藏]")
    .replace(/\b[A-Za-z]:[\\/][^\s<>]+/g, "[路径已隐藏]")
    .replace(/\\\\[^\s<>]+/g, "[路径已隐藏]")
    .replace(/(^|[\s"'(：:])\/[^\s<>]+/g, "$1[路径已隐藏]");
  return safe.length > 1200 ? `${safe.slice(0, 1200)}…` : safe;
}
function NotificationCard({ notification, busy, onAction, onUnknownRetry }: {
  notification: TaskNotification;
  busy: boolean;
  onAction: (action: NotificationAction) => void;
  onUnknownRetry: () => void;
}) {
  if (notification.status === "waiting") return null;
  const web = notification.destination.platform === "web";
  const label = {
    pending: web ? "待处理 · 未读" : "待发送",
    dispatching: "发送中",
    delivered: web ? "已读" : "已发送",
    unknown: "结果未知",
    rejected: "发送被拒",
    dismissed: "已忽略",
  }[notification.status];
  const channel = { web: "站内通知", telegram: "Telegram", wechat: "微信", qq: "QQ", feishu: "飞书" }[notification.destination.platform];
  const needsAttention = ["unknown", "rejected"].includes(notification.status);
  return <article className={`notification-card status-${notification.status}`}>
    <div className="notification-card-heading"><span className="service-icon sage"><Bell size={19} /></span><div><strong>{channel}</strong><time dateTime={notification.updatedAt}>{relativeTime(notification.updatedAt)}</time></div><span className={`badge ${notification.status === "delivered" ? "positive" : needsAttention ? "warning" : "neutral"}`}>{notification.status === "dispatching" && <Spinner />}{label}</span></div>
    <p className="notification-text">{notificationText(notification.text)}</p>
    {notification.status === "unknown" && <p className="notification-help">发送结果尚未确认，不会自动重发。再次发送可能产生重复通知。</p>}
    {notification.status === "dispatching" && <p className="notification-help">当前发送尚未结束，暂不可忽略或重新发送。</p>}
    <div className="notification-actions">
      {web && notification.status === "pending" && <button type="button" className="button secondary small" disabled={busy} onClick={() => onAction("read")}><Check size={14} />标为已读</button>}
      {needsAttention && <button type="button" className="button secondary small" disabled={busy} onClick={() => notification.status === "unknown" ? onUnknownRetry() : onAction("retry")}><RefreshCw size={14} />重新发送</button>}
      {["pending", "unknown", "rejected"].includes(notification.status) && <button type="button" className="text-button muted" disabled={busy} onClick={() => onAction("dismiss")}>忽略此通知</button>}
    </div>
  </article>;
}

type SessionInfo = {
  authenticated: boolean;
  needsSetup: boolean;
  testMode?: boolean;
};

function TestModeBanner({ active }: { active: boolean }) {
  const banner = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!active) return;
    document.body.classList.add("mori-test-mode");
    const measure = () => document.body.style.setProperty("--mori-test-banner-height", `${banner.current?.getBoundingClientRect().height || 64}px`);
    measure();
    const observer = new ResizeObserver(measure);
    if (banner.current) observer.observe(banner.current);
    return () => {
      observer.disconnect();
      document.body.classList.remove("mori-test-mode");
      document.body.style.removeProperty("--mori-test-banner-height");
    };
  }, [active]);
  if (!active) return null;
  return createPortal(<aside ref={banner} className="test-mode-banner" role="alert"><CircleAlert size={20} aria-hidden="true" /><p><strong>隔离测试模式：</strong>候选和资源是固定样例，不能用于真实搜索或订阅</p><a href="http://127.0.0.1:4180" target="_blank" rel="noreferrer">打开正式实例<ArrowUpRight size={16} aria-hidden="true" /></a></aside>, document.body);
}

export default function App() {
  const [testMode, setTestMode] = useState(false);
  return <><TestModeBanner active={testMode} /><MnemoApp onTestMode={setTestMode} /></>;
}

function MnemoApp({ onTestMode }: { onTestMode: (active: boolean) => void }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [draft, setDraft] = useState<AppConfig | null>(null);
  const [secrets, setSecrets] = useState<Record<string, boolean>>({});
  const [clearP115Cookie, setClearP115Cookie] = useState(false);
  const [clearAlipanRefreshToken, setClearAlipanRefreshToken] = useState(false);
  const [alipanAuthUnknown, setAlipanAuthUnknown] = useState(false);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [notifications, setNotifications] = useState<TaskNotification[] | null>(null);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsError, setNotificationsError] = useState("");
  const [notificationBusy, setNotificationBusy] = useState("");
  const [notificationActionError, setNotificationActionError] = useState("");
  const [notificationPage, setNotificationPage] = useState(0);
  const [unknownRetryId, setUnknownRetryId] = useState<string | null>(null);
  const [confirmUnknown, setConfirmUnknown] = useState(false);
  const notificationInFlight = useRef(false);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [page, setPage] = useState<Page>(() => {
    const hash = window.location.hash.slice(1);
    return [
      "overview",
      "assistant",
      "subscriptions",
      "downloads",
      "library",
      "notifications",
      "settings",
    ].includes(hash)
      ? (hash as Page)
      : "overview";
  });
  const [settingGroup, setSettingGroup] = useState<SettingGroup>("model");
  const [mobileNav, setMobileNav] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState("");
  const [libraryUsers, setLibraryUsers] = useState<
    { id: string; name: string }[] | null
  >(null);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; message: string }>
  >({});
  const [wizard, setWizard] = useState(false);
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<"chat" | "search">("chat");
  const [message, setMessage] = useState("");
  const [conversation, setConversation] = useState<Conversation[]>([]);
  const [requests, setRequests] = useState<MediaRequest[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [requestBusy, setRequestBusy] = useState("");
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>(
    {},
  );
  const [requestRecovery, setRequestRecovery] = useState<
    Record<string, boolean>
  >({});
  const [requestLoadError, setRequestLoadError] = useState("");
  const requestInFlight = useRef(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchDiagnostics, setSearchDiagnostics] = useState<SearchDiagnostics>();
  const [searchError, setSearchError] = useState("");
  const searchInFlight = useRef(false);
  const [thinking, setThinking] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const [playback, setPlayback] = useState<DownloadTask | null>(null);
  const [cmsPlayback, setCmsPlayback] = useState<{ title: string; url: string } | null>(null);
  const [taskUrl, setTaskUrl] = useState("");
  const [taskKind, setTaskKind] = useState<SearchResult["kind"] | undefined>();
  const [taskMedia, setTaskMedia] = useState<MediaInfo>({
    type: "movie",
    title: "",
  });
  const [identifyResults, setIdentifyResults] = useState<MediaInfo[] | null>(
    null,
  );
  const [identifying, setIdentifying] = useState(false);
  const [newSubscription, setNewSubscription] = useState(false);
  const [modalBusy, setModalBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState("");
  const [subscriptionCheckBusy, setSubscriptionCheckBusy] = useState("");
  const subscriptionCheckInFlight = useRef(false);
  const [taskFilter, setTaskFilter] = useState("all");
  const [showNotices, setShowNotices] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const notifyError = useCallback((value: unknown) => {
    setError(value instanceof Error ? value.message : "操作失败，请稍后重试。");
    if (value instanceof ApiError && value.status === 401) {
      setSession({ authenticated: false, needsSetup: false });
      setConfig(null);
      setDraft(null);
      setDashboard(null);
      setNotifications(null);
      setUnknownRetryId(null);
      setConversation([]);
      setRequests([]);
    }
  }, []);
  const loadSession = useCallback(async () => {
    setError("");
    try {
      const nextSession = await api<SessionInfo>("/session");
      setSession(nextSession);
      onTestMode(!!nextSession.testMode);
    } catch (error) {
      notifyError(error);
    }
  }, [notifyError, onTestMode]);
  const applyConfig = useCallback((value: ConfigResponse) => {
    const { secretStatus = {}, ...plain } = value;
    const normalized = { ...plain, defaultTitleAction: plain.defaultTitleAction || "search", sources: { ...plain.sources, p115Enabled: plain.sources.p115Enabled ?? false, p115Cookie: plain.sources.p115Cookie || "", alipanEnabled: plain.sources.alipanEnabled ?? false, alipanRefreshToken: plain.sources.alipanRefreshToken || "" } };
    setConfig(normalized);
    setDraft(normalized);
    setSecrets(secretStatus);
    setDirty(false);
    setClearP115Cookie(false);
    setClearAlipanRefreshToken(false);
  }, []);
  const refresh = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const work = (async () => {
      setNotificationsLoading(true);
      try {
        try {
          setDashboard(await api<Dashboard>("/dashboard", { signal: AbortSignal.timeout(15000) }));
        } catch (error) {
          notifyError(error);
          if (error instanceof ApiError && error.status === 401) return;
        }
        try {
          const result = await api<{ notifications: TaskNotification[] }>("/notifications", { signal: AbortSignal.timeout(15000) });
          setNotifications(result.notifications.filter((item) => item.status !== "waiting").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
          setNotificationsError("");
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) notifyError(error);
          else setNotificationsError(notificationText(error instanceof Error ? error.message : "暂时无法读取通知，请稍后重试。"));
        }
      } finally { setNotificationsLoading(false); }
    })();
    refreshInFlight.current = work;
    void work.finally(() => { if (refreshInFlight.current === work) refreshInFlight.current = null; });
    return work;
  }, [notifyError]);
  useEffect(() => {
    void loadSession();
  }, [loadSession]);
  useEffect(() => {
    if (!session?.authenticated) return;
    let current = true;
    void api<ConfigResponse>("/config")
      .then((value) => {
        if (current) {
          applyConfig(value);
          setWizard(!value.setupComplete);
        }
      })
      .catch(notifyError);
    void refresh();
    void reloadAudit();
    void api<{ items: Capability[] }>("/capabilities")
      .then((value) => {
        if (current) setCapabilities(value.items);
      })
      .catch(notifyError);
    void api<{ requests: MediaRequest[] }>("/requests", {
      signal: AbortSignal.timeout(15000),
    })
      .then((value) => {
        if (current) {
          setRequests((previous) =>
            mergeRequests(
              previous,
              value.requests.filter((request) => request.stage !== "completed"),
            ),
          );
          setRequestLoadError("");
        }
      })
      .catch((error) => {
        if (current)
          setRequestLoadError(
            error instanceof Error ? error.message : "无法读取待确认请求。",
          );
      });
    return () => {
      current = false;
    };
  }, [session?.authenticated, applyConfig, refresh, notifyError]);
  useEffect(() => {
    if (!session?.authenticated || !config || wizard) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function poll() {
      if (!document.hidden) await refresh();
      if (!stopped) timer = setTimeout(poll, 8000);
    }
    timer = setTimeout(poll, 8000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [session?.authenticated, !!config, wizard, refresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (conversation.length)
      chatEndRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
  }, [conversation, thinking]);
  useEffect(() => {
    const handler = () => {
      const value = window.location.hash.slice(1) as Page;
      if (
        [
          "overview",
          "assistant",
          "subscriptions",
          "downloads",
          "library",
          "notifications",
          "settings",
        ].includes(value)
      )
        setPage(value);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  function navigate(next: Page) {
    setPage(next);
    window.location.hash = next;
    setMobileNav(false);
    setShowNotices(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function settings(group: SettingGroup) {
    setSettingGroup(group);
    navigate("settings");
  }
  function update<K extends keyof AppConfig>(
    group: K,
    values: Partial<AppConfig[K]>,
  ) {
    if (
      group === "library" &&
      Object.keys(values).some((key) =>
        ["serverUrl", "serverToken", "profile"].includes(key),
      )
    ) {
      setLibraryUsers(null);
    }
    setDraft((current) =>
      current
        ? { ...current, [group]: { ...(current[group] as object), ...values } }
        : current,
    );
    setDirty(true);
    setTestResults({});
  }
  async function save(complete = false, silent = false) {
    if (!draft) return false;
    const submittedAlipanCredential = !!draft.sources.alipanRefreshToken.trim();
    const secretsToClear = [...(clearP115Cookie ? ["sources.p115Cookie"] : []), ...(clearAlipanRefreshToken ? ["sources.alipanRefreshToken"] : [])];
    setSaving(true);
    setError("");
    try {
      await api("/config", {
        method: "PUT",
        body: JSON.stringify({
          ...draft,
          ...(secretsToClear.length ? { clearSecrets: secretsToClear } : {}),
          setupComplete: complete || draft.setupComplete,
        }),
      });
      applyConfig(await api<ConfigResponse>("/config"));
      if (submittedAlipanCredential || clearAlipanRefreshToken) setAlipanAuthUnknown(false);
      if (!silent) setNotice("设置已保存。");
      return true;
    } catch (error) {
      notifyError(error);
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function test(kind: string) {
    if (kind === "alipan" && alipanAuthUnknown && !draft?.sources.alipanRefreshToken.trim()) return;
    setTesting(kind);
    setError("");
    try {
      if (await save(false, true)) {
        const result = await post<ConnectionTestResult>("/test", { kind });
        setTestResults((previous) => ({ ...previous, [kind]: result }));
        if (kind === "alipan") setAlipanAuthUnknown(result.code === "alipan_auth_unknown");
      }
    } catch (error) {
      if (kind === "alipan") {
        const code = error instanceof ApiError ? error.code : undefined;
        const message = code === "alipan_auth_unknown" ? alipanUnknownMessage : error instanceof Error ? error.message : "网页登录凭据验证失败，请稍后重试。";
        setAlipanAuthUnknown(code === "alipan_auth_unknown");
        setTestResults((previous) => ({ ...previous, alipan: { ok: false, message, code } }));
      }
      notifyError(error);
    } finally {
      setTesting("");
    }
  }
  async function loadLibraryUsers() {
    setTesting("library-users");
    setLibraryUsers(null);
    setError("");
    try {
      if (await save(false, true)) {
        const result = await api<{ users: { id: string; name: string }[] }>(
          "/library/users",
        );
        setLibraryUsers(result.users);
      }
    } catch (error) {
      notifyError(error);
    } finally {
      setTesting("");
    }
  }
  async function finishWizard() {
    if (await save(true, true)) {
      setWizard(false);
      navigate("overview");
      setNotice("你的影视空间准备好了，开始收藏第一部好故事吧。");
      void refresh();
    }
  }
  async function searchResources(query: string) {
    const text = query.trim();
    if (!text || searchInFlight.current) return;
    searchInFlight.current = true;
    setThinking(true);
    setError("");
    setSearchQuery(text);
    setResults(null);
    setSearchDiagnostics(undefined);
    setSearchError("");
    navigate("assistant");
    try {
      const report = await api<SearchReport>(`/search?q=${encodeURIComponent(text)}`, { signal: AbortSignal.timeout(30000) });
      setResults(report.results);
      setSearchDiagnostics(report.diagnostics);
    } catch (error) {
      const failure = error instanceof ApiError ? error : undefined;
      setResults(failure?.results || []);
      setSearchDiagnostics(failure?.diagnostics || { status: "failed", sources: [] });
      if (!failure?.diagnostics) setSearchError(failure?.message || (error instanceof DOMException && error.name === "TimeoutError" ? "搜索等待超时，请检查来源后手动重试。" : "暂时无法连接 Mnemo 搜索服务，请检查连接后手动重试。"));
      if (failure?.status === 401) notifyError(error);
    } finally {
      searchInFlight.current = false;
      setThinking(false);
    }
  }
  async function runComposer(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text || thinking) return;
    if (mode === "search") {
      await searchResources(text);
      return;
    }
    setThinking(true);
    setError("");
    navigate("assistant");
    try {
      setConversation((previous) => [...previous, { role: "user", text }]);
      setMessage("");
      const reply = await post<ChatReply>("/chat", { message: text });
      setConversation((previous) => [...previous, { role: "assistant", text: reply.text, results: reply.results, searchDiagnostics: reply.searchDiagnostics }]);
      if (reply.request) setRequests((previous) => mergeRequests(previous, [reply.request!]));
      if (reply.task || reply.subscription || reply.request?.stage === "completed") void refresh();
    } catch (error) {
      if (error instanceof ApiError && error.diagnostics) {
        setConversation((previous) => [...previous, { role: "assistant", text: searchDiagnosticSummary(error.diagnostics) || error.message, results: error.results, searchDiagnostics: error.diagnostics }]);
      }
      notifyError(error);
    } finally {
      setThinking(false);
    }
  }
  function openTask(result?: SearchResult) {
    setError("");
    setTaskMedia({ type: "movie", title: result?.title || "" });
    setTaskUrl(result?.url || "");
    setTaskKind(result?.kind);
    setIdentifyResults(null);
    setNewTask(true);
  }
  async function startRequest(query: string, intent: RequestIntent) {
    if (requestInFlight.current) return null;
    requestInFlight.current = true;
    setRequestBusy("new");
    setError("");
    try {
      const result = await api<{ request: MediaRequest }>("/requests", {
        method: "POST",
        body: JSON.stringify({ query, intent }),
        signal: AbortSignal.timeout(30000),
      });
      setRequests((previous) => mergeRequests(previous, [result.request]));
      setMode("chat");
      navigate("assistant");
      if (result.request.stage === "completed") void refresh();
      return result.request;
    } catch (error) {
      notifyError(error);
      return null;
    } finally {
      requestInFlight.current = false;
      setRequestBusy("");
    }
  }
  async function selectRequest(
    request: MediaRequest,
    selection: SelectionInput,
  ) {
    if (requestInFlight.current || requestRecovery[request.id]) return;
    requestInFlight.current = true;
    setRequestBusy(request.id);
    setRequestErrors((previous) => ({ ...previous, [request.id]: "" }));
    try {
      const result = await api<{ request: MediaRequest }>(
        `/requests/${encodeURIComponent(request.id)}/select`,
        {
          method: "POST",
          body: JSON.stringify({
            ...selection,
            expectedRevision: request.revision,
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
      setRequests((previous) => mergeRequests(previous, [result.request]));
      if (result.request.stage === "completed") void refresh();
      // 审批决定落库后立刻刷新历史，不必手动刷新页面。
      if (result.request.decision) void reloadAudit();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        notifyError(error);
        return;
      }
      const unknown = !(error instanceof ApiError) || error.status >= 500;
      setRequestErrors((previous) => ({
        ...previous,
        [request.id]: unknown
          ? "暂时无法确认这次选择的结果，未自动重复提交。"
          : error instanceof Error
            ? error.message
            : "选择失败，请重新核对。",
      }));
      setRequestRecovery((previous) => ({
        ...previous,
        [request.id]:
          unknown || (error instanceof ApiError && error.status === 409),
      }));
    } finally {
      requestInFlight.current = false;
      setRequestBusy("");
    }
  }
  async function reloadAudit() {
    try {
      const result = await api<{ entries: AuditEntry[] }>("/audit", {
        signal: AbortSignal.timeout(10000),
      });
      setAudit(result.entries);
    } catch {
      // 记录读不到不影响选片与下载；下次刷新会重试。
    }
  }
  async function reloadRequest(id?: string) {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setRequestBusy(id || "restore");
    try {
      const incoming = id
        ? [
            (
              await api<{ request: MediaRequest }>(
                `/requests/${encodeURIComponent(id)}`,
                { signal: AbortSignal.timeout(15000) },
              )
            ).request,
          ]
        : (
            await api<{ requests: MediaRequest[] }>("/requests", {
              signal: AbortSignal.timeout(15000),
            })
          ).requests.filter((request) => request.stage !== "completed");
      setRequests((previous) => mergeRequests(previous, incoming));
      if (id) {
        setRequestErrors((previous) => ({ ...previous, [id]: "" }));
        setRequestRecovery((previous) => ({ ...previous, [id]: false }));
      }
      setRequestLoadError("");
      if (!id) void reloadAudit();
      if (incoming.some((request) => request.stage === "completed"))
        void refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        notifyError(error);
        return;
      }
      if (id)
        setRequestErrors((previous) => ({
          ...previous,
          [id]:
            error instanceof Error ? error.message : "读取失败，请稍后重试。",
        }));
      else
        setRequestLoadError(
          error instanceof Error ? error.message : "无法读取待确认请求。",
        );
    } finally {
      requestInFlight.current = false;
      setRequestBusy("");
    }
  }
  async function identifyMedia() {
    if (!taskMedia.title.trim()) return;
    setIdentifying(true);
    setError("");
    setIdentifyResults(null);
    try {
      const result = await api<{ results: MediaInfo[] }>(
        `/identify?q=${encodeURIComponent(taskMedia.title.trim())}&type=${taskMedia.type}`,
      );
      setIdentifyResults(result.results);
    } catch (error) {
      notifyError(error);
    } finally {
      setIdentifying(false);
    }
  }
  async function taskAction(id: string, action: string) {
    setActionBusy(id);
    setError("");
    try {
      await post(`/tasks/${encodeURIComponent(id)}/action`, { action });
      await refresh();
    } catch (error) {
      notifyError(error);
    } finally {
      setActionBusy("");
    }
  }
  async function checkLibrary(task: DownloadTask) {
    if (actionBusy) return;
    setActionBusy(task.id);
    setError("");
    try {
      const result = await post<{ task: DownloadTask }>(
        `/tasks/${encodeURIComponent(task.id)}/library`,
      );
      setDashboard((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.map((item) =>
                item.id === result.task.id ? result.task : item,
              ),
            }
          : current,
      );
    } catch (error) {
      notifyError(error);
    } finally {
      setActionBusy("");
    }
  }
  async function subscriptionAction(
    id: string,
    method: string,
    body?: unknown,
    suffix = "",
  ) {
    const checking = suffix === "/check";
    if (checking) {
      if (subscriptionCheckInFlight.current) return;
      subscriptionCheckInFlight.current = true;
      setSubscriptionCheckBusy(id);
    } else setActionBusy(id);
    setError("");
    try {
      await api(`/subscriptions/${encodeURIComponent(id)}${suffix}`, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (refreshInFlight.current) await refreshInFlight.current;
      await refresh();
    } catch (error) {
      notifyError(error);
    } finally {
      if (checking) {
        subscriptionCheckInFlight.current = false;
        setSubscriptionCheckBusy("");
      } else setActionBusy("");
    }
  }
  async function logout() {
    setError("");
    try {
      await post("/logout");
      setSession({ authenticated: false, needsSetup: false });
      setConfig(null);
      setDraft(null);
      setDashboard(null);
      setNotifications(null);
      setUnknownRetryId(null);
      setConversation([]);
      setRequests([]);
      setSecrets({});
    } catch (error) {
      notifyError(error);
    }
  }
  function suggest(text: string) {
    setMode("chat");
    setMessage(text);
    composerRef.current?.focus();
  }
  async function notificationAction(id: string, action: NotificationAction, confirmed = false) {
    if (notificationInFlight.current) return;
    const target = notifications?.find((item) => item.id === id);
    if (!target || target.status === "dispatching") return;
    if (action === "retry" && target.status === "unknown" && !confirmed) {
      setUnknownRetryId(id); setConfirmUnknown(false); setNotificationActionError(""); return;
    }
    notificationInFlight.current = true; setNotificationBusy(id); setNotificationActionError("");
    try {
      await api(`/notifications/${encodeURIComponent(id)}/action`, { method: "POST", body: JSON.stringify({ action, ...(confirmed ? { confirmUnknown: true } : {}) }), signal: AbortSignal.timeout(20000) });
      if (refreshInFlight.current) await refreshInFlight.current;
      await refresh();
      if (action === "retry") { setUnknownRetryId(null); setConfirmUnknown(false); }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) notifyError(error);
      else setNotificationActionError(notificationText(error instanceof Error ? error.message : "通知操作失败，请重新读取状态后再决定下一步。"));
    } finally { notificationInFlight.current = false; setNotificationBusy(""); }
  }
  const tasks = dashboard?.tasks || [];
  const notificationAttention = notifications?.filter((item) => item.status === "unknown" || item.status === "rejected" || item.destination.platform === "web" && item.status === "pending").length || 0;
  const notificationPages = Math.max(1, Math.ceil((notifications?.length || 0) / 20));
  const currentNotificationPage = Math.min(notificationPage, notificationPages - 1);
  const unknownNotification = notifications?.find((item) => item.id === unknownRetryId);
  const subscriptions = dashboard?.subscriptions || [];
  const completed = tasks.filter((task) => task.status === "completed");
  const active = tasks.filter((task) =>
    ["queued", "downloading", "scraping"].includes(task.status),
  );
  const warnings = dashboard?.warnings || [];
  const profile = profiles.find((item) => item.id === config?.library.profile);

  function field(
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: {
      placeholder?: string;
      help?: string;
      secret?: string;
      type?: string;
      required?: boolean;
    } = {},
  ) {
    return (
      <label className="field">
        <span>
          {label}
          {options.secret && secrets[options.secret] && (
            <span className="secret-saved">
              <ShieldCheck size={12} />
              已保存
            </span>
          )}
        </span>
        <input
          type={options.secret ? "password" : options.type || "text"}
          autoComplete={options.secret ? "new-password" : "off"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            options.secret && secrets[options.secret]
              ? "•••••••• · 留空保留已保存的密钥"
              : options.placeholder
          }
          required={options.required}
        />
        {options.help && <small>{options.help}</small>}
      </label>
    );
  }
  function testButton(kind: string, label = "保存并测试连接", disabled = false) {
    const result = testResults[kind];
    return (
      <div className="test-row">
        <button
          type="button"
          className="button secondary small"
          onClick={() => void test(kind)}
          disabled={!!testing || saving || disabled}
        >
          {testing === kind ? <Spinner /> : <Zap size={14} />}
          {testing === kind ? "正在检查…" : label}
        </button>
        {result && (
          <span
            role="status"
            className={`test-result ${result.ok ? "success" : "failure"}`}
          >
            {result.ok ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
            {result.message}
          </span>
        )}
      </div>
    );
  }
  function formSection(group: SettingGroup) {
    if (!draft) return null;
    if (group === "model")
      return (
        <>
          <div className="info-banner">
            <Sparkles size={20} />
            <div>
              <strong>你的模型，你来选择</strong>
              <p>
                支持兼容 OpenAI Chat Completions
                的接口。也可暂不配置，使用基础搜索、订阅与下载指令。
              </p>
            </div>
          </div>
          <TitleActionControl value={draft.defaultTitleAction || "search"} onChange={(defaultTitleAction) => { setDraft((current) => current ? { ...current, defaultTitleAction } : current); setDirty(true); }} />
          <div className="form-grid">
            {field(
              "API 地址",
              draft.model.baseUrl,
              (value) => update("model", { baseUrl: value }),
              {
                placeholder: "http://localhost:11434/v1",
                help: "填入本地或远程兼容服务的完整 API 基础地址。",
                type: "url",
              },
            )}
            {field(
              "模型名称",
              draft.model.model,
              (value) => update("model", { model: value }),
              { placeholder: "本地或远程服务提供的模型 ID" },
            )}
          </div>
          {field(
            "API Key",
            draft.model.apiKey,
            (value) => update("model", { apiKey: value }),
            {
              secret: "model.apiKey",
              placeholder: "服务需要时填写，本地免密模型可留空",
              help: "仅保存在服务端。本地兼容模型可无需密钥；测试外部付费模型可能产生服务商费用。",
            },
          )}
          {testButton("model")}
          <div className="setting-divider" />
          <div className="icon-note">
            <ShieldCheck size={19} />
            <div>
              <strong>独立、安全、由你掌控</strong>
              <p>
                所有渠道共用这里的模型配置，也可为消息渠道单独指定模型。密钥不会返回到浏览器。
              </p>
            </div>
          </div>
        </>
      );
    if (group === "download")
      return (
        <>
          <div className="info-banner">
            <FolderOpen size={20} />
            <div>
              <strong>先给收藏安一个家</strong>
              <p>
                这是运行 Mnemo 的服务器路径。NAS
                请先挂载共享目录；容器部署请填写容器内的挂载路径。
              </p>
            </div>
          </div>
          {field(
            "下载目录",
            draft.download.directory,
            (value) => update("download", { directory: value }),
            {
              placeholder: "/media/mnemo",
              help: "建议使用独立目录。Mnemo 不会覆盖已有的媒体文件。",
              required: true,
            },
          )}
          {testButton("directory", "保存并检查目录")}
          <label className="field narrow-field">
            <span>同时下载数量</span>
            <select
              value={draft.download.concurrency}
              onChange={(e) =>
                update("download", { concurrency: Number(e.target.value) })
              }
            >
              {[1, 2, 3, 4].map((count) => (
                <option key={count} value={count}>
                  {count} 个任务
                </option>
              ))}
            </select>
            <small>根据服务器带宽与磁盘能力选择，建议从 2 个开始。</small>
          </label>
          <div className="setting-divider" />
          <div className="section-label">
            <h3>Aria2 下载器</h3>
            <span className="badge neutral">可选</span>
          </div>
          <p className="form-description">
            HTTP 直链可直接下载。磁力与 BT 任务需要你配置的 Aria2 服务支持。
          </p>
          {field(
            "Aria2 RPC 地址",
            draft.download.aria2Url,
            (value) => update("download", { aria2Url: value }),
            { placeholder: "http://aria2:6800/jsonrpc", type: "url" },
          )}
          {field(
            "RPC 密钥",
            draft.download.aria2Secret,
            (value) => update("download", { aria2Secret: value }),
            { secret: "download.aria2Secret", placeholder: "Aria2 RPC Secret" },
          )}
          {testButton("aria2")}
        </>
      );
    if (group === "library")
      return (
        <>
          <p className="form-description">
            选择你常用的媒体库。此设置影响文件整理和通用 NFO 输出，不会替代 NAS
            挂载或下载目录。
          </p>
          <div className="profile-grid">
            {profiles.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`profile-option ${draft.library.profile === item.id ? "selected" : ""}`}
                aria-pressed={draft.library.profile === item.id}
                onClick={() => update("library", { profile: item.id })}
              >
                <span
                  className="profile-logo"
                  style={{ background: `${item.color}15`, color: item.color }}
                >
                  {item.mark}
                </span>
                <strong>{item.name}</strong>
                <small>{item.detail}</small>
                {draft.library.profile === item.id && (
                  <span className="profile-check">
                    <Check size={12} />
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="info-banner subtle">
            <CircleAlert size={18} />
            <p>
              使用通用 NFO
              预设。不同播放器与版本的兼容性，请导入后在你的媒体库中实际确认。
            </p>
          </div>
          <label className="field narrow-field">
            <span>元数据语言</span>
            <select
              value={draft.library.language}
              onChange={(e) => update("library", { language: e.target.value })}
            >
              <option value="zh-CN">简体中文 · zh-CN</option>
              <option value="zh-TW">繁體中文 · zh-TW</option>
              <option value="en-US">English · en-US</option>
            </select>
          </label>
          <div className="switch-row">
            <div>
              <strong>规范文件命名</strong>
              <p>按识别到的影视名称与年份整理新下载文件。</p>
            </div>
            <Toggle
              label="规范文件命名"
              checked={draft.library.rename}
              onChange={(value) => update("library", { rename: value })}
            />
          </div>
          <div className="switch-row">
            <div>
              <strong>保存海报与背景图</strong>
              <p>需配置 TMDB 凭据，图片可用时才会保存。</p>
            </div>
            <Toggle
              label="保存海报与背景图"
              checked={draft.library.artwork}
              onChange={(value) => update("library", { artwork: value })}
            />
          </div>
          <div className="setting-divider" />
          <div className="section-label">
            <h3>媒体服务器</h3>
            <span className="badge neutral">可选</span>
          </div>
          {field(
            "服务地址",
            draft.library.serverUrl,
            (value) => update("library", { serverUrl: value }),
            { placeholder: "http://your-media-server:8096", type: "url" },
          )}
          {field(
            "服务 API Token",
            draft.library.serverToken,
            (value) => update("library", { serverToken: value }),
            {
              secret: "library.serverToken",
              placeholder: "输入媒体服务器的 Token",
            },
          )}
          <details className="setup-token-details">
            <summary>服务器路径不同？</summary>
            <p className="form-description">
              Mnemo
              与媒体服务器看到的同一文件路径不同时，填写一组目录映射。两项同时留空时，默认使用相同路径。
            </p>
            {field(
              "Mnemo 所见目录（pathFrom）",
              draft.library.pathFrom || "",
              (value) => update("library", { pathFrom: value }),
              {
                placeholder: draft.download.directory || "/downloads",
                help: "填写本机下载目录或它的上级目录。",
              },
            )}
            {field(
              "媒体服务器所见目录（pathTo）",
              draft.library.pathTo || "",
              (value) => update("library", { pathTo: value }),
              { placeholder: "例如：/media/mnemo" },
            )}
          </details>
          <div className="test-row">
            <button
              type="button"
              className="button secondary small"
              disabled={!!testing || saving || !draft.library.serverUrl.trim()}
              onClick={() => void loadLibraryUsers()}
            >
              {testing === "library-users" ? (
                <Spinner />
              ) : (
                <MonitorPlay size={14} />
              )}
              {testing === "library-users" ? "正在读取账户…" : "选择播放账户"}
            </button>
          </div>
          <p className="form-description">
            仅点击时保存当前设置并读取账户。Emby 需要选择播放账户；Jellyfin
            可选。
          </p>
          {(libraryUsers !== null || draft.library.userId) && (
            <label className="field">
              <span>播放账户</span>
              <select
                value={draft.library.userId || ""}
                onChange={(event) =>
                  update("library", { userId: event.target.value })
                }
              >
                <option value="">
                  {draft.library.profile === "emby"
                    ? "请选择播放账户"
                    : "不指定账户（可选）"}
                </option>
                {draft.library.userId &&
                  !libraryUsers?.some(
                    (user) => user.id === draft.library.userId,
                  ) && (
                    <option value={draft.library.userId}>
                      已保存账户 · {draft.library.userId}
                    </option>
                  )}
                {libraryUsers?.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
              {libraryUsers?.length === 0 && (
                <small>服务器未返回可选账户，请检查权限与服务配置。</small>
              )}
              <small>选定后点击「保存设置」，下一次检查会使用该账户。</small>
            </label>
          )}
          {testButton("library")}
        </>
      );
    if (group === "sources")
      return (
        <>
          <SearchReadiness sources={config?.sources} dirty={dirty} />
          <div className="source-heading">
            <span className="service-icon sand">
              <Search size={19} />
            </span>
            <div>
              <h3>PanSou 资源搜索</h3>
              <p>连接你部署的 PanSou 聚合搜索服务。</p>
            </div>
          </div>
          {field(
            "PanSou 地址",
            draft.sources.pansouUrl,
            (value) => update("sources", { pansouUrl: value }),
            { placeholder: "http://pansou:8888", type: "url" },
          )}
          {testButton("pansou")}
          <div className="setting-divider" />
          <div className="source-heading">
            <span className="service-icon green">
              <FolderOpen size={19} />
            </span>
            <div>
              <h3>OpenList 文件入口</h3>
              <p>检索你已挂载的文件，并按服务权限获取下载地址。</p>
            </div>
          </div>
          <div className="form-grid">
            {field(
              "OpenList 地址",
              draft.sources.openlistUrl,
              (value) => update("sources", { openlistUrl: value }),
              { placeholder: "http://openlist:5244", type: "url" },
            )}
            {field(
              "访问 Token",
              draft.sources.openlistToken,
              (value) => update("sources", { openlistToken: value }),
              {
                secret: "sources.openlistToken",
                placeholder: "OpenList Token",
              },
            )}
          </div>
          {testButton("openlist")}
          <div className="setting-divider" />
          <div className="source-heading"><span className="service-icon green"><FolderOpen size={19} /></span><div><h3>115 分享浏览</h3><p>按需开启，先浏览分享目录，再选择匹配的文件。</p></div><Toggle label="启用115分享浏览" checked={draft.sources.p115Enabled ?? false} onChange={(p115Enabled) => update("sources", { p115Enabled })} /></div>
          <fieldset className="share-cookie-fieldset" disabled={clearP115Cookie}>
            {field("115 Cookie（可选）", draft.sources.p115Cookie || "", (p115Cookie) => update("sources", { p115Cookie }), { secret: "sources.p115Cookie", placeholder: "可留空，尝试分享允许的匿名访问", help: clearP115Cookie ? "保存后将清除已保存Cookie，当前修改尚未提交。" : secrets["sources.p115Cookie"] ? "留空会保留已保存Cookie。若要改用匿名访问，请勾选下方清除选项后保存。" : "未配置Cookie时只尝试分享允许的匿名访问，不会绕过登录或访问权限要求。" })}
          </fieldset>
          {secrets["sources.p115Cookie"] && <label className="checkbox-label share-cookie-clear"><input type="checkbox" checked={clearP115Cookie} onChange={(event) => { const checked = event.target.checked; setClearP115Cookie(checked); if (checked) update("sources", { p115Cookie: "" }); else setDirty(true); }} /><span>保存后清除已保存的115 Cookie，并改用匿名访问。</span></label>}
          {testButton("p115", "保存并检查本地解析器")}
          <div className="info-banner subtle"><CircleAlert size={18} /><p>此检查仅验证本地解析器 / SDK 是否就绪，不代表账号或分享已验证。115分享下载使用内置下载器；已浏览目录可明确订阅并持续检查下级目录，其他网盘转存仍未提供。</p></div>
          <div className="setting-divider" />
          <div className="source-heading"><span className="service-icon sage"><Layers3 size={19} /></span><div><h3>阿里云盘分享</h3><p>可先浏览分享，下载文件与自动追更需要网页登录授权。</p></div><Toggle label="启用阿里云盘分享" checked={draft.sources.alipanEnabled ?? false} onChange={(alipanEnabled) => update("sources", { alipanEnabled })} /></div>
          <fieldset className="share-cookie-fieldset" disabled={clearAlipanRefreshToken}>
            {field("阿里云盘网页登录授权凭据", draft.sources.alipanRefreshToken || "", (alipanRefreshToken) => update("sources", { alipanRefreshToken }), { secret: "sources.alipanRefreshToken", placeholder: "Web RefreshToken（浏览分享可留空）", help: clearAlipanRefreshToken ? "保存后清除已保存的阿里网页登录授权，当前修改尚未提交。" : secrets["sources.alipanRefreshToken"] ? "留空会保留已保存凭据。重新授权时，请粘贴新取得的 Web RefreshToken 并保存。" : "请手动提供阿里云盘 Web 登录的 RefreshToken；不是开放平台 OAuth token。仅浏览分享可以留空。" })}
          </fieldset>
          {secrets["sources.alipanRefreshToken"] && <label className="checkbox-label share-cookie-clear"><input type="checkbox" checked={clearAlipanRefreshToken} onChange={(event) => { const checked = event.target.checked; setClearAlipanRefreshToken(checked); if (checked) update("sources", { alipanRefreshToken: "" }); else setDirty(true); }} /><span>保存后清除已保存的阿里网页登录授权，仅保留无需登录的分享浏览。</span></label>}
          {testButton("alipan", "保存并验证网页登录凭据", clearAlipanRefreshToken || (!draft.sources.alipanRefreshToken.trim() && (!secrets["sources.alipanRefreshToken"] || alipanAuthUnknown)))}
          {alipanAuthUnknown && <p className="alipan-auth-warning" role="alert"><CircleAlert size={16} />{alipanUnknownMessage}</p>}
          <div className="info-banner subtle"><KeyRound size={18} /><p>验证会向阿里云盘检查网页登录凭据，并加密保存更新后的授权。成功仅表示网页登录凭据通过，不保证某个分享可下载或具备会员下载权益；「已保存」也不代表已经验证。Mnemo 不会自动读取浏览器凭据，也不提供扫码授权。文件通过内置下载器落盘，不会转存到云端。若授权结果未知，请重新取得并保存新的 Web 凭据后再验证。</p></div>
          <div className="setting-divider" />
          <div className="source-heading">
            <span className="service-icon lavender">
              <Film size={19} />
            </span>
            <div>
              <h3>TMDB 影视元数据</h3>
              <p>用于识别作品、生成 NFO 与获取海报。</p>
            </div>
          </div>
          {field(
            "TMDB 凭据",
            draft.sources.tmdbApiKey,
            (value) => update("sources", { tmdbApiKey: value }),
            {
              secret: "sources.tmdbApiKey",
              placeholder: "TMDB API Key 或 API Read Access Token",
            },
          )}
          <div className="setting-divider" />
          <div className="source-heading">
            <span className="service-icon blue">
              <MonitorPlay size={19} />
            </span>
            <div>
              <h3>MoviePilot</h3>
              <p>接入自托管服务。具体能力受版本与接口权限影响。</p>
            </div>
          </div>
          <div className="form-grid">
            {field(
              "MoviePilot 地址",
              draft.sources.moviePilotUrl,
              (value) => update("sources", { moviePilotUrl: value }),
              { placeholder: "http://moviepilot:3001", type: "url" },
            )}
            {field(
              "API Token",
              draft.sources.moviePilotToken,
              (value) => update("sources", { moviePilotToken: value }),
              {
                secret: "sources.moviePilotToken",
                placeholder: "MoviePilot Token",
              },
            )}
          </div>
          {testButton("moviepilot")}
          <div className="setting-divider" />
          <div className="setting-divider" />
          <div className="source-heading">
            <span className="service-icon sand">
              <Layers3 size={19} />
            </span>
            <div>
              <h3>外置源注册表</h3>
              <p>粘贴源注册表 JSON（CMS V10 / RSS 聚合搜索）；留空关闭。</p>
            </div>
          </div>
          <label className="field">
            <span>注册表 JSON</span>
            <textarea
              rows={6}
              value={draft.sources.registryJson ?? ""}
              onChange={(event) =>
                update("sources", { registryJson: event.target.value })
              }
              placeholder={'{ "format": 1, "sources": [ … ] }'}
            />
            <small>
              每条源：id/name/kind（cms_v10|rss|atom）/endpoint（含 {"{query}"} 占位）。无效内容按未配置处理，不影响其他来源。
            </small>
          </label>
          {field(
            "Telegram 资源频道",
            draft.sources.telegramChannels.join(", "),
            (value) =>
              update("sources", {
                telegramChannels: value
                  .split(/[,，\n]/)
                  .map((item) => item.trim())
                  .filter(Boolean),
              }),
            {
              placeholder: "channel_name, another_channel",
              help: "公开频道名用逗号分隔；仅搜索公开可访问的内容。",
            },
          )}
        </>
      );
    return (
      <>
        <div className="channel-card">
          <div className="source-heading">
            <span className="service-icon sage">
              <ShieldCheck size={19} />
            </span>
            <div>
              <h3>渠道下载审批</h3>
              <p>
                开启后，消息渠道发起的下载会先停在「待批准」，由你在这里确认后再创建任务。
              </p>
            </div>
            <Toggle
              label="渠道下载需管理员批准"
              checked={draft.channels.requireApproval ?? false}
              onChange={(value) =>
                update("channels", { requireApproval: value })
              }
            />
          </div>
          <p className="small-note">
            默认关闭：你自己授权的渠道会直接按指令下载。家庭共用账号时再开启。
          </p>
          <div className="approval-overrides">
            <p className="small-note">
              按渠道单独设置，覆盖上面的全局开关：
            </p>
            {CHANNEL_PLATFORMS.map((platform) => {
              const overrides =
                draft.channels.approvalOverrides ?? {
                  telegram: "inherit",
                  wechat: "inherit",
                  qq: "inherit",
                  feishu: "inherit",
                };
              return (
                <label className="approval-override" key={platform}>
                  <span>{CHANNEL_LABELS[platform]}</span>
                  <select
                    aria-label={`${CHANNEL_LABELS[platform]}下载审批`}
                    value={overrides[platform]}
                    onChange={(event) =>
                      update("channels", {
                        approvalOverrides: {
                          ...overrides,
                          [platform]: event.target.value as ApprovalOverride,
                        },
                      })
                    }
                  >
                    <option value="inherit">跟随全局</option>
                    <option value="require">需批准</option>
                    <option value="skip">免批准</option>
                  </select>
                </label>
              );
            })}
          </div>
        </div>
        <div className="channel-card">
          <div className="source-heading">
            <span className="service-icon blue">
              <SendIcon />
            </span>
            <div>
              <h3>Telegram Bot</h3>
              <p>使用 Bot API 接收消息与回复。</p>
            </div>
            <Toggle
              label="启用 Telegram Bot"
              checked={draft.channels.telegram.enabled}
              onChange={(value) =>
                update("channels", {
                  telegram: { ...draft.channels.telegram, enabled: value },
                })
              }
            />
          </div>
          {field(
            "Bot Token",
            draft.channels.telegram.token,
            (value) =>
              update("channels", {
                telegram: { ...draft.channels.telegram, token: value },
              }),
            {
              secret: "channels.telegram.token",
              placeholder: "从 BotFather 获取的 Bot Token",
            },
          )}
          {field(
            "允许使用的 Chat ID",
            draft.channels.telegram.allowedChatIds.join(", "),
            (value) =>
              update("channels", {
                telegram: {
                  ...draft.channels.telegram,
                  allowedChatIds: value
                    .split(/[,，\n]/)
                    .map((item) => item.trim())
                    .filter(Boolean),
                },
              }),
            {
              placeholder: "123456789, -1001234567890",
              help: "仅允许列表中的用户或群组访问，请填写后再启用。",
            },
          )}
          {field(
            "渠道专用模型",
            draft.channels.telegram.model,
            (value) =>
              update("channels", {
                telegram: { ...draft.channels.telegram, model: value },
              }),
            { placeholder: "留空使用全局模型" },
          )}
          {testButton("telegram")}
        </div>
        <div className="channel-card">
          <div className="source-heading">
            <span className="service-icon green">
              <Cable size={20} />
            </span>
            <div>
              <h3>微信 / QQ / 飞书</h3>
              <p>通过 AstrBot 适配插件连接你常用的聊天工具</p>
            </div>
            <Toggle
              label="启用签名消息桥接"
              checked={draft.channels.bridge.enabled}
              onChange={(value) =>
                update("channels", {
                  bridge: { ...draft.channels.bridge, enabled: value },
                })
              }
            />
          </div>
          <div className="info-banner subtle">
            <CircleAlert size={18} />
            <p>
              将下方插件安装到
              AstrBot，并在其中连接聊天账号。两边填写相同的桥接密钥，
              再授权允许使用的会话。账号登录与平台权限由 AstrBot
              的对应适配器处理。
            </p>
          </div>
          {field(
            "桥接签名密钥",
            draft.channels.bridge.secret,
            (value) =>
              update("channels", {
                bridge: { ...draft.channels.bridge, secret: value },
              }),
            {
              secret: "channels.bridge.secret",
              placeholder: "输入与桥接端一致的高强度密钥",
            },
          )}
          {field(
            "渠道专用模型",
            draft.channels.bridge.model,
            (value) =>
              update("channels", {
                bridge: { ...draft.channels.bridge, model: value },
              }),
            { placeholder: "留空使用全局模型" },
          )}
          <a
            className="button secondary"
            href="/integrations/astrbot_mori-0.2.0.zip"
            download
          >
            <Download size={16} />
            下载 AstrBot 适配插件
          </a>
          <details className="endpoint-note">
            <summary>高级：自定义消息桥接</summary>
            <code>/api/channels/bridge/:platform</code>
            <small>
              platform 为 wechat、qq 或 feishu。签名协议见项目
              docs/CHANNELS.md。
            </small>
          </details>
        </div>
      </>
    );
  }
  function resultCards(items: SearchResult[], query?: string) {
    return (
      <div className="result-list">
        {items.map((result) => (
          <article key={result.id} className="result-card">
            <div className={`result-art ${result.kind}`} aria-hidden="true">
              {result.kind === "magnet" ? (
                <Zap size={25} />
              ) : result.kind === "share" ? (
                <Layers3 size={25} />
              ) : (
                <Film size={25} />
              )}
            </div>
            <div className="result-content">
              <div className="result-meta">
                <span className="badge neutral">{kindLabels[result.kind]}</span>
                {(result.shareRef || result.kind === "cloud") && <span>{cloudProviderName(result.provider)}</span>}
                <span>{result.source}</span>
                {result.size && <span>{result.size}</span>}
              </div>
              <h3>{result.title}</h3>
              <p className="resource-url">{result.url}</p>
              {result.kind === "share" && (
                <p className="request-help">
                  {result.shareRef ? `可浏览的${cloudProviderName(result.provider)}分享入口，不是媒体文件。先确认作品，再在选片请求中选择来源与文件。` : "网盘分享页面，不是媒体文件；当前分享尚未接入浏览能力，不能直接解析下载。"}
                </p>
              )}
              {result.provider === "alipan" && !secrets["sources.alipanRefreshToken"] && <ShareAccountGuide onConfigure={() => settings("sources")} />}
              <div className="result-actions">
                <button
                  className="text-button"
                  type="button"
                  disabled={(result.kind === "share" || result.kind === "cloud") && !!requestBusy}
                  onClick={() => {
                    if (result.kind === "share" || result.kind === "cloud") {
                      if (query?.trim()) void startRequest(query.trim(), "download");
                      else { setMode("chat"); setMessage("下载 "); navigate("assistant"); composerRef.current?.focus(); }
                    } else openTask(result);
                  }}
                >
                  <Plus size={15} />
                  {result.kind === "share" || result.kind === "cloud" ? query?.trim() ? "先确认作品" : "到助手确认作品" : "确认作品后下载"}
                </button>
                {/^https?:\/\//i.test(result.url) && (
                  <a
                    className="text-button muted"
                    href={result.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看来源
                    <ExternalLink size={13} />
                  </a>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
    );
  }
  function composer(home = false) {
    return (
      <form
        className={`composer ${home ? "home-composer" : ""}`}
        onSubmit={runComposer}
      >
        <label
          className="sr-only"
          htmlFor={home ? "home-message" : "assistant-message"}
        >
          {mode === "chat" ? "发送给 Mnemo 的消息" : "搜索资源名称"}
        </label>
        <textarea
          id={home ? "home-message" : "assistant-message"}
          ref={composerRef}
          rows={home ? 2 : 1}
          value={message}
          maxLength={4000}
          disabled={thinking}
          placeholder={
            mode === "chat"
              ? "告诉 Mnemo 你想看什么，剩下的交给我…"
              : "输入电影、剧集名称，搜索已配置的资源…"
          }
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="composer-footer">
          <div className="composer-modes" aria-label="输入模式">
            <button
              type="button"
              className={mode === "chat" ? "selected" : ""}
              aria-pressed={mode === "chat"}
              onClick={() => setMode("chat")}
            >
              <Sparkles size={14} />
              智能助手
            </button>
            <button
              type="button"
              className={mode === "search" ? "selected" : ""}
              aria-pressed={mode === "search"}
              onClick={() => setMode("search")}
            >
              <Search size={14} />
              资源搜索
            </button>
          </div>
          <div className="composer-send">
            <span className="keyboard-hint">Enter 发送</span>
            <button
              type="submit"
              className="send-button"
              aria-label={mode === "chat" ? "发送消息" : "搜索资源"}
              disabled={!message.trim() || thinking}
            >
              {thinking ? <Spinner /> : <ArrowUp size={21} />}
            </button>
          </div>
        </div>
        <TitleActionHint action={config?.defaultTitleAction || "search"} mode={mode} />
      </form>
    );
  }
  function taskRow(task: DownloadTask, compact = false) {
    const inProgress =
      task.status === "downloading" || task.status === "scraping";
    const canPause = ["queued", "downloading"].includes(task.status);
    const canRetry = ["failed", "needs_attention"].includes(task.status);
    return (
      <article className={`task-row ${compact ? "compact" : ""}`} key={task.id}>
        <div
          className={`task-art ${task.media.type === "tv" ? "tv" : ""}`}
          aria-hidden="true"
        >
          {task.media.type === "tv" ? <Tv size={22} /> : <Film size={22} />}
        </div>
        <div className="task-content">
          <div className="task-title">
            <h3>{task.title}</h3>
            <span
              className={`badge ${task.status === "completed" ? "positive" : ["failed", "needs_attention"].includes(task.status) ? "warning" : "neutral"}`}
            >
              {inProgress && <span className="live-dot" />}
              {taskLabels[task.status]}
            </span>
          </div>
          <div className="task-meta">
            <span>{kindLabels[task.kind]}</span>
            <span>
              {bytes(task.bytes)}
              {task.total > 0 ? ` / ${bytes(task.total)}` : ""}
            </span>
            {!compact && <span>{relativeTime(task.createdAt)}</span>}
          </div>
          {!["cancelled", "failed", "needs_attention"].includes(
            task.status,
          ) && (
            <div
              className={`progress-line ${task.status === "completed" ? "done" : ""}`}
              role="progressbar"
              aria-label={`${task.title} 进度`}
              aria-valuenow={Math.min(100, Math.max(0, task.progress))}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span
                style={{
                  width: `${Math.min(100, Math.max(0, task.progress))}%`,
                }}
              />
            </div>
          )}
          {task.error && (
            <p className="task-error">
              <CircleAlert size={12} />
              {task.error}
            </p>
          )}
          {task.path && task.status === "completed" && !compact && (
            <p className="task-path">
              <FolderOpen size={12} />
              {task.path}
            </p>
          )}
          {task.status === "completed" && (
            <div className="task-library">
              <div className="task-library-heading">
                <span
                  className={`badge ${task.library?.status === "verified" ? "positive" : ["failed", "unsupported"].includes(task.library?.status || "") ? "warning" : "neutral"}`}
                >
                  {task.library?.status === "pending" && <Spinner />}
                  {task.library
                    ? libraryLabels[task.library.status]
                    : config?.library.serverUrl
                      ? "媒体库待检查"
                      : "媒体库未配置"}
                </span>
                {!config?.library.serverUrl ? (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => settings("library")}
                  >
                    前往设置
                    <ArrowUpRight size={13} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`${task.library?.status === "pending" ? "重新检查媒体库" : "检查媒体库"} ${task.title}`}
                    disabled={!!actionBusy}
                    onClick={() => void checkLibrary(task)}
                  >
                    {actionBusy === task.id ? (
                      <Spinner />
                    ) : (
                      <RefreshCw size={13} />
                    )}
                    {task.library?.status === "pending"
                      ? "重新检查"
                      : "检查媒体库"}
                  </button>
                )}
                {config?.library.serverUrl &&
                  task.library?.status === "not_configured" && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => settings("library")}
                    >
                      核对媒体库设置
                      <ArrowUpRight size={13} />
                    </button>
                  )}
              </div>
              {task.library?.message && <p>{task.library.message}</p>}
              {task.library?.serverPath && !compact && (
                <p>服务器路径：{task.library.serverPath}</p>
              )}
              {task.library && !compact && (
                <p>
                  最近检查：{relativeTime(task.library.checkedAt)}
                  {task.library.playable === true && " · 服务端标记可播放"}
                  {task.library.playable === false && " · 服务端未确认可播放"}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="task-controls">
          {canPause && (
            <button
              className="icon-button"
              title="暂停"
              aria-label={`暂停 ${task.title}`}
              disabled={!!actionBusy}
              onClick={() => void taskAction(task.id, "pause")}
            >
              <Pause size={16} />
            </button>
          )}
          {task.status === "paused" && (
            <button
              className="icon-button"
              title="继续下载"
              aria-label={`继续下载 ${task.title}`}
              disabled={!!actionBusy}
              onClick={() => void taskAction(task.id, "resume")}
            >
              <Play size={16} />
            </button>
          )}
          {canRetry && (
            <button
              className="icon-button"
              title="重试"
              aria-label={`重试 ${task.title}`}
              disabled={!!actionBusy}
              onClick={() => void taskAction(task.id, "retry")}
            >
              <RefreshCw size={16} />
            </button>
          )}
          {!["completed", "cancelled"].includes(task.status) && (
            <button
              className="icon-button"
              title="取消任务"
              aria-label={`取消 ${task.title}`}
              disabled={!!actionBusy}
              onClick={() => void taskAction(task.id, "cancel")}
            >
              <X size={16} />
            </button>
          )}
          {task.status === "completed" && task.path && (
            <button
              className="icon-button"
              title="播放"
              aria-label={`播放 ${task.title}`}
              onClick={() => setPlayback(task)}
            >
              <Play size={16} />
            </button>
          )}
          {task.status === "completed" && (
            <CheckCircle2 size={18} className="green-text" />
          )}
        </div>
      </article>
    );
  }

  if (!session)
    return (
      <div className="loading-page">
        <Logo />
        <div>
          {error ? (
            <>
              <CircleAlert size={22} />
              <p role="alert">{error}</p>
              <button
                className="button secondary"
                onClick={() => void loadSession()}
              >
                重新连接
                <RefreshCw size={15} />
              </button>
            </>
          ) : (
            <>
              <Spinner />
              <p>正在打开你的影视空间…</p>
            </>
          )}
        </div>
      </div>
    );
  if (!session.authenticated)
    return (
      <Auth
        needsSetup={session.needsSetup}
        onSuccess={() => void loadSession()}
      />
    );
  if (!config || !draft)
    return (
      <div className="loading-page">
        <Logo />
        <div>
          {error ? (
            <>
              <CircleAlert size={22} />
              <p role="alert">{error}</p>
              <button
                className="button secondary"
                onClick={() => {
                  setSession(null);
                  void loadSession();
                }}
              >
                重新加载
                <RefreshCw size={15} />
              </button>
            </>
          ) : (
            <>
              <Spinner />
              <p>正在读取你的设置…</p>
            </>
          )}
        </div>
      </div>
    );

  const wizardSteps: {
    group: SettingGroup;
    label: string;
    title: string;
    description: string;
  }[] = [
    {
      group: "model",
      label: "连接模型",
      title: "认识你的私人影视助手。",
      description: "带上自己的模型密钥，让每一次发现更轻松。也可以稍后设置。",
    },
    {
      group: "download",
      label: "收藏位置",
      title: "好故事，总要有个家。",
      description: "选择服务器或已挂载的 NAS 目录，作为影视文件的存放位置。",
    },
    {
      group: "library",
      label: "媒体偏好",
      title: "配合你的观影习惯。",
      description: "告诉 Mnemo 你使用哪款媒体库，我们会按对应预设整理新收藏。",
    },
    {
      group: "sources",
      label: "资源入口",
      title: "让发现，从你的资源开始。",
      description: "连接自托管资源服务；尚未准备好的服务，都可以稍后添加。",
    },
    {
      group: "channels",
      label: "随处可达",
      title: "在熟悉的地方，遇见 Mnemo。",
      description: "消息渠道是可选的，直接使用网页，也能拥有完整的基础体验。",
    },
  ];
  if (wizard)
    return (
      <div className="wizard-page">
        <header className="wizard-top">
          <Logo />
          <span className="wizard-top-note">
            <ShieldCheck size={15} />
            密钥仅保存于服务端
          </span>
        </header>
        <div className="wizard-layout">
          <aside className="wizard-aside">
            <span className="eyebrow">LET'S MAKE IT YOURS</span>
            <h1>
              五个小步骤，
              <br />
              一个你的
              <br />
              <em>影视世界。</em>
            </h1>
            <p>
              不用一次设置完美。
              <br />
              所有选项都能在设置中随时调整。
            </p>
            <ol className="wizard-steps">
              {wizardSteps.map((item, index) => (
                <li
                  key={item.group}
                  className={
                    index === step ? "current" : index < step ? "done" : ""
                  }
                >
                  <button type="button" onClick={() => setStep(index)}>
                    <span>
                      {index < step ? <Check size={15} /> : `0${index + 1}`}
                    </span>
                    <div>
                      <strong>{item.label}</strong>
                      <small>
                        {index === 0
                          ? "BYOK · 也可稍后设置"
                          : index === 1
                            ? "本地磁盘或 NAS 挂载"
                            : index === 2
                              ? "选择常用媒体库"
                              : index === 3
                                ? "按需添加资源服务"
                                : "可选 · 聊天工具接入"}
                      </small>
                    </div>
                    {index === step && <ArrowRight size={15} />}
                  </button>
                </li>
              ))}
            </ol>
            <div className="wizard-leaf">
              <Leaf size={43} strokeWidth={1} />
              <span>慢慢来，好故事不赶时间。</span>
            </div>
          </aside>
          <main className="wizard-main">
            <div className="wizard-count">
              开始之前 <span>{String(step + 1).padStart(2, "0")} / 05</span>
            </div>
            <h2>{wizardSteps[step].title}</h2>
            <p className="wizard-description">
              {wizardSteps[step].description}
            </p>
            <fieldset className="wizard-form" disabled={saving || !!testing}>
              {formSection(wizardSteps[step].group)}
            </fieldset>
            {error && (
              <div className="alert error" role="alert">
                <CircleAlert size={17} />
                {error}
              </div>
            )}
            <div className="wizard-actions">
              <button
                type="button"
                className="text-button muted"
                onClick={() => (step ? setStep(step - 1) : void finishWizard())}
                disabled={saving || !!testing}
              >
                {step ? (
                  <>
                    <ChevronLeft size={15} />
                    上一步
                  </>
                ) : (
                  "先使用基础功能"
                )}
              </button>
              <div>
                {step < 4 && (
                  <button
                    type="button"
                    className="text-button muted"
                    onClick={() => setStep(step + 1)}
                  >
                    稍后设置
                  </button>
                )}
                <button
                  type="button"
                  className="button primary"
                  disabled={
                    saving ||
                    !!testing ||
                    (step === 1 && !draft.download.directory.trim())
                  }
                  onClick={() =>
                    step === 4
                      ? void finishWizard()
                      : void save(false, true).then((ok) => {
                          if (ok) setStep(step + 1);
                        })
                  }
                >
                  {saving ? (
                    <Spinner />
                  ) : (
                    <>
                      {step === 4 ? "开启我的影视空间" : "保存并继续"}
                      <ArrowRight size={17} />
                    </>
                  )}
                </button>
              </div>
            </div>
          </main>
        </div>
      </div>
    );

  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="sidebar-backdrop"
          aria-label="关闭导航"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <a
          href="#overview"
          className="brand-link"
          aria-label="Mnemo 我的空间"
          onClick={() => navigate("overview")}
        >
          <Logo />
        </a>
        <span className="sidebar-caption">你的私人影视世界</span>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={18} strokeWidth={1.7} />
              <span>{item.label}</span>
              {item.id === "assistant" && <span className="nav-ai">AI</span>}
              {item.id === "downloads" && active.length > 0 && (
                <span className="nav-count">{active.length}</span>
              )}
              {item.id === "notifications" && notificationAttention > 0 && <span className="nav-count">{notificationAttention}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-garden">
            <div className="garden-illustration" aria-hidden="true">
              <Leaf size={29} strokeWidth={1} />
              <span>✦</span>
            </div>
            <strong>少一点打理，多一点好戏。</strong>
            <p>
              搜索、订阅、下载、整理。
              <br />
              让收藏，自然而然。
            </p>
          </div>
          <button
            type="button"
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            aria-current={page === "settings" ? "page" : undefined}
            onClick={() => navigate("settings")}
          >
            <Settings2 size={18} strokeWidth={1.7} />
            <span>设置中心</span>
          </button>
          <div className="sidebar-account">
            <span className="account-avatar">L</span>
            <div>
              <strong>我的 Mnemo</strong>
              <small>
                <span className="tiny-dot" />
                自主托管空间
              </small>
            </div>
            <button
              type="button"
              className="sidebar-logout"
              title="退出登录"
              aria-label="退出登录"
              onClick={() => void logout()}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={21} />
            </button>
            <span className="breadcrumb">
              我的 Mnemo <ChevronRight size={13} />
              <strong>
                {page === "settings"
                  ? "设置中心"
                  : navigation.find((item) => item.id === page)?.label}
              </strong>
            </span>
          </div>
          <div className="topbar-right">
            <span className="private-label">
              <ShieldCheck size={14} />
              私人收藏，自在掌控
            </span>
            <button type="button" className={`icon-button notice-button ${notificationAttention ? "has-notice" : ""}`} aria-label="打开通知中心" title={notificationAttention ? `${notificationAttention} 条通知待处理` : "通知中心"} onClick={() => navigate("notifications")}><Bell size={18} /></button>
            <button
              type="button"
              className={`icon-button notice-button ${warnings.length ? "has-notice" : ""}`}
              aria-label="查看服务提醒"
              aria-expanded={showNotices}
              onClick={() => setShowNotices(!showNotices)}
            >
              <CircleAlert size={18} />
            </button>
            <button
              type="button"
              className="top-avatar"
              aria-label="打开设置"
              onClick={() => navigate("settings")}
            >
              L
            </button>
          </div>
          {showNotices && (
            <div className="notice-popover">
              <strong>服务提醒</strong>
              {warnings.length ? (
                warnings.map((warning, index) => (
                  <p key={index}>
                    <CircleAlert size={14} />
                    {warning}
                  </p>
                ))
              ) : (
                <p>
                  <CheckCircle2 size={14} />
                  当前没有服务提醒。连接状态请以设置中的实际测试为准。
                </p>
              )}
              <button
                type="button"
                className="text-button"
                onClick={() => settings("sources")}
              >
                管理资源连接
                <ArrowRight size={14} />
              </button>
            </div>
          )}
        </header>
        {error && (
          <div className="global-alert alert error" role="alert">
            <CircleAlert size={18} />
            <span>{error}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭错误提示"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <main className={`main-content page-${page}`} id="main-content">
          {page === "overview" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">YOUR PERSONAL CINEMA</span>
                  <h1>
                    我的空间<span className="heading-dot">.</span>
                  </h1>
                  <p>把时间留给好故事，把收藏交给 Mnemo。</p>
                </div>
                <span className="date-label">
                  {new Date().toLocaleDateString("zh-CN", {
                    month: "long",
                    day: "numeric",
                    weekday: "long",
                  })}
                </span>
              </div>
              <section className="welcome-card">
                <div className="welcome-ambient" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="welcome-heading">
                  <span className="assistant-orb">
                    <Sparkles size={23} strokeWidth={1.4} />
                  </span>
                  <div>
                    <span className="welcome-eyebrow">
                      MEET YOUR MEDIA COMPANION
                    </span>
                    <h2>下一部好故事，从一句话开始。</h2>
                    <p>想看什么？找资源、追新剧，或整理你的下一份收藏。</p>
                  </div>
                  <span className="welcome-flower" aria-hidden="true">
                    ✳
                  </span>
                </div>
                {composer(true)}
                <div className="suggestions">
                  <span>试着说</span>
                  <button type="button" onClick={() => suggest("搜索 ")}>
                    <Film size={13} />
                    帮我找部电影
                  </button>
                  <button type="button" onClick={() => suggest("订阅 ")}>
                    <Rss size={13} />
                    订阅一部新剧
                  </button>
                  <button type="button" onClick={() => navigate("downloads")}>
                    <Download size={13} />
                    看看下载进度
                  </button>
                </div>
              </section>
              <section className="stats-grid" aria-label="收藏概览">
                <div className="stat-card">
                  <span className="stat-icon sage">
                    <ArrowDownToLine size={20} />
                  </span>
                  <div>
                    <span>正在进行</span>
                    <strong>
                      {dashboard ? dashboard.stats.active : "—"}
                      <small>个任务</small>
                    </strong>
                  </div>
                  <span className="stat-foot">下载与整理</span>
                </div>
                <div className="stat-card">
                  <span className="stat-icon sand">
                    <Rss size={20} />
                  </span>
                  <div>
                    <span>我的订阅</span>
                    <strong>
                      {dashboard ? dashboard.stats.subscriptions : "—"}
                      <small>部作品</small>
                    </strong>
                  </div>
                  <span className="stat-foot">把期待交给时间</span>
                </div>
                <div className="stat-card">
                  <span className="stat-icon lavender">
                    <Clapperboard size={20} />
                  </span>
                  <div>
                    <span>已完成收藏</span>
                    <strong>
                      {dashboard ? dashboard.stats.completed : "—"}
                      <small>个任务</small>
                    </strong>
                  </div>
                  <span className="stat-foot">好故事，慢慢积攒</span>
                </div>
              </section>
              <div className="overview-grid">
                <section className="panel activity-panel">
                  <div className="panel-header">
                    <div>
                      <span className="eyebrow">IN THE MAKING</span>
                      <h2>最近的收藏动态</h2>
                    </div>
                    <button
                      type="button"
                      className="text-button muted"
                      onClick={() => navigate("downloads")}
                    >
                      全部任务
                      <ArrowUpRight size={15} />
                    </button>
                  </div>
                  {!dashboard ? (
                    <div className="loading-inline">
                      <Spinner />
                      正在读取任务…
                    </div>
                  ) : tasks.length ? (
                    <div>
                      {tasks.slice(0, 4).map((task) => taskRow(task, true))}
                    </div>
                  ) : (
                    <EmptyState
                      icon={FolderOpen}
                      title="这里，等着你的第一份收藏。"
                      action={
                        <button
                          type="button"
                          className="button secondary small"
                          onClick={() => openTask()}
                        >
                          <Plus size={15} />
                          添加下载任务
                        </button>
                      }
                    >
                      找到喜欢的作品，贴上下载链接。
                      <br />
                      接下来的进度会出现在这里。
                    </EmptyState>
                  )}
                </section>
                <section className="panel workflow-panel">
                  <div className="panel-header">
                    <div>
                      <span className="eyebrow">YOUR OWN LITTLE SYSTEM</span>
                      <h2>收藏的旅程</h2>
                    </div>
                    <Leaf size={18} className="green-text" />
                  </div>
                  <div className="journey">
                    <button type="button" onClick={() => settings("sources")}>
                      <span className="journey-icon">
                        <Search size={17} />
                      </span>
                      <div>
                        <strong>发现资源</strong>
                        <small>连接你熟悉的搜索入口</small>
                      </div>
                      <span
                        className={`journey-status ${config.sources.pansouUrl || config.sources.openlistUrl ? "configured" : ""}`}
                      >
                        {config.sources.pansouUrl || config.sources.openlistUrl
                          ? "已配置"
                          : "待配置"}
                      </span>
                    </button>
                    <button type="button" onClick={() => settings("download")}>
                      <span className="journey-icon">
                        <Download size={17} />
                      </span>
                      <div>
                        <strong>安心下载</strong>
                        <small>
                          {config.download.directory || "选择本地或 NAS 目录"}
                        </small>
                      </div>
                      <span
                        className={`journey-status ${config.download.directory ? "configured" : ""}`}
                      >
                        {config.download.directory ? "已设置" : "待设置"}
                      </span>
                    </button>
                    <button type="button" onClick={() => settings("library")}>
                      <span className="journey-icon">
                        <Clapperboard size={17} />
                      </span>
                      <div>
                        <strong>整理入库</strong>
                        <small>通用 NFO 与媒体文件</small>
                      </div>
                      <span className="journey-status configured">
                        {profile?.name || "待选择"}
                      </span>
                    </button>
                  </div>
                  <div className="journey-note">
                    <ShieldCheck size={14} />
                    <span>已配置不代表连接正常，可在设置中测试。</span>
                  </div>
                </section>
              </div>
              <div className="quiet-footer">
                <Leaf size={14} />
                收藏不是填满硬盘，是为喜欢的故事留个位置。
                <span>MNEMO / MADE FOR YOUR STORIES</span>
              </div>
            </>
          )}
          {page === "assistant" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">A CONVERSATION AWAY</span>
                  <h1>
                    Mnemo 助手<span className="heading-dot">.</span>
                  </h1>
                  <p>说说你想看什么，我们从这里开始。</p>
                </div>
                <span className="badge neutral">
                  <Sparkles size={13} />
                  {config.model.baseUrl && config.model.model
                    ? config.model.model
                    : "基础指令模式"}
                </span>
              </div>
              {(requests.length > 0 || requestLoadError) && (
                <section
                  className="request-inbox"
                  aria-label="待确认的选片请求"
                >
                  <div className="request-inbox-header">
                    <div>
                      <span className="eyebrow">PICK THE RIGHT STORY</span>
                      <h2>选片与确认</h2>
                      <p>
                        最近的待确认请求保存在服务器，刷新页面后可继续处理。
                      </p>
                    </div>
                    <span className="badge neutral">
                      {
                        requests.filter(
                          (request) => request.stage !== "completed",
                        ).length
                      }{" "}
                      条待确认
                    </span>
                  </div>
                  {requestLoadError && (
                    <div className="alert error" role="alert">
                      <CircleAlert size={15} />
                      <span>{requestLoadError}</span>
                      <button
                        type="button"
                        className="text-button"
                        disabled={!!requestBusy}
                        onClick={() => void reloadRequest()}
                      >
                        重新读取
                      </button>
                    </div>
                  )}
                  {requests.map((request) => (
                    <RequestCard
                      key={`${request.id}:${request.revision}`}
                      request={request}
                      busy={!!requestBusy}
                      problem={requestErrors[request.id]}
                      needsRefresh={!!requestRecovery[request.id]}
                      onSelect={(selection) =>
                        void selectRequest(request, selection)
                      }
                      onRefresh={() => void reloadRequest(request.id)}
                      onNavigate={navigate}
                      alipanCredentialsSaved={!!secrets["sources.alipanRefreshToken"]}
                      onConfigureSources={() => settings("sources")}
                      onRetrySearch={() => void startRequest(request.query, request.intent)}
                      onPlayStream={setCmsPlayback}
                    />
                  ))}
                </section>
              )}
              {audit.length > 0 && (
                <details className="approval-history">
                  <summary>
                    <Clock3 size={15} />
                    操作记录（最近 {audit.length} 条）
                  </summary>
                  <ul>
                    {audit.map((item) => (
                      <li key={item.id}>
                        <span
                          className={`badge ${
                            item.type === "approval"
                              ? item.outcome === "approved"
                                ? "positive"
                                : "warning"
                              : "neutral"
                          }`}
                        >
                          {item.type === "approval"
                            ? item.outcome === "approved"
                              ? "已批准"
                              : "已拒绝"
                            : ORIGIN_LABELS[item.origin ?? "web"]}
                        </span>
                        <strong>{item.title}</strong>
                        <span className="approval-history-owner">{item.owner}</span>
                        <time dateTime={item.at}>
                          {new Date(item.at).toLocaleString("zh-CN")}
                        </time>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="assistant-layout">
                <section className="conversation-panel">
                  {mode === "search" ? (
                    <div className="search-view">
                      <div className="section-label">
                        <h2>
                          {searchQuery
                            ? `“${searchQuery}”的资源`
                            : "发现你的下一部收藏"}
                        </h2>
                        {results && (
                          <span className="badge neutral">
                            {results.length} 条结果
                          </span>
                        )}
                      </div>
                      <SearchDiagnosticNotice diagnostics={searchDiagnostics} onSettings={() => settings("sources")} onRetry={searchQuery ? () => void searchResources(searchQuery) : undefined} retryBusy={thinking} compact={false} />
                      {searchError && <p className="search-transport-error" role="alert">{searchError}</p>}
                      {thinking ? (
                        <div className="loading-inline">
                          <Spinner />
                          正在搜索已配置的资源…
                        </div>
                      ) : results?.length ? (
                        <>
                          {resultCards(results, searchQuery)}
                          <p className="small-note">
                            网盘分享与频道消息可能需要人工处理。创建任务后，请以下载中心的实际状态为准。
                          </p>
                        </>
                      ) : (
                        <EmptyState
                          icon={Search}
                          title={
                            results === null
                              ? "一个名字，一次新的发现。"
                              : searchDiagnostics?.status === "not_configured"
                                ? "先连接一个片名搜索入口"
                                : searchDiagnostics?.status === "failed"
                                  ? "这次搜索没有完成"
                                  : searchDiagnostics?.status === "partial"
                                    ? "部分来源尚未完成，暂不能确定结果"
                                    : "已搜索的来源中暂未找到匹配资源"
                          }
                        >
                          {results === null
                            ? "在下方输入电影或剧集名称，搜索你已配置的资源入口。"
                            : searchDiagnostics?.status === "complete"
                              ? "本次来源已完成查询，可以换一个名称或稍后手动再搜一次。"
                              : "请查看上方来源诊断；调整设置后可手动重新搜索，不会自动重发。"}
                        </EmptyState>
                      )}
                    </div>
                  ) : (
                    <>
                      {!conversation.length && (
                        <div className="chat-welcome">
                          <div className="large-orb">
                            <Sparkles size={32} strokeWidth={1.3} />
                          </div>
                          <span className="eyebrow">
                            LESS MANAGING, MORE WATCHING
                          </span>
                          <h2>你好，我是 Mnemo。</h2>
                          <p>
                            找一部电影，守候一部新剧，
                            <br />
                            或是把一个下载链接交给我。
                          </p>
                          <div className="prompt-grid">
                            <button
                              type="button"
                              onClick={() => suggest("搜索 ")}
                            >
                              <Search size={19} />
                              <strong>找一部电影</strong>
                              <span>
                                搜索已连接的资源
                                <ArrowUpRight size={14} />
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => suggest("订阅 ")}
                            >
                              <Rss size={19} />
                              <strong>追一部新剧</strong>
                              <span>
                                订阅你想看的作品
                                <ArrowUpRight size={14} />
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => suggest("查看下载任务")}
                            >
                              <Download size={19} />
                              <strong>看下载进度</strong>
                              <span>
                                查看当前任务状态
                                <ArrowUpRight size={14} />
                              </span>
                            </button>
                          </div>
                        </div>
                      )}
                      {conversation.map((entry, index) => (
                        <article
                          className={`chat-message ${entry.role}`}
                          key={index}
                        >
                          <span className="chat-avatar">
                            {entry.role === "assistant" ? (
                              <Sparkles size={18} />
                            ) : (
                              "M"
                            )}
                          </span>
                          <div>
                            <span className="chat-name">
                              {entry.role === "assistant" ? "Mnemo" : "你"}
                            </span>
                            <p>{entry.text}</p>
                            <SearchDiagnosticNotice diagnostics={entry.searchDiagnostics} onSettings={() => settings("sources")} />
                            {entry.results?.length
                              ? resultCards(entry.results)
                              : null}
                          </div>
                        </article>
                      ))}
                      {thinking && (
                        <div className="chat-message assistant">
                          <span className="chat-avatar">
                            <Sparkles size={18} />
                          </span>
                          <div className="thinking">
                            <span />
                            <span />
                            <span />
                            <small>Mnemo 正在处理…</small>
                          </div>
                        </div>
                      )}
                      <div ref={chatEndRef} />
                    </>
                  )}
                </section>
                <div className="assistant-composer">
                  {composer()}
                  <p>
                    <ShieldCheck size={12} />
                    仅操作你配置的资源与目录。请确认资源内容和使用权限。
                  </p>
                </div>
              </div>
            </>
          )}
          {page === "downloads" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">ON THE WAY TO YOUR LIBRARY</span>
                  <h1>
                    下载中心<span className="heading-dot">.</span>
                  </h1>
                  <p>每一份期待，都有迹可循。</p>
                </div>
                <button
                  type="button"
                  className="button primary"
                  onClick={() => openTask()}
                >
                  <Plus size={17} />
                  新建任务
                </button>
              </div>
              <div className="download-summary">
                <span>
                  <span className="live-dot" />
                  {active.length} 个任务进行中
                </span>
                <span>
                  <HardDrive size={15} />
                  {config.download.directory || "尚未设置下载目录"}
                </span>
                <button
                  type="button"
                  className="text-button muted"
                  onClick={() => settings("download")}
                >
                  下载设置
                  <ArrowUpRight size={14} />
                </button>
              </div>
              <section className="panel task-panel">
                <div
                  className="task-tabs"
                  role="group"
                  aria-label="筛选下载任务"
                >
                  {[
                    { id: "all", label: "全部", count: tasks.length },
                    { id: "active", label: "进行中", count: active.length },
                    {
                      id: "completed",
                      label: "已完成",
                      count: completed.length,
                    },
                    {
                      id: "attention",
                      label: "需关注",
                      count: tasks.filter((task) =>
                        ["failed", "needs_attention", "paused"].includes(
                          task.status,
                        ),
                      ).length,
                    },
                  ].map((filter) => (
                    <button
                      key={filter.id}
                      type="button"
                      aria-pressed={taskFilter === filter.id}
                      className={taskFilter === filter.id ? "active" : ""}
                      onClick={() => setTaskFilter(filter.id)}
                    >
                      {filter.label}
                      <span>{filter.count}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    className="icon-button refresh-tasks"
                    aria-label="刷新任务"
                    onClick={() => void refresh()}
                  >
                    <RefreshCw size={16} />
                  </button>
                </div>
                {(() => {
                  const filtered = tasks.filter(
                    (task) =>
                      taskFilter === "all" ||
                      (taskFilter === "active" &&
                        ["queued", "downloading", "scraping"].includes(
                          task.status,
                        )) ||
                      (taskFilter === "completed" &&
                        task.status === "completed") ||
                      (taskFilter === "attention" &&
                        ["failed", "needs_attention", "paused"].includes(
                          task.status,
                        )),
                  );
                  return filtered.length ? (
                    filtered.map((task) => taskRow(task))
                  ) : (
                    <EmptyState
                      icon={ArrowDownToLine}
                      title={
                        taskFilter === "all"
                          ? "让好故事，慢慢抵达。"
                          : "这里暂时没有任务。"
                      }
                      action={
                        taskFilter === "all" && (
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => openTask()}
                          >
                            <Plus size={16} />
                            添加第一个任务
                          </button>
                        )
                      }
                    >
                      {taskFilter === "all"
                        ? "添加可用的下载直链，或通过 Mnemo 助手搜索资源。"
                        : "任务的实际状态会自动更新，也可以手动刷新。"}
                    </EmptyState>
                  );
                })()}
              </section>
              <div className="download-help">
                <ShieldCheck size={18} />
                <div>
                  <strong>进度真实，收藏安心。</strong>
                  <p>
                    只有文件实际下载完成才会标记完成。分享链接或缺少适配器的资源会显示「需要处理」，不会伪装成已下载。
                  </p>
                </div>
              </div>
            </>
          )}
          {page === "subscriptions" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">SOMETHING TO LOOK FORWARD TO</span>
                  <h1>
                    追剧订阅<span className="heading-dot">.</span>
                  </h1>
                  <p>记下想看的，把等待交给 Mnemo。</p>
                </div>
                <button
                  type="button"
                  className="button primary"
                  onClick={() => {
                    setError("");
                    setNewSubscription(true);
                  }}
                >
                  <Plus size={17} />
                  添加订阅
                </button>
              </div>
              <div className="subscription-intro">
                <span className="service-icon sand">
                  <Rss size={22} />
                </span>
                <div>
                  <strong>守候每一份上新</strong>
                  <p>
                    作品订阅定时搜索已配置资源，云盘目录订阅持续检查指定目录及下级目录；开启自动下载后，匹配的新资源会加入任务队列。
                  </p>
                </div>
                <span className="badge neutral">
                  {subscriptions.filter((item) => item.enabled).length} 个启用中
                </span>
              </div>
              {subscriptions.length ? (
                <div className="subscriptions-grid">
                  {subscriptions.map((subscription) => (
                    <article
                      key={subscription.id}
                      className={`subscription-card ${!subscription.enabled ? "disabled" : ""}`}
                    >
                      <div className="subscription-card-top">
                        <div className="subscription-art">
                          <Tv size={27} strokeWidth={1.2} />
                          <span>TO BE CONTINUED</span>
                        </div>
                        <div>
                          <span
                            className={`badge ${subscription.enabled ? "positive" : "neutral"}`}
                          >
                            {subscription.enabled ? "持续关注" : "已暂停"}
                          </span>
                          <h2>{subscription.title}</h2>
                          <p>{subscription.query}</p>
                        </div>
                        <Toggle
                          label={`${subscription.enabled ? "暂停" : "启用"} ${subscription.title} 订阅`}
                          checked={subscription.enabled}
                          disabled={!!actionBusy}
                          onChange={(enabled) =>
                            void subscriptionAction(subscription.id, "PATCH", {
                              enabled,
                            })
                          }
                        />
                      </div>
                      <DirectorySubscriptionStatus subscription={subscription} checking={subscriptionCheckBusy === subscription.id} alipanCredentialsSaved={!!secrets["sources.alipanRefreshToken"]} onConfigureSources={() => settings("sources")} />
                      <div className="subscription-option">
                        <span>
                          <ArrowDownToLine size={15} />
                          发现资源时自动下载
                        </span>
                        <Toggle
                          label={`${subscription.title} 自动下载`}
                          checked={
                            !!subscription.media && subscription.autoDownload
                          }
                          disabled={!!actionBusy || !subscription.media}
                          onChange={(autoDownload) =>
                            void subscriptionAction(subscription.id, "PATCH", {
                              autoDownload,
                            })
                          }
                        />
                      </div>
                      {!subscription.media && (
                        <div className="legacy-subscription-note">
                          <CircleAlert size={15} />
                          <div>
                            <p>
                              此订阅尚未确认作品身份，自动下载已停用。确认作品与季数后，会开启该作品的自动追更，保留原订阅记录。
                            </p>
                            <button
                              type="button"
                              className="text-button"
                              disabled={!!actionBusy || !!requestBusy}
                              onClick={async () => {
                                setActionBusy(subscription.id);
                                try {
                                  await startRequest(
                                    subscription.query,
                                    "subscribe",
                                  );
                                } finally {
                                  setActionBusy("");
                                }
                              }}
                            >
                              确认作品
                              <ArrowRight size={13} />
                            </button>
                          </div>
                        </div>
                      )}
                      <SearchDiagnosticNotice diagnostics={subscription.searchDiagnostics} onSettings={() => settings("sources")} onRetry={() => void subscriptionAction(subscription.id, "POST", {}, "/check")} retryBusy={!!actionBusy || !!subscriptionCheckBusy || !subscription.enabled} retryLabel="手动检查来源" />
                      {subscription.lastError && (
                        <div className="alert warning">
                          <CircleAlert size={15} />
                          {subscription.lastError}
                        </div>
                      )}
                      {subscription.lastSummary && (
                        <p className="form-description">
                          {subscription.lastSummary}
                        </p>
                      )}
                      <div className="subscription-footer">
                        <span>
                          <Clock3 size={13} />
                          {relativeTime(subscription.lastCheckedAt)}
                        </span>
                        <button
                          type="button"
                          className="text-button"
                          disabled={!!actionBusy || !!subscriptionCheckBusy}
                          onClick={() =>
                            void subscriptionAction(
                              subscription.id,
                              "POST",
                              {},
                              "/check",
                            )
                          }
                        >
                          {subscriptionCheckBusy === subscription.id ? (
                            <Spinner />
                          ) : (
                            <RefreshCw size={14} />
                          )}
                          立即检查
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`删除 ${subscription.title} 订阅`}
                          disabled={!!actionBusy}
                          onClick={() => {
                            if (
                              window.confirm(
                                `删除「${subscription.title}」的订阅？已创建的下载任务不会被删除。`,
                              )
                            )
                              void subscriptionAction(
                                subscription.id,
                                "DELETE",
                              );
                          }}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <section className="panel subscription-empty">
                  <EmptyState
                    icon={Rss}
                    title="总有一部剧，值得等待。"
                    action={
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => {
                          setError("");
                          setNewSubscription(true);
                        }}
                      >
                        <Plus size={16} />
                        添加第一部订阅
                      </button>
                    }
                  >
                    写下剧名或搜索关键词。
                    <br />
                    资源更新时，就不用再反复寻找。
                  </EmptyState>
                </section>
              )}
              <p className="small-note">
                <CircleAlert size={14} />
                先确认作品与季数，再按身份匹配新资源。确认后开启自动追更；不确定或不匹配的资源不会被当作已确认作品自动下载。
              </p>
            </>
          )}
          {page === "library" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">STORIES THAT STAY</span>
                  <h1>
                    媒体库<span className="heading-dot">.</span>
                  </h1>
                  <p>为喜欢的故事，留一个整整齐齐的位置。</p>
                </div>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => settings("library")}
                >
                  <SlidersHorizontal size={16} />
                  媒体库设置
                </button>
              </div>
              <section className="library-hero">
                <div>
                  <span className="eyebrow">YOUR COLLECTION, YOUR WAY</span>
                  <h2>
                    你的收藏，
                    <br />
                    有自己的模样。
                  </h2>
                  <p>
                    真实文件、清晰命名、通用 NFO。
                    <br />
                    从下载目录，到你喜欢的播放器。
                  </p>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => settings("library")}
                  >
                    管理整理偏好
                    <ArrowRight size={16} />
                  </button>
                </div>
                <div className="library-art" aria-hidden="true">
                  <div className="mini-poster poster-one">
                    <span>
                      MNEMO
                      <br />
                      COLLECTION
                    </span>
                    <strong>
                      流<br />光
                    </strong>
                    <small>THE STORIES WE KEEP</small>
                  </div>
                  <div className="mini-poster poster-two">
                    <span>
                      A FILM FOR
                      <br />
                      YOUR EVENING
                    </span>
                    <div className="poster-moon" />
                    <strong>
                      慢<br />
                      时光
                    </strong>
                    <small>STAY A LITTLE LONGER</small>
                  </div>
                  <div className="poster-shadow" />
                </div>
              </section>
              <div className="library-info-grid">
                <div className="panel library-profile">
                  <span
                    className="profile-logo large"
                    style={{
                      color: profile?.color,
                      background: `${profile?.color}15`,
                    }}
                  >
                    {profile?.mark}
                  </span>
                  <div>
                    <span className="eyebrow">当前媒体库预设</span>
                    <h3>{profile?.name}</h3>
                    <p>通用 NFO · {config.library.language}</p>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="更换媒体库预设"
                    onClick={() => settings("library")}
                  >
                    <ArrowUpRight size={18} />
                  </button>
                </div>
                <div className="panel library-path">
                  <FolderOpen size={25} strokeWidth={1.3} />
                  <div>
                    <span className="eyebrow">文件存放位置</span>
                    <strong>
                      {config.download.directory || "尚未选择目录"}
                    </strong>
                    <p>NAS 目录需在服务器上先完成挂载。</p>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="更改存储目录"
                    onClick={() => settings("download")}
                  >
                    <ArrowUpRight size={18} />
                  </button>
                </div>
              </div>
              <section className="panel">
                <div className="panel-header">
                  <div>
                    <span className="eyebrow">FINISHED & FILED</span>
                    <h2>在 Mnemo 完成的收藏</h2>
                  </div>
                  <span className="badge neutral">
                    {completed.length} 个任务
                  </span>
                </div>
                {completed.length ? (
                  completed.map((task) => taskRow(task))
                ) : (
                  <EmptyState
                    icon={Clapperboard}
                    title="你的故事书架，正等着被填满。"
                    action={
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => navigate("assistant")}
                      >
                        去发现下一部作品
                        <ArrowRight size={15} />
                      </button>
                    }
                  >
                    完成下载后的文件会显示在这里。
                    <br />
                    Mnemo 不会自动扫描或修改目录中的已有文件。
                  </EmptyState>
                )}
              </section>
              <p className="small-note">
                <CircleAlert size={14} />
                「文件已完成」表示本地文件就绪；「媒体库已识别」以服务器检查结果为准，不代表已在真实设备上播放验证。
              </p>
            </>
          )}
          {page === "notifications" && <>
            <div className="page-heading"><div><span className="eyebrow">A NOTE WHEN IT MATTERS</span><h1>通知中心<span className="heading-dot">.</span></h1><p>任务结果与渠道送达状态，都在这里。</p></div><button type="button" className="button secondary" disabled={notificationsLoading} onClick={() => void refresh()}>{notificationsLoading ? <Spinner /> : <RefreshCw size={16} />}刷新通知</button></div>
            {notificationsError && <div className="alert error notification-page-alert" role="alert"><CircleAlert size={16} /><span>{notificationsError}</span></div>}
            {notificationActionError && !unknownRetryId && <div className="alert error notification-page-alert" role="alert"><CircleAlert size={16} /><span>{notificationActionError}</span></div>}
            <section className="panel notification-feed" aria-label="任务结果通知"><div className="panel-header"><div><span className="eyebrow">DELIVERY WITH A CLEAR STATUS</span><h2>我的通知</h2></div><span className="badge neutral">{notifications === null ? "—" : notifications.length} 条</span></div>
              {notifications === null ? <div className="loading-inline">{notificationsError ? <><CircleAlert size={18} />通知尚未读取成功，请手动刷新。</> : <><Spinner />正在读取通知…</>}</div> : notifications.length === 0 ? <EmptyState icon={Bell} title="目前还没有结果通知。">任务完成或失败后，通知会出现在这里。<br />尚未产生结果的预留记录不会显示为消息。</EmptyState> : <div className="notification-list">{notifications.slice(currentNotificationPage * 20, (currentNotificationPage + 1) * 20).map((notification) => <NotificationCard key={notification.id} notification={notification} busy={!!notificationBusy} onAction={(action) => void notificationAction(notification.id, action)} onUnknownRetry={() => { setUnknownRetryId(notification.id); setConfirmUnknown(false); setNotificationActionError(""); }} />)}</div>}
              {notifications !== null && notificationPages > 1 && <div className="notification-pagination"><span>第 {currentNotificationPage + 1} / {notificationPages} 页 · 每页最多 20 条</span><button type="button" className="icon-button" aria-label="上一页通知" disabled={currentNotificationPage === 0} onClick={() => setNotificationPage(currentNotificationPage - 1)}><ChevronLeft size={17} /></button><button type="button" className="icon-button" aria-label="下一页通知" disabled={currentNotificationPage >= notificationPages - 1} onClick={() => setNotificationPage(currentNotificationPage + 1)}><ChevronRight size={17} /></button></div>}
            </section><p className="small-note"><ShieldCheck size={14} />「已发送」表示渠道接口确认发送，不代表对方已阅读；站内通知仅在你主动标记后显示「已读」。结果未知时不会自动重发。</p>
          </>}
          {page === "settings" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">MAKE MNEMO YOURS</span>
                  <h1>
                    设置中心<span className="heading-dot">.</span>
                  </h1>
                  <p>每一个偏好，都让 Mnemo 更像你的 Mnemo。</p>
                </div>
                <button
                  type="button"
                  className="button primary"
                  disabled={saving || !!testing || !dirty}
                  onClick={() => void save()}
                >
                  {saving ? <Spinner /> : <Check size={17} />}
                  {saving ? "保存中…" : dirty ? "保存更改" : "设置已保存"}
                </button>
              </div>
              <div className="settings-layout">
                <aside className="settings-nav" aria-label="设置分组">
                  {groups.map((group) => (
                    <button
                      key={group.id}
                      type="button"
                      className={settingGroup === group.id ? "active" : ""}
                      aria-pressed={settingGroup === group.id}
                      onClick={() => setSettingGroup(group.id)}
                    >
                      <group.icon size={17} />
                      <span>{group.label}</span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                  <div className="settings-nav-note">
                    <ShieldCheck size={22} strokeWidth={1.4} />
                    <strong>配置留在你的服务器</strong>
                    <p>密码框留空时，保留已保存的密钥。</p>
                  </div>
                  <button
                    type="button"
                    className="text-button muted reopen-wizard"
                    onClick={() => {
                      setStep(0);
                      setWizard(true);
                    }}
                  >
                    重新打开设置向导
                    <ArrowUpRight size={13} />
                  </button>
                </aside>
                <section className="panel settings-panel">
                  <div className="settings-section-heading">
                    <span className="service-icon sage">
                      {(() => {
                        const Icon = groups.find(
                          (group) => group.id === settingGroup,
                        )!.icon;
                        return <Icon size={22} />;
                      })()}
                    </span>
                    <div>
                      <h2>
                        {
                          groups.find((group) => group.id === settingGroup)
                            ?.label
                        }
                      </h2>
                      <p>
                        {
                          groups.find((group) => group.id === settingGroup)
                            ?.subtitle
                        }
                      </p>
                    </div>
                  </div>
                  <fieldset
                    className="settings-form"
                    disabled={saving || !!testing}
                  >
                    {formSection(settingGroup)}
                  </fieldset>
                  <div className="settings-save-footer">
                    <span>
                      {dirty ? "有未保存的更改" : "所有设置已保存"}
                      {dirty && <span className="unsaved-dot" />}
                    </span>
                    <button
                      type="button"
                      className="button primary"
                      disabled={saving || !!testing || !dirty}
                      onClick={() => void save()}
                    >
                      {saving ? <Spinner /> : <Check size={16} />}保存设置
                    </button>
                  </div>
                </section>
              </div>
              {capabilities.length > 0 && (
                <details className="capability-details">
                  <summary>
                    <Radio size={15} />
                    查看适配器能力与限制
                    <span>
                      {capabilities.length} 项<ChevronRight size={14} />
                    </span>
                  </summary>
                  <div className="capabilities-list">
                    {capabilities.map((item) => (
                      <div key={item.id}>
                        <strong>{item.name}</strong>
                        <span className="badge neutral">{item.status}</span>
                        <p>{item.description}</p>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          <span>{notice}</span>
          <button
            type="button"
            aria-label="关闭通知"
            onClick={() => setNotice("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {playback && <PlaybackDialog task={playback} onClose={() => setPlayback(null)} />}
      {cmsPlayback && (
        <CmsPlaybackDialog
          title={cmsPlayback.title}
          url={cmsPlayback.url}
          onClose={() => setCmsPlayback(null)}
        />
      )}
      {unknownRetryId && unknownNotification && <Modal title="确认重新发送这条通知？" onClose={() => { setUnknownRetryId(null); setConfirmUnknown(false); }}><form className="modal-form" onSubmit={(event) => { event.preventDefault(); if (confirmUnknown && unknownNotification.status === "unknown") void notificationAction(unknownNotification.id, "retry", true); }}><div className="alert warning"><CircleAlert size={18} /><span>上一次发送的结果未知，接收方可能已经收到通知。重新发送可能产生重复消息。</span></div><p className="notification-modal-text">{notificationText(unknownNotification.text)}</p>{unknownNotification.status !== "unknown" && <p className="notification-help">通知状态已变化，请关闭窗口并查看列表中的最新状态。</p>}<label className="checkbox-label"><input type="checkbox" required checked={confirmUnknown} disabled={!!notificationBusy || unknownNotification.status !== "unknown"} onChange={(event) => setConfirmUnknown(event.target.checked)} /><div><strong>我理解可能重复发送，仍要重新发送。</strong><p>这只会重新排队，不会把通知直接标记为已送达。</p></div></label>{notificationActionError && <div className="alert error modal-error" role="alert"><CircleAlert size={16} />{notificationActionError}</div>}<div className="modal-actions"><button type="button" className="button secondary" disabled={!!notificationBusy} onClick={() => { setUnknownRetryId(null); setConfirmUnknown(false); }}>取消</button><button type="submit" className="button primary" disabled={!confirmUnknown || !!notificationBusy || unknownNotification.status !== "unknown"}>{notificationBusy ? <Spinner /> : <RefreshCw size={15} />}确认重新发送</button></div></form></Modal>}
      {newTask && (
        <Modal title="新建下载任务" onClose={() => setNewTask(false)}>
          <form
            className="modal-form"
            onSubmit={async (event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              setModalBusy(true);
              setError("");
              try {
                await post("/tasks", {
                  title: taskMedia.title.trim(),
                  url: String(form.get("url")).trim(),
                  ...(taskKind ? { kind: taskKind } : {}),
                  media: { ...taskMedia, title: taskMedia.title.trim() },
                });
                setNewTask(false);
                setTaskMedia({ type: "movie", title: "" });
                setTaskUrl("");
                setTaskKind(undefined);
                setIdentifyResults(null);
                setNotice("任务已创建，请在下载中心查看实际状态。");
                navigate("downloads");
                await refresh();
              } catch (error) {
                notifyError(error);
              } finally {
                setModalBusy(false);
              }
            }}
          >
            <p>
              先核对作品、年份与季集，确认后再创建任务。文件会保存到已配置的目录。
            </p>
            <div className="form-grid">
              <label className="field">
                <span>作品类型</span>
                <select
                  value={taskMedia.type}
                  disabled={modalBusy}
                  onChange={(e) => {
                    setTaskMedia({
                      type: e.target.value as "movie" | "tv",
                      title: taskMedia.title,
                      year: taskMedia.year,
                    });
                    setIdentifyResults(null);
                  }}
                >
                  <option value="movie">电影</option>
                  <option value="tv">电视剧</option>
                </select>
              </label>
              <label className="field">
                <span>年份（可选）</span>
                <input
                  name="year"
                  type="number"
                  min={1880}
                  max={2100}
                  value={taskMedia.year ?? ""}
                  onChange={(e) =>
                    setTaskMedia({
                      ...taskMedia,
                      year: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                  placeholder="例如：2026"
                />
              </label>
            </div>
            <label className="field">
              <span>作品名称</span>
              <input
                name="title"
                required
                maxLength={200}
                autoFocus
                value={taskMedia.title}
                onChange={(e) => {
                  setTaskMedia({
                    ...taskMedia,
                    title: e.target.value,
                    tmdbId: undefined,
                    overview: undefined,
                    posterUrl: undefined,
                    backdropUrl: undefined,
                  });
                  setIdentifyResults(null);
                }}
                placeholder="输入准确的电影或剧集名称"
              />
            </label>
            <button
              type="button"
              className="button secondary small identify-button"
              disabled={identifying || !taskMedia.title.trim() || modalBusy}
              onClick={() => void identifyMedia()}
            >
              {identifying ? <Spinner /> : <Search size={14} />}从 TMDB 识别作品
            </button>
            {!secrets["sources.tmdbApiKey"] && (
              <p className="identify-note">
                可手动填写；在线识别需先在设置中保存 TMDB 凭据。
              </p>
            )}
            {identifyResults && (
              <div className="identify-results">
                {identifyResults.length ? (
                  identifyResults.map((media, index) => (
                    <button
                      type="button"
                      key={`${media.tmdbId}-${index}`}
                      className={
                        taskMedia.tmdbId && taskMedia.tmdbId === media.tmdbId
                          ? "selected"
                          : ""
                      }
                      onClick={() =>
                        setTaskMedia({
                          ...media,
                          ...(media.type === "tv"
                            ? {
                                season: taskMedia.season,
                                episode: taskMedia.episode,
                              }
                            : {}),
                        })
                      }
                    >
                      <Film size={16} />
                      <span>
                        <strong>
                          {media.title} {media.year && `(${media.year})`}
                        </strong>
                        <small>
                          {media.overview ||
                            (media.type === "tv" ? "电视剧" : "电影")}
                        </small>
                      </span>
                      {taskMedia.tmdbId &&
                        taskMedia.tmdbId === media.tmdbId && (
                          <Check size={15} />
                        )}
                    </button>
                  ))
                ) : (
                  <span className="identify-note">
                    没有找到匹配作品，请调整名称或手动填写。
                  </span>
                )}
              </div>
            )}
            {taskMedia.type === "tv" && (
              <div className="form-grid">
                <label className="field">
                  <span>季数</span>
                  <input
                    type="number"
                    required
                    min={0}
                    max={999}
                    value={taskMedia.season ?? ""}
                    onChange={(e) =>
                      setTaskMedia({
                        ...taskMedia,
                        season: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                    placeholder="例如：1"
                  />
                </label>
                <label className="field">
                  <span>集数</span>
                  <input
                    type="number"
                    required
                    min={1}
                    max={9999}
                    value={taskMedia.episode ?? ""}
                    onChange={(e) =>
                      setTaskMedia({
                        ...taskMedia,
                        episode: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                    placeholder="例如：1"
                  />
                </label>
              </div>
            )}
            <label className="field">
              <span>资源链接</span>
              <textarea
                name="url"
                required
                value={taskUrl}
                onChange={(event) => {
                  setTaskUrl(event.target.value);
                  setTaskKind(undefined);
                }}
                rows={3}
                maxLength={4000}
                placeholder="https://… 或 magnet:?xt=…"
              />
              <small>
                HTTP 直链可直接下载；磁力链接需要
                Aria2。网盘分享可能需要人工处理。
              </small>
            </label>
            {taskKind && (
              <p className="request-help">
                资源类型：{kindLabels[taskKind]}
                {taskKind === "share"
                  ? " · 这是分享页面，不是媒体文件；可能需要人工处理。"
                  : ""}
              </p>
            )}
            <div className="modal-destination">
              <FolderOpen size={16} />
              <span>
                {config.download.directory || "请先在设置中选择下载目录"}
              </span>
            </div>
            {error && (
              <div className="alert error modal-error" role="alert">
                <CircleAlert size={16} />
                {error}
              </div>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setNewTask(false)}
              >
                取消
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={
                  modalBusy || identifying || !config.download.directory
                }
              >
                {modalBusy ? <Spinner /> : <Plus size={16} />}创建任务
              </button>
            </div>
          </form>
        </Modal>
      )}
      {newSubscription && (
        <Modal
          title="记下一份新的期待"
          onClose={() => setNewSubscription(false)}
        >
          <form
            className="modal-form"
            onSubmit={async (event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              setModalBusy(true);
              setError("");
              try {
                const request = await startRequest(
                  String(form.get("query")).trim(),
                  "subscribe",
                );
                if (request) setNewSubscription(false);
              } catch (error) {
                notifyError(error);
              } finally {
                setModalBusy(false);
              }
            }}
          >
            <p>
              写下作品名称，下一步确认具体作品、年份与季数，避免追错同名作品。
            </p>
            <label className="field">
              <span>作品名称 / 原订阅关键词</span>
              <input
                name="query"
                required
                autoFocus
                maxLength={200}
                placeholder="例如：剧名 第二季 2026"
              />
              <small>加上年份、季数可减少同名作品的误匹配。</small>
            </label>
            <div className="info-banner subtle">
              <ShieldCheck size={18} />
              <p>
                先选片，再追更。确认作品身份后会开启自动追更；同关键词的旧订阅会原位升级并保留记录。
              </p>
            </div>
            <div className="modal-error">
              {error && (
                <div className="alert error" role="alert">
                  <CircleAlert size={16} />
                  {error}
                </div>
              )}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setNewSubscription(false)}
              >
                取消
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={modalBusy || !!requestBusy}
              >
                {modalBusy ? <Spinner /> : <Rss size={16} />}下一步：确认作品
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function SendIcon() {
  return <ArrowUpRight size={21} />;
}
