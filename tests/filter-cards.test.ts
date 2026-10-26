import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateRuleCards,
  parseExpr,
  parseMetadata,
  rankCandidates,
  validateRuleCard,
  type Candidate,
  type RuleCard,
} from "../server/filter-cards.js";
import type { MediaService } from "../shared/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("validation collects every issue at once for the M2 feedback loop", () => {
  const { issues } = validateRuleCard({
    id: "  ",
    name: "坏卡",
    conditions: [
      { type: "title_matches", patterns: ["ok", "([bad"], use_regex: true },
      { type: "title_matches", patterns: ["   "] },
    ],
    max_downloads: 0,
    quota_period: "hour",
  });
  const messages = issues.map((issue) => issue.message);
  assert.ok(messages.some((m) => m.includes("id 不能为空")), messages.join("; "));
  assert.ok(messages.some((m) => m.includes("([bad")), messages.join("; "));
  assert.ok(messages.some((m) => m.includes("模式不能为空字符串")), messages.join("; "));
  assert.ok(messages.some((m) => m.includes("配额必须大于 0")), messages.join("; "));
  // 好卡零问题。
  assert.ok(
    validateRuleCard({ id: "ok", name: "好卡", conditions: [{ type: "freeleech_only" }] })
      .issues.length === 0,
  );
});

test("metadata extraction reads resolutions, sources, codecs and seasons from titles", () => {
  const meta = parseMetadata("剧集 2023 S01E02 1080p Web-DL H265");
  assert.deepEqual(meta.resolutions, ["1080p"]);
  assert.deepEqual(meta.sources, ["webdl"]);
  assert.deepEqual(meta.codecs, ["h265"]);
  assert.deepEqual(meta.seasons, [1]);
  assert.deepEqual(meta.episodes, [2]);
  // M1 扩展：不含上下文与 v2 后缀。
  const context = parseMetadata("第2集 不包含第3集");
  assert.deepEqual(context.episodes, [2]);
  const version = parseMetadata("E03v2");
  assert.deepEqual(version.episodes, [3]);
});

test("rule cards evaluate deterministically with explainable checks", () => {
  const cards: RuleCard[] = [
    {
      id: "meta",
      name: "画质与来源",
      conditions: [
        { type: "resolution_in", values: ["1080P"] },
        { type: "source_in", values: ["WebDL"] },
        { type: "codec_in", values: ["H265"] },
      ],
    },
    {
      id: "season",
      name: "限季",
      conditions: [{ type: "season_in", values: [1] }],
    },
    {
      id: "free",
      name: "只要免费",
      conditions: [{ type: "freeleech_only" }],
    },
  ];
  const { evaluations } = evaluateRuleCards(cards, {
    title: "剧集 2023 S01E02 1080p Web-DL H265",
  });
  const byId = (id: string) => evaluations.find((e) => e.card_id === id)!.matched;
  assert.ok(byId("meta"));
  assert.ok(byId("season"));
  assert.ok(!byId("free"));

  // 不命中的卡片有可解释的 Check 明细。
  const free = evaluations.find((e) => e.card_id === "free")!;
  assert.ok(free.checks.some((check) => check.field === "freeleech_only" && !check.passed));
});

test("quota windows block when the usage reaches the limit", () => {
  const cards = [
    {
      id: "quota",
      name: "每小时最多 2 个",
      conditions: [],
      max_downloads: 2,
      quota_period: "hour" as const,
    },
  ];
  const ok = evaluateRuleCards(cards, { title: "x" }, { quota: 1 });
  assert.ok(ok.evaluations[0].matched);
  const blocked = evaluateRuleCards(cards, { title: "x" }, { quota: 2 });
  assert.ok(!blocked.evaluations[0].matched);
  assert.ok(
    blocked.evaluations[0].checks.some((check) => check.field === "quota" && !check.passed),
  );
});

test("boolean expressions compose cards with and/or/not and reject unknown cards", () => {
  const cards: RuleCard[] = [
    { id: "hd", name: "高清", conditions: [{ type: "resolution_in", values: ["1080p"] }] },
    { id: "pack", name: "合集", conditions: [{ type: "title_matches", patterns: ["合集"] }] },
    { id: "free", name: "免费", conditions: [{ type: "freeleech_only" }] },
  ];
  const expression = parseExpr("hd & !(pack | free)");

  const good = evaluateRuleCards(cards, { title: "剧集 S01E02 1080p" }, {}, expression);
  assert.equal(good.expression_matched, true);

  const bad = evaluateRuleCards(
    cards,
    { title: "剧集 合集 1080p", freeleech: true },
    {},
    expression,
  );
  assert.equal(bad.expression_matched, false);

  assert.throws(
    () => evaluateRuleCards(cards, { title: "x" }, {}, parseExpr("hd & ghost")),
    /ghost/,
  );
  assert.throws(() => parseExpr("a &"), /期望卡片名或括号/);
  assert.throws(() => parseExpr("(a"), /括号不闭合/);
});

test("priority ordering and disabled cards are honored", () => {
  const cards: RuleCard[] = [
    { id: "later", name: "低优先", priority: 10, conditions: [{ type: "title_matches", patterns: ["三体"] }] },
    { id: "earlier", name: "高优先", priority: -5, conditions: [{ type: "title_matches", patterns: ["三体"] }] },
    { id: "disabled", name: "停用", enabled: false, conditions: [{ type: "title_matches", patterns: ["三体"] }] },
  ];
  const { evaluations } = evaluateRuleCards(cards, { title: "三体 S01E02" });
  assert.ok(evaluations.every((evaluation) => evaluation.card_id !== "disabled"));
  // 求值顺序按优先级升序。
  const ids = evaluations.map((evaluation) => evaluation.card_id);
  assert.deepEqual(ids, ["earlier", "later"]);
});



test("M2 endpoints: rule cards validate, evaluate and persist per instance", async () => {
  const { createApp } = await import("../server/index.js");
  const { createServer } = await import("node:http");
  const root = await mkdtemp(path.join(os.tmpdir(), "lucerna-m2-"));
  const media: MediaService = {
    search: async () => [],
    identify: async () => [],
    download: async () => {
      throw new Error("fixture download disabled");
    },
    scrape: async () => ({ files: [], warnings: [] }),
    testConnection: async () => ({ ok: true, message: "fixture" }),
  };
  const instance = createApp({
    dataDirectory: root,
    downloadDirectory: path.join(root, "downloads"),
    media,
    startBackground: false,
    testMode: true,
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let cookie = "";
  async function request(route: string, method = "GET", body?: unknown) {
    return fetch(base + route, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const setup = await request("/api/setup", "POST", { password: "lucerna-m2-fixture-password" });
  assert.equal(setup.status, 200);
  cookie = setup.headers.get("set-cookie")!.split(";")[0];

  try {
    // 坏卡 422 + 全量问题列表。
    const bad = await request("/api/filter/cards", "PUT", {
      id: "bad",
      name: "坏卡",
      conditions: [{ type: "title_matches", patterns: ["(unclosed"], use_regex: true }],
    });
    assert.equal(bad.status, 422);
    const issues = (await bad.json()).issues;
    assert.ok(issues.some((issue: { message: string }) => issue.message.includes("无法编译")));

    // 好卡 201。
    const put = await request("/api/filter/cards", "PUT", {
      id: "hd",
      name: "高清",
      conditions: [{ type: "resolution_in", values: ["1080p"] }],
    });
    assert.equal(put.status, 201);

    // 求值：命中。
    const evaluated = await request("/api/filter/evaluate", "POST", {
      candidate: { title: "剧集 S01E02 1080p" },
    });
    const result = await evaluated.json();
    const hd = result.evaluations.find((e: { card_id: string }) => e.card_id === "hd");
    assert.equal(hd.matched, true);
    assert.ok(hd.checks.some((check: { field: string }) => check.field === "resolution_in"));

    // M4：选片资源附加规则卡检查明细（fixture 的 search 结果是 share 页，
    // 需要先浏览；这里验证列表端点的资源在无规则卡/有规则卡时都不报错，
    // 且有资源时带 filterChecks 字段）。
    const list = await request("/api/requests", "GET");
    const requests = (await list.json()).requests as {
      resources: { title: string; filterChecks?: unknown }[];
    }[];
    for (const item of requests) {
      for (const resource of item.resources) {
        assert.ok(
          resource.filterChecks === undefined || Array.isArray(resource.filterChecks),
          `filterChecks 必须是数组或缺省：${resource.title}`,
        );
        if (resource.filterChecks?.length) {
          assert.ok(
            resource.filterChecks.every((card) => Array.isArray(card.checks)),
            "每张卡必须有 checks 明细",
          );
        }
      }
    }

    // 删除。
    const deleted = await request("/api/filter/cards/hd", "DELETE");
    assert.equal(deleted.status, 200);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("M5 weighted ranking orders candidates with score gate and upgrade target", () => {
  const cards: RuleCard[] = [
    { id: "remux", name: "原盘加分", score: 50, conditions: [{ type: "source_in", values: ["remux"] }] },
    { id: "hd", name: "1080p 加分", score: 20, conditions: [{ type: "resolution_in", values: ["1080p"] }] },
    { id: "ban", name: "垃圾组负分", score: -100, conditions: [{ type: "group_in", groups: ["badgrp"] }] },
  ];
  const candidates: Candidate[] = [
    { title: "剧集 S01E02 1080p WEB-DL" },
    { title: "剧集 S01E02 1080p BluRay REMUX" },
    { title: "剧集 S01E02 720p" },
  ];
  const ranked = rankCandidates(cards, candidates, {}, { min_score: 10, upgrade_until: 60 });
  assert.equal(ranked[0].index, 1);
  assert.equal(ranked[0].total_score, 70);
  assert.ok(ranked[0].upgrade_reached);
  assert.equal(ranked[1].index, 0);
  assert.equal(ranked[1].total_score, 20);
  assert.ok(!ranked[1].upgrade_reached);
  assert.equal(ranked[2].index, 2); // 0 分被门槛压底
  // 负分深度扣分（硬拒绝映射）。
  const bad = rankCandidates(cards, [{ title: "剧集 1080p", group: "badgrp" }]);
  assert.equal(bad[0].total_score, 20 - 100);
});