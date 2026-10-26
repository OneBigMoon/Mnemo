import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { NOTIFICATION_ACTIVE_LIMIT } from "../server/notifications.js";
import { Queue } from "../server/queue.js";
import { Store } from "../server/store.js";
import type {
  DownloadTask,
  MediaInfo,
  MediaService,
  NotificationDestination,
  SearchResult,
  ShareScanCursor,
  ShareScanPage,
  ShareSubscriptionInput,
  TaskNotification,
} from "../shared/types.js";

const series: MediaInfo = {
  type: "tv",
  title: "The Last of Us",
  year: 2023,
  tmdbId: 100,
  season: 2,
};
const destination: NotificationDestination = { platform: "telegram", peer: "-10042", botId: "12345" };
const rawReference = "https://fixture.invalid/share/main";
const referenceAlias = rawReference + "?password=fixture";
const reference = opaque(9000);
const input: ShareSubscriptionInput = { query: "The Last of Us S02", media: series, reference };

function opaque(id: number) {
  return "mori-share:" + id.toString(16).padStart(64, "0");
}

function cursor(root = reference): ShareScanCursor {
  return {
    version: 1,
    root,
    frontier: [{ reference: root, directoryKey: "fixture-root", depth: 0 }],
    visited: [],
    pages: 1,
    entries: 20,
  };
}

function entry(episode: number, title = `The.Last.of.Us.2023.S02E${String(episode).padStart(2, "0")}.mkv`): ShareScanPage["files"][number] {
  return {
    resource: { id: `episode-${episode}`, title, kind: "cloud", url: opaque(episode), source: "115" },
    directories: ["The.Last.of.Us.2023", "Season 2"],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(t: TestContext, overrides: Partial<MediaService> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mori-directory-subscriptions-"));
  const directory = path.join(root, "state");
  let store = new Store(directory, root);
  let queue: Queue;
  const downloads: { task: DownloadTask; notices: TaskNotification[] }[] = [];
  const media: MediaService = {
    search: async () => [],
    identify: async () => [],
    shareDirectory: (value) => {
      const normalized = [rawReference, referenceAlias].includes(value) ? reference : value;
      if (!/^mori-share:[a-f0-9]{64}$/.test(normalized)) throw new Error("Invalid fixture directory");
      return { reference: normalized, title: series.title };
    },
    scanShare: async () => ({ files: [], complete: true }),
    download: async (task, signal) => {
      downloads.push({ task, notices: queue.notifications.list().filter((notice) => notice.taskId === task.id) });
      return new Promise<string>((_resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("Fixture cancelled"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
    scrape: async () => ({ files: [], warnings: [] }),
    testConnection: async () => ({ ok: true, message: "fixture" }),
    ...overrides,
  };
  queue = new Queue(store, media);
  t.after(async () => {
    await queue.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    get queue() { return queue; },
    get store() { return store; },
    downloads,
    async reopen() {
      await queue.stop();
      store.close();
      store = new Store(directory, root);
      queue = new Queue(store, media);
    },
  };
}

function dueIn(value: string | undefined, milliseconds: number, before: number) {
  assert.ok(value, "the next scan is scheduled");
  assert.ok(Date.parse(value) >= before + milliseconds);
  assert.ok(Date.parse(value) <= Date.now() + milliseconds);
}

test("directory pages admit ten at a time and retain pending files and cursor across restart", async (t) => {
  const calls: (ShareScanCursor | undefined)[] = [];
  const continuation = cursor();
  const h = fixture(t, {
    scanShare: async (_reference, value) => {
      calls.push(value);
      return calls.length === 1
        ? { files: Array.from({ length: 20 }, (_, i) => entry(i + 1)), cursor: continuation, complete: false }
        : { files: [entry(21), entry(22), entry(23)], complete: true };
    },
  });
  const sub = h.queue.subscribeDirectory(input);
  const firstCheck = Date.now();
  await h.queue.check(sub.id);
  const first = h.queue.subscriptions()[0];
  assert.equal(h.queue.tasks().length, 10);
  assert.equal(first.seen.length, 10);
  assert.equal(first.scan?.pending.length, 10);
  assert.deepEqual(first.scan?.cursor, continuation);
  dueIn(first.nextCheckAt, 15_000, firstCheck);
  assert.deepEqual(h.queue.updateSubscription(sub.id, { enabled: false }).scan, first.scan);
  assert.deepEqual(h.queue.updateSubscription(sub.id, { enabled: true }).scan, first.scan);

  await h.reopen();
  assert.deepEqual(h.queue.subscriptions()[0].scan, first.scan);
  assert.deepEqual(h.queue.subscriptions()[0].seen, first.seen);
  await h.queue.check(sub.id);
  assert.equal(h.queue.tasks().length, 20);
  assert.equal(h.queue.subscriptions()[0].scan?.pending.length, 0);
  assert.equal(calls.length, 1, "persisted pending files are drained before another page is requested");

  const completedCheck = Date.now();
  await h.queue.check(sub.id);
  const completed = h.queue.subscriptions()[0];
  assert.deepEqual(calls, [undefined, continuation]);
  assert.equal(h.queue.tasks().length, 23);
  assert.equal(completed.seen.length, 23);
  assert.equal(completed.scan?.pending.length, 0);
  assert.equal(completed.scan?.complete, true);
  assert.deepEqual(h.queue.tasks().map((task) => task.media.episode).sort((a, b) => a! - b!), Array.from({ length: 23 }, (_, i) => i + 1));
  dueIn(completed.nextCheckAt, 30 * 60_000, completedCheck);
});

test("directory subscriptions normalize their source and remain separate from aggregate and other directories", (t) => {
  const h = fixture(t);
  const aggregate = h.queue.subscribe(input.query, true, series);
  const first = h.queue.subscribeDirectory({ ...input, reference: rawReference, media: { ...series, episode: 3 }, startEpisode: 3 }, destination);
  const same = h.queue.subscribeDirectory({ ...input, query: "An alternate label", reference: referenceAlias, startEpisode: 3 });
  const other = h.queue.subscribeDirectory({ ...input, reference: opaque(9001) });
  assert.equal(same.id, first.id);
  assert.notEqual(first.id, aggregate.id);
  assert.notEqual(first.id, other.id);
  assert.equal(first.share?.reference, reference);
  assert.equal(first.media?.episode, undefined);
  assert.equal(first.startEpisode, 3);
  assert.equal(first.enabled, true);
  assert.equal(first.autoDownload, true);
  assert.equal(h.queue.subscriptions().length, 3);

  for (const invalid of [
    { ...input, query: "" },
    { ...input, media: undefined as unknown as MediaInfo },
    { ...input, media: { ...series, title: "" } },
    { ...input, media: { ...series, season: undefined } },
    ...[0, 1.5, 10_000].map((startEpisode) => ({ ...input, startEpisode })),
  ]) assert.throws(() => h.queue.subscribeDirectory(invalid));
  assert.equal(h.queue.subscriptions().length, 3, "invalid input does not leave partial subscriptions");
});

test("mismatched and uncertain files do not block matching episodes after the start episode", async (t) => {
  const files = [
    ...Array.from({ length: 9 }, (_, i) => entry(100 + i, `The.Last.of.Us.1990.S02E${String(i + 1).padStart(2, "0")}.mkv`)),
    entry(200, "The.Last.of.Us.2023.S01E01.mkv"),
    { ...entry(201, "video.mkv"), directories: [] },
    entry(2),
    entry(3),
    entry(4),
  ];
  const h = fixture(t, { scanShare: async () => ({ files, complete: true }) });
  const sub = h.queue.subscribeDirectory({ ...input, startEpisode: 3 });
  await h.queue.check(sub.id);
  assert.deepEqual(h.queue.tasks().map((task) => task.media.episode).sort(), [3, 4]);
  const stored = h.queue.subscriptions()[0];
  assert.equal(stored.scan?.pending.length, 0);
  assert.ok(stored.seen.includes("episode-3") && stored.seen.includes("episode-4"));
  assert.equal(stored.lastError, undefined);
});

test("notification inheritance failure rolls back the task and reservations without consuming pending", async (t) => {
  let scans = 0;
  const h = fixture(t, { scanShare: async () => { scans++; return { files: [entry(1)], complete: true }; } });
  const sub = h.queue.subscribeDirectory(input, destination);
  const inherit = h.queue.notifications.inheritSubscription.bind(h.queue.notifications);
  h.queue.notifications.inheritSubscription = (id, task) => {
    inherit(id, task);
    throw new Error("Fixture inheritance failure");
  };
  await h.queue.check(sub.id);
  await setImmediate();
  assert.equal(h.queue.tasks().length, 0);
  assert.equal(h.queue.notifications.list().length, 0);
  assert.equal(h.downloads.length, 0);
  assert.deepEqual(h.queue.subscriptions()[0].seen, []);
  assert.deepEqual(h.queue.subscriptions()[0].scan?.pending.map((file) => file.resource.id), ["episode-1"]);
  assert.match(h.queue.subscriptions()[0].lastError!, /Fixture inheritance failure/);

  h.queue.notifications.inheritSubscription = inherit;
  await h.queue.check(sub.id);
  await setImmediate();
  assert.equal(scans, 1);
  assert.equal(h.queue.tasks().length, 1);
  assert.deepEqual(h.queue.subscriptions()[0].seen, ["episode-1"]);
  assert.equal(h.queue.subscriptions()[0].scan?.pending.length, 0);
  const notices = h.queue.notifications.list();
  assert.equal(notices.length, 2);
  assert.deepEqual(new Set(notices.map((notice) => notice.destination.platform)), new Set(["web", "telegram"]));
  assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0].notices.length, 2, "both destinations are reserved before download starts");
});

test("notification capacity failure leaves the directory file pending for a later check", async (t) => {
  let scans = 0;
  const h = fixture(t, { scanShare: async () => { scans++; return { files: [entry(1)], complete: true }; } });
  const seed = h.queue.add({ title: "Capacity seed", url: "https://fixture.invalid/seed-share", kind: "share" });
  const template = h.queue.notifications.list().find((notice) => notice.taskId === seed.id)!;
  h.store.transaction(() => {
    for (let i = 1; i < NOTIFICATION_ACTIVE_LIMIT - 1; i++)
      h.store.put("notification", { ...template, id: `capacity-${i}`, taskId: `capacity-task-${i}` });
  });
  const before = h.queue.tasks();
  const sub = h.queue.subscribeDirectory(input, destination);
  await h.queue.check(sub.id);
  assert.deepEqual(h.queue.tasks(), before);
  assert.equal(h.queue.notifications.list().length, NOTIFICATION_ACTIVE_LIMIT - 1);
  assert.deepEqual(h.queue.subscriptions()[0].seen, []);
  assert.equal(h.queue.subscriptions()[0].scan?.pending.length, 1);
  assert.match(h.queue.subscriptions()[0].lastError!, /通知|容量/);
  assert.equal(h.downloads.length, 0);

  h.store.remove("notification", "capacity-1");
  await h.queue.check(sub.id);
  assert.equal(scans, 1);
  assert.equal(h.queue.tasks().length, before.length + 1);
  assert.equal(h.queue.notifications.list().length, NOTIFICATION_ACTIVE_LIMIT);
  assert.deepEqual(h.queue.subscriptions()[0].seen, ["episode-1"]);
  assert.equal(h.queue.subscriptions()[0].scan?.pending.length, 0);
});

test("a directory hit inherits its watcher onto an existing task without another download", async (t) => {
  const file = entry(1);
  const h = fixture(t, { scanShare: async () => ({ files: [file], complete: true }) });
  const task = h.queue.add({ ...file.resource, media: { ...series, episode: 1 } });
  const sub = h.queue.subscribeDirectory(input, destination);
  await h.queue.check(sub.id);
  await setImmediate();
  assert.deepEqual(h.queue.tasks().map((current) => current.id), [task.id]);
  assert.equal(h.downloads.length, 1);
  const notices = h.queue.notifications.list().filter((notice) => notice.taskId === task.id);
  assert.equal(notices.length, 2);
  assert.deepEqual(new Set(notices.map((notice) => notice.destination.platform)), new Set(["web", "telegram"]));
  assert.deepEqual(h.queue.subscriptions()[0].seen, [file.resource.id]);
  assert.equal(h.queue.subscriptions()[0].scan?.pending.length, 0);
});

test("pause, disabling auto download, removal and stop abort scans and reject late admission", async (t) => {
  for (const action of ["pause", "autoDownload", "remove", "stop"] as const) {
    await t.test(action, async (t) => {
      const page = deferred<ShareScanPage>();
      let signal: AbortSignal | undefined;
      const h = fixture(t, { scanShare: async (_reference, _cursor, currentSignal) => { signal = currentSignal; return page.promise; } });
      const sub = h.queue.subscribeDirectory(input, destination);
      const checking = h.queue.check(sub.id);
      let stopping: Promise<void> | undefined;
      let stopSettled = false;
      let aborted = false;
      try {
        await setImmediate();
        assert.ok(signal, "the scan receives a cancellation signal");
        if (action === "pause") h.queue.updateSubscription(sub.id, { enabled: false });
        else if (action === "autoDownload") h.queue.updateSubscription(sub.id, { autoDownload: false });
        else if (action === "remove") h.queue.removeSubscription(sub.id);
        else {
          stopping = h.queue.stop();
          void stopping.then(() => { stopSettled = true; });
        }
        aborted = signal.aborted;
        await setImmediate();
        if (action === "stop") assert.equal(stopSettled, false, "stop drains the running scan");
      } finally {
        page.resolve({ files: [entry(1)], complete: true });
        await Promise.all([checking, stopping]);
      }
      assert.equal(aborted, true);
      assert.equal(h.queue.tasks().length, 0);
      assert.equal(h.queue.notifications.list().length, 0);
      assert.equal(h.downloads.length, 0);
      const stored = h.queue.subscriptions().find((current) => current.id === sub.id);
      if (action === "remove") assert.equal(stored, undefined);
      else {
        assert.equal(stored?.lastError, undefined);
        assert.equal(stored?.lastCheckedAt, undefined, "a revoked scan cannot publish completion");
        if (action === "pause") assert.equal(stored?.enabled, false);
        if (action === "autoDownload") assert.equal(stored?.autoDownload, false);
      }
    });
  }
});

test("aggregate searches receive cancellation and cannot add a result after pause", async (t) => {
  const results = deferred<SearchResult[]>();
  let signal: AbortSignal | undefined;
  const h = fixture(t, { search: async (_query, currentSignal) => { signal = currentSignal; return results.promise; } });
  const sub = h.queue.subscribe(input.query, true, series);
  const checking = h.queue.check(sub.id);
  try {
    await setImmediate();
    assert.ok(signal);
    h.queue.updateSubscription(sub.id, { enabled: false });
    assert.equal(signal.aborted, true);
  } finally {
    results.resolve([{ ...entry(1).resource, kind: "direct", url: "https://fixture.invalid/late.mp4" }]);
    await checking;
  }
  assert.equal(h.queue.tasks().length, 0);
  assert.equal(h.queue.subscriptions()[0].lastError, undefined);
  assert.equal(h.queue.subscriptions()[0].lastCheckedAt, undefined);
});

test("same-id checks share one promise while at most three different subscriptions scan", async (t) => {
  const scans: { reference: string; done: ReturnType<typeof deferred<ShareScanPage>> }[] = [];
  let active = 0;
  let maximum = 0;
  const h = fixture(t, {
    scanShare: async (value) => {
      const done = deferred<ShareScanPage>();
      scans.push({ reference: value, done });
      maximum = Math.max(maximum, ++active);
      try { return await done.promise; }
      finally { active--; }
    },
  });
  const subscriptions = Array.from({ length: 4 }, (_, i) => h.queue.subscribeDirectory({ ...input, reference: opaque(9100 + i) }));
  const checks: Promise<unknown>[] = [];
  try {
    const first = h.queue.check(subscriptions[0].id);
    checks.push(first);
    assert.equal(h.queue.check(subscriptions[0].id), first);
    checks.push(h.queue.check(subscriptions[1].id), h.queue.check(subscriptions[2].id));
    await setImmediate();
    assert.equal(scans.length, 3);
    await assert.rejects(async () => h.queue.check(subscriptions[3].id), { status: 429 });
    assert.equal(scans.length, 3);
    scans[0].done.resolve({ files: [], complete: true });
    await first;
    checks.push(h.queue.check(subscriptions[3].id));
    await setImmediate();
    assert.equal(scans.length, 4, "capacity is released when a check settles");
    assert.equal(maximum, 3);
  } finally {
    for (const scan of scans) scan.done.resolve({ files: [], complete: true });
    await Promise.all(checks);
  }
});

test("the scheduler gives a fourth directory a turn while incomplete scans remain due", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: new Date("2026-10-24T00:00:00Z") });
  const calls: string[] = [];
  const h = fixture(t, {
    scanShare: async (value) => { calls.push(value); return { files: [], cursor: cursor(value), complete: false }; },
  });
  const references = Array.from({ length: 4 }, (_, i) => opaque(9200 + i));
  for (const value of references) h.queue.subscribeDirectory({ ...input, reference: value });
  h.queue.start();
  await setImmediate();
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(15_000);
    await setImmediate();
  }
  assert.deepEqual(new Set(calls), new Set(references));
});

test("a scan limit disables the subscription and preserves its cursor for inspection", async (t) => {
  let scans = 0;
  const continuation = cursor();
  const h = fixture(t, {
    scanShare: async () => {
      if (++scans === 1) return { files: [], cursor: continuation, complete: false };
      throw Object.assign(new Error("扫描上限"), { code: "scan_limit" });
    },
  });
  const sub = h.queue.subscribeDirectory(input);
  await h.queue.check(sub.id);
  const before = h.queue.subscriptions()[0];
  await h.queue.check(sub.id);
  const after = h.queue.subscriptions()[0];
  assert.equal(after.enabled, false);
  assert.match(after.lastError!, /扫描上限/);
  assert.deepEqual(after.scan, before.scan);
  assert.deepEqual(after.seen, before.seen);
  assert.deepEqual(after.scan?.cursor, continuation);
  assert.equal(h.queue.tasks().length, 0);
});
