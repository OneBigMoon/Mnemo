import { createHash, randomUUID } from "node:crypto";
import type {
  DownloadTask,
  NotificationClaim,
  NotificationDestination,
  NotificationService,
  TaskNotification,
} from "../shared/types.js";
import { Store } from "./store.js";

const KIND = "notification";
const MAX_WATCHERS = 8;
const CLAIM_LEASE_MS = 120_000;
export const NOTIFICATION_ACTIVE_LIMIT = 5000;
export const NOTIFICATION_HISTORY_LIMIT = 500;

type Watcher = {
  id: string;
  destination: NotificationDestination;
  lastDeliveredEvent?: string;
  lastSettledGeneration?: number;
};

function failure(message: string, status = 409) {
  return Object.assign(new Error(message), { status });
}

function destination(input: NotificationDestination): NotificationDestination {
  if (
    !input ||
    !["web", "telegram", "wechat", "qq", "feishu"].includes(input.platform) ||
    typeof input.peer !== "string" ||
    !input.peer.trim() ||
    input.peer.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(input.peer)
  )
    throw failure("通知接收方无效", 400);
  if (input.platform === "telegram") {
    if (
      typeof input.botId !== "string" ||
      !/^[1-9]\d{0,19}$/.test(input.botId) ||
      !/^-?[1-9]\d{0,19}$/.test(input.peer)
    )
      throw failure("Telegram 通知需要有效的 bot ID 和 chat ID", 400);
    return { platform: input.platform, peer: input.peer, botId: input.botId };
  }
  if (input.botId !== undefined || (input.platform === "web" && input.peer !== "admin"))
    throw failure("通知接收方无效", 400);
  return { platform: input.platform, peer: input.peer };
}

function identity(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function generation(task: DownloadTask) {
  const value = task.generation ?? 1;
  if (!Number.isSafeInteger(value) || value < 1)
    throw failure("任务通知代次无效", 400);
  if (typeof task.id !== "string" || !task.id || task.id.length > 256)
    throw failure("任务通知标识无效", 400);
  return value;
}

function watcherKind(taskId: string) {
  return `notification-watch-task:${taskId}`;
}

function event(task: DownloadTask) {
  return task.status === "completed" || task.status === "failed"
    ? task.status
    : undefined;
}

function label(value: string, length: number) {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+|magnet:\S+|(?:[A-Za-z]:[\\/]|\\\\)\S+|\/\S+/giu, " [已隐藏]")
    .trim()
    .slice(0, length);
}

function message(task: DownloadTask) {
  const library = {
    not_configured: "未配置",
    pending: "待验证",
    verified: "已验证",
    failed: "同步失败",
    unsupported: "不支持",
  }[task.library?.status ?? "not_configured"];
  return `${label(task.title, 160) || "任务"}（${label(task.id, 80)}）：${task.status === "completed" ? "已完成" : "失败"}；媒体库：${library}`;
}

function settled(record: TaskNotification) {
  return record.status === "delivered" || record.status === "rejected" || record.status === "dismissed";
}

export class Notifications implements NotificationService {
  constructor(private store: Store) {
    store.transaction(() => {
      for (const record of store.list<TaskNotification>(KIND)) {
        if (record.status === "dispatching") {
          store.put(KIND, {
            ...record,
            status: "unknown",
            error: "发送已中断，结果未确认",
            updatedAt: new Date().toISOString(),
          });
        } else if (record.status === "waiting") {
          const task = store.record<DownloadTask>("task", record.taskId);
          if (task && generation(task) === record.generation) {
            if (event(task)) this.publish(record, task);
            else if (task.status === "cancelled") this.settle(record, "dismissed");
          }
        }
      }
      this.prune();
    });
  }

  private watch(kind: string, target: NotificationDestination) {
    const id = identity(target);
    const existing = this.store.record<Watcher>(kind, id);
    if (existing) return existing;
    if (this.store.list<Watcher>(kind).length >= MAX_WATCHERS)
      throw failure("每个任务或订阅最多支持 8 个通知接收方", 429);
    const watcher: Watcher = { id, destination: target };
    this.store.put(kind, watcher);
    return watcher;
  }

  private reserve(task: DownloadTask, watchers: Watcher[]) {
    const currentGeneration = generation(task);
    const additions = watchers.flatMap((watcher) => {
      const id = identity([task.id, currentGeneration, watcher.destination]);
      if (
        (watcher.lastSettledGeneration ?? 0) >= currentGeneration ||
        this.store.record<TaskNotification>(KIND, id)
      )
        return [];
      return [{ id, watcher }];
    });
    if (!additions.length) return;
    if (
      this.store.list<TaskNotification>(KIND).filter((record) => !settled(record)).length +
        additions.length > NOTIFICATION_ACTIVE_LIMIT
    )
      throw failure("通知队列已满，请先处理待确认的通知", 429);
    const now = new Date().toISOString();
    for (const { id, watcher } of additions)
      this.store.put<TaskNotification>(KIND, {
        id,
        taskId: task.id,
        generation: currentGeneration,
        destination: watcher.destination,
        status: "waiting",
        text: "",
        createdAt: now,
        updatedAt: now,
        attempts: 0,
      });
  }

  watchTask(task: DownloadTask, input: NotificationDestination) {
    const target = destination(input);
    this.store.transaction(() => {
      this.reserve(task, [this.watch(watcherKind(task.id), target)]);
      if (event(task)) this.terminal(task);
      else if (task.status === "cancelled") this.cancel(task);
    });
  }

  watchSubscription(id: string, input: NotificationDestination) {
    const target = destination(input);
    if (typeof id !== "string" || !id || id.length > 256)
      throw failure("订阅通知标识无效", 400);
    this.store.transaction(() => {
      this.watch(`notification-watch-subscription:${id}`, target);
    });
  }

  inheritSubscription(id: string, task: DownloadTask) {
    this.store.transaction(() => {
      for (const watcher of this.store.list<Watcher>(`notification-watch-subscription:${id}`))
        this.watchTask(task, watcher.destination);
    });
  }

  unwatchSubscription(id: string) {
    this.store.transaction(() => {
      const kind = `notification-watch-subscription:${id}`;
      for (const watcher of this.store.list<Watcher>(kind))
        this.store.remove(kind, watcher.id);
    });
  }

  /**
   * 排入一条与下载任务无关的消息（例如审批结果）。
   *
   * 不走 watch/prepare：这里没有任务可等，直接进 pending 队列，由 `claim()`
   * 按目标身份领取。`ref` 参与去重键，同一件事重复调用只排一条。
   */
  message(input: NotificationDestination, ref: string, text: string) {
    const target = destination(input);
    if (typeof ref !== "string" || !ref || ref.length > 200)
      throw failure("通知标识无效", 400);
    const body = label(text, 300);
    if (!body) throw failure("通知内容为空", 400);
    const id = identity(["message", ref, target]);
    this.store.transaction(() => {
      if (this.store.record<TaskNotification>(KIND, id)) return;
      if (
        this.store.list<TaskNotification>(KIND).filter((record) => !settled(record)).length >=
        NOTIFICATION_ACTIVE_LIMIT
      )
        throw failure("通知队列已满，请先处理待确认的通知", 429);
      const now = new Date().toISOString();
      this.store.put<TaskNotification>(KIND, {
        id,
        taskId: ref,
        generation: 0,
        destination: target,
        status: "pending",
        event: "message",
        text: body,
        createdAt: now,
        updatedAt: now,
        attempts: 0,
      });
    });
  }

  prepare(task: DownloadTask) {
    this.store.transaction(() => {
      this.reserve(task, this.store.list<Watcher>(watcherKind(task.id)));
    });
  }

  private publish(record: TaskNotification, task: DownloadTask) {
    this.store.put<TaskNotification>(KIND, {
      ...record,
      status: "pending",
      event: event(task),
      text: message(task),
      updatedAt: new Date().toISOString(),
    });
  }

  terminal(task: DownloadTask) {
    if (!event(task)) return;
    const currentGeneration = generation(task);
    this.store.transaction(() => {
      for (const watcher of this.store.list<Watcher>(watcherKind(task.id))) {
        const id = identity([task.id, currentGeneration, watcher.destination]);
        const record = this.store.record<TaskNotification>(KIND, id);
        if (!record) {
          if ((watcher.lastSettledGeneration ?? 0) >= currentGeneration) continue;
          throw failure("任务通知未预留，无法提交任务结果");
        }
        if (record.status === "waiting") this.publish(record, task);
      }
    });
  }

  cancel(task: DownloadTask) {
    const currentGeneration = generation(task);
    this.store.transaction(() => {
      for (const watcher of this.store.list<Watcher>(watcherKind(task.id))) {
        const id = identity([task.id, currentGeneration, watcher.destination]);
        const record = this.store.record<TaskNotification>(KIND, id);
        if (record?.status === "waiting") this.settle(record, "dismissed");
      }
      this.prune();
    });
  }

  private expireClaims() {
    const records = this.store.list<TaskNotification>(KIND);
    const now = Date.now();
    for (const record of records) {
      if (
        record.status === "dispatching" &&
        (!record.claimExpiresAt || Date.parse(record.claimExpiresAt) <= now)
      ) {
        record.status = "unknown";
        record.error = "发送确认已超时，结果未确认";
        record.updatedAt = new Date(now).toISOString();
        this.store.put(KIND, record);
      }
    }
    return records;
  }

  list() {
    return this.store.transaction(() => this.expireClaims());
  }

  claim(input: NotificationDestination, limit = 10): NotificationClaim[] {
    const target = destination(input);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw failure("每次只能领取 1–10 条通知", 400);
    return this.store.transaction(() => {
      const records = this.expireClaims()
        .filter((record) => record.status === "pending" && identity(record.destination) === identity(target))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit);
      const now = new Date().toISOString();
      return records.map((record) => {
        const claimToken = randomUUID();
        const expiresAt = new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
        this.store.put<TaskNotification>(KIND, {
          ...record,
          status: "dispatching",
          attempts: record.attempts + 1,
          claimToken,
          claimExpiresAt: expiresAt,
          updatedAt: now,
        });
        return { id: record.id, taskId: record.taskId, text: record.text, claimToken, expiresAt };
      });
    });
  }

  private record(id: string) {
    const record = this.store.record<TaskNotification>(KIND, id);
    if (!record) throw failure("通知不存在", 404);
    return record;
  }

  acknowledge(
    input: NotificationDestination,
    id: string,
    claimToken: string,
    outcome: "delivered" | "unknown" | "rejected",
    receipt?: string,
  ) {
    const target = destination(input);
    if (
      !["delivered", "unknown", "rejected"].includes(outcome) ||
      (receipt !== undefined && (typeof receipt !== "string" || receipt.length > 500 || /[\u0000-\u001f\u007f]/u.test(receipt)))
    )
      throw failure("通知回执无效", 400);
    this.store.transaction(() => {
      this.expireClaims();
      const record = this.record(id);
      if (
        identity(record.destination) !== identity(target) ||
        !claimToken || record.claimToken !== claimToken
      )
        throw failure("通知接收方或领取凭据不匹配");
      if (record.status === outcome && outcome !== "unknown") return;
      if (record.status !== "dispatching" && record.status !== "unknown")
        throw failure("该通知已不接受本次发送的回执");
      const update = { ...record, status: outcome, receipt, updatedAt: new Date().toISOString() };
      if (outcome !== "delivered")
        update.error = outcome === "unknown" ? "发送结果未确认" : "发送被接收方拒绝";
      else delete update.error;
      if (outcome === "unknown") this.store.put(KIND, update);
      else {
        this.settle(update, outcome);
        this.prune();
      }
    });
  }

  retry(id: string, confirmUnknown = false) {
    this.store.transaction(() => {
      this.expireClaims();
      const record = this.record(id);
      if (record.status !== "unknown" && record.status !== "rejected")
        throw failure("只有结果未确认或被拒绝的通知可以重试");
      if (record.status === "unknown" && confirmUnknown !== true)
        throw failure("重试可能重复发送，请明确确认后再试");
      if (
        record.status === "rejected" &&
        this.store.list<TaskNotification>(KIND).filter((entry) => !settled(entry)).length >= NOTIFICATION_ACTIVE_LIMIT
      )
        throw failure("通知队列已满，请先处理待确认的通知", 429);
      record.status = "pending";
      record.updatedAt = new Date().toISOString();
      delete record.claimToken;
      delete record.claimExpiresAt;
      delete record.receipt;
      delete record.error;
      this.store.put(KIND, record);
    });
  }

  private settle(record: TaskNotification, status: "delivered" | "rejected" | "dismissed") {
    const watcher = this.store.record<Watcher>(watcherKind(record.taskId), identity(record.destination));
    if (watcher) {
      if (status === "delivered") watcher.lastDeliveredEvent = record.id;
      watcher.lastSettledGeneration = Math.max(watcher.lastSettledGeneration ?? 0, record.generation);
      this.store.put(watcherKind(record.taskId), watcher);
    }
    this.store.put<TaskNotification>(KIND, { ...record, status, updatedAt: new Date().toISOString() });
  }

  dismiss(id: string) {
    this.store.transaction(() => {
      this.expireClaims();
      const record = this.record(id);
      if (record.status === "waiting" || record.status === "dispatching")
        throw failure("进行中的通知不能清除");
      if (record.status === "delivered" || record.status === "dismissed") return;
      delete record.claimToken;
      delete record.claimExpiresAt;
      this.settle(record, "dismissed");
      this.prune();
    });
  }

  read(id: string) {
    this.store.transaction(() => {
      const record = this.record(id);
      if (record.destination.platform !== "web" || record.destination.peer !== "admin")
        throw failure("只能标记应用内通知为已读");
      if (record.status === "delivered") return;
      if (record.status !== "pending") throw failure("该通知当前不能标记为已读");
      this.settle(record, "delivered");
      this.prune();
    });
  }

  private prune() {
    const history = this.store.list<TaskNotification>(KIND)
      .filter(settled)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const record of history.slice(NOTIFICATION_HISTORY_LIMIT))
      this.store.remove(KIND, record.id);
  }
}
