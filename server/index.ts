import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { existsSync, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { Store, publicConfig, SECRET_PATHS, validateConfig } from "./store.js";
import { readEnv } from "./env.js";
import { RustCoreError } from "./rust-core.js";
import { requiresApproval as approvalRequired } from "../shared/approval.js";
import { listAudit } from "./audit.js";
import { mediaContentType, parseByteRange, PlaybackError, resolvePlayableFile } from "./playback.js";
import { Queue } from "./queue.js";
import { Requests } from "./requests.js";
import { createMediaService } from "./media.js";
import {
  evaluateResourceAgainstCards,
  parseSizeBytes,
  evaluateRuleCards,
  parseExpr,
  validateRuleCard,
  type Candidate,
  type Evaluation,
  type RuleCard,
} from "./filter-cards.js";
import { loadRegistry } from "./source-registry.js";
import { signRegistry, verifyRegistrySubscription } from "./registry-subscription.js";
import { guardEndpoint } from "./registry-search.js";
import { filterMediaPlaylist, isEncryptedPlaylist } from "./hls.js";
import { Readable } from "node:stream";
import { searchWithDiagnostics, searchDiagnosticSummary } from "../shared/search.js";
import { Shares } from "./shares.js";
import { AlipanError } from "./alipan-auth.js";
import { listLibraryUsers } from "./library.js";
import { runAgent, testModel } from "./agent.js";
import { startChannels, registerChannelRoutes } from "./channels.js";
import type {
  AgentDeps,
  MediaService,
  ResourceChoice,
  SearchReport,
  NotificationDestination,
} from "../shared/types.js";

function destinationFor(owner = "web:admin"): NotificationDestination | undefined {
  if (owner === "web:admin") return;
  const telegram = /^telegram:(\d{1,20}):(-?\d{1,20})$/.exec(owner);
  if (telegram)
    return { platform: "telegram", botId: telegram[1], peer: telegram[2] };
  const bridge = /^bridge:(wechat|qq|feishu):(.{1,200})$/u.exec(owner);
  if (bridge && !/[\u0000-\u001f\u007f]/u.test(bridge[2]))
    return { platform: bridge[1] as "wechat" | "qq" | "feishu", peer: bridge[2] };
  throw new Error("通知来源身份无效");
}

const SESSION_COOKIE = "mnemo_session";
/** 改名前的会话 Cookie；只读兼容，让已登录的浏览器不必重新登录。 */
const LEGACY_SESSION_COOKIE = "mori_session";

function cookie(req: Request) {
  const jar = req.headers.cookie?.split(";").map((x) => x.trim()) ?? [];
  for (const name of [SESSION_COOKIE, LEGACY_SESSION_COOKIE]) {
    const found = jar.find((x) => x.startsWith(`${name}=`));
    if (found) return found.slice(name.length + 1);
  }
  return "";
}
function sameSecret(a: unknown, b: string) {
  if (typeof a !== "string") return false;
  const av = Buffer.from(a),
    bv = Buffer.from(b);
  return av.length === bv.length && timingSafeEqual(av, bv);
}
export function createApp(
  options: {
    dataDirectory?: string;
    downloadDirectory?: string;
    media?: MediaService;
    startBackground?: boolean;
    testMode?: boolean;
  } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  const store = new Store(
    options.dataDirectory || readEnv("DATA_DIR") || path.resolve("data"),
    options.downloadDirectory ||
      readEnv("DOWNLOAD_DIR") ||
      path.resolve("downloads"),
  );
  const media = options.media || createMediaService(() => store.config(), new Shares(store));
  const queue = new Queue(store, media);
  const background = options.startBackground !== false;
  const requests = new Requests(store, media, {
    addTask: (input, owner) =>
      queue.add(input, destinationFor(owner), { origin: "channel", owner }),
    subscribe: (query, identity, startEpisode, owner) =>
      queue.subscribe(query, true, identity, startEpisode, destinationFor(owner)),
    subscribeDirectory: (input, owner) =>
      queue.subscribeDirectory(input, destinationFor(owner)),
    // M8 补全：渠道申请人没有网页可看，批准/拒绝必须主动回一条消息。
    notifyDecision: (request, decision) => {
      const target = destinationFor(request.owner);
      if (!target) return; // web 管理员自己发起的请求，网页里有记录
      const title = request.query.trim().slice(0, 80);
      const text =
        decision === "rejected"
          ? `管理员已拒绝你的请求${title ? `：${title}` : ""}，未创建下载任务。`
          : `管理员已批准你的请求${title ? `：${title}` : ""}，已开始下载，完成后会再通知你。`;
      queue.notifications.message(target, `request:${request.id}:${decision}`, text);
    },
  });
  const forOwner = (owner: string): AgentDeps => ({
    config: () => store.config(),
    search: (q) => media.search(q),
    searchWithDiagnostics: (q, signal) => searchWithDiagnostics(media, q, signal),
    tasks: () => queue.tasks(),
    subscribe: (q) => queue.subscribe(q, false, undefined, undefined, destinationFor(owner)),
    addTask: (i) =>
      queue.add(i, destinationFor(owner), { origin: "channel", owner }),
    notifications: queue.notifications,
    request: (query, intent, signal) =>
      requests.begin(owner, query, intent, signal),
    selectRequest: (id, selection, signal) =>
      requests.select(owner, id, selection, signal),
    latestRequest: () => requests.latest(owner),
    getRequest: (id) => requests.get(owner, id),
    requiresApproval: () => approvalRequired(store.config(), owner),
    forOwner,
  });
  const deps = forOwner("web:admin");
  let channelError = "";
  let stopChannels: () => Promise<void> = async () => {};
  let cancelBridge = () => {};
  let channelEpoch = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const directSearches = new Map<AbortController, Promise<SearchReport>>();
  const passwordChecks = new Map<AbortController, Promise<boolean>>();
  const refreshChannels = async () => {
    const epoch = ++channelEpoch;
    cancelBridge();
    try {
      await stopChannels();
      if (background && !closing && epoch === channelEpoch)
        stopChannels = startChannels(deps, (m) => {
          channelError = redact(m);
        });
    } catch {
      channelError = "渠道停止失败，请检查通知状态后重新连接";
    }
  };
  function redact(message: string) {
    let result = message;
    const config = store.config();
    for (const key of SECRET_PATHS) {
      const val = key.split(".").reduce((v: any, k) => v?.[k], config);
      if (typeof val === "string" && val)
        result = result.split(val).join("[已隐藏]");
    }
    return result.slice(0, 500);
  }
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: https://image.tmdb.org; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    );
    if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use((req, res, next) => {
    let host: string;
    try {
      host = new URL(`http://${req.headers.host || ""}`).hostname;
    } catch {
      res.status(400).json({ error: "无效主机地址" });
      return;
    }
    const localAddress = (req.socket.localAddress || "").replace(
      /^::ffff:/,
      "",
    );
    let publicHost = "";
    try {
      const publicOrigin = readEnv("PUBLIC_ORIGIN");
      publicHost = publicOrigin ? new URL(publicOrigin).hostname : "";
    } catch {
      res.status(500).json({ error: "服务器公开地址配置无效" });
      return;
    }
    if (
      ![
        "localhost",
        "127.0.0.1",
        "[::1]",
        localAddress,
        `[${localAddress}]`,
        publicHost,
      ]
        .filter(Boolean)
        .includes(host) &&
      !isIP(host.replace(/^\[|\]$/g, ""))
    ) {
      res
        .status(403)
        .json({ error: "此主机名未获授权，请配置 MORI_PUBLIC_ORIGIN" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  app.use("/api", (req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin
    ) {
      let origin: URL;
      try {
        origin = new URL(req.headers.origin);
      } catch {
        res.status(403).json({ error: "无效请求来源" });
        return;
      }
      const configured = readEnv("PUBLIC_ORIGIN");
      if (
        origin.host !== req.headers.host &&
        (!configured || origin.origin !== configured)
      ) {
        res.status(403).json({ error: "不允许跨站请求" });
        return;
      }
    }
    next();
  });
  const loginAttempts = new Map<string, { count: number; reset: number }>();
  function throttle(req: Request, res: Response, next: NextFunction) {
    const key = req.socket.remoteAddress || "local";
    const now = Date.now();
    for (const [k, v] of loginAttempts)
      if (v.reset < now) loginAttempts.delete(k);
    if (loginAttempts.size > 1000) {
      res.status(429).json({ error: "登录繁忙，请稍后重试" });
      return;
    }
    const current = loginAttempts.get(key) || { count: 0, reset: now + 60000 };
    current.count++;
    loginAttempts.set(key, current);
    if (current.count > 15) {
      res.status(429).json({ error: "尝试次数过多，请一分钟后重试" });
      return;
    }
    next();
  }
  function setSession(res: Response, req: Request) {
    res.cookie(SESSION_COOKIE, store.session(), {
      httpOnly: true,
      sameSite: "strict",
      secure: req.secure || readEnv("COOKIE_SECURE") === "1",
      maxAge: 7 * 86400000,
      path: "/",
    });
  }
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, version: "0.1.0" }),
  );
  app.get("/api/session", (req, res) =>
    res.json({
      authenticated: store.authenticated(cookie(req)),
      needsSetup: !store.initialized(),
      testMode: options.testMode === true,
    }),
  );
  app.post("/api/setup", throttle, (req, res) => {
    if (store.initialized()) {
      res.status(409).json({ error: "管理员已经初始化，请登录" });
      return;
    }
    const ip = req.socket.remoteAddress || "";
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip);
    if (
      (readEnv("SETUP_TOKEN") || !local || readEnv("PUBLIC_ORIGIN")) &&
      !sameSecret(req.body?.setupToken, readEnv("SETUP_TOKEN") || "")
    ) {
      res
        .status(403)
        .json({ error: "NAS 首次初始化需要部署时设置的 MNEMO_SETUP_TOKEN" });
      return;
    }
    if (
      (!local || readEnv("PUBLIC_ORIGIN")) && !readEnv("SETUP_TOKEN")
    ) {
      res
        .status(403)
        .json({ error: "请先在服务器设置 MNEMO_SETUP_TOKEN，再初始化管理员" });
      return;
    }
    store.setup(req.body?.password);
    setSession(res, req);
    res.json({ ok: true });
  });
  app.post("/api/login", throttle, async (req, res) => {
    if (closing) {
      res.status(503).json({ error: "服务正在关闭，请稍后重试" });
      return;
    }
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", onClose);
    const work = store.checkPassword(req.body?.password, controller.signal);
    passwordChecks.set(controller, work);
    try {
      const matched = await work;
      controller.signal.throwIfAborted();
      if (closing || res.destroyed) return;
      if (!matched) {
        res.status(401).json({ error: "密码不正确" });
        return;
      }
      setSession(res, req);
      res.json({ ok: true });
    } catch (error) {
      if (res.destroyed) return;
      if (controller.signal.aborted || closing) {
        res.status(503).json({ error: "登录验证已取消，请稍后重试" });
      } else if (error instanceof RustCoreError) {
        res.status(error.code === "CORE_BUSY" ? 429 : 503).json({
          error: "登录验证核心不可用，请检查安装包或稍后重试", code: "auth_core_unavailable",
        });
      } else throw error;
    } finally {
      res.off("close", onClose);
      passwordChecks.delete(controller);
    }
  });
  cancelBridge = registerChannelRoutes(app, deps);
  app.use("/api", (req, res, next) => {
    if (!store.authenticated(cookie(req))) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    next();
  });
  app.post("/api/logout", (req, res) => {
    store.logout(cookie(req));
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.clearCookie(LEGACY_SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });
  app.get("/api/config", (_req, res) => res.json(publicConfig(store.config())));
  app.put("/api/config", (req, res) => {
    const old = store.config();
    const config = validateConfig(req.body, old);
    if (
      queue.isBusy() &&
      (old.download.directory !== config.download.directory ||
        old.library.profile !== config.library.profile)
    )
      throw new Error(
        "请先暂停正在处理的任务，并等待停止完成，再更改下载目录或媒体库类型",
      );
    store.setConfig(config);
    void refreshChannels();
    res.json(publicConfig(config));
  });
  app.get("/api/dashboard", (_req, res) => {
    const tasks = queue.tasks(),
      subscriptions = queue.subscriptions(),
      config = store.config();
    const warnings: string[] = [];
    if (!config.model.baseUrl || !config.model.model)
      warnings.push("尚未连接模型：当前使用关键词与固定指令模式");
    if (!config.sources.pansouUrl && !config.sources.telegramChannels.length)
      warnings.push("尚未配置搜索源，可先添加 PanSou 地址或直接添加文件链接");
    if (channelError) warnings.push(channelError);
    res.json({
      tasks,
      subscriptions,
      stats: {
        active: tasks.filter((t) =>
          ["queued", "downloading", "scraping"].includes(t.status),
        ).length,
        completed: tasks.filter((t) => t.status === "completed").length,
        subscriptions: subscriptions.length,
      },
      warnings,
    });
  });
  app.get("/api/capabilities", (_req, res) =>
    res.json({
      items: [
        {
          id: "direct",
          name: "文件直链",
          status: "available",
          description: "流式下载到实际目录，支持可用来源的续传；不覆盖已有文件",
        },
        {
          id: "pansou",
          name: "PanSou 聚合搜索",
          status: "configurable",
          description: "配置自己的搜索服务；分享页仍需要转存或文件解析",
        },
        {
          id: "openlist",
          name: "OpenList 网盘",
          status: "configurable",
          description: "通过已授权的挂载路径获取文件；不自动绕过网盘登录",
        },
        {
          id: "aria2",
          name: "aria2 下载加速",
          status: "configurable",
          description:
            "连接自有 RPC 服务与共享目录，按服务端允许的范围分段下载",
        },
        {
          id: "p115",
          name: "115 分享文件",
          status: "configurable",
          description: "浏览分享并由内置下载器落盘；确认作品和目录后可订阅下级目录追更，需分享访问权限，不自动转存",
        },
        {
          id: "alipan",
          name: "阿里云盘分享",
          status: "configurable",
          description: "浏览分享；使用自己的网页登录凭据下载和目录追更，按网盘实际权限执行，不转存",
        },
        {
          id: "telegram",
          name: "Telegram",
          status: "configurable",
          description: "原生机器人对话，需 Bot Token 与聊天 ID 白名单",
        },
        {
          id: "bridge",
          name: "微信 / QQ / 飞书",
          status: "bridge_required",
          description: "通过签名桥接接入已有渠道适配器，尚非内置扫码登录",
        },
        {
          id: "profiles",
          name: "Emby / 飞牛 / 绿联 / Jellyfin / Kodi",
          status: "compatibility_candidate",
          description:
            "通用 NFO 与命名预设；专有媒体服务器端到端兼容性待实机验收",
        },
      ],
    }),
  );
  app.post("/api/test", async (req, res) => {
    const kind = req.body?.kind;
    if (typeof kind !== "string") throw new Error("请选择要测试的连接");
    if (kind === "model") {
      res.json(await testModel(store.config()));
      return;
    }
    if (kind === "telegram") {
      const token = store.config().channels.telegram.token;
      if (!token) throw new Error("请先保存 Telegram Token");
      const response = await fetch(
        `https://api.telegram.org/bot${token}/getMe`,
        { signal: AbortSignal.timeout(12000) },
      );
      const data = (await response.json()) as any;
      res.json({
        ok: response.ok && data.ok === true,
        message: data.ok ? "机器人连接成功" : "机器人连接失败，请核对 Token",
      });
      return;
    }
    res.json(await media.testConnection(kind));
  });
  app.get("/api/search", async (req, res) => {
    const query = String(req.query.q || "").trim();
    if (!query || query.length > 200)
      throw new Error("搜索词长度应为 1–200 字");
    if (closing) {
      res.status(503).json({ error: "服务正在关闭，请稍后重试", code: "search_closed" });
      return;
    }
    if (directSearches.size >= 8) {
      res.status(429).json({ error: "搜索请求较多，请稍后重试", code: "search_busy" });
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", onClose);
    const work = searchWithDiagnostics(media, query, signal);
    directSearches.set(controller, work);
    try {
      const report = await work;
      signal.throwIfAborted();
      const status = report.diagnostics.status;
      const failed = status === "failed" || status === "not_configured";
      res.status(status === "not_configured" ? 409 : status === "failed" ? 502 : 200).json({
        ...report,
        ...(failed ? {
          error: searchDiagnosticSummary(report.diagnostics),
          code: status === "not_configured" ? "search_not_configured" : "search_failed",
        } : {}),
      });
    } catch (error) {
      if (res.destroyed) return;
      if (signal.aborted) {
        res.status(closing ? 503 : 504).json({ error: closing ? "服务正在关闭，请稍后重试" : "搜索超时，请稍后重试", code: closing ? "search_closed" : "search_timeout" });
        return;
      }
      throw error;
    } finally {
      directSearches.delete(controller);
      res.off("close", onClose);
    }
  });
  app.get("/api/identify", async (req, res) => {
    const query = String(req.query.q || "").trim();
    if (!query || query.length > 200) throw new Error("请输入片名");
    const type = req.query.type;
    res.json({
      results: await media.identify(
        query,
        type === "movie" || type === "tv" ? type : undefined,
      ),
    });
  });
  app.get("/api/tasks", (_req, res) => res.json({ tasks: queue.tasks() }));
  app.get("/api/notifications", (_req, res) => res.json({
    notifications: queue.notifications.list()
      .filter((item) => item.status !== "waiting")
      .map(({ claimToken, ...item }) => ({
        ...item,
        text: redact(item.text),
        ...(item.error ? { error: redact(item.error) } : {}),
      })),
  }));
  app.post("/api/notifications/:id/action", (req, res) => {
    const id = String(req.params.id);
    if (req.body?.action === "read") queue.notifications.read(id);
    else if (req.body?.action === "dismiss") queue.notifications.dismiss(id);
    else if (req.body?.action === "retry")
      queue.notifications.retry(id, req.body.confirmUnknown === true);
    else throw new Error("未知通知操作");
    res.json({ ok: true });
  });
  // M4：把规则卡逐字段检查明细附加到选片资源（"为什么没抓取"展示）。
  const activeFilterCards = (): RuleCard[] =>
    filterCards.map((entry) => entry.card).filter((card) => card.enabled !== false);
  const attachFilterChecks = <T extends { resources: ResourceChoice[] }>(request: T): T => {
    const cards = activeFilterCards();
    if (!cards.length) return request;
    // M5：任何卡配置了 score 时，按命中总分降序排候选（稳定排序保输入序），
    // 并给每个资源附 filterScore；无分数卡时保持原有顺序只附明细。
    const scored = cards.some((card) => typeof card.score === "number");
    const enriched = request.resources.map((resource, index) => {
      const evaluations: Evaluation[] = evaluateResourceAgainstCards(resource, cards);
      const filterScore = evaluations
        .filter((evaluation) => evaluation.matched)
        .reduce(
          (total, evaluation) =>
            total +
            (cards.find((item) => item.id === evaluation.card_id)?.score ?? 0),
          0,
        );
      return {
        ...resource,
        ...(scored ? { filterScore } : {}),
        __index: index,
        filterChecks: evaluations.map((evaluation) => {
          const card = cards.find((item) => item.id === evaluation.card_id);
          return {
            card_id: evaluation.card_id,
            card_name: card?.name ?? evaluation.card_id,
            matched: evaluation.matched,
            checks: evaluation.checks.map((check) => ({
              field: check.field,
              passed: check.passed,
              detail: check.detail,
            })),
          };
        }),
      };
    });
    const ordered = scored
      ? [...enriched].sort((a, b) => (b.filterScore ?? 0) - (a.filterScore ?? 0) || a.__index - b.__index)
      : enriched;
    return {
      ...request,
      resources: ordered.map(({ __index, ...resource }) => resource),
    };
  };
  app.get("/api/requests", (_req, res) => {
    // M8：管理员视角列出全部域的请求（含渠道入口的待批准项）。
    const enriched = requests
      .listAll()
      .map((request) => attachFilterChecks(request));
    res.json({ requests: enriched });
  });
  // M7：源注册表订阅分发——导出当前注册表的签名文档；导入验签后应用。
  app.get("/api/registry/subscription", (_req, res) => {
    const registryJson = store.config().sources.registryJson?.trim();
    if (!registryJson) {
      res.status(404).json({ error: "尚未配置源注册表" });
      return;
    }
    const { registry } = loadRegistry(registryJson);
    if (!registry) {
      res.status(422).json({ error: "当前注册表配置无效，无法签发订阅" });
      return;
    }
    try {
      const subscription = signRegistry(registry, store.masterKey);
      res.json({ subscription });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "签发失败" });
    }
  });
  app.post("/api/registry/subscription", (req, res) => {
    const document = req.body?.document;
    if (typeof document !== "string" || !document.trim()) {
      res.status(400).json({ error: "请提供订阅文档（document 字符串）" });
      return;
    }
    const { registry, issuedAt, error } = verifyRegistrySubscription(document, store.masterKey);
    if (error || !registry) {
      res.status(422).json({ error: error ?? "订阅文档无效" });
      return;
    }
    const config = store.config();
    store.setConfig({
      ...config,
      sources: { ...config.sources, registryJson: JSON.stringify(registry) },
    });
    res.json({ ok: true, issuedAt });
  });
  // M2：过滤规则卡引擎（server/filter-cards.ts）——AI 提案规则卡 JSON，
  // 引擎对选片候选做确定性求值并逐字段给出 Check 明细。规则卡集在实例
  // 生命周期内保存在内存（持久化表待主线 store 扩展非加密表后接入）。
  const filterCards: { id: string; card: import("./filter-cards.js").RuleCard }[] = [];
  app.get("/api/filter/cards", (_req, res) =>
    res.json({ cards: filterCards.map((entry) => entry.card) }),
  );
  app.put("/api/filter/cards", (req, res) => {
    const { card, issues } = validateRuleCard(req.body);
    if (issues.length) {
      res.status(422).json({ issues });
      return;
    }
    const existing = filterCards.findIndex((entry) => entry.id === card!.id);
    if (existing >= 0) filterCards[existing] = { id: card!.id, card: card! };
    else filterCards.push({ id: card!.id, card: card! });
    res.status(201).json({ card });
  });
  app.delete("/api/filter/cards/:id", (req, res) => {
    const index = filterCards.findIndex((entry) => entry.id === req.params.id);
    if (index < 0) {
      res.status(404).json({ error: "规则卡不存在" });
      return;
    }
    filterCards.splice(index, 1);
    res.json({ ok: true });
  });
  app.post("/api/filter/evaluate", (req, res) => {
    try {
      const candidate = {
        title: String(req.body?.candidate?.title ?? ""),
        size_bytes: req.body?.candidate?.size_bytes,
        group: req.body?.candidate?.group,
        age_minutes: req.body?.candidate?.age_minutes,
        freeleech: req.body?.candidate?.freeleech === true,
        extension: req.body?.candidate?.extension,
      };
      const cards = filterCards.map((entry) => entry.card);
      const expression =
        typeof req.body?.expression === "string"
          ? parseExpr(req.body.expression)
          : undefined;
      const { evaluations, expression_matched } = evaluateRuleCards(
        cards,
        candidate,
        {},
        expression,
      );
      res.json({ evaluations, expression_matched });
    } catch (error) {
      res
        .status(422)
        .json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get("/api/requests/:id", (req, res) => {
    // M8：管理员会话读取任意域的请求；渠道入口的待批准项也要能打开。
    const request = requests.getAny(String(req.params.id));
    res.json({ request: attachFilterChecks(request) });
  });
  app.post("/api/requests", async (req, res) =>
    res
      .status(201)
      .json({
        request: await requests.begin(
          "web:admin",
          req.body?.query,
          req.body?.intent,
        ),
      }),
  );
  app.post("/api/requests/:id/select", async (req, res) =>
    res.json({
      // M8：管理员会话经 adminSelect 跨域操作（审批渠道请求）；
      // 自有请求同样经此路径（会话即授权）。
      request: await requests.adminSelect(String(req.params.id), req.body),
    }),
  );
  // M8：审批历史（管理员视图）。请求 1 天后会被清理，历史单独保留。
  app.get("/api/approvals", (_req, res) =>
    res.json({ approvals: requests.listApprovals(50) }),
  );
  // 操作审计：任务创建 + 审批决定的统一时间线。
  app.get("/api/audit", (_req, res) =>
    res.json({ entries: listAudit(store, 50) }),
  );
  app.get("/api/library/users", async (_req, res) =>
    res.json({ users: await listLibraryUsers(store.config()) }),
  );
  // M9：CMS 在线播放——服务端 HLS 代理（广告分片过滤 + 凭据不转发）。
  const segmentProxyUrl = (absolute: string) =>
    `/api/cms/segment?url=${encodeURIComponent(absolute)}`;
  app.get("/api/cms/stream", async (req, res) => {
    const target = String(req.query.url ?? "");
    const guarded = guardEndpoint(target);
    if (!guarded.ok) {
      res.status(400).json({ error: `地址无效：${guarded.error}` });
      return;
    }
    try {
      const upstream = await fetch(guarded.url, {
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: { accept: "application/vnd.apple.mpegurl, */*" },
      });
      if (!upstream.ok) {
        res.status(502).json({ error: `上游返回 HTTP ${upstream.status}` });
        return;
      }
      const text = await upstream.text();
      if (isEncryptedPlaylist(text)) {
        res.status(422).json({ error: "加密播放列表不做在线代理" });
        return;
      }
      const result = filterMediaPlaylist(text, guarded.url, segmentProxyUrl);
      res.setHeader("content-type", "application/vnd.apple.mpegurl");
      if (result.dropped > 0)
        res.setHeader("x-lucerna-filtered", String(result.dropped));
      res.send(result.playlist);
    } catch (error) {
      res
        .status(502)
        .json({ error: error instanceof Error ? error.message : "播放列表获取失败" });
    }
  });
  app.get("/api/cms/segment", async (req, res) => {
    const target = String(req.query.url ?? "");
    const guarded = guardEndpoint(target);
    if (!guarded.ok) {
      res.status(400).json({ error: `地址无效：${guarded.error}` });
      return;
    }
    try {
      const upstream = await fetch(guarded.url, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!upstream.ok) {
        res.status(upstream.status === 404 ? 404 : 502).json({ error: `分片获取失败 HTTP ${upstream.status}` });
        return;
      }
      res.status(upstream.status);
      const type = upstream.headers.get("content-type");
      if (type) res.setHeader("content-type", type);
      const length = upstream.headers.get("content-length");
      if (length) res.setHeader("content-length", length);
      Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
    } catch (error) {
      res
        .status(502)
        .json({ error: error instanceof Error ? error.message : "分片获取失败" });
    }
  });
  app.get("/api/tasks/:id/stream", async (req, res) => {
    const task = queue.tasks().find((item) => item.id === String(req.params.id));
    if (!task) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    if (task.status !== "completed" || !task.path) {
      res.status(409).json({ error: "文件完成下载后才能播放" });
      return;
    }
    let file: { path: string; size: number };
    try {
      const roots = [task.downloadRoot, store.config().download.directory].filter(
        (root): root is string => typeof root === "string" && root.length > 0,
      );
      file = await resolvePlayableFile(task.path, roots);
    } catch (error) {
      res
        .status(404)
        .json({ error: error instanceof PlaybackError ? error.message : "媒体文件不可用" });
      return;
    }
    const range = parseByteRange(req.headers.range, file.size);
    if (range === "invalid") {
      res.setHeader("Content-Range", `bytes */${file.size}`);
      res.status(416).end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : file.size - 1;
    res.status(range ? 206 : 200);
    res.setHeader("Content-Type", mediaContentType(file.path));
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(end - start + 1));
    res.setHeader("Content-Disposition", "inline");
    if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${file.size}`);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(file.path, { start, end });
    stream.on("error", () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    res.once("close", () => stream.destroy());
    stream.pipe(res);
  });
  app.post("/api/tasks/:id/library", async (req, res) =>
    res.json({ task: await queue.verifyLibrary(String(req.params.id)) }),
  );
  app.post("/api/tasks", (req, res) =>
    res
      .status(201)
      .json({
        task: queue.add(req.body || {}, undefined, {
          origin: "web",
          owner: "web:admin",
        }),
      }),
  );
  app.post("/api/tasks/:id/action", (req, res) =>
    res.json({ task: queue.action(String(req.params.id), req.body?.action) }),
  );
  app.get("/api/subscriptions", (_req, res) =>
    res.json({ subscriptions: queue.subscriptions() }),
  );
  app.post("/api/subscriptions", (req, res) => {
    if (
      req.body?.autoDownload !== undefined &&
      typeof req.body.autoDownload !== "boolean"
    )
      throw new Error("自动下载选项无效");
    res.status(201).json({
      subscription: queue.subscribe(
        req.body?.query,
        req.body?.autoDownload === true,
      ),
    });
  });
  app.patch("/api/subscriptions/:id", (req, res) => {
    const id = String(req.params.id);
    if (!queue.subscriptions().some((subscription) => subscription.id === id)) {
      res.status(404).json({ error: "订阅不存在" });
      return;
    }
    const changes: { enabled?: boolean; autoDownload?: boolean } = {};
    for (const field of ["enabled", "autoDownload"] as const) {
      if (req.body?.[field] !== undefined) changes[field] = req.body[field];
    }
    res.json({ subscription: queue.updateSubscription(id, changes) });
  });
  app.delete("/api/subscriptions/:id", (req, res) => {
    queue.removeSubscription(String(req.params.id));
    res.json({ ok: true });
  });
  app.post("/api/subscriptions/:id/check", async (req, res) =>
    res.json({ subscription: await queue.check(String(req.params.id)) }),
  );
  app.post("/api/chat", async (req, res) => {
    if (
      typeof req.body?.message !== "string" ||
      !req.body.message.trim() ||
      req.body.message.length > 2000
    )
      throw new Error("消息长度应为 1–2000 字");
    res.json(await runAgent(req.body.message, deps));
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在" }));
  const dist = path.resolve("dist");
  if (existsSync(path.join(dist, "index.html"))) {
    app.use(express.static(dist));
    app.get("/{*splat}", (_req, res) =>
      res.sendFile(path.join(dist, "index.html")),
    );
  }
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = [400, 401, 403, 404, 409, 410, 413, 429, 502, 503].includes(
      error?.status,
    )
      ? error.status
      : 400;
    res.status(status).json({
      error: redact(error instanceof Error ? error.message : "操作失败"),
      ...(error instanceof AlipanError ||
      ["auth_required", "alipan_auth_required", "alipan_auth_invalid", "alipan_auth_unknown"].includes(error?.code)
        ? { code: error.code } : {}),
    });
  });
  if (background) {
    queue.start();
  void refreshChannels();
  }
  return {
    app,
    store,
    queue,
    close: () => closePromise ??= (async () => {
      closing = true;
      channelEpoch++;
      const channelStop = stopChannels();
      cancelBridge();
      for (const controller of directSearches.keys()) controller.abort();
      for (const controller of passwordChecks.keys()) controller.abort();
      const stopped = await Promise.allSettled([channelStop, queue.stop(), requests.close(), Promise.allSettled(directSearches.values()), Promise.allSettled(passwordChecks.values())]);
      await media.close?.();
      const failure = stopped.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      store.close();
    })(),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const instance = createApp();
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 4180);
  const server = instance.app.listen(port, host, () =>
    console.log(`Mnemo listening on ${host}:${port}`),
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    const closed = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    server.closeIdleConnections();
    await closed;
    await instance.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
