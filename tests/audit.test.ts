import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.js";
import { listAudit, MAX_TASK_AUDIT, ownerFromDestination, recordTaskAudit } from "../server/audit.js";
import type { ApprovalRecord, DownloadTask } from "../shared/types.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mori-audit-"));
  const store = new Store(path.join(root, "state"), path.join(root, "files"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return store;
}

function task(id: string, at: string, title = `片名 ${id}`): DownloadTask {
  return {
    id,
    title,
    url: "https://fixture.invalid/v.mp4",
    kind: "direct",
    status: "queued",
    progress: 0,
    bytes: 0,
    total: 0,
    media: { type: "movie", title },
    profile: "emby",
    createdAt: at,
    updatedAt: at,
  };
}

test("任务审计记录来源、归属与片名，并与审批决定合并成时间线", (t) => {
  const store = fixture(t);
  recordTaskAudit(store, task("t1", "2026-10-25T10:00:00.000Z"), "channel", "bridge:qq:family");
  recordTaskAudit(store, task("t2", "2026-10-25T12:00:00.000Z"), "web", "web:admin");
  store.put<ApprovalRecord>("approval", {
    id: "r1",
    requestId: "r1",
    owner: "bridge:qq:family",
    query: "沙丘",
    outcome: "approved",
    at: "2026-10-25T11:00:00.000Z",
    by: "web:admin",
  });

  const entries = listAudit(store, 10);
  assert.equal(entries.length, 3);
  // 最新的在前。
  assert.deepEqual(
    entries.map((entry) => entry.at),
    [
      "2026-10-25T12:00:00.000Z",
      "2026-10-25T11:00:00.000Z",
      "2026-10-25T10:00:00.000Z",
    ],
  );
  assert.equal(entries[0].type, "task");
  assert.equal(entries[0].origin, "web");
  assert.equal(entries[0].owner, "web:admin");
  assert.equal(entries[1].type, "approval");
  assert.equal(entries[1].outcome, "approved");
  assert.equal(entries[1].title, "沙丘");
  assert.equal(entries[1].detail, "web:admin");
  assert.equal(entries[2].origin, "channel");
  assert.equal(entries[2].detail, "direct");
  assert.match(entries[0].id, /^task:/);
  assert.match(entries[1].id, /^approval:/);

  // limit 生效。
  assert.equal(listAudit(store, 1).length, 1);
});

test("任务审计按上限裁剪最旧记录，审批历史不受影响", (t) => {
  const store = fixture(t);
  for (let index = 0; index <= MAX_TASK_AUDIT + 2; index++) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    recordTaskAudit(store, task(`bulk-${index}`, at), "subscription", "system:subscription");
  }
  const rows = store.list<{ id: string }>("audit");
  assert.equal(rows.length, MAX_TASK_AUDIT, "超出上限时丢弃最旧的");
  const entries = listAudit(store, MAX_TASK_AUDIT);
  assert.equal(entries.length, MAX_TASK_AUDIT);
  // 最新的一条一定还在，最旧的已被裁掉。
  assert.ok(entries.some((entry) => entry.title === `片名 bulk-${MAX_TASK_AUDIT + 2}`));
  assert.ok(!entries.some((entry) => entry.title === "片名 bulk-0"));
});

test("没有显式归属时从通知目标反推可读标识", () => {
  assert.equal(ownerFromDestination(undefined), "web:admin");
  assert.equal(ownerFromDestination({ platform: "web", peer: "admin" }), "web:admin");
  assert.equal(ownerFromDestination({ platform: "qq", peer: "family" }), "qq:family");
  assert.equal(
    ownerFromDestination({ platform: "telegram", peer: "-100", botId: "42" }),
    "telegram:42:-100",
  );
});
