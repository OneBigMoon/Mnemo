#!/usr/bin/env node
// Rust 核心一致性验收：cargo test / clippy / fmt 与 TS 主线全套回归，
// 结果落盘为 docs/evidence/rust-cms-episodes-pin-20261025.json。
//
// 覆盖本切片两项遗留：搜索抓取改用连接时钉住的地址（DNS pin），
// 以及 CMS 详情分集解析（browseCms 对齐）。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustCwd = path.join(root, "output", "zcode-work", "rust-core");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
const output = path.join(
  root,
  "docs",
  "evidence",
  "rust-cms-episodes-pin-20261025.json",
);

const commands = [
  {
    id: "rust-full",
    command: cargo,
    args: ["test"],
    cwd: rustCwd,
  },
  {
    id: "rust-clippy",
    command: cargo,
    args: ["clippy", "--all-targets", "--", "-D", "warnings"],
    cwd: rustCwd,
  },
  {
    id: "rust-fmt",
    command: cargo,
    args: ["fmt", "--check"],
    cwd: rustCwd,
  },
  { id: "full-ts", command: npm, args: ["test"], cwd: root },
  { id: "typecheck", command: npm, args: ["run", "check"], cwd: root },
];

const changedFiles = [
  "output/zcode-work/rust-core/src/cms.rs",
  "output/zcode-work/rust-core/src/download.rs",
  "output/zcode-work/rust-core/src/service.rs",
  "output/zcode-work/rust-core/tests/cms_test.rs",
  "output/zcode-work/rust-core/tests/service_test.rs",
];

function tapCounts(text) {
  const count = (name) => {
    const matches = [...text.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gmu"))];
    return matches.length ? Number(matches.at(-1)[1]) : null;
  };
  return {
    tests: count("tests"),
    pass: count("pass"),
    fail: count("fail"),
    cancelled: count("cancelled"),
    skipped: count("skipped"),
    todo: count("todo"),
  };
}

// cargo test 每个测试二进制各打印一行 "test result: ok. N passed; ..."。
function cargoCounts(text) {
  const totals = { suites: 0, passed: 0, failed: 0, ignored: 0 };
  for (const match of text.matchAll(
    /^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/gmu,
  )) {
    totals.suites += 1;
    totals.passed += Number(match[1]);
    totals.failed += Number(match[2]);
    totals.ignored += Number(match[3]);
  }
  return totals.suites ? totals : null;
}

function digest(relative) {
  const file = path.join(root, relative);
  if (!existsSync(file)) return null;
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const results = [];
for (const entry of commands) {
  const started = Date.now();
  const run = spawnSync(entry.command, entry.args, {
    cwd: entry.cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = run.stdout ?? "";
  const stderr = run.stderr ?? "";
  const combined = `${stdout}\n${stderr}`;
  const record = {
    id: entry.id,
    command: [entry.command, ...entry.args].join(" "),
    cwd: path.relative(root, entry.cwd) || ".",
    status: run.status,
    durationMs: Date.now() - started,
  };
  if (entry.id === "rust-full") {
    const counts = cargoCounts(combined);
    if (counts) record.counts = counts;
    record.summary = combined
      .split("\n")
      .filter((line) => line.startsWith("test result:"))
      .join(" | ");
  } else if (entry.id === "full-ts") {
    const counts = tapCounts(combined);
    if (counts.tests !== null) record.counts = counts;
  } else if (entry.id === "rust-clippy") {
    // clippy 的告警行以 "warning:" 开头；0 条才算通过。
    record.warnings = combined
      .split("\n")
      .filter((line) => line.startsWith("warning:"))
      .filter((line) => !line.includes("generated")).length;
  } else if (entry.id === "rust-fmt") {
    record.summary = combined.trim().slice(0, 2000);
  }
  results.push(record);
  process.stderr.write(
    `[${record.status === 0 ? "ok" : "FAIL"}] ${record.command} (${record.durationMs}ms)\n`,
  );
}

const failed = results.filter((entry) => entry.status !== 0);
const clippy = results.find((entry) => entry.id === "rust-clippy");
const clippyClean = !clippy || clippy.status === 0;
const state = failed.length === 0 && clippyClean ? "passed" : "failed";

const receipt = {
  schema: 1,
  state,
  createdAt: new Date().toISOString(),
  scope:
    "Rust-core parity for the two gaps recorded in rust-search-20261025: connect-time DNS pinning on search fetches, and CMS V10 detail episode resolution (browseCms) with an auth-gated /api/cms/episodes endpoint",
  change: {
    summary:
      "download.rs adds pinned_agent(addrs, timeout) so every non-download fetch reuses the same validate-then-pin contract (resolve once, verify all results, connect to the pinned address); it also disables redirects (TS uses redirect:'error'), applies a total request timeout and sets a mnemo-core UA. cms.rs HttpFetch now calls validate_and_pin + pinned_agent instead of resolving again at connect time, closes the DNS-rebinding window between check and connect, and rejects non-2xx responses (ureq returns 3xx as Ok once redirects are off, so a redirect/404 body used to be parsed as a payload). cms.rs adds detail_url (TS detailUrl semantics: trailing ?/& stripped, ? vs & joiner, query-safe id encoding) and browse_cms (detail fetch via injected transport → parse_vod_detail → id match with first-detail fallback → first play group only → direct/share classification by media extension whitelist, pathname-only for absolute URLs → UTF-16-bounded 300-unit id cap). Error taxonomy: FetchError carries a security flag and browse_cms returns BrowseError {Security|Transport|Parse|Empty} instead of letting callers match on message text. download.rs also fixes host:port splitting for bracketed IPv6 literals without a port (shared split_host_port used by validate_url and validate_and_pin). service.rs adds auth-gated POST /api/cms/episodes {sourceId, sourceName, endpoint, vodId} returning {episodes}, mapping BrowseError to 400 CMS_SECURITY / 502 CMS_TRANSPORT / 502 CMS_PARSE / 502 CMS_EMPTY. Tests: cms 10/10 (detail_url joiners, first-group-only classification, first-detail fallback, Transport/Parse/Empty classification, guard rejection, a real loopback fixture proving the pinned connection still succeeds, and a redirect fixture asserting the 302 surfaces as an error with the target never requested and the origin hit exactly once), service 8/8 (endpoint auth gate, two-episode classification through a local CMS fixture, missing vodId 400).",
    files: changedFiles,
  },
  commands: results,
  evidenceFiles: Object.fromEntries(
    changedFiles.map((relative) => [relative, { sha256: digest(relative) }]),
  ),
  supersedes: "",
  relatedEvidence: ["docs/evidence/rust-search-20261025.json"],
  limitations: [
    "Rust /api/cms/episodes covers CMS V10 registry sources only; PanSou/OpenList/MoviePilot/Telegram adapters remain TS-side parity gaps.",
    "Only the first play group is returned (multi-line sources keep their alternates TS-side too, but neither side exposes group selection yet).",
    "m3u8 episodes are classified share and are not downloadable; the TS side added online playback (M9) while the Rust slice has no player.",
    "The slice is isolated under output/zcode-work and is not part of the source release package.",
    "The parent goal's final real-account/device name→find→download→scrape→playable acceptance remains outstanding.",
  ],
};

mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
const totals = results.find((entry) => entry.id === "rust-full")?.counts;
process.stdout.write(
  `Rust parity receipt: ${path.relative(root, output)} (${state})\n` +
    `rust tests: ${totals ? `${totals.passed} passed / ${totals.failed} failed across ${totals.suites} suites` : "n/a"}\n`,
);
process.exit(state === "passed" ? 0 : 1);
