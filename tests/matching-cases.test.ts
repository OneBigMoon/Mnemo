import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { episodeMarkers } from "../server/matching.js";

// 与 output/zcode-work/rust-core/tests/matching_parity.rs 消费同一份夹具：
// parity 用例锁定当前 TS 行为（Rust 移植逐条对照）；extended 用例是 M1 扩展
// 的手写规格，TS 主线实现后由 gen-fixtures.mjs 翻转为 parity。
const fixture = JSON.parse(
  readFileSync(new URL("fixtures/matching-cases.json", import.meta.url), "utf8"),
) as {
  cases: { title: string; level: "parity" | "extended"; seasons: number[]; episodes: number[]; pack: boolean }[];
};

test("matching fixture parity cases match the TypeScript implementation", () => {
  const parity = fixture.cases.filter((item) => item.level === "parity");
  assert.ok(parity.length >= 60, `expected the full parity set, got ${parity.length}`);
  for (const item of parity) {
    assert.deepEqual(
      episodeMarkers(item.title),
      { seasons: item.seasons, episodes: item.episodes, pack: item.pack },
      item.title,
    );
  }
});
