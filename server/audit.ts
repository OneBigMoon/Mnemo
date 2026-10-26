/**
 * 操作审计：任务创建 + 审批决定的统一留痕。
 *
 * 两类事件分开存（`audit` 与既有的 `approval`），读取时合并成一条时间线，
 * 这样审批历史不必迁移，任务审计也不会和决定混在一张表里。
 *
 * 写入都在调用方的事务内完成：任务审计跟任务创建同生共死，
 * 不会出现「有任务没记录」。
 */
import type {
  ApprovalRecord,
  AuditEntry,
  AuditOrigin,
  DownloadTask,
  NotificationDestination,
} from "../shared/types.js";
import type { Store } from "./store.js";

export const AUDIT_KIND = "audit";
/** 任务审计上限；超出按时间丢弃最旧的。 */
export const MAX_TASK_AUDIT = 500;

type TaskAuditRow = {
  id: string;
  at: string;
  origin: AuditOrigin;
  owner: string;
  title: string;
  detail: string;
};

/** 没有显式归属时，从通知目标反推一个可读的归属标识。 */
export function ownerFromDestination(destination?: NotificationDestination): string {
  if (!destination || destination.platform === "web") return "web:admin";
  return destination.botId
    ? `${destination.platform}:${destination.botId}:${destination.peer}`
    : `${destination.platform}:${destination.peer}`;
}

export function recordTaskAudit(
  store: Store,
  task: DownloadTask,
  origin: AuditOrigin,
  owner: string,
) {
  store.put<TaskAuditRow>(AUDIT_KIND, {
    id: task.id,
    at: task.createdAt,
    origin,
    owner: owner.slice(0, 300),
    title: task.title.slice(0, 200),
    detail: task.kind,
  });
  const rows = store.list<TaskAuditRow>(AUDIT_KIND);
  if (rows.length <= MAX_TASK_AUDIT) return;
  rows
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(MAX_TASK_AUDIT)
    .forEach((row) => store.remove(AUDIT_KIND, row.id));
}

/** 合并任务审计与审批历史，最新的在前。 */
export function listAudit(store: Store, limit = 50): AuditEntry[] {
  const size = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_TASK_AUDIT) : 50;
  const tasks: AuditEntry[] = store.list<TaskAuditRow>(AUDIT_KIND).map((row) => ({
    id: `task:${row.id}`,
    at: row.at,
    type: "task",
    owner: row.owner,
    title: row.title,
    origin: row.origin,
    detail: row.detail,
  }));
  const approvals: AuditEntry[] = store.list<ApprovalRecord>("approval").map((row) => ({
    id: `approval:${row.id}`,
    at: row.at,
    type: "approval",
    owner: row.owner,
    title: row.query,
    outcome: row.outcome,
    detail: row.by,
  }));
  return [...tasks, ...approvals]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, size);
}
