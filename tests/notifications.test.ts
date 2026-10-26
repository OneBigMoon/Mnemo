import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.js";
import {
  Notifications,
  NOTIFICATION_ACTIVE_LIMIT,
  NOTIFICATION_HISTORY_LIMIT,
} from "../server/notifications.js";
import type {
  DownloadTask,
  NotificationDestination,
  TaskNotification,
  TaskStatus,
} from "../shared/types.js";

const web: NotificationDestination = { platform: "web", peer: "admin" };
const bridge: NotificationDestination = { platform: "wechat", peer: "fixture:GroupMessage:1" };
const telegram: NotificationDestination = { platform: "telegram", peer: "-10042", botId: "12345" };

function task(id: string, status: TaskStatus = "queued"): DownloadTask {
  return {
    id,
    title: `Fixture ${id}`,
    url: "https://fixture.invalid/video.mp4",
    kind: "direct",
    status,
    progress: 0,
    bytes: 0,
    total: 0,
    media: { type: "movie", title: "Fixture" },
    profile: "emby",
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
  };
}

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mori-notifications-"));
  const store = new Store(path.join(root, "state"), path.join(root, "files"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, notifications: new Notifications(store) };
}

test("task and subscription watchers reserve independent destinations and atomically publish terminal results", (t) => {
  const { store, notifications } = fixture(t);
  const queued = task("multi");
  store.put("task", queued);
  notifications.watchTask(queued, web);
  notifications.watchTask(queued, bridge);
  notifications.watchTask(queued, bridge);
  notifications.watchSubscription("season", telegram);
  notifications.watchSubscription("season", telegram);
  notifications.inheritSubscription("season", queued);
  notifications.prepare(queued);
  const reservations = notifications.list();
  assert.equal(reservations.length, 3);
  assert.ok(reservations.every((record) => record.status === "waiting" && record.generation === 1));
  assert.deepEqual(notifications.claim(bridge), []);
  const completed = { ...queued, status: "completed" as const };
  store.transaction(() => {
    store.put("task", completed);
    notifications.terminal(completed);
  });
  notifications.terminal(completed);
  notifications.watchTask(completed, web);
  const pending = notifications.list();
  assert.deepEqual(new Set(pending.map((record) => record.id)), new Set(reservations.map((record) => record.id)));
  assert.ok(pending.every((record) => record.status === "pending" && record.event === "completed"));
  const claimed = notifications.claim(bridge);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].taskId, queued.id);
  assert.deepEqual(notifications.claim(bridge), []);
  assert.equal(notifications.list().filter((record) => record.status === "pending").length, 2);
});

test("task and subscription watcher caps roll back additional associations", (t) => {
  const { store, notifications } = fixture(t);
  const queued = task("watcher-cap");
  store.put("task", queued);
  for (let i = 0; i < 8; i++) {
    const target: NotificationDestination = { platform: "qq", peer: `fixture-${i}` };
    notifications.watchTask(queued, target);
    notifications.watchSubscription("capped-season", target);
  }
  assert.throws(() => notifications.watchTask(queued, bridge), /最多支持 8/);
  assert.throws(() => notifications.watchSubscription("capped-season", bridge), /最多支持 8/);
  assert.equal(store.list(`notification-watch-task:${queued.id}`).length, 8);
  assert.equal(store.list("notification-watch-subscription:capped-season").length, 8);
  const inherited = task("inherited-cap");
  notifications.watchTask(inherited, web);
  assert.throws(() => notifications.inheritSubscription("capped-season", inherited), /最多支持 8/);
  assert.equal(store.list(`notification-watch-task:${inherited.id}`).length, 1);
  assert.equal(notifications.list().filter((record) => record.taskId === inherited.id).length, 1);
});

test("outer task transactions roll back notification reservations and terminal transitions", (t) => {
  const { store, notifications } = fixture(t);
  const queued = task("rollback");
  store.put("task", queued);
  notifications.watchTask(queued, web);
  assert.throws(() => store.transaction(() => {
    const completed = { ...queued, status: "completed" as const };
    store.put("task", completed);
    notifications.terminal(completed);
    throw new Error("fixture rollback");
  }), /fixture rollback/);
  assert.equal(store.record<DownloadTask>("task", queued.id)!.status, "queued");
  assert.equal(notifications.list()[0].status, "waiting");
  assert.throws(() => store.transaction(() => {
    notifications.watchTask(queued, bridge);
    throw new Error("admission rollback");
  }), /admission rollback/);
  assert.equal(store.list(`notification-watch-task:${queued.id}`).length, 1);
  assert.equal(notifications.list().length, 1);
  const completed = { ...queued, status: "completed" as const };
  store.transaction(() => {
    store.put("task", completed);
    notifications.terminal(completed);
  });
  assert.equal(notifications.list()[0].status, "pending");
});

test("full active capacity backpressures admission and retry while reserved terminal results survive", (t) => {
  const { store, notifications } = fixture(t);
  const queued = task("capacity");
  store.put("task", queued);
  notifications.watchTask(queued, web);
  const reserved = notifications.list()[0];
  store.transaction(() => {
    for (let i = 1; i < NOTIFICATION_ACTIVE_LIMIT; i++)
      store.put("notification", { ...reserved, id: `capacity-${i}`, taskId: `seed-${i}` });
  });
  assert.throws(() => notifications.watchTask(queued, bridge), { status: 429 });
  assert.equal(store.list(`notification-watch-task:${queued.id}`).length, 1);
  const retrying = { ...queued, generation: 2 };
  assert.throws(() => notifications.prepare(retrying), { status: 429 });
  assert.equal(notifications.list().length, NOTIFICATION_ACTIVE_LIMIT);
  const completed = { ...queued, status: "completed" as const };
  store.transaction(() => {
    store.put("task", completed);
    notifications.terminal(completed);
  });
  assert.equal(store.record<TaskNotification>("notification", reserved.id)!.status, "pending");
  notifications.read(reserved.id);
  notifications.watchTask(completed, bridge);
  const claim = notifications.claim(bridge)[0];
  notifications.acknowledge(bridge, claim.id, claim.claimToken, "rejected");
  const replacement = task("replacement", "completed");
  store.put("task", replacement);
  notifications.watchTask(replacement, web);
  assert.throws(() => notifications.retry(claim.id), { status: 429 });
  const replacementNotice = notifications.list().find((record) => record.taskId === replacement.id)!;
  notifications.read(replacementNotice.id);
  notifications.retry(claim.id);
  assert.equal(store.record<TaskNotification>("notification", claim.id)!.status, "pending");
});

test("settled watcher identities survive history pruning for delivered, rejected and dismissed events", (t) => {
  const { store, notifications } = fixture(t);
  const completed = [task("delivered", "completed"), task("rejected", "failed"), task("dismissed", "completed")];
  for (const record of completed) store.put("task", record);
  notifications.watchTask(completed[0], web);
  const delivered = notifications.list()[0];
  notifications.read(delivered.id);
  notifications.read(delivered.id);
  notifications.watchTask(completed[1], bridge);
  const rejected = notifications.claim(bridge)[0];
  notifications.acknowledge(bridge, rejected.id, rejected.claimToken, "rejected");
  notifications.watchTask(completed[2], web);
  notifications.dismiss(notifications.list().find((record) => record.taskId === "dismissed")!.id);
  store.transaction(() => {
    for (let i = 0; i < NOTIFICATION_HISTORY_LIMIT; i++)
      store.put("notification", {
        ...delivered,
        id: `history-${i}`,
        taskId: `history-task-${i}`,
        status: "delivered",
        updatedAt: "2100-01-01T00:00:00.000Z",
      });
  });
  const restored = new Notifications(store);
  assert.equal(restored.list().length, NOTIFICATION_HISTORY_LIMIT);
  assert.ok(restored.list().every((record) => record.id.startsWith("history-")));
  restored.watchTask(completed[0], web);
  restored.watchTask(completed[1], bridge);
  restored.watchTask(completed[2], web);
  assert.equal(restored.list().length, NOTIFICATION_HISTORY_LIMIT);
  for (const record of completed) restored.prepare({ ...record, generation: 2, status: "queued" });
  assert.equal(restored.list().filter((record) => record.status === "waiting" && record.generation === 2).length, 3);
});

test("pause and resume keep a reservation while cancellation dismisses it and retry reserves a new generation", (t) => {
  const { store, notifications } = fixture(t);
  const queued = task("generation");
  notifications.watchTask(queued, web);
  notifications.watchTask(queued, bridge);
  const first = notifications.list().map((record) => record.id);
  const paused = { ...queued, status: "paused" as const };
  notifications.prepare(paused);
  notifications.terminal(paused);
  notifications.prepare(queued);
  assert.deepEqual(notifications.list().map((record) => record.id), first);
  assert.ok(notifications.list().every((record) => record.status === "waiting"));
  assert.throws(() => notifications.dismiss(first[0]), /进行中/);
  const cancelled = { ...queued, status: "cancelled" as const };
  store.transaction(() => {
    store.put("task", cancelled);
    notifications.cancel(cancelled);
  });
  assert.ok(notifications.list().every((record) => record.status === "dismissed" && !record.event && !record.text));
  const retried = { ...queued, generation: 2 };
  store.transaction(() => {
    notifications.prepare(retried);
    store.put("task", retried);
  });
  assert.equal(notifications.list().filter((record) => record.status === "waiting" && record.generation === 2).length, 2);
  const failed = { ...retried, status: "failed" as const };
  store.transaction(() => {
    store.put("task", failed);
    notifications.terminal(failed);
  });
  assert.equal(notifications.list().filter((record) => record.event === "failed" && record.status === "pending").length, 2);
  assert.deepEqual(notifications.list().filter((record) => record.generation === 1).map((record) => record.id), first);
});

test("restart reconciles waiting terminal tasks and fences interrupted sends as unknown", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mori-notification-restart-"));
  const directory = path.join(root, "state");
  let store = new Store(directory, path.join(root, "files"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  let notifications = new Notifications(store);
  const waiting = task("reconcile");
  store.put("task", waiting);
  notifications.watchTask(waiting, web);
  store.put("task", { ...waiting, status: "completed" });
  const interrupted = task("interrupted", "failed");
  store.put("task", interrupted);
  notifications.watchTask(interrupted, bridge);
  const claim = notifications.claim(bridge)[0];
  const cancelled = task("cancelled-restart");
  store.put("task", cancelled);
  notifications.watchTask(cancelled, web);
  store.put("task", { ...cancelled, status: "cancelled" });
  store.close();
  store = new Store(directory, path.join(root, "files"));
  notifications = new Notifications(store);
  const recovered = notifications.list();
  assert.equal(recovered.find((record) => record.taskId === waiting.id)!.status, "pending");
  assert.equal(recovered.find((record) => record.taskId === interrupted.id)!.status, "unknown");
  assert.equal(recovered.find((record) => record.taskId === cancelled.id)!.status, "dismissed");
  assert.deepEqual(notifications.claim(bridge), []);
  assert.throws(() => notifications.retry(claim.id), /明确确认/);
  notifications.acknowledge(bridge, claim.id, claim.claimToken, "delivered", "fixture-receipt");
  assert.equal(notifications.list().find((record) => record.id === claim.id)!.status, "delivered");
});

test("expired claims allow same-attempt late acknowledgement and reject stale tokens after explicit retry", (t) => {
  const { store, notifications } = fixture(t);
  const first = task("late-ack", "completed");
  notifications.watchTask(first, bridge);
  const late = notifications.claim(bridge)[0];
  assert.equal(Date.parse(late.expiresAt) - Date.now() > 119_000, true);
  store.put("notification", { ...store.record<TaskNotification>("notification", late.id)!, claimExpiresAt: "2000-01-01T00:00:00.000Z" });
  assert.equal(notifications.list().find((record) => record.id === late.id)!.status, "unknown");
  assert.deepEqual(notifications.claim(bridge), []);
  assert.throws(() => notifications.retry(late.id), /明确确认/);
  notifications.acknowledge(bridge, late.id, late.claimToken, "delivered", "late-fixture");
  notifications.acknowledge(bridge, late.id, late.claimToken, "delivered", "late-fixture");
  const second = task("new-claim", "completed");
  notifications.watchTask(second, bridge);
  const old = notifications.claim(bridge)[0];
  store.put("notification", { ...store.record<TaskNotification>("notification", old.id)!, claimExpiresAt: "2000-01-01T00:00:00.000Z" });
  notifications.list();
  notifications.retry(old.id, true);
  assert.throws(() => notifications.acknowledge(bridge, old.id, old.claimToken, "delivered"), /凭据不匹配/);
  const current = notifications.claim(bridge)[0];
  assert.equal(current.id, old.id);
  assert.notEqual(current.claimToken, old.claimToken);
  assert.equal(store.record<TaskNotification>("notification", current.id)!.attempts, 2);
  assert.throws(() => notifications.dismiss(current.id), /进行中/);
  assert.throws(() => notifications.acknowledge(bridge, current.id, old.claimToken, "delivered"), /凭据不匹配/);
  const otherPeer: NotificationDestination = { ...bridge, peer: "fixture:GroupMessage:2" };
  assert.throws(() => notifications.acknowledge(otherPeer, current.id, current.claimToken, "delivered"), /接收方/);
  notifications.acknowledge(bridge, current.id, current.claimToken, "delivered");
  assert.throws(() => notifications.retry(current.id, true), /只有结果/);
});

test("unknown and rejected results require explicit action and web reads cannot acknowledge another platform", (t) => {
  const { store, notifications } = fixture(t);
  notifications.watchTask(task("rejected-action", "failed"), bridge);
  let claim = notifications.claim(bridge)[0];
  notifications.acknowledge(bridge, claim.id, claim.claimToken, "rejected");
  assert.deepEqual(notifications.claim(bridge), []);
  assert.throws(() => notifications.read(claim.id), /应用内/);
  notifications.retry(claim.id);
  claim = notifications.claim(bridge)[0];
  notifications.acknowledge(bridge, claim.id, claim.claimToken, "unknown");
  assert.deepEqual(notifications.claim(bridge), []);
  notifications.dismiss(claim.id);
  assert.equal(store.record<TaskNotification>("notification", claim.id)!.status, "dismissed");
  assert.throws(() => notifications.acknowledge(bridge, claim.id, claim.claimToken, "delivered"), /凭据不匹配/);
  assert.throws(() => notifications.retry(claim.id, true), /只有结果/);
});

test("destinations and claim limits are validated and acknowledgements are bound to the bot and peer", (t) => {
  const { notifications } = fixture(t);
  const completed = task("destination", "completed");
  assert.throws(() => notifications.watchTask(completed, { platform: "web", peer: "other" }), /接收方/);
  assert.throws(() => notifications.watchTask(completed, { platform: "telegram", peer: "-10042" }), /bot ID/);
  assert.throws(() => notifications.watchTask(completed, { ...telegram, peer: "name" }), /chat ID/);
  assert.throws(() => notifications.watchTask(completed, { ...bridge, peer: "x".repeat(201) }), /接收方/);
  assert.throws(() => notifications.watchTask(completed, { ...bridge, peer: "peer\nother" }), /接收方/);
  assert.throws(() => notifications.claim(bridge, 11), /1–10/);
  assert.throws(() => notifications.claim(bridge, 0), /1–10/);
  notifications.watchTask(completed, telegram);
  const claim = notifications.claim(telegram, 1)[0];
  assert.throws(() => notifications.acknowledge({ ...telegram, botId: "54321" }, claim.id, claim.claimToken, "delivered"), /接收方/);
  assert.throws(() => notifications.acknowledge(telegram, claim.id, claim.claimToken, "delivered", "x".repeat(501)), /回执无效/);
  notifications.acknowledge(telegram, claim.id, claim.claimToken, "delivered");
});

test("notification text contains bounded result fields without URLs, filesystem paths or raw errors", (t) => {
  const { notifications } = fixture(t);
  const completed: DownloadTask = {
    ...task("safe-id", "completed"),
    title: `Fixture(/private/adjacent-only.mkv) https://fixture.invalid/title-only /Users/fixture/private.mkv C:\\private\\fixture.mkv ${"x".repeat(500)}`,
    url: "https://fixture.invalid/private?credential=download-only",
    path: "/private/fixture/download-only.mkv",
    error: "raw-failure-detail",
    library: {
      status: "failed",
      checkedAt: "2026-10-24T00:00:00.000Z",
      message: "library-only-detail",
      serverPath: "/private/library-only.mkv",
    },
  };
  notifications.watchTask(completed, web);
  const text = notifications.list()[0].text;
  assert.ok(text.includes("Fixture") && text.includes("safe-id") && text.includes("已完成") && text.includes("同步失败"));
  assert.ok(text.length <= 300);
  for (const forbidden of ["https:", "/Users/", "C:\\", "/private/", "adjacent-only", "title-only", "download-only", "raw-failure-detail", "library-only"])
    assert.equal(text.includes(forbidden), false);
});

test("decision messages enqueue directly, dedupe by ref and stay bound to their destination", (t) => {
  const { notifications } = fixture(t);
  notifications.message(bridge, "request:r1:approved", "管理员已批准你的请求：沙丘，已开始下载。");
  // 同一 ref 重复排入只保留一条（审批被重复提交时不刷屏）。
  notifications.message(bridge, "request:r1:approved", "重复内容不应覆盖第一条");
  const pending = notifications.list().filter((record) => record.event === "message");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.match(pending[0].text, /管理员已批准/);

  // 目标身份必须精确匹配：别的 peer / 平台领不到。
  assert.deepEqual(notifications.claim(web, 1), []);
  assert.deepEqual(notifications.claim({ ...bridge, peer: "fixture:GroupMessage:2" }, 1), []);
  const claim = notifications.claim(bridge, 1)[0];
  assert.match(claim.text, /管理员已批准/);
  // taskId 用 ref 承载，便于调用方溯源；不是真实任务 id。
  assert.equal(claim.taskId, "request:r1:approved");
  notifications.acknowledge(bridge, claim.id, claim.claimToken, "delivered");
  assert.equal(notifications.list().find((record) => record.id === claim.id)?.status, "delivered");

  // 参数校验：空文本、空 ref 都拒绝。
  assert.throws(() => notifications.message(bridge, "request:r2:rejected", "   "), /内容为空/);
  assert.throws(() => notifications.message(bridge, "", "文本"), /标识无效/);
});
