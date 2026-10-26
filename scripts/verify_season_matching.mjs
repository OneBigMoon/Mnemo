#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const output = path.join(root, "docs", "evidence", "season-matching-20261024.json");
const commands = [
  {
    id: "focused",
    command: npx,
    args: [
      "tsx",
      "--test",
      "tests/matching.test.ts",
      "tests/directory-matching.test.ts",
      "tests/requests.test.ts",
    ],
  },
  { id: "full", command: npm, args: ["test"] },
  { id: "typecheck", command: npm, args: ["run", "check"] },
  { id: "build", command: npm, args: ["run", "build"] },
];

function tapCounts(text) {
  const count = (name) => {
    const matches = [
      ...text.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gmu")),
    ];
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

function digest(relative) {
  const file = path.join(root, relative);
  if (!existsSync(file)) return null;
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function run(step) {
  const started = Date.now();
  const result = spawnSync(step.command, step.args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    maxBuffer: 20 * 1024 * 1024,
    timeout: 300_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combined = `${stdout}\n${stderr}`;
  const counts = ["focused", "full"].includes(step.id)
    ? tapCounts(combined)
    : null;
  return {
    id: step.id,
    command: [step.command, ...step.args].join(" "),
    status: result.status,
    signal: result.signal,
    durationMs: Date.now() - started,
    ...(counts ? { counts } : {}),
    outputTail: combined.trim().slice(-4000),
  };
}

const results = [];
for (const step of commands) {
  process.stdout.write(`\n$ ${step.command} ${step.args.join(" ")}\n`);
  const result = run(step);
  results.push(result);
  process.stdout.write(result.outputTail);
  process.stdout.write("\n");
  if (result.status !== 0) break;
}

const failed = results.filter((result) => result.status !== 0);
const complete = results.length === commands.length && failed.length === 0;
const full = results.find((result) => result.id === "full");
const focused = results.find((result) => result.id === "focused");
const countsHealthy =
  !full ||
  (full.counts?.fail === 0 &&
    full.counts?.cancelled === 0 &&
    full.counts?.pass === full.counts?.tests);
const state = complete && countsHealthy ? "passed" : "failed";

const hashedFiles = [
  "server/matching.ts",
  "server/requests.ts",
  "tests/matching.test.ts",
  "tests/directory-matching.test.ts",
  "tests/requests.test.ts",
  "README.md",
  "docs/SEASON_MATCHING.md",
  "docs/ACCEPTANCE.md",
  "scripts/verify_season_matching.mjs",
  "package.json",
].map((file) => ({ file, sha256: digest(file) }));

const dist = path.join(root, "dist");
const assets = existsSync(path.join(dist, "assets"))
  ? readdirSync(path.join(dist, "assets"))
      .filter((name) => !name.startsWith("."))
      .sort()
      .map((name) => {
        const file = path.join("dist", "assets", name);
        return {
          file,
          bytes: statSync(path.join(root, file)).size,
          sha256: digest(file),
        };
      })
  : [];

const record = {
  task: "Mnemo 电视剧季集匹配验收",
  date: "2026-10-24",
  generatedAt: new Date().toISOString(),
  state,
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  commands: results.map(({ outputTail, ...result }) => result),
  focusedTests: focused?.counts ?? null,
  fullTests: full?.counts ?? null,
  build: {
    indexHtml: digest("dist/index.html"),
    assets,
  },
  hashedFiles,
  changedFiles: [
    "server/matching.ts",
    "tests/matching.test.ts",
    "tests/directory-matching.test.ts",
    "tests/requests.test.ts",
    "README.md",
    "docs/ACCEPTANCE.md",
    "docs/SEASON_MATCHING.md",
    "docs/evidence/season-matching-20261024.json",
    "scripts/verify_season_matching.mjs",
    "package.json",
  ],
  limitations: [
    "名称与元数据匹配测试使用受控 fixture；未调用真实 TMDB、PanSou、网盘账号、NAS 或媒体库。",
    "未校验视频文件内部季集，也未实现合集或多视频自动拆分。",
    "未知命名变体仍可能进入 uncertain 或 mismatch，需要人工判断。",
    "真实账号下载权益、真实播放链路及 Windows/物理 NAS 不在本回执范围内。",
  ],
};

writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(
  `\n${state === "passed" ? "PASS" : "FAIL"}: ${path.relative(root, output)}\n`,
);
process.stdout.write(
  `focused=${focused?.counts?.tests ?? "n/a"} full=${full?.counts?.tests ?? "n/a"} failedSteps=${failed.length}\n`,
);
process.exitCode = state === "passed" ? 0 : 1;
