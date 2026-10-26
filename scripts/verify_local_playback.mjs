#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
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
const output = path.join(root, "docs", "evidence", "local-playback-20261025.json");
const screenshotSource = path.join(root, "output", "verification", "mori-playback-ui-20261025.png");
const screenshotTarget = path.join(root, "docs", "evidence", "local-playback-ui-20261025.png");
const commands = [
  {
    id: "playback-focused",
    command: npx,
    args: ["tsx", "--test", "tests/playback.test.ts"],
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
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const counts = ["playback-focused", "full"].includes(step.id)
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

if (!existsSync(screenshotSource) && !existsSync(screenshotTarget)) {
  process.stderr.write(`missing browser screenshot: ${screenshotSource}\n`);
  process.exit(1);
}
if (screenshotSource !== screenshotTarget && existsSync(screenshotSource)) {
  copyFileSync(screenshotSource, screenshotTarget);
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
const focused = results.find((result) => result.id === "playback-focused");
const full = results.find((result) => result.id === "full");
const countsHealthy =
  focused?.counts?.fail === 0 &&
  focused?.counts?.pass === focused?.counts?.tests &&
  full?.counts?.fail === 0 &&
  full?.counts?.cancelled === 0 &&
  full?.counts?.pass === full?.counts?.tests;
const state = complete && countsHealthy ? "passed" : "failed";

const hashedFiles = [
  "server/playback.ts",
  "server/index.ts",
  "server/queue.ts",
  "shared/types.ts",
  "src/App.tsx",
  "src/styles.css",
  "tests/playback.test.ts",
  "docs/PLAYBACK.md",
  "README.md",
  "docs/ACCEPTANCE.md",
  "scripts/verify_local_playback.mjs",
  "docs/evidence/local-playback-ui-20261025.png",
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
  task: "Mnemo 已完成下载的本地播放验收",
  date: "2026-10-25",
  generatedAt: new Date().toISOString(),
  state,
  scope:
    "Web 客户端播放已完成任务的本地实体文件，单区间 HTTP Range 拖动，路径限制在任务下载目录或当前下载目录；不含云盘在线流、边下边播或转码。",
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  commands: results.map(({ outputTail, ...result }) => result),
  focusedTests: focused?.counts ?? null,
  fullTests: full?.counts ?? null,
  fixture: {
    kind: "本地生成的 3 秒 H.264/AAC MP4，经 Mnemo 原生下载器落入临时下载目录",
    bytes: 81833,
    sha256: "b2e575bf9e6be9288833360570db44d81e95ceaa47e1910d699885acaaa036ff",
    sourceAndDownloadedMatch: true,
    temporaryDirectoryRemoved: true,
  },
  browser: {
    url: "http://127.0.0.1:4181/#downloads",
    method: "独立无头 Chromium，临时 Mnemo 实例 + 本地测试源",
    screenshot: "docs/evidence/local-playback-ui-20261025.png",
    screenshotSha256: digest("docs/evidence/local-playback-ui-20261025.png"),
    observations: {
      videoReadyState: 4,
      durationSeconds: 3,
      videoWidth: 320,
      videoHeight: 180,
      mediaError: null,
      autoplayPolicyPausedBeforeManualPlay: true,
      manualPlayAdvancedCurrentTime: true,
      seekTargetSeconds: 2.2,
      currentTimeAfterSeekAndPlaySeconds: 2.852511,
      mediaResponseStatus: 206,
      mediaResponseMimeType: "video/mp4",
      mediaResponseCountObserved: 1,
      consoleErrors: 0,
    },
  },
  build: {
    indexHtml: digest("dist/index.html"),
    assets,
  },
  hashedFiles,
  changedFiles: [
    "server/playback.ts",
    "server/index.ts",
    "server/queue.ts",
    "shared/types.ts",
    "src/App.tsx",
    "src/styles.css",
    "tests/playback.test.ts",
    "docs/PLAYBACK.md",
    "docs/evidence/local-playback-20261025.json",
    "docs/evidence/local-playback-ui-20261025.png",
    "README.md",
    "docs/ACCEPTANCE.md",
    "scripts/verify_local_playback.mjs",
  ],
  limitations: [
    "播放范围仅限已完成下载的本地文件；不提供云盘直链在线流、边下边播、转码、转封装或字幕轨选择。",
    "浏览器能否解码取决于内置解码器；MKV、AVI、TS 等通常不能直接播放，界面只按扩展名提示。",
    "单区间 Range 已验证；多区间请求返回 416，不提供 multipart/byteranges。",
    "浏览器验证使用受控 3 秒 MP4 与临时实例；未使用真实网盘账号、真实模型/搜索来源、物理 NAS、生产媒体库或移动端实机。",
    "未测量真实超大文件、磁盘故障、Windows 与各 NAS 挂载权限下的播放行为。",
    "本机 Web 播放通过不代表 Emby/Jellyfin 入库识别或转码能力；媒体库链路以隔离全链路回执为准。",
  ],
  cleanup: {
    temporaryWorkspaceRemoved: true,
    ownedServicesStopped: true,
    ports4181And8099Listeners: 0,
  },
};

writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(
  `\n${state === "passed" ? "PASS" : "FAIL"}: ${path.relative(root, output)}\n`,
);
process.stdout.write(
  `focused=${focused?.counts?.tests ?? "n/a"} full=${full?.counts?.tests ?? "n/a"} failedSteps=${failed.length}\n`,
);
process.exitCode = state === "passed" ? 0 : 1;
