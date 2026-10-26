import assert from "node:assert/strict";
import test from "node:test";
import { guardEndpoint, parseVodList, registrySearch } from "../server/registry-search.js";
import { HealthTracker, type SourceRegistry } from "../server/source-registry.js";

const LIST_OK = JSON.stringify({
  code: 1,
  list: [
    { vod_id: 101, vod_name: "三体", vod_remarks: "全30集" },
    { vod_id: "102", vod_name: "漫长的季节" },
    { vod_id: "", vod_name: "缺 id" },
  ],
});

function registryOf(...sources: SourceRegistry["sources"]): SourceRegistry {
  return { format: 1, sources };
}

test("guardEndpoint enforces scheme and private-address rejection", () => {
  assert.ok(guardEndpoint("https://a.example.org/api.php/provide/vod").ok);
  assert.ok(!guardEndpoint("ftp://a.example.org/x").ok);
  assert.ok(!guardEndpoint("http://localhost/x").ok);
  assert.ok(!guardEndpoint("http://127.0.0.1/x").ok);
  assert.ok(!guardEndpoint("http://192.168.1.5/x").ok);
  assert.ok(!guardEndpoint("http://10.0.0.2/x").ok);
  assert.ok(!guardEndpoint("http://[::1]/x").ok);
  assert.ok(!guardEndpoint("not a url").ok);
});

test("parseVodList maps entries and skips idless rows, reporting code errors", () => {
  const { items } = parseVodList(LIST_OK);
  assert.deepEqual(items, [
    { id: "101", name: "三体", remarks: "全30集" },
    { id: "102", name: "漫长的季节" },
  ]);
  const bad = parseVodList(JSON.stringify({ code: -1, list: [] }));
  assert.match(bad.error ?? "", /code=-1/);
  const invalid = parseVodList("not json");
  assert.match(invalid.error ?? "", /不是合法 JSON/);
});

test("registrySearch aggregates sources, tolerates failures and escalates health", async () => {
  const health = new HealthTracker();
  const registry = registryOf(
    { id: "a", name: "源A", kind: "cms_v10", endpoint: "https://a.example.org/api.php/provide/vod" },
    { id: "b", name: "源B", kind: "cms_v10", endpoint: "https://b.example.org/api.php/provide/vod" },
    { id: "off", name: "停用", kind: "rss", endpoint: "https://off.example.org/f", enabled: false },
  );
  const fetchText = async (url: string) => {
    if (url.startsWith("https://a.example.org")) {
      return LIST_OK;
    }
    throw new Error("connection refused");
  };
  const report = await registrySearch(registry, "三体", fetchText, health, 0);
  assert.equal(report.status, "partial"); // 一源成功一源失败
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].source, "源A");
  assert.equal(report.results[0].kind, "share");
  assert.ok(report.results[0].url.startsWith("https://a.example.org/api.php"));
  const byId = Object.fromEntries(report.sources.map((item) => [item.id, item]));
  assert.equal(byId.a.status, "ok");
  assert.equal(byId.b.status, "failed");
  assert.equal(byId.b.resultCount, 0);
  assert.ok(!byId.off, "停用源不参与");
  // 失败源被禁用 30 分钟；再查时跳过。
  const second = await registrySearch(registry, "三体", fetchText, health, 10);
  const byId2 = Object.fromEntries(second.sources.map((item) => [item.id, item]));
  assert.equal(byId2.b.status, "skipped_unhealthy");
});

test("registrySearch deduplicates within a source and reports empty sources", async () => {
  const health = new HealthTracker();
  const registry = registryOf({
    id: "dup",
    name: "重复源",
    kind: "cms_v10",
    endpoint: "https://d.example.org/api.php/provide/vod",
  });
  let calls = 0;
  const fetchText = async () => {
    calls += 1;
    // 同一条目重复出现 + 一条空结果。
    return JSON.stringify({
      code: 1,
      list: [
        { vod_id: 1, vod_name: "A" },
        { vod_id: 1, vod_name: "A" },
      ],
    });
  };
  const report = await registrySearch(registry, "x", fetchText, health, 0);
  assert.equal(calls, 1);
  assert.equal(report.results.length, 1);
  assert.equal(report.status, "complete");

  const emptyFetch = async () => JSON.stringify({ code: 1, list: [] });
  const empty = await registrySearch(registry, "x", emptyFetch, health, 0);
  assert.equal(empty.status, "complete"); // 空结果不是失败
  assert.equal(empty.sources[0].status, "empty");
});

test("media pipeline treats an invalid registryJson as not configured", async () => {
  const { loadRegistry } = await import("../server/source-registry.js");
  // 无效 JSON / 非法注册表都收敛为 issues，registry 为 undefined ——
  // media.searchWithDiagnostics 的接入层据此跳过（不抛错）。
  const invalid = loadRegistry("{bad");
  assert.equal(invalid.registry, undefined);
  assert.ok(invalid.issues.length > 0);
  const badEndpoint = loadRegistry(
    JSON.stringify({ format: 1, sources: [{ id: "x", name: "X", kind: "cms_v10", endpoint: "ftp://x/y" }] }),
  );
  assert.equal(badEndpoint.registry, undefined);
});

test("parseVodDetail splits play groups and episodes; detailUrl joins correctly", async () => {
  const { parseVodDetail, detailUrl } = await import("../server/cms-detail.js");
  const payload = JSON.stringify({
    code: 1,
    list: [
      {
        vod_id: 101,
        vod_name: "三体",
        vod_play_url:
          "第01集$https://cdn.example.org/e01.m3u8#第02集$https://cdn.example.org/e02.m3u8$$$备用线路$https://backup.example.org/e01.m3u8",
      },
      { vod_id: "", vod_name: "缺 id" },
    ],
  });
  const { details } = parseVodDetail(payload);
  assert.equal(details.length, 1);
  assert.equal(details[0].playGroups.length, 2);
  assert.equal(details[0].playGroups[0].length, 2);
  assert.equal(details[0].playGroups[0][0].name, "第01集");
  assert.equal(details[0].playGroups[1][0].name, "备用线路");
  assert.deepEqual(parseVodDetail("nope").details, []);
  assert.match(parseVodDetail(JSON.stringify({ code: -1 })).error ?? "", /code=-1/);
  assert.equal(
    detailUrl("https://a.example.org/api.php/provide/vod", "101"),
    "https://a.example.org/api.php/provide/vod?ac=videolist&ids=101",
  );
});