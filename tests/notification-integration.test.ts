import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import { NOTIFICATION_ACTIVE_LIMIT } from "../server/notifications.js";
import { Queue } from "../server/queue.js";
import { Requests } from "../server/requests.js";
import { Store } from "../server/store.js";
import type {
  DownloadTask,
  MediaInfo,
  MediaService,
  NotificationDestination,
  SearchResult,
  TaskNotification,
} from "../shared/types.js";

const web: NotificationDestination = { platform: "web", peer: "admin" };
const telegram: NotificationDestination = { platform: "telegram", peer: "-10042", botId: "12345" };
const bridge: NotificationDestination = { platform: "wechat", peer: "fixture:GroupMessage:42" };
const movie: MediaInfo = { type: "movie", title: "Dune", year: 2021, tmdbId: 438631 };
const series: MediaInfo = { type: "tv", title: "The Last of Us", year: 2023, tmdbId: 100 };
const input = { title: "Dune 2021 1080p", url: "https://fixture.invalid/dune.mp4", media: movie };

type Attempt = {
  task: DownloadTask;
  signal: AbortSignal;
  reservations: TaskNotification[];
  resolve(file: string): void;
  reject(error: Error): void;
};

function resource(title = input.title, url = input.url): SearchResult {
  return { id: url, title, url, source: "fixture", kind: "direct" };
}

function fixture(t: TestContext, results: SearchResult[] = [resource()]) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mori-notification-integration-"));
  const store = new Store(path.join(directory, "state"), path.join(directory, "files"));
  const config = store.config();
  config.download.concurrency = 1;
  config.library.serverUrl = "";
  config.library.serverToken = "";
  store.setConfig(config);
  const state = { attempts: [] as Attempt[], scrapes: 0 };
  const notices = (id: string) => queue.notifications.list().filter((record) => record.taskId === id);
  const media: MediaService = {
    identify: async (query) => [query.includes("Last") ? series : movie],
    search: async () => results,
    download: (task, signal) => new Promise<string>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      state.attempts.push({
        task: structuredClone(task),
        signal,
        reservations: notices(task.id),
        resolve(file) { signal.removeEventListener("abort", aborted); resolve(file); },
        reject(error) { signal.removeEventListener("abort", aborted); reject(error); },
      });
      if (signal.aborted) aborted();
      else signal.addEventListener("abort", aborted, { once: true });
    }),
    scrape: async () => { state.scrapes++; return { files: [], warnings: [] }; },
    testConnection: async () => ({ ok: true, message: "fixture" }),
  };
  const queue = new Queue(store, media);
  const task = (id: string) => store.record<DownloadTask>("task", id)!;
  const complete = (attempt: Attempt) => {
    const file = path.join(directory, `${attempt.task.id}-${attempt.task.generation}.mp4`);
    writeFileSync(file, "fixture-video");
    attempt.resolve(file);
    return file;
  };
  t.after(async () => {
    await queue.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, queue, media, state, notices, task, complete };
}

async function waitFor(predicate: () => boolean, message: string) {
  for (let i = 0; i < 100 && !predicate(); i++) await setTimeout(20);
  assert.ok(predicate(), message);
}

function fillCapacity(h: ReturnType<typeof fixture>, count = NOTIFICATION_ACTIVE_LIMIT - 1) {
  if (!h.queue.notifications.list().length)
    h.queue.add({ title: "Capacity seed", url: "https://fixture.invalid/seed-share", kind: "share" });
  const records = h.queue.notifications.list();
  h.store.transaction(() => {
    for (let i = records.length; i < count; i++)
      h.store.put("notification", { ...records[0], id: `capacity-${i}`, taskId: `capacity-task-${i}` });
  });
}

test("terminal tasks cannot bypass a new generation through pause and resume", async (t) => {
  for (const status of ["failed", "cancelled"] as const) {
    await t.test(status, async (t) => {
      const h = fixture(t);
      const task = h.queue.add(input, telegram);
      await waitFor(() => h.state.attempts.length === 1, "first attempt starts");
      if (status === "failed") h.state.attempts[0].reject(new Error("fixture failure"));
      else h.queue.action(task.id, "cancel");
      await waitFor(() => !h.queue.isBusy(), "first attempt settles");
      assert.equal(h.task(task.id).status, status);
      assert.throws(() => h.queue.action(task.id, "pause"), /不能暂停/);
      assert.equal(h.task(task.id).status, status);
      h.queue.action(task.id, "resume");
      await waitFor(() => h.state.attempts.length === 2, "second attempt starts");
      assert.equal(h.task(task.id).generation, 2);
      assert.equal(h.state.attempts[1].reservations.filter((n) => n.generation === 2 && n.status === "waiting").length, 2);
      h.complete(h.state.attempts[1]);
      await waitFor(() => h.notices(task.id).some((n) => n.generation === 2 && n.event === "completed"), "the retry result is retained");
    });
  }
});

test("deleting a subscription atomically releases only its watchers and retains task notifications", async (t) => {
  const h = fixture(t, [resource()]);
  const sub = h.queue.subscribe("Dune", true, movie, undefined, telegram);
  h.queue.subscribe("Dune", true, movie, undefined, bridge);
  await h.queue.check(sub.id);
  await waitFor(() => h.state.attempts.length === 1, "subscription task starts");
  const task = h.queue.tasks()[0];
  const watchers = `notification-watch-subscription:${sub.id}`;
  assert.equal(h.store.list(watchers).length, 3);
  const unwatch = h.queue.notifications.unwatchSubscription.bind(h.queue.notifications);
  h.queue.notifications.unwatchSubscription = (id) => { unwatch(id); throw new Error("fixture cleanup failure"); };
  assert.throws(() => h.queue.removeSubscription(sub.id), /cleanup failure/);
  assert.equal(h.queue.subscriptions().length, 1);
  assert.equal(h.store.list(watchers).length, 3);
  h.queue.notifications.unwatchSubscription = unwatch;
  h.queue.removeSubscription(sub.id);
  assert.equal(h.queue.subscriptions().length, 0);
  assert.equal(h.store.list(watchers).length, 0);
  assert.equal(h.notices(task.id).length, 3);
  h.complete(h.state.attempts[0]);
  await waitFor(() => h.notices(task.id).every((n) => n.event === "completed"), "inherited task watchers survive subscription deletion");
});

test("web, Telegram and bridge admissions merge URL and media identity before publishing one real download result", async (t) => {
  const h = fixture(t);
  const first = h.queue.add(input);
  assert.equal(h.queue.add(input, telegram).id, first.id);
  assert.equal(h.queue.add({ ...input, url: "https://fixture.invalid/alternate.mp4" }, bridge).id, first.id);
  assert.equal(h.queue.add(input, telegram).id, first.id);
  assert.equal(h.queue.tasks().length, 1);
  const reserved = h.notices(first.id);
  assert.equal(reserved.length, 3);
  assert.deepEqual(new Set(reserved.map((record) => record.destination)), new Set([web, telegram, bridge]));
  assert.ok(reserved.every((record) => record.status === "waiting" && record.generation === 1 && !record.event));
  await waitFor(() => h.state.attempts.length === 1, "one shared download starts");
  assert.equal(h.state.attempts[0].reservations.length, 3);
  assert.ok(h.state.attempts[0].reservations.every((record) => record.status === "waiting"));
  const file = h.complete(h.state.attempts[0]);
  await waitFor(() => h.notices(first.id).every((record) => record.status === "pending"), "all destinations receive the terminal event");
  assert.equal(h.task(first.id).status, "completed");
  assert.equal(h.task(first.id).path, file);
  assert.equal(readFileSync(file, "utf8"), "fixture-video");
  assert.equal(h.state.scrapes, 1);
  assert.equal(h.state.attempts.length, 1);
  assert.deepEqual(new Set(h.notices(first.id).map((record) => record.id)), new Set(reserved.map((record) => record.id)));
  assert.ok(h.notices(first.id).every((record) => record.event === "completed"));
});

test("automatic subscription children inherit every watcher before dispatch", async (t) => {
  const h = fixture(t, [
    resource("The.Last.of.Us.2023.S01E01.1080p", "https://fixture.invalid/episode-1.mp4"),
    resource("The.Last.of.Us.2023.S01E02.1080p", "https://fixture.invalid/episode-2.mp4"),
  ]);
  const season = { ...series, season: 1 };
  const sub = h.queue.subscribe("The Last of Us S01", true, season, 1, telegram);
  assert.equal(h.queue.subscribe(sub.query, true, season, 1, bridge).id, sub.id);
  await h.queue.check(sub.id);
  assert.equal(h.queue.tasks().length, 2);
  assert.deepEqual(new Set(h.queue.tasks().map((task) => task.media.episode)), new Set([1, 2]));
  for (const task of h.queue.tasks()) {
    const notices = h.notices(task.id);
    assert.equal(notices.length, 3);
    assert.deepEqual(new Set(notices.map((record) => record.destination)), new Set([web, telegram, bridge]));
    assert.ok(notices.every((record) => record.status === "waiting" && !record.event));
  }
  await waitFor(() => h.state.attempts.length === 1, "the first subscription child starts");
  assert.equal(h.state.attempts[0].reservations.length, 3);
  h.complete(h.state.attempts[0]);
  await waitFor(() => h.state.attempts.length === 2, "the second child starts after the first finishes");
  assert.equal(h.state.attempts[1].reservations.length, 3);
  assert.ok(h.state.attempts[1].reservations.every((record) => record.status === "waiting"));
});

test("pausing and resuming active work retain generation and reservation identity", async (t) => {
  const h = fixture(t);
  const task = h.queue.add(input, telegram);
  const ids = new Set(h.notices(task.id).map((record) => record.id));
  await waitFor(() => h.state.attempts.length === 1, "the original download starts");
  h.queue.action(task.id, "pause");
  assert.equal(h.state.attempts[0].signal.aborted, true);
  await setImmediate();
  assert.equal(h.task(task.id).status, "paused");
  assert.equal(h.task(task.id).generation, 1);
  assert.ok(h.notices(task.id).every((record) => record.status === "waiting" && !record.event));
  h.queue.action(task.id, "resume");
  await waitFor(() => h.state.attempts.length === 2, "resumed work starts");
  assert.equal(h.task(task.id).generation, 1);
  assert.deepEqual(new Set(h.notices(task.id).map((record) => record.id)), ids);
  h.complete(h.state.attempts[1]);
  await waitFor(() => h.notices(task.id).every((record) => record.status === "pending"), "resumed work publishes its existing reservations");
  assert.ok(h.notices(task.id).every((record) => record.generation === 1 && record.event === "completed"));
});

test("a failed download publishes failure and retry reserves the next generation before work", async (t) => {
  const h = fixture(t);
  const task = h.queue.add(input, telegram);
  await waitFor(() => h.state.attempts.length === 1, "the failing download starts");
  h.state.attempts[0].reject(new Error("fixture download failure"));
  await waitFor(() => h.task(task.id).status === "failed", "the download failure is persisted");
  const failed = h.notices(task.id);
  assert.equal(failed.length, 2);
  assert.ok(failed.every((record) => record.status === "pending" && record.event === "failed" && record.generation === 1));
    h.queue.action(task.id, "retry");
  await waitFor(() => h.state.attempts.length === 2, "retry starts once");
  assert.equal(h.task(task.id).generation, 2);
  const next = h.state.attempts[1].reservations.filter((record) => record.generation === 2);
  assert.equal(next.length, 2);
  assert.ok(next.every((record) => record.status === "waiting" && !record.event));
  assert.ok(next.every((record) => !failed.some((old) => old.id === record.id)));
  h.complete(h.state.attempts[1]);
  await waitFor(() => h.notices(task.id).filter((record) => record.generation === 2).every((record) => record.status === "pending"), "retry publishes its own result");
  assert.ok(h.notices(task.id).filter((record) => record.generation === 1).every((record) => record.event === "failed"));
  assert.ok(h.notices(task.id).filter((record) => record.generation === 2).every((record) => record.event === "completed"));
});

test("cancellation emits no terminal result and retry reserves a new generation", async (t) => {
  const h = fixture(t);
  const task = h.queue.add(input, bridge);
  await waitFor(() => h.state.attempts.length === 1, "the cancellable download starts");
  h.queue.action(task.id, "cancel");
  await setImmediate();
  assert.equal(h.task(task.id).status, "cancelled");
  assert.equal(h.task(task.id).generation, 1);
  assert.ok(h.notices(task.id).every((record) => record.status === "dismissed" && !record.event));
  h.queue.action(task.id, "retry");
  await waitFor(() => h.state.attempts.length === 2, "cancelled work can retry");
  assert.equal(h.task(task.id).generation, 2);
  const reserved = h.state.attempts[1].reservations.filter((record) => record.generation === 2);
  assert.equal(reserved.length, 2);
  assert.ok(reserved.every((record) => record.status === "waiting" && !record.event));
  h.complete(h.state.attempts[1]);
  await waitFor(() => h.notices(task.id).some((record) => record.generation === 2 && record.event === "completed"), "the new generation completes");
  assert.ok(h.notices(task.id).filter((record) => record.generation === 1).every((record) => record.status === "dismissed" && !record.event));
});

test("missing, empty, directory and symlink download results fail before completion or scraping", async (t) => {
  for (const kind of ["missing", "empty", "directory", "symlink"] as const) {
    await t.test(kind, async (child) => {
      const h = fixture(child);
      const task = h.queue.add(input, bridge);
      await waitFor(() => h.state.attempts.length === 1, "the invalid-file download starts");
      const file = path.join(h.directory, "result.mp4");
      if (kind === "empty") writeFileSync(file, "");
      if (kind === "directory") mkdirSync(file);
      if (kind === "symlink") {
        const target = path.join(h.directory, "target.mp4");
        writeFileSync(target, "fixture-video");
        symlinkSync(target, file);
      }
      h.state.attempts[0].resolve(file);
      await waitFor(() => h.task(task.id).status === "failed", "an invalid file is a persisted failure");
      assert.equal(h.state.scrapes, 0);
      const notices = h.notices(task.id);
      assert.equal(notices.length, 2);
      assert.ok(notices.every((record) => record.status === "pending" && record.event === "failed"));
    });
  }
});

test("capacity failure rolls back direct and subscription task admission without starting downloads", async (t) => {
  const h = fixture(t);
  fillCapacity(h);
  const before = h.queue.tasks();
  assert.throws(() => h.queue.add(input, telegram), { status: 429 });
  assert.deepEqual(h.queue.tasks(), before);
  assert.equal(h.queue.notifications.list().length, NOTIFICATION_ACTIVE_LIMIT - 1);
  const sub = h.queue.subscribe("Dune", true, movie, undefined, telegram);
  await h.queue.check(sub.id);
  assert.deepEqual(h.queue.tasks(), before);
  assert.equal(h.queue.notifications.list().length, NOTIFICATION_ACTIVE_LIMIT - 1);
  assert.deepEqual(h.queue.subscriptions()[0].seen, []);
  assert.match(h.queue.subscriptions()[0].lastError!, /通知|容量/);
  await setImmediate();
  assert.equal(h.state.attempts.length, 0);
});

test("capacity failure rolls back retry status, generation and partial reservations", async (t) => {
  const h = fixture(t);
  const task = h.queue.add(input, telegram);
  await waitFor(() => h.state.attempts.length === 1, "the initial attempt starts");
  h.state.attempts[0].reject(new Error("fixture retry failure"));
  await waitFor(() => h.task(task.id).status === "failed", "the initial attempt fails");
  fillCapacity(h);
  const before = h.task(task.id);
  const notices = h.notices(task.id);
  assert.throws(() => h.queue.action(task.id, "retry"), { status: 429 });
  assert.deepEqual(h.task(task.id), before);
  assert.deepEqual(h.notices(task.id), notices);
  assert.equal(h.queue.notifications.list().length, NOTIFICATION_ACTIVE_LIMIT - 1);
  await setImmediate();
  assert.equal(h.state.attempts.length, 1);
});

test("Requests forwards the stored trusted owner to download and subscription callbacks", async (t) => {
  const h = fixture(t);
  const downloadOwner = "trusted:telegram:12345:-10042";
  const subscriptionOwner = "trusted:wechat:fixture:GroupMessage:42";
  const calls: { action: string; owner: string | undefined; startEpisode?: number }[] = [];
  const requests = new Requests(h.store, h.media, {
    addTask(task, owner) {
      calls.push({ action: "download", owner });
      return h.queue.add(task, telegram);
    },
    subscribe(query, media, startEpisode, owner) {
      calls.push({ action: "subscribe", owner, startEpisode });
      return h.queue.subscribe(query, true, media, startEpisode, bridge);
    },
  });
  const download = await requests.begin(downloadOwner, "Dune (2021)", "download");
  assert.equal(download.stage, "completed");
  assert.equal(download.owner, downloadOwner);
  assert.equal(h.task(download.taskId!).status, "downloading");
  assert.ok(h.notices(download.taskId!).every((record) => record.status === "waiting" && !record.event));
  await assert.rejects(requests.select(subscriptionOwner, download.id, {
    expectedRevision: download.revision,
    resourceId: download.resources[0].id,
  }), /无权|不存在/);
  const subscription = await requests.begin(subscriptionOwner, "The Last of Us S01E03", "subscribe");
  assert.equal(subscription.stage, "completed");
  assert.equal(subscription.owner, subscriptionOwner);
  const stored = h.queue.subscriptions().find((record) => record.id === subscription.subscriptionId)!;
  assert.equal(stored.media?.season, 1);
  assert.equal(stored.media?.episode, undefined);
  assert.equal(stored.startEpisode, 3);
  assert.deepEqual(calls, [
    { action: "download", owner: downloadOwner },
    { action: "subscribe", owner: subscriptionOwner, startEpisode: 3 },
  ]);
});

test("Requests completion and Queue admission roll back together when notification capacity is exhausted", async (t) => {
  const h = fixture(t);
  fillCapacity(h);
  const owner = "trusted:telegram:12345:-10042";
  const requests = new Requests(h.store, h.media, {
    addTask(task, trustedOwner) {
      assert.equal(trustedOwner, owner);
      return h.queue.add(task, telegram);
    },
    subscribe() { throw new Error("unexpected subscription"); },
  });
  const request = await requests.begin(owner, "Dune (2021)", "search");
  assert.equal(request.stage, "resource");
  const before = h.queue.tasks();
  await assert.rejects(requests.select(owner, request.id, {
    expectedRevision: request.revision,
    resourceId: request.resources[0].id,
  }), { status: 429 });
  assert.deepEqual(requests.get(owner, request.id), request);
  assert.deepEqual(h.queue.tasks(), before);
  assert.equal(h.queue.notifications.list().length, NOTIFICATION_ACTIVE_LIMIT - 1);
  await setImmediate();
  assert.equal(h.state.attempts.length, 0);
});
