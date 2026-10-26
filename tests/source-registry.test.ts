import assert from "node:assert/strict";
import test from "node:test";
import { defaults, validateConfig } from "../server/store.js";

test("source registry survives settings validation for new and older installations", () => {
  const registryJson = JSON.stringify({ format: 1, sources: [{ id: "rss", name: "RSS", kind: "rss", endpoint: "https://catalog.example/feed" }] });
  for (const legacy of [false, true]) {
    const old = defaults("/tmp/registry-fixture");
    if (legacy) delete old.sources.registryJson;
    const input = structuredClone(old);
    input.sources.registryJson = registryJson;
    const saved = validateConfig(input, old);
    assert.equal(saved.sources.registryJson, registryJson);
    const earlierClient = structuredClone(saved);
    delete earlierClient.sources.registryJson;
    assert.equal(validateConfig(earlierClient, saved).sources.registryJson, registryJson);
  }
});
import {
  HealthTracker,
  loadRegistry,
  validateRegistry,
  type SourceRegistry,
} from "../server/source-registry.js";

test("registry validation collects every issue at once and rejects private endpoints", () => {
  const { issues } = validateRegistry({
    format: 2,
    sources: [
      { id: "", name: "缺 id", kind: "cms_v10", endpoint: "https://a.example.org/api.php/provide/vod" },
      { id: "dup", name: "一", kind: "cms_v10", endpoint: "https://b.example.org/api.php/provide/vod" },
      { id: "dup", name: "二", kind: "cms_v10", endpoint: "https://c.example.org/api.php/provide/vod" },
      { id: "bad-kind", name: "坏类型", kind: "torznab", endpoint: "https://d.example.org/x" },
      { id: "private", name: "内网", kind: "rss", endpoint: "http://192.168.1.5/feed.xml" },
      { id: "loopback", name: "环回", kind: "rss", endpoint: "http://localhost/feed.xml" },
    ],
  });
  const messages = issues.map((issue) => issue.message);
  assert.ok(messages.some((m) => m.includes("format 必须是 1")), messages.join(";"));
  assert.ok(messages.some((m) => m.includes("id 不能为空")));
  assert.ok(messages.some((m) => m.includes("id 重复：dup")));
  assert.ok(messages.some((m) => m.includes("kind 必须是")));
  assert.ok(messages.some((m) => m.includes("拒绝内网/环回")));
  // 合法注册表零问题。
  const ok: SourceRegistry = {
    format: 1,
    sources: [
      { id: "cms-a", name: "采集 A", kind: "cms_v10", endpoint: "https://a.example.org/api.php/provide/vod", detailRoot: "https://a.example.org/" },
      { id: "rss-b", name: "RSS B", kind: "rss", endpoint: "https://b.example.org/feed.xml", enabled: false },
    ],
  };
  assert.deepEqual(validateRegistry(ok).issues, []);
  assert.deepEqual(validateRegistry(ok).registry, ok);
});

test("loadRegistry parses JSON text and reports invalid JSON cleanly", () => {
  const { registry } = loadRegistry(
    JSON.stringify({ format: 1, sources: [{ id: "s", name: "S", kind: "rss", endpoint: "https://s.example.org/f" }] }),
  );
  assert.equal(registry?.sources.length, 1);
  const bad = loadRegistry("{not json");
  assert.equal(bad.issues.length, 1);
  assert.match(bad.issues[0].message, /不是合法 JSON/);
});

test("health tracker escalates 30min → 24h → 28d and recovers on success", () => {
  const tracker = new HealthTracker();
  assert.ok(tracker.isAvailable("s", 0));
  assert.equal(tracker.recordFailure("s", 100), 30);
  assert.ok(!tracker.isAvailable("s", 110));
  assert.ok(tracker.isAvailable("s", 130));
  assert.equal(tracker.recordFailure("s", 130), 24 * 60);
  assert.ok(!tracker.isAvailable("s", 130 + 60));
  assert.equal(tracker.recordFailure("s", 130 + 24 * 60), 28 * 24 * 60);
  assert.equal(tracker.consecutiveFailures("s"), 3);
  tracker.recordSuccess("s");
  assert.ok(tracker.isAvailable("s", 131));
  assert.equal(tracker.consecutiveFailures("s"), 0);
});
