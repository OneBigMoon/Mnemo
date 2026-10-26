import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.js";
import { Queue } from "../server/queue.js";
import type { MediaService, SearchResult } from "../shared/types.js";

test("cancelling before a subscription check starts does not search or revive deleted state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-subscription-cancel-"));
  const store = new Store(path.join(root, "state"), root);
  let searches = 0;
  const media: MediaService = {
    search: async () => { searches++; return []; },
    identify: async () => [],
    download: async () => { throw new Error("unexpected download"); },
    scrape: async () => ({ files: [], warnings: [] }),
    testConnection: async () => ({ ok: true, message: "fixture" }),
  };
  const queue = new Queue(store, media);
  try {
    const paused = queue.subscribe("paused fixture");
    const pausing = queue.check(paused.id);
    queue.updateSubscription(paused.id, { enabled: false });
    assert.equal((await pausing)?.enabled, false);
    const removed = queue.subscribe("removed fixture");
    const removing = queue.check(removed.id);
    queue.removeSubscription(removed.id);
    assert.equal(await removing, undefined);
    assert.equal(searches, 0);
    assert.equal(queue.tasks().length, 0);
    assert.equal(queue.subscriptions()[0].lastCheckedAt, undefined);
  } finally {
    await queue.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("confirmed seasonal subscriptions preserve future episodes, upgrade legacy records and do not lose a capped batch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-subscriptions-"));
  const store = new Store(path.join(root, "state"), root);
  const queries: string[] = [];
  const results: SearchResult[] = [
    {
      id: "wrong-year",
      title: "The.Last.of.Us.1990.S02E03.1080p",
      kind: "direct",
      url: "https://fixture.invalid/wrong.mp4",
      source: "fixture",
    },
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `ep-${i + 3}`,
      title: `The.Last.of.Us.2023.S02E${String(i + 3).padStart(2, "0")}.1080p`,
      kind: "direct" as const,
      url: `https://fixture.invalid/${i + 3}.mp4`,
      source: "fixture",
    })),
  ];
  const media: MediaService = {
    search: async (q) => {
      queries.push(q);
      return results;
    },
    identify: async () => [],
    testConnection: async () => ({ ok: true, message: "fixture" }),
    download: async (task) => {
      const file = path.join(root, task.id + ".mp4");
      await writeFile(file, "fixture");
      return file;
    },
    scrape: async () => ({ files: [], warnings: [] }),
  };
  const queue = new Queue(store, media);
  try {
    const legacy = queue.subscribe("The Last of Us S02E03");
    assert.throws(() => queue.subscribe("unsafe", true), /确认/);
    const sub = queue.subscribe(legacy.query, true, {
      type: "tv",
      title: "The Last of Us",
      year: 2023,
      tmdbId: 100,
      season: 2,
      episode: 3,
    });
    assert.equal(sub.id, legacy.id);
    assert.equal(sub.media?.episode, undefined);
    assert.equal(sub.startEpisode, 3);
    assert.equal(queue.subscriptions().length, 1);
    await queue.check(sub.id);
    assert.equal(queue.tasks().length, 10);
    assert.equal(queue.subscriptions()[0].seen.length, 10);
    assert.equal(queue.subscriptions()[0].lastError, undefined);
    assert.ok(!queries[0].includes("E03"));
    assert.ok(queries[0].includes("S02"));
    await queue.check(sub.id);
    assert.equal(queue.tasks().length, 12);
    assert.deepEqual(
      queue
        .tasks()
        .map((t) => t.media.episode)
        .sort((a, b) => a! - b!),
      Array.from({ length: 12 }, (_, i) => i + 3),
    );
    const same = queue.add({
      title: "alternate",
      url: "https://fixture.invalid/alternate.mp4",
      kind: "direct",
      media: {
        type: "tv",
        title: "The Last of Us",
        year: 2023,
        tmdbId: 100,
        season: 2,
        episode: 3,
      },
    });
    assert.ok(queue.tasks().some((t) => t.id === same.id));
    assert.equal(queue.tasks().length, 12);
    const held = queue.add({
      title: "Other Movie",
      url: "https://fixture.invalid/share",
      kind: "share",
      media: { type: "movie", title: "Other Movie", year: 2024 },
    });
    assert.equal(held.status, "needs_attention");
    const actual = queue.add({
      title: "Other Movie",
      url: "https://fixture.invalid/other.mp4",
      kind: "direct",
      media: { type: "movie", title: "Other Movie", year: 2024 },
    });
    assert.notEqual(actual.id, held.id);
    const manual = queue.add({
      title: "Same Year",
      url: "https://fixture.invalid/manual.mp4",
      kind: "direct",
      media: { type: "movie", title: "Same Year", year: 2020 },
    });
    const identified = queue.add({
      title: "Same Year",
      url: "https://fixture.invalid/identified.mp4",
      kind: "direct",
      media: { type: "movie", title: "Same Year", year: 2020, tmdbId: 9988 },
    });
    assert.notEqual(
      identified.id,
      manual.id,
      "an identified work must not be replaced by an unverified legacy file",
    );
    assert.throws(
      () =>
        queue.add({
          title: "Same Year",
          url: "https://fixture.invalid/manual.mp4",
          kind: "direct",
          media: {
            type: "movie",
            title: "Same Year",
            year: 2020,
            tmdbId: 9988,
          },
        }),
      /已关联另一作品/,
    );
    const paused = queue.subscriptions()[0];
    paused.autoDownload = false;
    paused.enabled = false;
    paused.seen = ["ep-3"];
    store.put("subscription", paused);
    const resumed = queue.subscribe(
      paused.query,
      true,
      paused.media,
      paused.startEpisode,
    );
    assert.equal(resumed.id, paused.id);
    assert.equal(resumed.enabled, true);
    assert.equal(resumed.autoDownload, true);
    assert.deepEqual(resumed.seen, []);
  } finally {
    await queue.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
