import test from "node:test";
import assert from "node:assert/strict";
import { searchWithDiagnostics, searchDiagnosticSummary, searchFailureMessage } from "../shared/search.js";
import type { SearchDiagnostics, SearchReport, SearchResult } from "../shared/types.js";

test("detailed search preserves receiver, report and cancellation signal", async () => {
 const signal = new AbortController().signal;
 const report: SearchReport = { results: [], diagnostics: { status: "partial", sources: [] } };
 const service = {
  search: async (): Promise<SearchResult[]> => { throw new Error("legacy path must not run"); },
  async searchWithDiagnostics(query: string, received?: AbortSignal) {
   assert.equal(this, service);
   assert.equal(query, "测试剧集");
   assert.equal(received, signal);
   return report;
  },
 };
 assert.equal(await searchWithDiagnostics(service, "测试剧集", signal), report);
});

test("legacy search fallback preserves results and observable errors", async () => {
 const signal = new AbortController().signal;
 const results: SearchResult[] = [{ id: "one", title: "测试", source: "fixture", kind: "share", url: "https://example.invalid/one" }];
 const report = await searchWithDiagnostics({ search: async (query, received) => {
  assert.equal(query, "测试"); assert.equal(received, signal); return results;
 } }, "测试", signal);
 assert.equal(report.results, results);
 assert.deepEqual(report.diagnostics, { status: "complete", sources: [] });
 const error = new Error("fixture failure");
 await assert.rejects(searchWithDiagnostics({ search: async () => { throw error; } }, "测试"), (value) => value === error);
});

test("source summaries separate missing configuration, partial and failed searches from complete empty searches", () => {
 assert.equal(searchDiagnosticSummary(), "");
 assert.equal(searchDiagnosticSummary({ status: "complete", sources: [] }), "");
 assert.match(searchDiagnosticSummary({ status: "not_configured", sources: [] }), /分享解析账号不能代替搜索源/);
 const source: SearchDiagnostics["sources"][number] = { id: "pansou", source: "pansou", name: "PanSou", status: "failed", resultCount: 0, code: "timeout" };
 assert.match(searchDiagnosticSummary({ status: "partial", sources: [source] }), /结果不完整.*PanSou.*超时/);
 assert.match(searchDiagnosticSummary({ status: "failed", sources: [source] }), /无法判断是否有资源/);
 for (const code of ["timeout", "unreachable", "auth_required", "rate_limited", "invalid_response", "upstream_error"] as const) {
  assert(searchFailureMessage(code).length > 0);
 }
 assert.equal(searchFailureMessage(), searchFailureMessage("upstream_error"));
});
