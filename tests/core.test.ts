import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  mkdir,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store, validateConfig, publicConfig } from "../server/store.js";
import { Queue } from "../server/queue.js";
import type { DownloadTask, MediaService } from "../shared/types.js";

test("a pause after file publication keeps the receipt and resumes without downloading again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-publish-pause-"));
  const store = new Store(path.join(root, "state"), root);
  let calls = 0;
  let queue: Queue;
  const media: MediaService = {
    search: async () => [],
    identify: async () => [],
    testConnection: async () => ({ ok: true, message: "fixture" }),
    download: async (task) => {
      calls++;
      const file = path.join(root, "fixture.mp4");
      await writeFile(file, "fixture-video");
      queue.action(task.id, "pause");
      return file;
    },
    scrape: async () => ({ files: [], warnings: [] }),
  };
  queue = new Queue(store, media);
  try {
    const added = queue.add({
      title: "Fixture",
      url: "https://fixture.invalid/publication.mp4",
    });
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (!queue.isBusy()) break;
    }
    const paused = queue.tasks().find((t) => t.id === added.id)!;
    assert.equal(paused.status, "paused");
    assert.ok(paused.path);
    assert.equal(paused.bytes, 13);
    queue.action(added.id, "resume");
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (!queue.isBusy()) break;
    }
    assert.equal(queue.tasks()[0].status, "completed");
    assert.equal(calls, 1);
  } finally {
    await queue.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup recovery reflects resumable partial bytes instead of stale zero progress", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-resume-progress-"));
  const downloads = path.join(root, "downloads");
  await mkdir(downloads, { recursive: true });
  const store = new Store(path.join(root, "state"), downloads);
  const record = (id: string, title: string): DownloadTask => ({
    id,
    title,
    url: `https://fixture.invalid/${id}.mp4`,
    kind: "direct",
    status: "downloading",
    progress: 0,
    bytes: 0,
    total: 0,
    media: { type: "movie", title, year: 2026 },
    profile: "jellyfin",
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
  });
  const resumed = record("resumed-fixture", "Resumed Fixture");
  const linked = record("linked-fixture", "Linked Fixture");
  store.put("task", resumed);
  store.put("task", linked);
  const prefix = (id: string) =>
    `.mori-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
  const partial = Buffer.alloc(4 * 1024 * 1024, 3);
  await writeFile(path.join(downloads, `${prefix(resumed.id)}.part`), partial);
  await writeFile(
    path.join(downloads, `${prefix(resumed.id)}.json`),
    JSON.stringify({
      source: "fixture",
      filename: "Resumed Fixture (2026).mp4",
      validator: '"fixture-etag"',
      total: 8 * 1024 * 1024,
    }),
  );
  const outside = path.join(root, "outside.part");
  await writeFile(outside, partial);
  await symlink(outside, path.join(downloads, `${prefix(linked.id)}.part`));
  await writeFile(
    path.join(downloads, `${prefix(linked.id)}.json`),
    JSON.stringify({
      source: "fixture",
      filename: "Linked Fixture (2026).mp4",
      validator: '"fixture-etag"',
      total: 8 * 1024 * 1024,
    }),
  );
  const queue = new Queue(store, {} as MediaService);
  try {
    const tasks = queue.tasks();
    const restored = tasks.find((task) => task.id === resumed.id)!;
    assert.equal(restored.status, "paused");
    assert.equal(restored.bytes, partial.length);
    assert.equal(restored.total, 8 * 1024 * 1024);
    assert.equal(restored.progress, 50);
    const rejected = tasks.find((task) => task.id === linked.id)!;
    assert.equal(rejected.status, "paused");
    assert.equal(rejected.bytes, 0);
    assert.equal(rejected.total, 0);
  } finally {
    await queue.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration encryption, secret-preserving edits, password and persistent sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-store-"));
  let store: Store | undefined;
  try {
    store = new Store(root, path.join(root, "files"));
    const config = store.config();
    config.model.apiKey = "fixture-only-secret";
    store.setConfig(config);
    assert.equal(publicConfig(config).model.apiKey, "");
    assert.equal(publicConfig(config).secretStatus["model.apiKey"], true);
    assert.equal(
      validateConfig(publicConfig(config), config).model.apiKey,
      "fixture-only-secret",
    );
    assert.equal(
      validateConfig(
        { ...publicConfig(config), clearSecrets: ["model.apiKey"] },
        config,
      ).model.apiKey,
      "",
    );
    assert.throws(() =>
      validateConfig(
        { ...config, download: { ...config.download, directory: "/" } },
        config,
      ),
    );
    assert.throws(() =>
      validateConfig(
        { ...config, download: { ...config.download, concurrency: 50 } },
        config,
      ),
    );
    assert.throws(() => store!.setup("short"));
    assert.throws(() =>
      validateConfig(
        { library: { pathFrom: "/downloads", pathTo: "" } },
        config,
      ),
    );
    assert.throws(() =>
      validateConfig(
        { library: { pathFrom: "/downloads", pathTo: "relative/path" } },
        config,
      ),
    );
    delete config.library.pathFrom;
    delete config.library.pathTo;
    delete config.library.userId;
    store.setConfig(config);
    assert.equal(store.config().library.pathFrom, "");
    assert.equal(store.config().library.pathTo, "");
    assert.equal(store.config().library.userId, "");
    store.setup("mori-fixture-password");
    assert.equal(await store.checkPassword("bad"), false);
    assert.equal(await store.checkPassword("mori-fixture-password"), true);
    const session = store.session();
    assert.equal(store.authenticated(session), true);
    assert.equal(store.authenticated("fake"), false);
    store.close();
    store = undefined;
    const bytes = await readFile(path.join(root, "mori.sqlite"));
    assert.equal(bytes.includes(Buffer.from("fixture-only-secret")), false);
    store = new Store(root);
    assert.equal(store.config().model.apiKey, "fixture-only-secret");
    assert.equal(store.authenticated(session), true);
    store.logout(session);
    assert.equal(store.authenticated(session), false);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("queue deduplicates, distinguishes share links, recovers interrupted work and finishes real fixture", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-queue-"));
  const store = new Store(root, path.join(root, "files"));
  let queue: Queue | undefined;
  const media: MediaService = {
    search: async () => [],
    identify: async () => [],
    testConnection: async () => ({ ok: true, message: "fixture" }),
    download: async (task, signal, progress) => {
      assert.equal(signal.aborted, false);
      await mkdir(path.join(root, "files"), { recursive: true });
      const file = path.join(root, "files", task.id + ".mp4");
      await writeFile(file, "fixture-video");
      progress({ bytes: 13, total: 13, progress: 100 });
      return file;
    },
    scrape: async () => ({ files: [], warnings: [] }),
  };
  try {
    queue = new Queue(store, media);
    const first = queue.add({
      title: "Fixture",
      url: "https://fixture.invalid/video.mp4",
    });
    const duplicate = queue.add({
      title: "Again",
      url: "https://fixture.invalid/video.mp4",
    });
    assert.equal(first.id, duplicate.id);
    const share = queue.add({
      title: "Share",
      url: "https://fixture.invalid/share",
      kind: "share",
    });
    assert.equal(share.status, "needs_attention");
    assert.throws(() => queue!.action(share.id, "resume"));
    for (
      let i = 0;
      i < 100 &&
      queue.tasks().find((t) => t.id === first.id)?.status !== "completed";
      i++
    )
      await new Promise((r) => setTimeout(r, 20));
    const done = queue.tasks().find((t) => t.id === first.id)!;
    assert.equal(done.status, "completed");
    assert.equal(await readFile(done.path!, "utf8"), "fixture-video");
    const sub = queue.subscribe("Example");
    assert.equal(queue.subscribe("example").id, sub.id);
    assert.equal(sub.autoDownload, false);
    await queue.stop();
    queue = undefined;
    store.put("task", { ...done, id: "interrupted", status: "scraping" });
    let redownloaded = false;
    queue = new Queue(store, {
      ...media,
      download: async () => {
        redownloaded = true;
        throw new Error("must not redownload");
      },
    });
    assert.equal(
      queue.tasks().find((t) => t.id === "interrupted")?.status,
      "paused",
    );
    queue.action("interrupted", "resume");
    for (
      let i = 0;
      i < 100 &&
      queue.tasks().find((t) => t.id === "interrupted")?.status !== "completed";
      i++
    )
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      queue.tasks().find((t) => t.id === "interrupted")?.status,
      "completed",
    );
    assert.equal(redownloaded, false);
  } finally {
    await queue?.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
