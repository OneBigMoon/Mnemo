import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { searchDiagnosticSummary, searchWithDiagnostics } from "../shared/search.js";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type {
  DownloadTask,
  AppConfig,
  MediaInfo,
  MediaService,
  ResourceKind,
  Subscription,
  AuditOrigin,
  NotificationDestination,
  NotificationService,
  ShareSubscriptionInput,
} from "../shared/types.js";
import { Store } from "./store.js";
import { syncLibrary } from "./library.js";
import { matchDirectoryResource, matchResource } from "./matching.js";
import { Notifications } from "./notifications.js";
import { ownerFromDestination, recordTaskAudit } from "./audit.js";

type TaskInput = {
  title: string;
  url: string;
  kind?: ResourceKind;
  media?: MediaInfo;
};
const WEB_DESTINATION: NotificationDestination = { platform: "web", peer: "admin" };

function sameMedia(a: MediaInfo, b: MediaInfo) {
  if (a.type !== b.type) return false;
  const same =
    a.tmdbId || b.tmdbId
      ? Boolean(a.tmdbId && b.tmdbId && a.tmdbId === b.tmdbId)
      : a.year !== undefined &&
        a.year === b.year &&
        a.title.normalize("NFKC").toLocaleLowerCase() ===
          b.title.normalize("NFKC").toLocaleLowerCase();
  return Boolean(
    same &&
      (a.type === "movie" ||
        (a.season !== undefined &&
          a.season === b.season &&
          a.episode !== undefined &&
          a.episode === b.episode)),
  );
}

function libraryTargetId(config: AppConfig) {
  const l = config.library;
  return createHash("sha256")
    .update(
      JSON.stringify([
        l.profile,
        l.serverUrl,
        l.serverToken,
        l.userId || "",
        l.pathFrom || "",
        l.pathTo || "",
      ]),
    )
    .digest("hex");
}

export class Queue {
  private active = new Map<string, AbortController>();
  private running = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  private subscriptionChecks = new Map<
    string,
    { controller: AbortController; promise: Promise<Subscription | undefined> }
  >();
  private stopped = false;
  private verifying = new Map<
    string,
    { controller: AbortController; promise: Promise<DownloadTask> }
  >();
  constructor(
    private store: Store,
    private media: MediaService,
    readonly notifications: NotificationService = new Notifications(store),
  ) {
    for (const task of this.tasks())
      if (["downloading", "scraping"].includes(task.status))
        this.save({
          ...task,
          status: "paused",
          error: "服务曾中断，请点击继续；已有下载内容将按来源能力恢复",
        });
    this.restorePartialProgress();
  }
  tasks() {
    const current = libraryTargetId(this.store.config());
    return this.store.list<DownloadTask>("task").map((task) =>
      task.library && task.library.targetId !== current
        ? {
            ...task,
            library: {
              ...task.library,
              status: "pending" as const,
              playable: false,
              message: "媒体服务器配置已变更，请重新检查当前媒体库",
            },
          }
        : task,
    );
  }
  isBusy() {
    return this.active.size > 0 || this.verifying.size > 0;
  }
  async verifyLibrary(
    id: string,
    parentSignal?: AbortSignal,
  ): Promise<DownloadTask> {
    if (this.stopped) throw new Error("服务正在关闭");
    const running = this.verifying.get(id);
    if (running) return running.promise;
    const task = this.store.record<DownloadTask>("task", id);
    if (!task || task.status !== "completed" || !task.path)
      throw new Error("文件完成下载后才能检查媒体库");
    const controller = new AbortController();
    const signal = parentSignal
      ? AbortSignal.any([controller.signal, parentSignal])
      : controller.signal;
    const config = this.store.config();
    const targetId = libraryTargetId(config);
    task.library = {
      targetId,
      status: "pending",
      checkedAt: new Date().toISOString(),
      message: "正在检查媒体服务器中的实际文件",
    };
    this.save(task);
    const promise = (async () => {
      try {
        const file = await lstat(task.path!);
        if (file.isFile() && !file.isSymbolicLink()) {
          task.bytes = file.size;
          task.total = file.size;
        }
        task.library = await syncLibrary(config, task, signal);
      } catch {
        task.library = {
          status: signal.aborted ? "pending" : "failed",
          checkedAt: new Date().toISOString(),
          message: signal.aborted
            ? "媒体库检查已中断，可稍后重新检查"
            : "媒体库检查失败，请核对服务器配置",
        };
      }
      task.library.targetId = targetId;
      if (targetId !== libraryTargetId(this.store.config())) {
        task.library = {
          ...task.library,
          status: "pending",
          playable: false,
          message: "检查期间媒体服务器配置已变更，请重新检查当前媒体库",
        };
      }
      return this.save(task);
    })();
    this.verifying.set(id, { controller, promise });
    try {
      return await promise;
    } finally {
      this.verifying.delete(id);
    }
  }
  subscriptions() {
    return this.store.list<Subscription>("subscription");
  }
  removeSubscription(id: string) {
    this.store.transaction(() => {
      this.store.remove("subscription", id);
      this.notifications.unwatchSubscription(id);
    });
    this.subscriptionChecks.get(id)?.controller.abort();
  }
  updateSubscription(
    id: string,
    changes: { enabled?: boolean; autoDownload?: boolean },
  ) {
    if (
      !changes ||
      typeof changes !== "object" ||
      Object.entries(changes).some(
        ([key, value]) => !["enabled", "autoDownload"].includes(key) || typeof value !== "boolean",
      )
    )
      throw new Error("订阅设置无效");
    const sub = this.store.transaction(() => {
      const current = this.store.record<Subscription>("subscription", id);
      if (!current) throw Object.assign(new Error("订阅不存在"), { status: 404 });
      if (changes.autoDownload && !current.media)
        throw new Error("请先确认作品身份和季集，再开启自动下载");
      if (changes.autoDownload && !current.autoDownload) current.seen = [];
      Object.assign(current, changes);
      if (current.enabled) current.nextCheckAt = new Date().toISOString();
      this.store.put("subscription", current);
      return current;
    });
    this.subscriptionChecks.get(id)?.controller.abort();
    return sub;
  }
  private save(task: DownloadTask) {
    task.updatedAt = new Date().toISOString();
    this.store.put("task", task);
    return task;
  }
  private restorePartialProgress() {
    const directory = this.store.config().download.directory;
    for (const task of this.tasks()) {
      if (task.status !== "paused" || task.path) continue;
      const prefix = `.mori-${createHash("sha256").update(task.id).digest("hex").slice(0, 24)}`;
      try {
        const part = lstatSync(path.join(directory, `${prefix}.part`));
        const metadata = lstatSync(path.join(directory, `${prefix}.json`));
        if (
          !part.isFile() ||
          part.isSymbolicLink() ||
          !part.size ||
          !metadata.isFile() ||
          metadata.isSymbolicLink()
        )
          continue;
        const resume = JSON.parse(
          readFileSync(path.join(directory, `${prefix}.json`), "utf8"),
        ) as { filename?: unknown; validator?: unknown; total?: unknown };
        const total = Number(resume.total);
        if (
          typeof resume.filename !== "string" ||
          typeof resume.validator !== "string" ||
          !resume.validator ||
          !Number.isSafeInteger(total) ||
          total < part.size
        )
          continue;
        this.save({
          ...task,
          bytes: part.size,
          total,
          progress: Math.min(99, (part.size / total) * 100),
        });
      } catch {
        // Most paused tasks have no partial file; leave their stored progress.
      }
    }
  }
  add(
    input: TaskInput,
    destination?: NotificationDestination,
    context: { origin: AuditOrigin; owner?: string } = { origin: "web" },
  ): DownloadTask {
    return this.store.transaction(() => this.addInternal(input, destination, context));
  }
  private watchTask(task: DownloadTask, destination?: NotificationDestination) {
    this.notifications.watchTask(task, WEB_DESTINATION);
    if (destination && destination.platform !== "web")
      this.notifications.watchTask(task, destination);
    return task;
  }
  private addInternal(
    input: TaskInput,
    destination?: NotificationDestination,
    context: { origin: AuditOrigin; owner?: string } = { origin: "web" },
  ): DownloadTask {
    if (
      typeof input.title !== "string" ||
      !input.title.trim() ||
      input.title.length > 300 ||
      typeof input.url !== "string" ||
      input.url.length > 8192
    )
      throw new Error("请提供有效片名与资源链接");
    const url = new URL(input.url);
    if (
      !["http:", "https:", "magnet:", "openlist:", "mori-share:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("资源地址必须是 HTTP(S)、magnet、OpenList 或已解析的分享文件");
    const kind: ResourceKind =
      input.kind ||
      (url.protocol === "magnet:"
        ? "magnet"
        : url.protocol === "openlist:"
          ? "openlist"
          : url.protocol === "mori-share:"
            ? "cloud"
            : "direct");
    if (!["direct", "share", "magnet", "openlist", "telegram", "cloud"].includes(kind))
      throw new Error("未知资源类型");
    if ((kind === "cloud") !== /^mori-share:[a-f0-9]{64}$/.test(input.url))
      throw new Error("分享文件必须使用服务端生成的有效引用");
    const id = createHash("sha256")
      .update(input.url)
      .digest("hex")
      .slice(0, 24);
    const existing = this.store.record<DownloadTask>("task", id);
    const episode = input.title.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
    const year = input.title.match(/\b(19\d{2}|20\d{2})\b/);
    let media: MediaInfo = {
      type: episode ? "tv" : "movie",
      title: input.title.trim(),
      ...(year ? { year: Number(year[1]) } : {}),
      ...(episode
        ? { season: Number(episode[1]), episode: Number(episode[2]) }
        : {}),
    };
    if (input.media) {
      const m = input.media;
      if (
        !["movie", "tv"].includes(m.type) ||
        typeof m.title !== "string" ||
        !m.title.trim() ||
        m.title.length > 300
      )
        throw new Error("影片信息不正确");
      for (const value of [m.year, m.season, m.episode, m.tmdbId])
        if (
          value !== undefined &&
          (!Number.isInteger(value) || value < 0 || value > 99999999)
        )
          throw new Error("年份或集数不正确");
      if (
        m.type === "tv" &&
        (m.season === undefined || m.episode === undefined)
      )
        throw new Error("电视剧下载请先确认季号与集号");
      media = { ...m, title: m.title.trim() };
    }
    if (existing) {
      if (input.media) {
        const a = existing.media,
          b = media;
        const sameUrlIdentity =
          a.type === b.type &&
          (a.tmdbId || b.tmdbId
            ? Boolean(a.tmdbId && b.tmdbId && a.tmdbId === b.tmdbId)
            : a.title.normalize("NFKC").toLocaleLowerCase() ===
                b.title.normalize("NFKC").toLocaleLowerCase() &&
              a.year === b.year) &&
          (b.type !== "tv" ||
            (a.season === b.season && a.episode === b.episode));
        if (!sameUrlIdentity)
          throw new Error(
            "此资源链接已关联另一作品，不能将旧任务作为当前作品的完成结果",
          );
      }
      return this.watchTask(existing, destination);
    }
    if (input.media) {
      const same = this.tasks().find(
        (task) =>
          ["queued", "downloading", "scraping", "completed", "paused"].includes(
            task.status,
          ) && sameMedia(task.media, media),
      );
      if (same) return this.watchTask(same, destination);
    }
    if (this.tasks().length >= 5000)
      throw new Error("任务记录已达到 5000 条，请先导出并整理记录");
    const now = new Date().toISOString();
    const task: DownloadTask = {
      id,
      title: input.title.trim(),
      url: input.url,
      kind,
      status:
        kind === "share" || kind === "telegram" ? "needs_attention" : "queued",
      progress: 0,
      bytes: 0,
      total: 0,
      media,
      profile: this.store.config().library.profile,
      createdAt: now,
      updatedAt: now,
      generation: 1,
    };
    if (task.status === "needs_attention")
      task.error =
        "这是分享页或频道消息，尚未解析为媒体文件。请通过 OpenList 提供已挂载文件路径，或输入已授权的文件直链。";
    this.save(task);
    // 与任务创建同一事务：不会出现「有任务没记录」。
    recordTaskAudit(
      this.store,
      task,
      context.origin,
      context.owner ?? ownerFromDestination(destination),
    );
    queueMicrotask(() => this.pump());
    return this.watchTask(task, destination);
  }
  action(id: string, action: string) {
    const task = this.store.transaction(() => this.actionInternal(id, action));
    if (action === "pause" || action === "cancel") this.active.get(id)?.abort();
    else this.pump();
    return task;
  }
  private actionInternal(id: string, action: string) {
    const task = this.store.record<DownloadTask>("task", id);
    if (!task) throw new Error("任务不存在");
    if (action === "pause" || action === "cancel") {
      if (task.status === "completed")
        throw new Error("已完成任务不能暂停或取消");
      if (action === "pause" && !["queued", "downloading", "scraping", "paused"].includes(task.status))
        throw new Error("当前任务不能暂停");
      task.status = action === "pause" ? "paused" : "cancelled";
      this.save(task);
      if (action === "cancel") this.notifications.cancel(task);
    } else if (action === "resume" || action === "retry") {
      if (this.active.has(id)) throw new Error("任务正在停止，请稍后重试");
      if (task.status === "completed") throw new Error("任务已经完成");
      if (task.kind === "share" || task.kind === "telegram")
        throw new Error("请先将分享链接解析为文件直链或 OpenList 路径");
      if (task.status === "failed" || task.status === "cancelled")
        task.generation = (task.generation || 1) + 1;
      task.status = "queued";
      task.error = undefined;
      this.watchTask(task);
      this.notifications.prepare(task);
      this.save(task);
    } else throw new Error("未知任务操作");
    return task;
  }
  subscribe(
    query: string,
    autoDownload = false,
    media?: MediaInfo,
    startEpisode?: number,
    destination?: NotificationDestination,
  ) {
    const sub = this.store.transaction(() => {
      const sub = this.subscribeInternal(query, autoDownload, media, startEpisode);
      this.notifications.watchSubscription(sub.id, WEB_DESTINATION);
      if (destination && destination.platform !== "web")
        this.notifications.watchSubscription(sub.id, destination);
      return sub;
    });
    this.subscriptionChecks.get(sub.id)?.controller.abort();
    return sub;
  }
  subscribeDirectory(
    input: ShareSubscriptionInput,
    destination?: NotificationDestination,
  ) {
    const { query, reference } = input;
    let { media, startEpisode } = input;
    if (typeof query !== "string" || !query.trim() || query.length > 200)
      throw new Error("订阅关键词长度应为 1–200 字");
    if (
      !media ||
      !["movie", "tv"].includes(media.type) ||
      typeof media.title !== "string" ||
      !media.title.trim() ||
      !Number.isInteger(media.year) ||
      media.year! < 1870 ||
      media.year! > 2200 ||
      (media.type === "tv" &&
        (!Number.isInteger(media.season) || media.season! < 0 || media.season! > 999))
    )
      throw new Error("目录订阅需要完整作品年份和季数");
    if (media.type === "tv") {
      startEpisode ??= media.episode;
      media = { ...media, episode: undefined };
    }
    if (
      startEpisode !== undefined &&
      (!Number.isInteger(startEpisode) || startEpisode < 1 || startEpisode > 9999)
    )
      throw new Error("开始集数无效");
    if (!this.media.shareDirectory || !this.media.scanShare)
      throw new Error("当前分享来源不支持目录订阅");
    const share = this.media.shareDirectory(reference);
    const sub = this.store.transaction(() => {
      const existing = this.subscriptions().find(
        (current) => current.share?.reference === share.reference && current.media &&
          sameMedia(
            { ...current.media, episode: current.media.type === "tv" ? 1 : undefined },
            { ...media, episode: media.type === "tv" ? 1 : undefined },
          ),
      );
      let current: Subscription;
      if (existing) {
        current = existing;
        if (!current.autoDownload || current.startEpisode !== startEpisode) current.seen = [];
        Object.assign(current, {
          enabled: true,
          autoDownload: true,
          startEpisode,
          nextCheckAt: new Date().toISOString(),
        });
      } else {
        if (this.subscriptions().length >= 100) throw new Error("最多可创建 100 条订阅");
        current = {
          id: randomUUID(), title: query.trim(), query: query.trim(),
          enabled: true, autoDownload: true, media: structuredClone(media), startEpisode,
          share: structuredClone(share), scan: { pending: [], complete: false },
          seen: [], createdAt: new Date().toISOString(), nextCheckAt: new Date().toISOString(),
        };
      }
      this.store.put("subscription", current);
      this.notifications.watchSubscription(current.id, WEB_DESTINATION);
      if (destination && destination.platform !== "web")
        this.notifications.watchSubscription(current.id, destination);
      return current;
    });
    this.subscriptionChecks.get(sub.id)?.controller.abort();
    return sub;
  }
  private subscribeInternal(
    query: string,
    autoDownload = false,
    media?: MediaInfo,
    startEpisode?: number,
  ) {
    if (media?.type === "tv") {
      startEpisode ??= media.episode;
      media = { ...media, episode: undefined };
    }
    if (typeof query !== "string" || !query.trim() || query.length > 200)
      throw new Error("订阅关键词长度应为 1–200 字");
    if (autoDownload && !media)
      throw new Error("请先确认作品身份和季集，再开启自动下载");
    if (
      media &&
      (!["movie", "tv"].includes(media.type) ||
        !media.title ||
        (media.type === "tv" &&
          (!Number.isInteger(media.season) || media.season! < 0)))
    )
      throw new Error("订阅作品信息不完整，电视剧需要确认季数");
    if (
      startEpisode !== undefined &&
      (!Number.isInteger(startEpisode) ||
        startEpisode < 1 ||
        startEpisode > 9999)
    )
      throw new Error("开始集数无效");
    const existing = this.subscriptions().filter((x) => !x.share).find((x) =>
      media && x.media
        ? sameMedia(
            { ...x.media, episode: x.media.type === "tv" ? 1 : undefined },
            { ...media, episode: media.type === "tv" ? 1 : undefined },
          )
        : !x.media && x.query.toLowerCase() === query.trim().toLowerCase(),
    );
    if (existing) {
      if (media) {
        if (!existing.media) {
          existing.media = structuredClone(media);
          existing.seen = [];
        }
        if (autoDownload && !existing.autoDownload) {
          existing.autoDownload = true;
          existing.seen = [];
        }
        if (autoDownload) existing.enabled = true;
        if (
          startEpisode !== undefined &&
          startEpisode !== existing.startEpisode
        ) {
          existing.startEpisode = startEpisode;
          existing.seen = [];
        }
        this.store.put("subscription", existing);
      }
      return existing;
    }
    if (this.subscriptions().length >= 100)
      throw new Error("最多可创建 100 条订阅");
    const sub: Subscription = {
      id: randomUUID(),
      title: query.trim(),
      query: query.trim(),
      enabled: true,
      autoDownload,
      ...(media ? { media: structuredClone(media), startEpisode } : {}),
      createdAt: new Date().toISOString(),
      seen: [],
    };
    this.store.put("subscription", sub);
    return sub;
  }
  check(id: string): Promise<Subscription | undefined> {
    const existing = this.subscriptionChecks.get(id);
    if (existing) return existing.promise;
    if (this.stopped) return Promise.resolve(undefined);
    if (this.subscriptionChecks.size >= 3)
      return Promise.reject(Object.assign(new Error("订阅检查并发已达上限，请稍后重试"), { status: 429 }));
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      const sub = this.store.record<Subscription>("subscription", id);
      if (controller.signal.aborted || this.stopped) return sub;
      if (!sub) throw Object.assign(new Error("订阅不存在"), { status: 404 });
      if (!sub.enabled) return sub;
      return sub.share
        ? this.checkDirectory(id, controller.signal)
        : this.checkAggregate(id, controller.signal);
    }).finally(() => {
      if (this.subscriptionChecks.get(id)?.promise === promise)
        this.subscriptionChecks.delete(id);
    });
    this.subscriptionChecks.set(id, { controller, promise });
    return promise;
  }
  private checkFailure(id: string, error: unknown, signal: AbortSignal, clearDiagnostics = false) {
    const sub = this.store.record<Subscription>("subscription", id);
    if (!sub || signal.aborted || this.stopped) return sub;
    if (clearDiagnostics) sub.searchDiagnostics = undefined;
    sub.lastCheckedAt = new Date().toISOString();
    sub.lastError = error instanceof Error ? error.message : "订阅检查失败";
    if (typeof error === "object" && error !== null && "code" in error && error.code === "scan_limit")
      sub.enabled = false;
    sub.nextCheckAt = new Date(Date.now() + (sub.share &&
      (sub.scan?.pending.length || !sub.scan?.complete) ? 15_000 : 30 * 60_000)).toISOString();
    this.store.put("subscription", sub);
    return sub;
  }
  private async checkDirectory(id: string, signal: AbortSignal) {
    let sub = this.store.record<Subscription>("subscription", id)!;
    if (signal.aborted || this.stopped) return sub;
    if (sub.searchDiagnostics) {
      sub.searchDiagnostics = undefined;
      sub.lastError = undefined;
      sub.lastSummary = undefined;
      this.store.put("subscription", sub);
    }
    try {
      if (!sub.autoDownload) {
        sub.lastCheckedAt = new Date().toISOString();
        sub.nextCheckAt = new Date(Date.now() + 30 * 60_000).toISOString();
        sub.lastError = undefined;
        sub.lastSummary = "目录自动下载已关闭，保留扫描进度";
        this.store.put("subscription", sub);
        return sub;
      }
      if (!sub.media || !sub.share || !this.media.scanShare)
        throw new Error("目录订阅信息不完整，无法检查");
      let scan = sub.scan ?? { pending: [], complete: false };
      if (!scan.pending.length) {
        const page = await this.media.scanShare(
          sub.share.reference, scan.complete ? undefined : scan.cursor, signal,
        );
        sub = this.store.record<Subscription>("subscription", id)!;
        if (signal.aborted || this.stopped || !sub || !sub.enabled || !sub.autoDownload)
          return sub;
        if (!Array.isArray(page.files) || page.files.length > 20 ||
          typeof page.complete !== "boolean" || (!page.complete && !page.cursor))
          throw new Error("分享目录扫描返回了无效分页");
        scan = structuredClone({ pending: page.files, cursor: page.cursor, complete: page.complete });
        sub.scan = scan;
        this.store.put("subscription", sub);
      }
      const candidates = scan.pending.map((entry) => ({
        entry,
        matched: matchDirectoryResource(entry.resource, sub.media!, entry.directories),
      })).filter(({ entry, matched }) =>
        !sub.seen.includes(entry.resource.id) &&
        ["direct", "openlist", "magnet", "cloud"].includes(entry.resource.kind) &&
        matched.match === "matched" && matched.media &&
        (matched.media.type !== "tv" || (matched.media.episode ?? 0) >= (sub.startEpisode ?? 1)),
      ).sort((a, b) => (a.matched.media?.episode ?? 0) - (b.matched.media?.episode ?? 0));
      scan.pending = candidates.map(({ entry }) => entry);
      sub.scan = scan;
      this.store.put("subscription", sub);
      const knownTasks = new Set(this.tasks().map((task) => task.id));
      let added = 0;
      let admitted = 0;
      for (const { entry, matched } of candidates.slice(0, 10)) {
        if (signal.aborted || this.stopped) return this.store.record<Subscription>("subscription", id);
        const result = this.store.transaction(() => {
          const current = this.store.record<Subscription>("subscription", id);
          if (!current || !current.enabled || !current.autoDownload || signal.aborted || this.stopped)
            return undefined;
          const task = this.add({
            title: entry.resource.title, url: entry.resource.url,
            kind: entry.resource.kind, media: matched.media,
          }, undefined, { origin: "subscription", owner: "system:subscription" });
          this.notifications.inheritSubscription(id, task);
          current.scan!.pending = current.scan!.pending.filter(
            (file) => file.resource.id !== entry.resource.id,
          );
          current.seen = [...new Set([entry.resource.id, ...current.seen])].slice(0, 1000);
          this.store.put("subscription", current);
          return { task, current };
        });
        if (!result) return this.store.record<Subscription>("subscription", id);
        sub = result.current;
        admitted++;
        if (!knownTasks.has(result.task.id)) { added++; knownTasks.add(result.task.id); }
      }
      sub = this.store.record<Subscription>("subscription", id)!;
      if (signal.aborted || this.stopped || !sub || !sub.enabled || !sub.autoDownload) return sub;
      const continuing = Boolean(sub.scan?.pending.length || !sub.scan?.complete);
      sub.lastCheckedAt = new Date().toISOString();
      sub.nextCheckAt = new Date(Date.now() + (continuing ? 15_000 : 30 * 60_000)).toISOString();
      sub.lastError = undefined;
      sub.lastSummary = `目录本批确认 ${admitted} 个文件，新增 ${added} 个下载任务${continuing ? "；稍后继续扫描" : "；本轮扫描完成"}`;
      this.store.put("subscription", sub);
      return sub;
    } catch (error) {
      return this.checkFailure(id, error, signal);
    }
  }
  private async checkAggregate(id: string, signal: AbortSignal) {
    let sub = this.store.record<Subscription>("subscription", id);
    if (!sub) throw new Error("订阅不存在");
    let reportProduced = false;
    try {
      const searchQuery = sub.media
        ? [
            sub.media.title,
            sub.media.year,
            sub.media.type === "tv"
              ? `S${String(sub.media.season).padStart(2, "0")}`
              : undefined,
          ]
            .filter((value) => value !== undefined && value !== "")
            .join(" ")
        : sub.query;
      const { results, diagnostics } = await searchWithDiagnostics(this.media, searchQuery, signal);
      reportProduced = true;
      sub = this.store.record<Subscription>("subscription", id);
      if (!sub || signal.aborted || this.stopped || !sub.enabled) return sub;
      const summary = searchDiagnosticSummary(diagnostics);
      sub.searchDiagnostics = diagnostics;
      if (diagnostics.status === "failed" || diagnostics.status === "not_configured") {
        sub.lastSummary = summary;
        this.store.put("subscription", sub);
        return this.checkFailure(id, new Error(summary), signal);
      }
      this.store.put("subscription", sub);
      const novel = results.filter((r) => !sub!.seen.includes(r.id));
      const processed: string[] = [];
      const knownTasks = new Set(this.tasks().map((task) => task.id));
      let added = 0;
      if (sub.enabled && sub.autoDownload && sub.media) {
        const candidates = novel
          .map((result) => ({
            result,
            matched: matchResource(result, sub!.media!),
          }))
          .filter(
            ({ result, matched }) =>
              ["direct", "openlist", "magnet"].includes(result.kind) &&
              matched.match === "matched" &&
              matched.media &&
              (matched.media.type !== "tv" ||
                (matched.media.episode ?? 0) >= (sub!.startEpisode ?? 1)),
          )
          .sort(
            (a, b) =>
              (a.matched.media?.episode ?? 0) - (b.matched.media?.episode ?? 0),
          );
        for (const { result, matched } of candidates.slice(0, 10)) {
          const task = this.store.transaction(() => {
            const added = this.add({
            title: result.title,
            url: result.url,
            kind: result.kind,
            media: matched.media,
            }, undefined, { origin: "subscription", owner: "system:subscription" });
            this.notifications.inheritSubscription(sub!.id, added);
            return added;
          });
          if (!knownTasks.has(task.id)) {
            added++;
            knownTasks.add(task.id);
          }
          processed.push(result.id);
        }
      }
      sub.seen = [
        ...new Set([
          ...(sub.autoDownload ? processed : results.map((r) => r.id)),
          ...sub.seen,
        ]),
      ].slice(0, 1000);
      const identityWarning =
        sub.autoDownload && !sub.media
          ? "旧订阅尚未确认作品身份，自动下载已停止"
          : undefined;
      sub.lastError = [identityWarning, summary].filter(Boolean).join("；") || undefined;
      sub.lastSummary = diagnostics.status === "partial" && !results.length
        ? summary
        : `找到 ${novel.length} 个新结果，新增 ${added} 个下载任务${sub.autoDownload && novel.length > processed.length ? "；其余待身份确认、资源解析或下一批检查" : ""}${summary ? `；${summary}` : ""}`;
      sub.lastCheckedAt = new Date().toISOString();
      sub.nextCheckAt = new Date(Date.now() + 30 * 60_000).toISOString();
      this.store.put("subscription", sub);
      return sub;
    } catch (e) {
      return this.checkFailure(id, e, signal, !reportProduced);
    }
  }
  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      this.pump();
      if (!this.polling && !this.stopped)
        this.polling = this.poll().catch(() => {
          console.error("订阅检查调度失败，请检查订阅状态");
        }).finally(() => { this.polling = undefined; });
    }, 15000);
    this.timer.unref();
    this.pump();
  }
  private async poll() {
    if (this.stopped) return;
    const now = Date.now();
    const due = this.subscriptions().filter((sub) => {
      const deadline = sub.nextCheckAt ? Date.parse(sub.nextCheckAt)
        : sub.lastCheckedAt ? Date.parse(sub.lastCheckedAt) + 30 * 60_000 : 0;
      return sub.enabled && !this.subscriptionChecks.has(sub.id) && (!Number.isFinite(deadline) || deadline <= now);
    }).sort((a, b) =>
      Date.parse(a.lastCheckedAt ?? a.createdAt) - Date.parse(b.lastCheckedAt ?? b.createdAt) ||
      a.id.localeCompare(b.id),
    );
    const checks = due.slice(0, Math.max(0, 3 - this.subscriptionChecks.size)).map((sub) => this.check(sub.id));
    for (const result of await Promise.allSettled(checks))
      if (result.status === "rejected") console.error("订阅检查调度失败，请检查订阅状态");
  }
  private pump() {
    if (this.stopped) return;
    const capacity =
      this.store.config().download.concurrency - this.active.size;
    if (capacity <= 0) return;
    for (const task of this.tasks()
      .filter((t) => t.status === "queued")
      .reverse()
      .slice(0, capacity)) {
      const controller = new AbortController();
      this.active.set(task.id, controller);
      const running = this.run(task, controller);
      this.running.add(running);
      void running
        .finally(() => this.running.delete(running))
        .catch(() => console.error("任务执行器异常终止，请检查任务状态"));
    }
  }
  private async run(task: DownloadTask, controller: AbortController) {
    const downloadRoot = this.store.config().download.directory;
    try {
      task.status = task.path ? "scraping" : "downloading";
      task.error = undefined;
      this.save(task);
      let last = 0;
      let file = task.path;
      if (file) {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0)
          throw new Error("已记录的媒体文件不可用，请检查原下载目录");
      } else
        file = await this.media.download(task, controller.signal, (p) => {
          if (Date.now() - last < 700) return;
          last = Date.now();
          const current = this.store.record<DownloadTask>("task", task.id);
          if (current?.status === "downloading") {
            Object.assign(task, p);
            this.save(task);
          }
        });
      if (!task.path && !task.downloadRoot) task.downloadRoot = downloadRoot;
      const finishedFile = await lstat(file);
      if (
        !finishedFile.isFile() ||
        finishedFile.isSymbolicLink() ||
        finishedFile.size <= 0
      )
        throw new Error("下载器未返回有效的实际媒体文件");
      if (controller.signal.aborted) {
        const interrupted = this.store.record<DownloadTask>("task", task.id);
        if (interrupted)
          this.save({
            ...interrupted,
            path: file,
            bytes: finishedFile.size,
            total: finishedFile.size,
            error: "媒体文件已落盘，后续整理已停止；继续时会复用此文件",
          });
        return;
      }
      task.bytes = finishedFile.size;
      task.total = finishedFile.size;
      task.path = file;
      task.status = "scraping";
      task.progress = 100;
      this.save(task);
      const result = await this.media.scrape(
        file,
        task.media,
        task.profile,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      task.status = "completed";
      task.error = result.warnings.join("；") || undefined;
      this.save(task);
      await this.verifyLibrary(task.id, controller.signal);
      this.store.transaction(() => {
        const finished = this.store.record<DownloadTask>("task", task.id);
        if (finished?.status === "completed") this.notifications.terminal(finished);
      });
    } catch (e) {
      const current = this.store.record<DownloadTask>("task", task.id);
      if (
        current &&
        current.status !== "paused" &&
        current.status !== "cancelled"
      ) {
        task.status = "failed";
        task.error = e instanceof Error ? e.message : "下载失败";
        this.store.transaction(() => {
          this.save(task);
          this.notifications.terminal(task);
        });
      }
    } finally {
      this.active.delete(task.id);
      this.pump();
    }
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const [id, c] of this.active) {
      const task = this.store.record<DownloadTask>("task", id);
      if (task && task.status !== "completed")
        this.save({
          ...task,
          status: "paused",
          error: "服务关闭，等待手动继续",
        });
      c.abort();
    }
    for (const check of this.verifying.values()) check.controller.abort();
    for (const check of this.subscriptionChecks.values()) check.controller.abort();
    await Promise.allSettled([...this.running]);
    await Promise.allSettled(
      [...this.verifying.values()].map((check) => check.promise),
    );
    await Promise.allSettled([
      ...[...this.subscriptionChecks.values()].map((check) => check.promise),
      ...(this.polling ? [this.polling] : []),
    ]);
  }
}
