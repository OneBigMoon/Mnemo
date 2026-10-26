/**
 * Mnemo 本地启动与安装自检工具的离线测试。
 *
 * 全部测试只使用自建临时 fixture 与替身脚本（fake npm / fake Python），不联网、
 * 不触碰真实项目文件、不读取任何凭据。信号转发与进程组语义在 macOS/Linux 上验证；
 * Windows 启动器仅做静态断言（本测试不在 Windows 上运行，见 docs/LOCAL_INSTALL.md）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as local from '../local.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SLICE_ROOT = path.resolve(TEST_DIR, '../..');
const LOCAL_MJS = path.join(SLICE_ROOT, 'scripts', 'local.mjs');
const IS_POSIX = process.platform !== 'win32';

let base;

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'mori-launcher-test-'));
});

after(() => {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch { /* 尽力清理 */ }
});

// ---------------------------------------------------------------------------
// fixture 构造
// ---------------------------------------------------------------------------

function tmp(name) {
  const d = path.join(base, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function makeFixture(root, {
  lockfile = true, server = true, nodeModules = true, dist = true, distAssets = true,
  dataDirs = true, p115Helper = false,
} = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'mori-media-agent',
    version: '0.1.0',
    engines: { node: '>=22.13.0' },
    scripts: { start: 'tsx server/index.ts' },
  }, null, 2));
  if (lockfile) fs.writeFileSync(path.join(root, 'package-lock.json'), '{ "name": "mori-media-agent", "lockfileVersion": 3 }');
  if (server) {
    fs.mkdirSync(path.join(root, 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, 'server/index.ts'), 'export {}; // fixture\n');
  }
  if (nodeModules) {
    for (const p of ['express', 'react', 'react-dom', 'tsx', 'vite', 'typescript']) {
      const d = path.join(root, 'node_modules', p);
      fs.mkdirSync(d, { recursive: true });
      // 可被 require.resolve 真实解析的最小包：package.json main 指向存在的入口
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: p, version: '0.0.0-fixture', main: 'index.js' }));
      fs.writeFileSync(path.join(d, 'index.js'), 'module.exports = {};\n');
    }
  }
  if (dist) {
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/index.html'), '<!doctype html><title>fixture</title><script src="./assets/app.js"></script>');
    if (distAssets) {
      fs.mkdirSync(path.join(root, 'dist', 'assets'), { recursive: true });
      fs.writeFileSync(path.join(root, 'dist', 'assets', 'app.js'), '// fixture asset\n');
    }
  }
  if (dataDirs) {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.mkdirSync(path.join(root, 'downloads'), { recursive: true });
  }
  if (p115Helper) {
    fs.mkdirSync(path.join(root, 'integrations', 'p115_resolver'), { recursive: true });
    fs.writeFileSync(path.join(root, 'integrations', 'p115_resolver', 'main.py'), '# fixture helper\n');
  }
  return root;
}

/** 测试替身 npm：记录参数与 cwd，可模拟退出码、延迟、信号清理与孙进程。 */
function writeFakeNpm(dir) {
  const file = path.join(dir, 'fake-npm.cjs');
  fs.writeFileSync(file, `const fs = require('node:fs');
const args = process.argv.slice(2);
const logPath = process.env.MORI_TEST_NPM_LOG;
if (logPath) fs.appendFileSync(logPath, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const marker = process.env.MORI_TEST_NPM_MARKER;
if (args[0] === '--version') {
  const ve = process.env.MORI_TEST_NPM_VERSION_EXIT;
  if (ve) process.exit(Number(ve));
  console.log('10.0.0-fixture');
  process.exit(0);
}
if (args[0] === 'start') {
  if (marker) fs.writeFileSync(marker + '.started', String(Date.now()));
  if (process.env.MORI_TEST_NPM_GRANDCHILD) {
    const cp = require('node:child_process');
    const gc = cp.spawn(process.execPath, ['-e', 'const fs=require("node:fs");const m=process.env.MORI_TEST_GC_MARKER;const seen=[];process.on("SIGINT",()=>{seen.push("SIGINT");fs.writeFileSync(m,seen.join(","));setTimeout(()=>process.exit(0),150);});process.on("SIGTERM",()=>{seen.push("SIGTERM");fs.writeFileSync(m,seen.join(","));setTimeout(()=>process.exit(0),150);});fs.writeFileSync(m+".pid",String(process.pid));setTimeout(()=>process.exit(0),20000);setInterval(()=>{},1000);'], { stdio: 'ignore', env: process.env });
    gc.unref();
  }
  let sigCount = 0;
  const sigFile = process.env.MORI_TEST_NPM_SIGCOUNT;
  const cleanup = (sig) => {
    sigCount += 1;
    if (sigFile) fs.writeFileSync(sigFile, String(sigCount));
    if (process.env.MORI_TEST_NPM_IGNORE) return;
    if (marker) fs.writeFileSync(marker + '.cleaned', sig);
    setTimeout(() => process.exit(Number(process.env.MORI_TEST_NPM_EXIT || '0')), Number(process.env.MORI_TEST_NPM_DELAY || '200'));
  };
  if (!process.env.MORI_TEST_NPM_NO_TRAP) {
    process.on('SIGINT', () => cleanup('SIGINT'));
    process.on('SIGTERM', () => cleanup('SIGTERM'));
  }
  setTimeout(() => process.exit(Number(process.env.MORI_TEST_NPM_EXIT || '0')), Number(process.env.MORI_TEST_NPM_WAIT || '30000'));
} else if (args[0] === 'ci') {
  console.log('fixture npm ci ok');
  setTimeout(() => process.exit(0), 10);
} else if (args[0] === 'run' && args[1] === 'build') {
  console.log('fixture vite build ok');
  setTimeout(() => process.exit(Number(process.env.MORI_TEST_BUILD_EXIT || '0')), 10);
} else {
  console.error('fixture npm: unsupported args ' + JSON.stringify(args));
  process.exit(64);
}
`);
  return file;
}

/**
 * 测试替身 Python：--version 输出版本；其余调用按 helper 固定 health 协议应答
 * （读 stdin，输出一行 JSON）。
 */
function writeFakePython(file, { version = '3.12.7', p115 = 'ok' } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const healthByMode = {
    ok: '{"ok":true,"data":{"available":true,"version":"0.0.9.7.2"}}',
    missing: '{"ok":true,"data":{"available":false,"version":null}}',
    wrong: '{"ok":true,"data":{"available":true,"version":"9.9.9.9"}}',
  };
  const lines = [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then echo "Python ${version}"; exit 0; fi`,
  ];
  if (p115 === 'fail') {
    lines.push('cat > /dev/null', 'exit 1');
  } else {
    lines.push('cat > /dev/null', `printf '%s\\n' '${healthByMode[p115] ?? healthByMode.ok}'`, 'exit 0');
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function fakeVenvPython(parent, mode) {
  return writeFakePython(path.join(parent, `venv-${mode}`, 'bin', 'python'), { p115: mode });
}

// ---------------------------------------------------------------------------
// 子进程辅助
// ---------------------------------------------------------------------------

function launcherEnv(extra = {}) {
  const env = { ...process.env };
  delete env.npm_execpath;
  return { ...env, ...extra };
}

function runLauncherSync(args, { env = launcherEnv(), timeout = 30000 } = {}) {
  return spawnSync(process.execPath, [LOCAL_MJS, ...args], { env, encoding: 'utf8', timeout });
}

function spawnLauncher(args, { env = launcherEnv(), detached = false, stdio = ['ignore', 'pipe', 'pipe'] } = {}) {
  const child = spawn(process.execPath, [LOCAL_MJS, ...args], { env, detached, stdio });
  let out = '';
  if (stdio[1] === 'pipe') child.stdout.on('data', (d) => { out += d; });
  if (stdio[2] === 'pipe') child.stderr.on('data', (d) => { out += d; });
  child.getOutput = () => out;
  return child;
}

async function waitExit(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`launcher 未在 ${timeoutMs}ms 内退出。输出：\n${child.getOutput()}`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitFor(predicate, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function readNpmLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** 除 --version 探测外的实际 npm 步骤调用（doctor/start/install 均会先探测一次）。 */
function npmSteps(logPath) {
  return readNpmLog(logPath).filter((e) => e.args[0] !== '--version').map((e) => e.args);
}

// ---------------------------------------------------------------------------
// 版本比较与参数解析（纯函数）
// ---------------------------------------------------------------------------

test('parseVersion：识别 v 前缀、预发布与非法输入', () => {
  assert.deepEqual(local.parseVersion('v22.13.0'), { major: 22, minor: 13, patch: 0, pre: null });
  assert.deepEqual(local.parseVersion('1.2.3-rc.1'), { major: 1, minor: 2, patch: 3, pre: 'rc.1' });
  assert.equal(local.parseVersion('22.13'), null);
  assert.equal(local.parseVersion('abc'), null);
  assert.equal(local.parseVersion(null), null);
});

test('compareVersions：大小、相等、预发布与非法输入', () => {
  assert.equal(local.compareVersions('22.13.0', 'v22.13.0'), 0);
  assert.equal(local.compareVersions('22.12.9', '22.13.0') < 0, true);
  assert.equal(local.compareVersions('23.0.0', '22.13.0') > 0, true);
  assert.equal(local.compareVersions('22.13.0-rc.1', '22.13.0') < 0, true);
  assert.equal(local.compareVersions('22.13.0-rc.1', '22.13.0-rc.2') < 0, true);
  assert.equal(local.compareVersions('22.13.0', 'not-a-version'), null);
});

test('parseArgs：命令、标志与错误分支', () => {
  assert.deepEqual(local.parseArgs(['doctor', '--json']), { command: 'doctor', flags: { json: true, help: false, version: false, root: null } });
  assert.equal(local.parseArgs(['--root', '/tmp/x', 'start']).flags.root, '/tmp/x');
  assert.equal(local.parseArgs(['doctor', '--root=/y']).flags.root, '/y');
  assert.ok(local.parseArgs(['--root']).error);
  assert.ok(local.parseArgs(['bogus']).error.includes('未知命令'));
  assert.ok(local.parseArgs(['--wat']).error.includes('未知参数'));
  assert.ok(local.parseArgs(['start', 'extra']).error.includes('多余'));
  assert.equal(local.parseArgs([]).command, null);
});

// ---------------------------------------------------------------------------
// doctor：单元级
// ---------------------------------------------------------------------------

const unitCtx = () => {
  const scratch = tmp('unit');
  const fakeNpm = writeFakeNpm(scratch);
  return {
    scratch,
    fakeNpm,
    completeRoot: makeFixture(tmp('unit/complete'), { p115Helper: true }),
    env: launcherEnv({ npm_execpath: fakeNpm }),
  };
};

test('doctor：完整 fixture 全部就绪，退出码 0', () => {
  const { scratch, fakeNpm, completeRoot, env } = unitCtx();
  const py = fakeVenvPython(scratch, 'ok');
  const { report, exitCode } = local.runDoctor({
    root: completeRoot, env: { ...env, MORI_PYTHON: py },
  });
  assert.deepEqual(report.checks.map((c) => c.id), ['node', 'npm', 'project', 'dependencies', 'build', 'network', 'dataDir', 'downloadDir', 'p115']);
  assert.equal(report.ok, true);
  assert.equal(exitCode, 0);
  assert.equal(report.summary.unavailable, 0);
  assert.equal(report.summary.unconfigured, 0);
});

test('doctor：Node 版本过低 → 不可用且整体退出码 1', () => {
  const { scratch, completeRoot, env } = unitCtx();
  const { report, exitCode } = local.runDoctor({
    root: completeRoot, env, nodeVersion: 'v20.11.0',
  });
  const node = report.checks.find((c) => c.id === 'node');
  assert.equal(node.status, 'unavailable');
  assert.ok(node.repair.includes('nodejs.org'));
  assert.equal(report.ok, false);
  assert.equal(exitCode, 1);
});

test('doctor：缺依赖与缺构建 → 未配置，修复建议指向 install', () => {
  const { scratch, completeRoot, env } = unitCtx();
  const root = makeFixture(tmp('unit/no-deps'), { nodeModules: false, dist: false });
  const { report, exitCode } = local.runDoctor({ root, env });
  const deps = report.checks.find((c) => c.id === 'dependencies');
  const build = report.checks.find((c) => c.id === 'build');
  assert.equal(deps.status, 'unconfigured');
  assert.ok(deps.repair.includes('install'));
  assert.equal(build.status, 'unconfigured');
  assert.equal(report.ok, false);
  assert.equal(exitCode, 1);
  // 对照：完整目录不受影响
  assert.ok(completeRoot);
});

test('doctor：空目录 → 项目文件不可用', () => {
  const { scratch, env } = unitCtx();
  const { report, exitCode } = local.runDoctor({ root: tmp('unit/empty-project'), env });
  const project = report.checks.find((c) => c.id === 'project');
  assert.equal(project.status, 'unavailable');
  assert.equal(exitCode, 1);
});

test('doctor：缺 package-lock.json → 项目未配置（不浮动安装）', () => {
  const { scratch, env } = unitCtx();
  const root = makeFixture(tmp('unit/no-lock'), { lockfile: false });
  const { report } = local.runDoctor({ root, env });
  const project = report.checks.find((c) => c.id === 'project');
  assert.equal(project.status, 'unconfigured');
  assert.ok(project.detail.includes('package-lock.json'));
});

test('doctor：已存在但不可写的目录 → 不可用（仅 POSIX 权限语义）', () => {
  const { scratch, env } = unitCtx();
  const root = makeFixture(tmp('unit/ro-dir'));
  const dataDir = path.join(root, 'data');
  fs.chmodSync(dataDir, 0o500);
  try {
    const { report, exitCode } = local.runDoctor({ root, env });
    const dataDirCheck = report.checks.find((c) => c.id === 'dataDir');
    assert.equal(dataDirCheck.status, 'unavailable');
    assert.ok(dataDirCheck.repair.length > 0);
    assert.equal(exitCode, 1);
  } finally {
    fs.chmodSync(dataDir, 0o700);
  }
});

test('doctor：目录不存在但父目录可写 → 正常（将自动创建）；上级不可写 → 不可用', () => {
  const { scratch, env } = unitCtx();
  const root = makeFixture(tmp('unit/auto-create'));
  const creatable = local.runDoctor({
    root, env: { ...env, MORI_DATA_DIR: path.join(root, 'data-new') },
  });
  assert.equal(creatable.report.checks.find((c) => c.id === 'dataDir').status, 'healthy');
  // 不可写父目录下的不存在目录
  const parent = path.join(root, 'locked-parent');
  fs.mkdirSync(parent);
  fs.chmodSync(parent, 0o500);
  try {
    const blocked = local.runDoctor({
      root, env: { ...env, MORI_DOWNLOAD_DIR: path.join(parent, 'downloads') },
    });
    assert.equal(blocked.report.checks.find((c) => c.id === 'downloadDir').status, 'unavailable');
  } finally {
    fs.chmodSync(parent, 0o700);
  }
});

// ---------------------------------------------------------------------------
// doctor：HOST/PORT 校验与路径解析
// ---------------------------------------------------------------------------

test('doctor：PORT/HOST 非法 → network 不可用，整体不就绪；合法值通过并回显', () => {
  const { scratch, completeRoot, env } = unitCtx();
  const cases = [
    [{ PORT: 'abc' }, 'PORT'],
    [{ PORT: '99999' }, '99999'],
    [{ PORT: '' }] /* 空串视为未设置，用下方单独断言 */,
    [{ HOST: 'not a host' }, 'HOST'],
    [{ HOST: 'bad_host' }, 'HOST'],
  ];
  for (const [vars, phrase] of cases) {
    if (!phrase) continue;
    const { report, exitCode } = local.runDoctor({ root: completeRoot, env: { ...env, ...vars } });
    const network = report.checks.find((c) => c.id === 'network');
    assert.equal(network.status, 'unavailable', JSON.stringify(vars));
    assert.ok(network.detail.includes(phrase), network.detail);
    assert.equal(report.ok, false);
    assert.equal(exitCode, 1);
  }
  const good = local.runDoctor({ root: completeRoot, env: { ...env, PORT: '5099', HOST: 'localhost' } });
  const network = good.report.checks.find((c) => c.id === 'network');
  assert.equal(network.status, 'healthy');
  assert.equal(good.report.config.port, '5099');
  assert.equal(good.report.config.host, 'localhost');
  // 空串 HOST/PORT 等价于未设置
  const empty = local.runDoctor({ root: completeRoot, env: { ...env, PORT: '', HOST: '' } });
  assert.equal(empty.report.config.port, '4180');
  assert.equal(empty.report.config.host, '127.0.0.1');
});

test('doctor：相对路径按安装目录解析，「~」开头被拒绝，悬空符号链接被识别', () => {
  const { scratch, env } = unitCtx();
  const root = makeFixture(tmp('unit/paths'));
  // 相对路径：以安装目录为基准（与 start 子进程的 cwd 一致）
  const rel = local.runDoctor({ root, env: { ...env, MORI_DATA_DIR: 'rel-data' } });
  assert.equal(rel.report.config.dataDir, path.join(root, 'rel-data'));
  assert.equal(rel.report.checks.find((c) => c.id === 'dataDir').status, 'healthy');
  // 「~」开头：Node 不展开波浪号，直接拒绝并给出可操作提示
  const tilde = local.runDoctor({ root, env: { ...env, MORI_DATA_DIR: '~/mori-data' } });
  const td = tilde.report.checks.find((c) => c.id === 'dataDir');
  assert.equal(td.status, 'unavailable');
  assert.ok(td.detail.includes('~'));
  assert.ok(td.detail.includes('MORI_DATA_DIR'));
  // 悬空符号链接：目标不存在时不得报告「将自动创建」
  const link = path.join(root, 'dangling');
  fs.symlinkSync(path.join(root, 'no-such-target'), link);
  const dangling = local.runDoctor({ root, env: { ...env, MORI_DATA_DIR: link } });
  const dd = dangling.report.checks.find((c) => c.id === 'dataDir');
  assert.equal(dd.status, 'unavailable');
  assert.ok(dd.detail.includes('符号链接'));
});

// ---------------------------------------------------------------------------
// doctor：依赖与构建的实质检查
// ---------------------------------------------------------------------------

test('doctor：占位依赖包无法解析 → 不可用；missingRuntimePackages 结论一致', () => {
  const { scratch, env } = unitCtx();
  const root = makeFixture(tmp('unit/placeholder'));
  // express 只有 package.json，没有实际入口（CJS 解析在 main 缺失时会回退 index.js，需一并移除）
  fs.writeFileSync(
    path.join(root, 'node_modules', 'express', 'package.json'),
    JSON.stringify({ name: 'express', version: '0.0.0-fixture', main: './no-such-entry.js' }),
  );
  fs.rmSync(path.join(root, 'node_modules', 'express', 'index.js'));
  const { report } = local.runDoctor({ root, env });
  const deps = report.checks.find((c) => c.id === 'dependencies');
  assert.equal(deps.status, 'unavailable');
  assert.ok(deps.detail.includes('express'));
  assert.deepEqual(local.missingRuntimePackages(root), ['express']);
});

test('doctor：空 dist/index.html 或引用资源缺失 → 未配置，不算构建完成', () => {
  const { scratch, env } = unitCtx();
  const emptyRoot = makeFixture(tmp('unit/build-empty'), { distAssets: false });
  fs.writeFileSync(path.join(emptyRoot, 'dist', 'index.html'), '');
  const empty = local.runDoctor({ root: emptyRoot, env });
  const emptyCheck = empty.report.checks.find((c) => c.id === 'build');
  assert.equal(emptyCheck.status, 'unconfigured');
  assert.ok(emptyCheck.detail.includes('空文件'));

  const refRoot = makeFixture(tmp('unit/build-missing-asset'), { distAssets: false });
  const ref = local.runDoctor({ root: refRoot, env });
  const refCheck = ref.report.checks.find((c) => c.id === 'build');
  assert.equal(refCheck.status, 'unconfigured');
  assert.ok(refCheck.detail.includes('assets/app.js'));
});

// ---------------------------------------------------------------------------
// doctor：npm 探测
// ---------------------------------------------------------------------------

test('resolveNpmInvocation：探测失败如实不可用，且只探测一次', () => {
  const scratch = tmp('npm-unit');
  const fakeNpm = writeFakeNpm(scratch);
  let calls = 0;
  const run = () => {
    calls += 1;
    return { status: 7, stdout: '', stderr: '' };
  };
  const inv = local.resolveNpmInvocation({ npm_execpath: fakeNpm }, run);
  assert.equal(inv.available, false);
  assert.ok(inv.detail.includes('7'));
  assert.equal(calls, 1);
});

test('resolveNpmInvocation：成功探测只执行一次并携带版本', () => {
  let calls = 0;
  const run = () => {
    calls += 1;
    return { status: 0, stdout: '10.9.8\n', stderr: '' };
  };
  const inv = local.resolveNpmInvocation({}, run);
  assert.equal(inv.available, true);
  assert.ok(['bundled', 'path'].includes(inv.mode));
  assert.equal(inv.version, '10.9.8');
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// doctor：115 组件（MORI_PYTHON + helper 固定 health 协议）
// ---------------------------------------------------------------------------

test('doctor：115 组件各状态均为可选，不阻塞整体就绪', () => {
  const { scratch, completeRoot, env } = unitCtx();
  const alwaysFail = () => ({ status: 1, stdout: '', stderr: '' });
  const pyOk = fakeVenvPython(scratch, 'ok');
  const pyMissing = fakeVenvPython(scratch, 'missing');
  const pyWrong = fakeVenvPython(scratch, 'wrong');
  const pyFail = fakeVenvPython(scratch, 'fail');

  // ① 无可用解释器（注入恒失败的 run）
  const none = local.runDoctor({ root: completeRoot, env, runCommand: alwaysFail });
  const noneCheck = none.report.checks.find((c) => c.id === 'p115');
  assert.equal(noneCheck.status, 'unavailable');
  assert.ok(noneCheck.repair.includes('不受影响'));

  // ② MORI_PYTHON 显式指定但不可用 → 如实不可用，不静默回退到其他解释器
  const bad = local.runDoctor({ root: completeRoot, env: { ...env, MORI_PYTHON: '/no/such/python' }, runCommand: alwaysFail });
  const badCheck = bad.report.checks.find((c) => c.id === 'p115');
  assert.equal(badCheck.status, 'unavailable');
  assert.ok(badCheck.detail.includes('MORI_PYTHON'));

  // ③ 组件文件缺失（该根目录不含 integrations/p115_resolver/main.py）
  const noHelperRoot = makeFixture(tmp('unit/no-helper'));
  const noHelper = local.runDoctor({ root: noHelperRoot, env: { ...env, MORI_PYTHON: pyOk } });
  const noHelperCheck = noHelper.report.checks.find((c) => c.id === 'p115');
  assert.equal(noHelperCheck.status, 'unconfigured');
  assert.ok(noHelperCheck.detail.includes('缺失'));

  // ④⑤⑥ health 协议下 SDK 缺失 / 版本不符 / 运行失败
  const helperRoot = makeFixture(tmp('unit/p115-helper'), { p115Helper: true });
  const cases = [
    [pyMissing, '真实导入'],
    [pyWrong, '版本不符'],
    [pyFail, '健康检查未通过'],
  ];
  for (const [py, phrase] of cases) {
    const { report } = local.runDoctor({ root: helperRoot, env: { ...env, MORI_PYTHON: py } });
    const p115 = report.checks.find((c) => c.id === 'p115');
    assert.equal(p115.optional, true);
    assert.equal(p115.status, 'unconfigured', phrase);
    assert.ok(p115.detail.includes(phrase), p115.detail);
    assert.equal(report.ok, true, '115 未就绪不应影响整体就绪');
  }

  // ⑦ 通过 helper health 协议的真实就绪
  const ready = local.runDoctor({ root: helperRoot, env: { ...env, MORI_PYTHON: pyOk } });
  const readyCheck = ready.report.checks.find((c) => c.id === 'p115');
  assert.equal(readyCheck.status, 'healthy');
  assert.ok(readyCheck.detail.includes('0.0.9.7.2'));
  assert.equal(ready.exitCode, 0);
});

test('doctor：115 组件经真实子进程走 helper health 协议（MORI_PYTHON 端到端）', () => {
  const scratch = tmp('p115-e2e');
  const root = makeFixture(path.join(scratch, 'proj'), { p115Helper: true });
  const py = writeFakePython(path.join(scratch, 'venv', 'bin', 'python'), { p115: 'ok' });
  const r = runLauncherSync(['doctor', '--json', '--root', root], {
    env: launcherEnv({ npm_execpath: writeFakeNpm(scratch), MORI_PYTHON: py }),
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(r.stdout);
  const p115 = report.checks.find((c) => c.id === 'p115');
  assert.equal(p115.status, 'healthy');
  assert.ok(p115.detail.includes('0.0.9.7.2'));
});

// ---------------------------------------------------------------------------
// doctor：子进程级（JSON / 人类可读输出 / 退出码 / 探针清理 / 无泄密）
// ---------------------------------------------------------------------------

test('doctor --json：完整 fixture 退出码 0，结构完整可解析', () => {
  const scratch = tmp('json-ok');
  const root = makeFixture(path.join(scratch, 'proj'), { p115Helper: true });
  const py = writeFakePython(path.join(scratch, 'venv', 'bin', 'python'), { p115: 'ok' });
  const r = runLauncherSync(['doctor', '--json', '--root', root], {
    env: launcherEnv({ npm_execpath: writeFakeNpm(scratch), MORI_PYTHON: py }),
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.tool, 'mori-local');
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((c) => c.id), ['node', 'npm', 'project', 'dependencies', 'build', 'network', 'dataDir', 'downloadDir', 'p115']);
  for (const c of report.checks) {
    assert.ok(['healthy', 'unconfigured', 'unavailable'].includes(c.status));
    assert.equal(typeof c.detail, 'string');
    assert.ok(c.repair === null || typeof c.repair === 'string');
  }
  assert.equal(report.summary.healthy + report.summary.unconfigured + report.summary.unavailable, report.checks.length);
  assert.equal(report.config.host, '127.0.0.1');
  assert.equal(report.config.port, '4180');
  assert.ok(report.nextSteps.length >= 1);
});

test('doctor --json：缺依赖 → 退出码 1，后续步骤包含 install', () => {
  const scratch = tmp('json-broken');
  const root = makeFixture(path.join(scratch, 'proj'), { nodeModules: false, dist: false });
  const r = runLauncherSync(['doctor', '--json', '--root', root], {
    env: launcherEnv({ npm_execpath: writeFakeNpm(scratch) }),
  });
  assert.equal(r.status, 1);
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.nextSteps.some((s) => s.includes('install')));
});

test('doctor（人类可读）：包含状态标签、修复建议与概要', () => {
  const scratch = tmp('human');
  const root = makeFixture(path.join(scratch, 'proj'), { nodeModules: false });
  const r = runLauncherSync(['doctor', '--root', root]); // 走真实 PATH 的 npm 探测
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes('Mnemo 本地自检'));
  assert.ok(r.stdout.includes('[未配置]'));
  assert.ok(r.stdout.includes('修复建议'));
  assert.ok(r.stdout.includes('概要'));
});

test('doctor：安装路径含空格与中文 → 正常工作', () => {
  const scratch = tmp('含空格 的中文 目录');
  const root = makeFixture(path.join(scratch, 'mori 安装 目录'));
  const r = runLauncherSync(['doctor', '--json', '--root', root], {
    env: launcherEnv({ npm_execpath: writeFakeNpm(scratch) }),
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
});

test('doctor：写探针只创建并删除自己的随机临时文件', () => {
  const scratch = tmp('probe');
  const root = makeFixture(path.join(scratch, 'proj'));
  const before = fs.readdirSync(path.join(root, 'data'));
  const r = runLauncherSync(['doctor', '--json', '--root', root], {
    env: launcherEnv({ npm_execpath: writeFakeNpm(scratch) }),
  });
  assert.equal(r.status, 0);
  const after = fs.readdirSync(path.join(root, 'data'));
  assert.deepEqual(after, before);
  assert.equal(after.length, 0);
});

test('probeHardLink：支持硬链接时成功且不残留探针文件', () => {
  const dir = tmp('hardlink-ok');
  const result = local.probeHardLink(dir);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('probeHardLink：文件系统拒绝硬链接时返回错误码并清理临时文件', () => {
  const dir = tmp('hardlink-fail');
  const original = fs.linkSync;
  fs.linkSync = () => {
    const err = new Error('operation not supported');
    err.code = 'ENOTSUP';
    throw err;
  };
  let result;
  try {
    result = local.probeHardLink(dir);
  } finally {
    fs.linkSync = original;
  }
  assert.deepEqual(result, { ok: false, error: 'ENOTSUP' });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('doctor：下载目录不支持硬链接 → 健康并注明拷贝回退，数据目录不受影响', () => {
  const scratch = tmp('hardlink-doctor');
  const root = makeFixture(path.join(scratch, 'proj'));
  const download = path.join(scratch, 'exfat-like');
  fs.mkdirSync(download, { recursive: true });
  const env = launcherEnv({
    MORI_DATA_DIR: path.join(root, 'data'),
    MORI_DOWNLOAD_DIR: download,
    MORI_PYTHON: path.join(scratch, 'no-python'),
  });
  const original = fs.linkSync;
  fs.linkSync = () => {
    const err = new Error('operation not supported');
    err.code = 'ENOTSUP';
    throw err;
  };
  let report;
  try {
    ({ report } = local.runDoctor({
      root,
      env,
      runCommand: () => ({ status: 0, stdout: '10.9.8', stderr: '' }),
    }));
  } finally {
    fs.linkSync = original;
  }
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  assert.equal(byId.downloadDir.status, local.STATUS.HEALTHY);
  assert.match(byId.downloadDir.detail, /不支持硬链接/);
  assert.match(byId.downloadDir.detail, /拷贝回退/);
  assert.equal(byId.dataDir.status, local.STATUS.HEALTHY);
  assert.equal(report.ok, true);
  assert.deepEqual(fs.readdirSync(download), []);
});

test('doctor：不读取也不输出任何凭据类内容', () => {
  const scratch = tmp('secrets');
  const root = makeFixture(path.join(scratch, 'proj'));
  const secret = 'mori-do-not-leak-9f3a7c';
  const r = runLauncherSync(['doctor', '--json', '--root', root], {
    env: launcherEnv({
      npm_execpath: writeFakeNpm(scratch),
      MORI_COOKIE: secret,
      MORI_P115_COOKIE: secret,
      MORI_API_TOKEN: secret,
      OPENAI_API_KEY: secret,
    }),
  });
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.includes(secret));
  assert.ok(!r.stderr.includes(secret));
  const report = JSON.parse(r.stdout);
  const json = JSON.stringify(report);
  assert.ok(!json.includes(secret));
  const keyScan = [];
  const walk = (v, p) => {
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (/cookie|secret|token|password|credential|key/i.test(k)) keyScan.push(p + k);
        walk(val, p + k + '.');
      }
    }
  };
  walk(report, '');
  assert.deepEqual(keyScan, []);
});

// ---------------------------------------------------------------------------
// start 命令
// ---------------------------------------------------------------------------

test('start：转发给 npm start，保留退出码并在正确目录执行（路径含空格/中文）', async () => {
  const scratch = tmp('start-exit');
  const root = makeFixture(path.join(scratch, 'mori 目录'));
  const log = path.join(scratch, 'npm.log');
  const env = launcherEnv({
    npm_execpath: writeFakeNpm(scratch),
    MORI_TEST_NPM_LOG: log,
    MORI_TEST_NPM_WAIT: '150',
    MORI_TEST_NPM_EXIT: '42',
  });
  const child = spawnLauncher(['start', '--root', root], { env });
  const { code } = await waitExit(child);
  assert.equal(code, 42, child.getOutput());
  const entries = readNpmLog(log);
  assert.deepEqual(entries[entries.length - 1].args, ['start']);
  assert.equal(entries[entries.length - 1].cwd, fs.realpathSync(root));
  assert.ok(child.getOutput().includes('http://127.0.0.1:4180'));
});

test('start：SIGINT 转发一次、等待子进程清理后按其退出码退出', { skip: !IS_POSIX }, async () => {
  const scratch = tmp('start-sigint');
  const root = makeFixture(path.join(scratch, 'proj'));
  const marker = path.join(scratch, 'marker');
  const sigFile = path.join(scratch, 'sigcount');
  const env = launcherEnv({
    npm_execpath: writeFakeNpm(scratch),
    MORI_TEST_NPM_MARKER: marker,
    MORI_TEST_NPM_SIGCOUNT: sigFile,
    MORI_TEST_NPM_EXIT: '7',
    MORI_TEST_NPM_DELAY: '250',
  });
  const child = spawnLauncher(['start', '--root', root], { env });
  assert.ok(await waitFor(() => fs.existsSync(`${marker}.started`)), '子进程未启动：' + child.getOutput());
  child.kill('SIGINT');
  const { code, signal } = await waitExit(child);
  assert.equal(signal, null);
  assert.equal(code, 7, '应等待子进程按自身退出码 7 退出：' + child.getOutput());
  assert.ok(fs.existsSync(`${marker}.cleaned`));
  assert.equal(fs.readFileSync(`${marker}.cleaned`, 'utf8'), 'SIGINT');
  assert.equal(fs.readFileSync(sigFile, 'utf8'), '1', '直接子进程应只收到一次 SIGINT');
});

test('start：SIGTERM 同样转发并等待清理', { skip: !IS_POSIX }, async () => {
  const scratch = tmp('start-sigterm');
  const root = makeFixture(path.join(scratch, 'proj'));
  const marker = path.join(scratch, 'marker');
  const env = launcherEnv({
    npm_execpath: writeFakeNpm(scratch),
    MORI_TEST_NPM_MARKER: marker,
    MORI_TEST_NPM_EXIT: '0',
    MORI_TEST_NPM_DELAY: '200',
  });
  const child = spawnLauncher(['start', '--root', root], { env });
  assert.ok(await waitFor(() => fs.existsSync(`${marker}.started`)));
  child.kill('SIGTERM');
  const { code } = await waitExit(child);
  assert.equal(code, 0, '应采用子进程清理后的退出码而非信号码：' + child.getOutput());
  assert.ok(fs.existsSync(`${marker}.cleaned`));
});

test('start：子进程被信号终止 → 退出码为 128+信号值', { skip: !IS_POSIX }, async () => {
  const scratch = tmp('start-sigexit');
  const root = makeFixture(path.join(scratch, 'proj'));
  const marker = path.join(scratch, 'marker');
  const env = launcherEnv({
    npm_execpath: writeFakeNpm(scratch),
    MORI_TEST_NPM_MARKER: marker,
    MORI_TEST_NPM_NO_TRAP: '1',
    MORI_TEST_NPM_WAIT: '30000',
  });
  const child = spawnLauncher(['start', '--root', root], { env, stdio: ['ignore', 'ignore', 'ignore'] });
  assert.ok(await waitFor(() => fs.existsSync(`${marker}.started`)), '子进程未启动');
  child.kill('SIGINT');
  const { code, signal } = await waitExit(child);
  assert.equal(signal, null);
  assert.equal(code, 130, 'SIGINT 终止应得到 128+2');
});

test('start：终端组级 SIGINT（Ctrl+C 广播）只让直接子进程收到一次信号', { skip: !IS_POSIX }, async () => {
  const scratch = tmp('start-ctrlc-once');
  const root = makeFixture(path.join(scratch, 'proj'));
  const marker = path.join(scratch, 'marker');
  const sigFile = path.join(scratch, 'sigcount');
  const env = launcherEnv({
    npm_execpath: writeFakeNpm(scratch),
    MORI_TEST_NPM_MARKER: marker,
    MORI_TEST_NPM_SIGCOUNT: sigFile,
    MORI_TEST_NPM_EXIT: '0',
    MORI_TEST_NPM_DELAY: '150',
  });
  // detached：launcher 成为独立进程组长，模拟终端向前台进程组广播 Ctrl+C
  const child = spawnLauncher(['start', '--root', root], { env, detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  assert.ok(await waitFor(() => fs.existsSync(`${marker}.started`)), '子进程未启动');
  process.kill(-child.pid, 'SIGINT');
  const { code } = await waitExit(child);
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(sigFile, 'utf8'), '1', '子进程在自己的进程组内，只应经一次转发收到 SIGINT');
  assert.ok(fs.existsSync(`${marker}.cleaned`));
});

test('start：SIGTERM 送达整个进程组，孙进程一并退出', { skip: !IS_POSIX }, async () => {
  const scratch = tmp('start-tree');
  const root = makeFixture(path.join(scratch, 'proj'));
  const marker = path.join(scratch, 'marker');
  const gcMarker = path.join(scratch, 'gc');
  const env = launcherEnv({
    npm_execpath: writeFakeNpm(scratch),
    MORI_TEST_NPM_MARKER: marker,
    MORI_TEST_NPM_GRANDCHILD: '1',
    MORI_TEST_GC_MARKER: gcMarker,
    MORI_TEST_NPM_EXIT: '0',
    MORI_TEST_NPM_DELAY: '200',
  });
  const child = spawnLauncher(['start', '--root', root], { env, stdio: ['ignore', 'ignore', 'ignore'] });
  assert.ok(await waitFor(() => fs.existsSync(`${gcMarker}.pid`)), '孙进程未启动');
  const gcPid = Number(fs.readFileSync(`${gcMarker}.pid`, 'utf8'));
  child.kill('SIGTERM');
  const { code } = await waitExit(child);
  assert.equal(code, 0);
  assert.ok(fs.existsSync(`${marker}.cleaned`), '直接子进程应收到信号并清理');
  assert.ok(await waitFor(() => {
    try {
      process.kill(gcPid, 0);
      return false;
    } catch {
      return true;
    }
  }), '孙进程应随进程组退出');
  assert.equal(fs.readFileSync(gcMarker, 'utf8'), 'SIGTERM');
});

test('runForeground：清理超时按组 SIGKILL 并返回准确信号', { skip: !IS_POSIX }, async () => {
  const scratch = tmp('fg-timeout');
  const fakeNpm = writeFakeNpm(scratch);
  const marker = path.join(scratch, 'marker');
  const start = Date.now();
  // runForeground 在等待期间为测试进程注册了信号处理器：向自身发 SIGTERM 会触发
  // 转发与限时清理，而替身 npm 忽略该信号，最终应在 killTimeoutMs 后按组 SIGKILL。
  const pending = local.runForeground(process.execPath, [fakeNpm, 'start'], {
    cwd: scratch,
    env: { ...process.env, MORI_TEST_NPM_MARKER: marker, MORI_TEST_NPM_IGNORE: '1' },
    killTimeoutMs: 300,
  });
  assert.ok(await waitFor(() => fs.existsSync(`${marker}.started`)), '子进程未启动');
  process.kill(process.pid, 'SIGTERM');
  const result = await pending;
  assert.equal(result.signal, 'SIGKILL');
  assert.ok(Date.now() - start < 5000, '应有界退出而不是无限等待');
});

test('runForeground：直接子进程先退出仍限时清理忽略 SIGTERM 的孙进程', { skip: !IS_POSIX }, async () => {
  const scratch = tmp('fg-orphan');
  const marker = path.join(scratch, 'tree.json');
  const grand = path.join(scratch, 'grand.cjs');
  const middle = path.join(scratch, 'middle.cjs');
  const wrapper = path.join(scratch, 'wrapper.mjs');
  fs.writeFileSync(grand, `process.on('SIGTERM', () => {}); process.send(process.pid); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 5000);`);
  fs.writeFileSync(middle, `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [${JSON.stringify(grand)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
child.on('message', (pid) => fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ middle: process.pid, grand: pid })));
process.on('SIGTERM', () => process.exit(0));
setTimeout(() => process.exit(0), 5000);
`);
  fs.writeFileSync(wrapper, `
import { runForeground, signalExitCode } from ${JSON.stringify(pathToFileURL(LOCAL_MJS).href)};
const result = await runForeground(process.execPath, [${JSON.stringify(middle)}], { cwd: ${JSON.stringify(scratch)}, killTimeoutMs: 300 });
console.log(JSON.stringify(result));
process.exitCode = result.signal ? signalExitCode(result.signal) : result.code;
`);
  const child = spawn(process.execPath, [wrapper], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  child.getOutput = () => output;
  let tree;
  try {
    assert.ok(await waitFor(() => fs.existsSync(marker), 3000), '孙进程信号处理器未就绪');
    tree = JSON.parse(fs.readFileSync(marker, 'utf8'));
    const closed = waitExit(child, 2000);
    const start = Date.now();
    child.kill('SIGTERM');
    const { code, signal } = await closed;
    assert.equal(signal, null);
    assert.equal(code, 137, output);
    assert.throws(() => process.kill(tree.grand, 0), { code: 'ESRCH' }, 'launcher 退出时孙进程必须已消失');
    assert.ok(Date.now() - start < 1500, '取消后清理必须有界');
  } finally {
    for (const pid of [tree?.grand, tree?.middle]) {
      if (Number.isInteger(pid) && pid > 1) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* fixture 已退出 */ }
      }
    }
    child.kill('SIGKILL');
  }
});

test('start：PORT 非法 → 中文错误退出码 1，且绝不启动 npm', () => {
  const scratch = tmp('start-badport');
  const root = makeFixture(path.join(scratch, 'proj'));
  const log = path.join(scratch, 'npm.log');
  const r = runLauncherSync(['start', '--root', root], {
    env: launcherEnv({ npm_execpath: writeFakeNpm(scratch), MORI_TEST_NPM_LOG: log, PORT: '99999' }),
  });
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes('PORT'));
  assert.equal(readNpmLog(log).filter((e) => e.args[0] === 'start').length, 0, 'npm start 不应被调用');
});

test('start：依赖缺失 → 给出安装指引且绝不调用 npm start', () => {
  const scratch = tmp('start-nodeps');
  const root = makeFixture(path.join(scratch, 'proj'), { nodeModules: false });
  const log = path.join(scratch, 'npm.log');
  const r = runLauncherSync(['start', '--root', root], {
    env: launcherEnv({ npm_execpath: writeFakeNpm(scratch), MORI_TEST_NPM_LOG: log }),
  });
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes('install'));
  assert.ok(r.stdout.includes('依赖尚未安装'));
  assert.equal(readNpmLog(log).filter((e) => e.args[0] === 'start').length, 0);
});

test('start：npm 探测失败（--version 退出码 7）→ 如实报错且不启动', () => {
  const scratch = tmp('start-npmbroken');
  const root = makeFixture(path.join(scratch, 'proj'));
  const log = path.join(scratch, 'npm.log');
  const r = runLauncherSync(['start', '--root', root], {
    env: launcherEnv({
      npm_execpath: writeFakeNpm(scratch),
      MORI_TEST_NPM_LOG: log,
      MORI_TEST_NPM_VERSION_EXIT: '7',
    }),
  });
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes('npm'));
  assert.ok(r.stdout.includes('Node.js'));
  assert.equal(readNpmLog(log).filter((e) => e.args[0] === 'start').length, 0);
});

test('start：--root 指向无效目录 → 参数层报错退出码 1', () => {
  const r = runLauncherSync(['start', '--root', path.join(base, 'no-such-dir')]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('不存在'));
});

// ---------------------------------------------------------------------------
// install 命令
// ---------------------------------------------------------------------------

test('install：依次执行 npm ci --include=dev 与 npm run build，成功退出码 0', async () => {
  const scratch = tmp('install-ok');
  const root = makeFixture(path.join(scratch, 'proj'), { nodeModules: false, dist: false });
  const log = path.join(scratch, 'npm.log');
  const env = launcherEnv({ npm_execpath: writeFakeNpm(scratch), MORI_TEST_NPM_LOG: log });
  const child = spawnLauncher(['install', '--root', root], { env });
  const { code } = await waitExit(child);
  assert.equal(code, 0, child.getOutput());
  assert.deepEqual(npmSteps(log), [['ci', '--include=dev'], ['run', 'build']]);
  assert.ok(child.getOutput().includes('安装完成'));
});

test('install：NODE_ENV=production 仍通过 --include=dev 安装构建工具', async () => {
  const scratch = tmp('install-prodenv');
  const root = makeFixture(path.join(scratch, 'proj'), { nodeModules: false, dist: false });
  const log = path.join(scratch, 'npm.log');
  const env = launcherEnv({
    npm_execpath: writeFakeNpm(scratch),
    MORI_TEST_NPM_LOG: log,
    NODE_ENV: 'production',
    npm_config_omit: 'dev',
  });
  const child = spawnLauncher(['install', '--root', root], { env });
  const { code } = await waitExit(child);
  assert.equal(code, 0, child.getOutput());
  assert.deepEqual(npmSteps(log), [['ci', '--include=dev'], ['run', 'build']]);
});

test('install：构建失败 → 保留失败退出码并停止后续步骤', async () => {
  const scratch = tmp('install-fail');
  const root = makeFixture(path.join(scratch, 'proj'), { nodeModules: false, dist: false });
  const log = path.join(scratch, 'npm.log');
  const env = launcherEnv({
    npm_execpath: writeFakeNpm(scratch),
    MORI_TEST_NPM_LOG: log,
    MORI_TEST_BUILD_EXIT: '5',
  });
  const child = spawnLauncher(['install', '--root', root], { env });
  const { code } = await waitExit(child);
  assert.equal(code, 5, child.getOutput());
  assert.deepEqual(npmSteps(log), [['ci', '--include=dev'], ['run', 'build']]);
  assert.ok(child.getOutput().includes('失败'));
});

test('install：缺 package-lock.json → 拒绝浮动安装，不调用 npm', async () => {
  const scratch = tmp('install-nolock');
  const root = makeFixture(path.join(scratch, 'proj'), { lockfile: false });
  const log = path.join(scratch, 'npm.log');
  const env = launcherEnv({ npm_execpath: writeFakeNpm(scratch), MORI_TEST_NPM_LOG: log });
  const child = spawnLauncher(['install', '--root', root], { env });
  const { code } = await waitExit(child);
  assert.equal(code, 1);
  assert.ok(child.getOutput().includes('package-lock.json'));
  assert.equal(npmSteps(log).length, 0, '不应有 ci/build 调用');
});

// ---------------------------------------------------------------------------
// CLI 行为与启动器脚本静态检查
// ---------------------------------------------------------------------------

test('CLI：help 退出码 0，未知命令退出码 2，--version 输出版本', () => {
  const help = runLauncherSync(['help']);
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('用法'));
  assert.ok(help.stdout.includes('安全说明'));
  const bogus = runLauncherSync(['bogus']);
  assert.equal(bogus.status, 2);
  assert.ok(bogus.stderr.includes('未知命令'));
  const ver = runLauncherSync(['--version']);
  assert.equal(ver.status, 0);
  assert.equal(ver.stdout.trim(), local.TOOL_VERSION);
});

test('doctor --json：PORT 非法 → network 不可用并反映在 JSON 中', () => {
  const scratch = tmp('json-badport');
  const root = makeFixture(path.join(scratch, 'proj'));
  const r = runLauncherSync(['doctor', '--json', '--root', root], {
    env: launcherEnv({ npm_execpath: writeFakeNpm(scratch), PORT: 'abc' }),
  });
  assert.equal(r.status, 1);
  const report = JSON.parse(r.stdout);
  const network = report.checks.find((c) => c.id === 'network');
  assert.equal(network.status, 'unavailable');
  assert.ok(network.detail.includes('abc'));
});

test('启动器脚本：存在且关键内容符合跨平台要求', () => {
  const cmd = fs.readFileSync(path.join(SLICE_ROOT, 'start-mori.cmd'));
  const sh = fs.readFileSync(path.join(SLICE_ROOT, 'start-mori.sh'), 'utf8');
  const command = fs.readFileSync(path.join(SLICE_ROOT, 'start-mori.command'), 'utf8');
  // Windows：UTF-8 代码页、定位脚本目录、带引号的 node 调用、保留退出码。
  // 不做 cd /d（UNC 路径下 cmd 无法切换目录，且 local.mjs 以自身位置定位根目录），
  // 也不转发 %*（cmd 无法安全转义任意参数）。
  const cmdText = cmd.toString('utf8');
  assert.ok(cmdText.includes('chcp 65001'));
  assert.ok(cmdText.includes('set "SCRIPT_DIR=%~dp0"'));
  assert.ok(!cmdText.includes('cd /d'));
  assert.ok(!cmdText.includes('%*'));
  assert.ok(cmdText.includes('node "%SCRIPT_DIR%scripts\\local.mjs" start'));
  assert.ok(cmdText.includes('exit /b'));
  assert.ok(cmd.includes(Buffer.from('\r\n')), '.cmd 应使用 CRLF 行尾');
  // POSIX：command -v 探测、以脚本自身位置定位项目、引号包裹路径
  assert.ok(sh.includes('command -v node'));
  assert.ok(sh.includes('$(dirname -- "$0")'));
  assert.ok(sh.includes('"$SCRIPT_DIR/scripts/local.mjs" start'));
  assert.ok(sh.includes('nodejs.org'));
  // macOS 双击入口委托给 start-mori.sh，避免两份实现漂移
  assert.ok(command.includes('start-mori.sh'));
  if (IS_POSIX) {
    for (const f of ['start-mori.sh', 'start-mori.command']) {
      assert.ok(fs.statSync(path.join(SLICE_ROOT, f)).mode & 0o111, `${f} 应有可执行权限`);
    }
  }
});
