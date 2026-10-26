import assert from "node:assert/strict";
import test from "node:test";
import { CORE_PAYLOAD_LIMIT, coreEngine, runRustCore, RustCoreError } from "../server/rust-core.js";
import { registrySearch, settleSearchSources } from "../server/registry-search.js";
import { HealthTracker } from "../server/source-registry.js";
import { createMediaService } from "../server/media.js";
import { defaults } from "../server/store.js";

const cms = JSON.stringify({ code: 1, list: [{ vod_id: 7, vod_name: "Test", vod_play_url: "EP1$https://cdn.example/e1.mp4#EP2$https://cdn.example/e2.m3u8" }] });
const rss = `<rss version="2.0"><channel><title>Catalog</title>
<item><title>Test S01E01</title><guid>one</guid><enclosure url="https://cdn.example/e1.mp4" length="42"/></item>
<item><title>Different</title><link>https://cdn.example/other.mp4</link></item>
<item><title>Test unsafe</title><link>javascript:alert(1)</link></item></channel></rss>`;

test("source scheduling is bounded and preserves order through individual failures", async () => {
  let active = 0, maximum = 0;
  const outcomes = await settleSearchSources(Array.from({ length: 32 }, (_, index) => index), async index => {
    maximum = Math.max(maximum, ++active);
    await new Promise<void>(resolve => setImmediate(resolve));
    active--;
    if (index === 5) throw new Error("fixture failure");
    return index;
  });
  assert.equal(maximum, 4);
  assert.equal(outcomes[5].status, "rejected");
  assert.deepEqual(outcomes[31], { status: "fulfilled", value: 31 });
});

test("local parser failure is visible and does not disable a healthy source", async () => {
  const health = new HealthTracker();
  const registry = { format: 1 as const, sources: [{ id: "local", name: "Local", kind: "cms_v10" as const, endpoint: "https://catalog.example/api" }] };
  const report = await registrySearch(registry, "Test", async () => cms, health, 0, undefined,
    async () => { throw new RustCoreError("CORE_UNAVAILABLE", "Core unavailable"); });
  assert.equal(report.sources[0].code, "CORE_UNAVAILABLE");
  assert.equal(health.consecutiveFailures("local"), 0);
  const retry = await registrySearch(registry, "Test", async () => cms, health, 0);
  assert.equal(retry.status, "complete");
});

test("native queue rejects overload and cancellation releases queued work", async () => {
  const controller = new AbortController();
  const work = Array.from({ length: 18 }, (_, index) => runRustCore("cms_list", cms, index === 10 ? controller.signal : undefined));
  const settled = Promise.allSettled(work);
  await assert.rejects(runRustCore("cms_list", cms), { code: "CORE_BUSY" });
  controller.abort();
  const results = await settled;
  assert.equal(results.filter(result => result.status === "fulfilled").length, 17);
  assert.equal(results[10].status, "rejected");
  assert.equal((await runRustCore("cms_list", cms)).items.length, 1);
});

test("the real native process parses CMS and RSS, with explicit errors and bounds", async () => {
  assert.equal(coreEngine(), "rust");
  assert.deepEqual((await runRustCore("cms_list", cms)).items.map(item => [item.id, item.name]), [["7", "Test"]]);
  const detail = await runRustCore("cms_detail", cms);
  assert.equal(detail.details[0].playGroups[0][1].url, "https://cdn.example/e2.m3u8");
  assert.equal((await runRustCore("feed", rss)).kind, "rss");
  await assert.rejects(runRustCore("feed", "<rss><channel>"), (error: unknown) => error instanceof RustCoreError && error.code === "FEED_XML");
  await assert.rejects(runRustCore("cms_list", "private-bad-body"), (error: unknown) => error instanceof RustCoreError && !error.message.includes("private-bad-body"));
  await assert.rejects(runRustCore("cms_list", "x".repeat(CORE_PAYLOAD_LIMIT + 1)), { code: "LIMIT" });
  await assert.rejects(runRustCore("cms_list", cms, AbortSignal.abort()), { name: "AbortError" });
});

test("feed sources use their fixed endpoint, select matching titles and retain file identity", async () => {
  const registry = { format: 1 as const, sources: [{ id: "rss", name: "Feed", kind: "rss" as const, endpoint: "https://catalog.example/feed.xml" }] };
  const seen: string[] = [];
  const first = await registrySearch(registry, "Test", async url => { seen.push(url); return rss; }, new HealthTracker(), 0);
  assert.deepEqual(seen, ["https://catalog.example/feed.xml"]);
  assert.equal(first.status, "complete");
  assert.deepEqual(first.results.map(item => [item.title, item.kind, item.url, item.size]), [["Test S01E01", "direct", "https://cdn.example/e1.mp4", "42 B"]]);
  assert.equal(first.results[0].cmsRef, undefined);
  const second = await registrySearch(registry, "Test", async () => rss, new HealthTracker(), 0);
  assert.equal(second.results[0].id, first.results[0].id);
});

test("Atom search and source failures remain independently visible", async () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title><entry><id>episode</id><title>Test E2</title><link href="https://cdn.example/e2.mp4" rel="enclosure"/></entry></feed>`;
  const sources = [
    { id: "atom", name: "Atom", kind: "atom" as const, endpoint: "https://catalog.example/feed" },
    { id: "bad", name: "Bad", kind: "rss" as const, endpoint: "https://broken.example/feed" },
  ];
  const report = await registrySearch({ format: 1, sources }, "Test", async url => url.includes("broken") ? "<rss>" : atom, new HealthTracker(), 0);
  assert.equal(report.status, "partial");
  assert.equal(report.results.length, 1);
  assert.equal(report.sources.find(source => source.id === "bad")?.status, "failed");
});

test("main media pipeline uses native CMS detail parsing and bounded response reads", async (t) => {
  const config = defaults("/tmp/mnemo-native-fixture");
  const service = createMediaService(() => config);
  t.after(() => service.close?.());
  t.mock.method(globalThis, "fetch", async () => new Response(cms));
  const episodes = await service.browseCms!({ sourceId: "cms", sourceName: "CMS", endpoint: "https://catalog.example/api", vodId: "7" });
  assert.deepEqual(episodes.map(item => item.kind), ["direct", "share"]);
  assert.equal(episodes[0].id, "cms:7:EP1:https://cdn.example/e1.mp4");
  t.mock.method(globalThis, "fetch", async () => new Response("x".repeat(CORE_PAYLOAD_LIMIT + 1)));
  await assert.rejects(service.browseCms!({ sourceId: "cms", sourceName: "CMS", endpoint: "https://catalog.example/api", vodId: "7" }), { code: "RESPONSE_TOO_LARGE" });
});

test("explicit TypeScript rollback retains CMS and reports unavailable feed parsing", async (t) => {
  const before = process.env.MNEMO_CORE;
  process.env.MNEMO_CORE = "typescript";
  t.after(() => { if (before === undefined) delete process.env.MNEMO_CORE; else process.env.MNEMO_CORE = before; });
  const source = { id: "cms", name: "CMS", kind: "cms_v10" as const, endpoint: "https://catalog.example/api" };
  const report = await registrySearch({ format: 1, sources: [source] }, "Test", async () => cms, new HealthTracker(), 0);
  assert.equal(report.results[0].title, "Test");
  const feeds = await registrySearch({ format: 1, sources: [{ ...source, kind: "rss" }] }, "Test", async () => rss, new HealthTracker(), 0);
  assert.equal(feeds.status, "failed");
  assert.match(feeds.sources[0].error ?? "", /Rust/);
});
