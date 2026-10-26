#!/usr/bin/env node
/**
 * Mnemo 本地启动与安装自检工具（Windows / macOS / Linux 通用，仅用 Node 标准库）。
 *
 * 命令：
 *   node scripts/local.mjs doctor [--json] [--root <Mnemo安装目录>]
 *   node scripts/local.mjs start   [--root <Mnemo安装目录>]
 *   node scripts/local.mjs install [--root <Mnemo安装目录>]
 *   node scripts/local.mjs help
 *
 * 本工具不读取任何账号凭据、数据库或私密状态；管理员与凭据只能在 Mnemo 网页界面配置。
 * 工具自身不下载 Node.js、Python 或远程脚本；依赖安装由 npm/pip 按锁文件联网完成。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TOOL_VERSION = '1.0.0';
export const REQUIRED_NODE = '22.13.0';
export const DEFAULT_PORT = '4180';
export const DEFAULT_HOST = '127.0.0.1';
export const PINNED_P115 = '0.0.9.7.2';
// integrations/p115_resolver/README.md 记录的默认虚拟环境解释器位置；用户目录安装见 docs/LOCAL_INSTALL.md。
const DEFAULT_P115_PYTHONS = () => [
  '/opt/mori-p115/bin/python',
  path.join(os.homedir(), '.local', 'share', 'mori-p115', 'bin', 'python'),
];

export const STATUS = {
  HEALTHY: 'healthy',
  UNCONFIGURED: 'unconfigured',
  UNAVAILABLE: 'unavailable',
};

const IS_WINDOWS = process.platform === 'win32';
// start 正常运行所需的依赖（dependencies + 关键 devDependencies）
const RUNTIME_PACKAGES = ['express', 'react', 'react-dom', 'tsx', 'vite', 'typescript'];
// 115 readiness 只采信 helper 自身的固定 health 协议（真实导入 SDK 并核对精确版本）。
const P115_HEALTH_REQUEST = '{"op":"health"}\n';

// ---------------------------------------------------------------------------
// 版本比较
// ---------------------------------------------------------------------------

export function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(input.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

function comparePre(a, b) {
  if (a === b) return 0;
  if (a === null) return 1; // 正式版 > 预发布版
  if (b === null) return -1;
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x) ? Number(x) : null;
    const yn = /^\d+$/.test(y) ? Number(y) : null;
    if (xn !== null && yn !== null) {
      if (xn !== yn) return xn < yn ? -1 : 1;
    } else if (xn !== null) return -1; // 数字标识 < 字母数字标识
    else if (yn !== null) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (va[key] !== vb[key]) return va[key] < vb[key] ? -1 : 1;
  }
  return comparePre(va.pre, vb.pre);
}

// ---------------------------------------------------------------------------
// 参数解析与配置校验
// ---------------------------------------------------------------------------

const KNOWN_COMMANDS = new Set(['doctor', 'start', 'install', 'help']);

export function parseArgs(argv) {
  const flags = { json: false, help: false, version: false, root: null };
  let command = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--version' || a === '-v') flags.version = true;
    else if (a === '--root') {
      const v = argv[++i];
      if (!v) return { error: '--root 需要一个目录参数' };
      flags.root = v;
    } else if (a.startsWith('--root=')) flags.root = a.slice('--root='.length);
    else if (a.startsWith('-') && a !== '-') return { error: `未知参数：${a}` };
    else if (command === null) {
      if (!KNOWN_COMMANDS.has(a)) return { error: `未知命令：${a}` };
      command = a;
    } else return { error: `多余的参数：${a}` };
  }
  return { command, flags };
}

export function defaultProjectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function isValidHost(value) {
  if (typeof value !== 'string' || !value || value.length > 253) return false;
  if (net.isIP(value)) return true;
  // 主机名：点分标签，标签内仅字母数字与连字符
  return /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/.test(value);
}

function resolveDirConfig(root, rawValue, envName, fallbackName) {
  if (rawValue == null || rawValue === '') {
    return { dir: path.join(root, fallbackName), error: null };
  }
  const value = String(rawValue);
  if (value.startsWith('~')) {
    return {
      dir: null,
      error: `${envName}「${value}」以「~」开头：本工具与应用都不会展开波浪号，按字面路径处理几乎一定不是想要的位置。请在 shell 中用 "$HOME/..." 展开后传入，或改为绝对路径 / 相对安装目录的路径。`,
    };
  }
  // 与 start 的子进程保持一致：相对路径按 Mnemo 安装目录解析（启动时 cwd 为安装目录）。
  return { dir: path.isAbsolute(value) ? value : path.resolve(root, value), error: null };
}

export function resolveConfig(root, env = process.env) {
  const errors = { host: null, port: null, dataDir: null, downloadDir: null };
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  const rawHost = env.HOST;
  if (rawHost != null && String(rawHost) !== '') {
    if (isValidHost(String(rawHost))) host = String(rawHost);
    else errors.host = `HOST「${rawHost}」不是合法的主机名或 IP 地址。`;
  }
  const rawPort = env.PORT;
  if (rawPort != null && String(rawPort) !== '') {
    const value = String(rawPort);
    if (!/^\d+$/.test(value)) errors.port = `PORT「${value}」必须是 0–65535 的十进制整数。`;
    else if (Number(value) > 65535) errors.port = `PORT ${value} 超出范围：必须是 0–65535 的十进制整数。`;
    else port = value;
  }
  const data = resolveDirConfig(root, env.MORI_DATA_DIR, 'MORI_DATA_DIR', 'data');
  const download = resolveDirConfig(root, env.MORI_DOWNLOAD_DIR, 'MORI_DOWNLOAD_DIR', 'downloads');
  errors.dataDir = data.error;
  errors.downloadDir = download.error;
  return {
    host,
    port,
    dataDir: data.dir,
    downloadDir: download.dir,
    errors,
  };
}

// ---------------------------------------------------------------------------
// 子进程探测：一律固定命令 + 参数数组直呼，不经 shell，不做任何字符串拼接
// ---------------------------------------------------------------------------

export function defaultRunCommand(command, args, opts = {}) {
  return spawnSync(command, args, {
    timeout: opts.timeout ?? 10000,
    encoding: 'utf8',
    windowsHide: true,
    env: opts.env,
    input: opts.input,
  });
}

export function resolveNpmInvocation(env = process.env, run = defaultRunCommand) {
  // 只探测一次：真实执行 `npm --version` 并以其退出状态为准，结果供 doctor / start / install 复用。
  const probe = (command, baseArgs, mode, detail) => {
    const r = run(command, [...baseArgs, '--version'], { timeout: 15000, env });
    if (r.error && !r.stdout && !r.stderr) {
      return { available: false, mode, detail: `${detail}；无法启动进程（${r.error.code || r.error.message || r.error}）。` };
    }
    if (r.status !== 0) {
      const firstErr = r.stderr ? String(r.stderr).trim().split('\n')[0] : '';
      return {
        available: false,
        mode,
        detail: `${detail}；npm --version 退出码 ${r.status ?? '未知'}${firstErr ? `：${firstErr}` : ''}。`,
      };
    }
    return { available: true, mode, command, baseArgs, version: String(r.stdout || '').trim(), detail };
  };

  const execPath = env.npm_execpath;
  if (execPath && path.isAbsolute(execPath) && fs.existsSync(execPath)) {
    // npm 脚本内运行：node 直调 npm 的 JS 入口，全平台不经 shell。
    return probe(process.execPath, [execPath], 'execpath', `npm 执行入口 ${execPath}（node 直调）`);
  }
  // 标准 Node.js 发行版自带 npm（含 nvm-windows 布局），同样经 node 直调。
  const bundled = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  let bundledFailure = null;
  if (fs.existsSync(bundled)) {
    const result = probe(process.execPath, [bundled], 'bundled', `Node 自带 npm（${bundled}）`);
    if (result.available) return result;
    bundledFailure = result;
  }
  if (IS_WINDOWS) {
    // Windows 上 PATH 中的 npm 是需要 shell 的 .cmd 批处理；为避免不安全的 shell 拼接，这里如实报告不可用。
    return bundledFailure ?? {
      available: false,
      mode: null,
      detail: 'Windows 下未能定位可直调的 npm（不经 shell）。请使用标准 Node.js 安装（自带 npm），或在 npm 脚本内运行本工具。',
    };
  }
  const pathProbe = probe('npm', [], 'path', '经 PATH 调用 npm');
  if (pathProbe.available) return pathProbe;
  return bundledFailure ?? pathProbe;
}

// ---------------------------------------------------------------------------
// 写入探针：只在明确选定的目录内创建独占随机临时文件，且只删除该文件本身
// ---------------------------------------------------------------------------

export function probeWriteAccess(dir) {
  const name = `.mori-doctor-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  const target = path.join(dir, name);
  let created = false;
  try {
    const fd = fs.openSync(target, 'wx'); // 独占创建：绝不覆盖既有文件
    created = true;
    try {
      fs.writeSync(fd, 'mori doctor write probe\n');
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.code ? err.code : String(err) };
  } finally {
    if (created) {
      try {
        fs.unlinkSync(target);
      } catch {
        // 探针文件清理失败时保留现场，不影响诊断结论
      }
    }
  }
}

// Mnemo 下载完成后优先用硬链接原子发布媒体；exFAT/FAT32 等文件系统不支持
// link(2) 时自动改用拷贝回退（较慢，发布期间需要约两倍空间）。
export function probeHardLink(dir) {
  const base = `.mori-doctor-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const source = path.join(dir, `${base}.tmp`);
  const link = path.join(dir, `${base}.link`);
  let created = false;
  let linked = false;
  try {
    const fd = fs.openSync(source, 'wx');
    created = true;
    try {
      fs.writeSync(fd, 'mori doctor hard link probe\n');
    } finally {
      fs.closeSync(fd);
    }
    fs.linkSync(source, link);
    linked = true;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.code ? err.code : String(err) };
  } finally {
    if (linked) {
      try {
        fs.unlinkSync(link);
      } catch {
        // 尽力清理；不影响诊断结论
      }
    }
    if (created) {
      try {
        fs.unlinkSync(source);
      } catch {
        // 尽力清理；不影响诊断结论
      }
    }
  }
}

function nearestExistingAncestor(dir) {
  let cur = dir;
  while (cur && cur !== path.dirname(cur)) {
    if (fs.existsSync(cur)) return cur;
    cur = path.dirname(cur);
  }
  return fs.existsSync(cur) ? cur : null;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

function makeCheck(id, title, { optional = false, status, detail, repair = null }) {
  return { id, title, optional, status, detail, repair };
}

function probePythonVersion(command, run, env) {
  const r = run(command, ['--version'], { timeout: 6000, env });
  if (r.error && !r.stderr) return null;
  const m = /Python\s+(\d+)\.(\d+)(?:\.(\d+))?/.exec(`${r.stdout || ''} ${r.stderr || ''}`);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

// README 要求 Python >=3.12,<4：major 为 3 且 minor>=12 即同时满足上界。
function isSupportedPython(v) {
  return v.major === 3 && v.minor >= 12;
}

function checkNode(nodeVersion) {
  const cmp = compareVersions(nodeVersion, REQUIRED_NODE);
  if (cmp === null || cmp < 0) {
    return makeCheck('node', 'Node.js 运行时', {
      status: STATUS.UNAVAILABLE,
      detail: `当前 ${nodeVersion || '未知'}，低于要求的 v${REQUIRED_NODE}。`,
      repair: `请从 https://nodejs.org/zh-cn 手动安装 Node.js v${REQUIRED_NODE} 或更高版本（本工具不会自动下载）。`,
    });
  }
  return makeCheck('node', 'Node.js 运行时', {
    status: STATUS.HEALTHY,
    detail: `当前 ${nodeVersion}（要求 ≥ v${REQUIRED_NODE}）。`,
  });
}

function checkNpm(npmInvocation) {
  if (!npmInvocation.available) {
    return makeCheck('npm', 'npm 包管理器', {
      status: STATUS.UNAVAILABLE,
      detail: npmInvocation.detail,
      repair: 'npm 随 Node.js 一起分发；请安装完整的 Node.js（含 npm）后重试。若在 npm 脚本内运行，请确认 npm_execpath 指向有效的 npm-cli.js。',
    });
  }
  return makeCheck('npm', 'npm 包管理器', {
    status: STATUS.HEALTHY,
    detail: `npm ${npmInvocation.version}，${npmInvocation.detail}。`,
  });
}

function checkProject(root) {
  const missingCore = [];
  if (!fs.existsSync(path.join(root, 'package.json'))) missingCore.push('package.json');
  if (!fs.existsSync(path.join(root, 'server', 'index.ts'))) missingCore.push('server/index.ts');
  if (missingCore.length) {
    return makeCheck('project', '项目文件', {
      status: STATUS.UNAVAILABLE,
      detail: `目录 ${root} 缺少核心文件：${missingCore.join('、')}。`,
      repair: '请在完整的 Mnemo 安装目录中运行本工具（不要单独移动 scripts 或启动器文件）。',
    });
  }
  if (!fs.existsSync(path.join(root, 'package-lock.json'))) {
    return makeCheck('project', '项目文件', {
      status: STATUS.UNCONFIGURED,
      detail: '缺少 package-lock.json，无法以锁定方式安装依赖。',
      repair: '请从完整的 Mnemo 发布包中恢复 package-lock.json（不要改用浮动版本安装）。',
    });
  }
  return makeCheck('project', '项目文件', {
    status: STATUS.HEALTHY,
    detail: `核心文件齐全（${root}）。`,
  });
}

function resolvableFrom(root, pkg) {
  try {
    createRequire(path.join(root, 'package.json')).resolve(pkg);
    return true;
  } catch {
    return false;
  }
}

function checkDependencies(root) {
  const nm = path.join(root, 'node_modules');
  if (!fs.existsSync(nm)) {
    return makeCheck('dependencies', '依赖安装', {
      status: STATUS.UNCONFIGURED,
      detail: '尚未安装依赖（node_modules 不存在）。',
      repair: '运行 node scripts/local.mjs install（即 npm ci --include=dev + 前端构建）。',
    });
  }
  const broken = RUNTIME_PACKAGES.filter((p) => !resolvableFrom(root, p));
  if (broken.length) {
    return makeCheck('dependencies', '依赖安装', {
      status: STATUS.UNAVAILABLE,
      detail: `关键依赖无法从 node_modules 解析（缺失、占位或损坏）：${broken.join('、')}。`,
      repair: '运行 node scripts/local.mjs install 重新按锁文件安装；若仍失败，删除 node_modules 后重试。',
    });
  }
  return makeCheck('dependencies', '依赖安装', {
    status: STATUS.HEALTHY,
    detail: `关键依赖均可解析（${RUNTIME_PACKAGES.join('、')}）。`,
  });
}

const ASSET_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.css', '.map', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.json', '.txt', '.wasm',
]);

function missingBuiltAssets(root) {
  const dist = path.join(root, 'dist');
  let html = '';
  try {
    html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  } catch {
    return [];
  }
  const missing = new Set();
  let checked = 0;
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    if (checked >= 50) break;
    let ref = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || ref.startsWith('#')) continue;
    ref = ref.split(/[?#]/, 1)[0];
    if (!ref || !ASSET_EXTENSIONS.has(path.extname(ref).toLowerCase())) continue;
    checked++;
    const file = path.join(dist, ref.replace(/^[./\\]+/, ''));
    let st = null;
    try {
      st = fs.statSync(file);
    } catch {
      st = null;
    }
    if (!st || !st.isFile()) missing.add(ref);
  }
  return [...missing];
}

function distEntryProblem(root) {
  const entry = path.join(root, 'dist', 'index.html');
  let st = null;
  try {
    st = fs.statSync(entry);
  } catch {
    st = null;
  }
  if (!st || !st.isFile()) return 'missing';
  if (st.size === 0) return 'empty';
  return null;
}

function checkBuild(root) {
  const problem = distEntryProblem(root);
  if (problem === 'missing') {
    return makeCheck('build', '前端构建', {
      status: STATUS.UNCONFIGURED,
      detail: '未找到 dist/index.html，网页界面将无法访问。',
      repair: '运行 node scripts/local.mjs install（或 npm run build）构建前端。',
    });
  }
  if (problem === 'empty') {
    return makeCheck('build', '前端构建', {
      status: STATUS.UNCONFIGURED,
      detail: 'dist/index.html 是空文件：不能视为构建完成。',
      repair: '运行 node scripts/local.mjs install 重新构建前端。',
    });
  }
  const missing = missingBuiltAssets(root);
  if (missing.length) {
    return makeCheck('build', '前端构建', {
      status: STATUS.UNCONFIGURED,
      detail: `构建产物不完整：index.html 引用的本地资源缺失：${missing.slice(0, 5).join('、')}${missing.length > 5 ? ' 等' : ''}。`,
      repair: '运行 node scripts/local.mjs install 重新构建前端。',
    });
  }
  return makeCheck('build', '前端构建', {
    status: STATUS.HEALTHY,
    detail: '构建产物存在且引用的本地资源齐全（dist/index.html）。',
  });
}

function checkNetwork(config) {
  const problems = [config.errors.host, config.errors.port].filter(Boolean);
  if (problems.length) {
    return makeCheck('network', '监听地址与端口（HOST/PORT）', {
      status: STATUS.UNAVAILABLE,
      detail: problems.join(' '),
      repair: '请修正环境变量：PORT 为 0–65535 的十进制整数；HOST 为合法主机名或 IP（如 127.0.0.1、0.0.0.0、localhost）。',
    });
  }
  return makeCheck('network', '监听地址与端口（HOST/PORT）', {
    status: STATUS.HEALTHY,
    detail: `HOST ${config.host}，PORT ${config.port}，均通过校验。`,
  });
}

function checkDirectory(id, title, dir, resolveError, { hardLink = false } = {}) {
  if (resolveError) {
    return makeCheck(id, title, {
      status: STATUS.UNAVAILABLE,
      detail: resolveError,
      repair: '请改用绝对路径，或使用相对 Mnemo 安装目录的路径（MORI_DATA_DIR / MORI_DOWNLOAD_DIR）。',
    });
  }
  let lst = null;
  try {
    lst = fs.lstatSync(dir);
  } catch {
    lst = null;
  }
  if (lst) {
    if (lst.isSymbolicLink()) {
      let target = null;
      try {
        target = fs.statSync(dir);
      } catch {
        target = null;
      }
      if (!target || !target.isDirectory()) {
        return makeCheck(id, title, {
          status: STATUS.UNAVAILABLE,
          detail: `${dir} 是符号链接，但其目标不存在或不是目录（悬空链接不会自动创建）。`,
          repair: '请移除或修复该符号链接，或用环境变量把该目录指向其他位置。',
        });
      }
    } else if (!lst.isDirectory()) {
      return makeCheck(id, title, {
        status: STATUS.UNAVAILABLE,
        detail: `${dir} 已存在，但不是目录。`,
        repair: '请删除同名文件，或通过环境变量把该目录指向其他位置。',
      });
    }
    const probe = probeWriteAccess(dir);
    if (probe.ok) {
      if (hardLink) {
        const link = probeHardLink(dir);
        if (!link.ok) {
          return makeCheck(id, title, {
            status: STATUS.HEALTHY,
            detail: `目录存在且可写：${dir}。文件系统不支持硬链接（${link.error}），下载完成后将以拷贝回退发布：较慢，且发布期间需要约两倍空间。`,
          });
        }
      }
      return makeCheck(id, title, { status: STATUS.HEALTHY, detail: `目录存在且可写：${dir}。` });
    }
    const reason = probe.error === 'EACCES' || probe.error === 'EPERM' ? '权限不足' : String(probe.error);
    return makeCheck(id, title, {
      status: STATUS.UNAVAILABLE,
      detail: `目录不可写：${dir}（${reason}）。`,
      repair: '请修正该目录的读写权限（macOS/Linux：chmod/chown；Windows：右键属性或以管理员运行），或用环境变量指定其他可写目录。',
    });
  }
  const ancestor = nearestExistingAncestor(path.dirname(dir));
  const probe = ancestor ? probeWriteAccess(ancestor) : { ok: false, error: 'ENOENT' };
  if (probe.ok) {
    if (hardLink) {
      const link = probeHardLink(ancestor);
      if (!link.ok) {
        return makeCheck(id, title, {
          status: STATUS.HEALTHY,
          detail: `目录尚未创建，首次启动会自动创建：${dir}（父目录可写，已验证）。上级目录不支持硬链接（${link.error}），下载完成后将以拷贝回退发布。`,
        });
      }
    }
    return makeCheck(id, title, {
      status: STATUS.HEALTHY,
      detail: `目录尚未创建，首次启动会自动创建：${dir}（父目录可写，已验证）。`,
    });
  }
  return makeCheck(id, title, {
    status: STATUS.UNAVAILABLE,
    detail: `无法创建目录 ${dir}：最近的上级目录 ${ancestor || '（不存在）'} 不可写。`,
    repair: '请手动创建该目录并授予写权限，或用环境变量指向可写位置。',
  });
}

function parseHelperHealth(r) {
  if (r.error) {
    return { state: 'error', reason: `无法运行 helper（${r.error.code || r.error.message || r.error}）` };
  }
  if (r.status !== 0) {
    return { state: 'error', reason: `退出码 ${r.status ?? `信号 ${r.signal}`}` };
  }
  const line = String(r.stdout || '').trim().split('\n').filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { state: 'error', reason: '输出不是合法 JSON' };
  }
  if (!parsed || parsed.ok !== true || typeof parsed.data !== 'object' || parsed.data === null) {
    const code = parsed && parsed.error && parsed.error.code;
    return { state: 'error', reason: code ? `helper 返回错误（${code}）` : 'helper 响应不符合固定协议' };
  }
  return { state: parsed.data.available ? 'ok' : 'unavailable', version: parsed.data.version ?? null };
}

function checkP115(env, run, root) {
  const base = { id: 'p115', title: '115 分享解析组件', optional: true };
  const notAffected = '该组件只影响「115 分享文件解析」，其余功能不受影响；不需要 115 可忽略本项。';
  if (IS_WINDOWS) {
    return makeCheck(base.id, base.title, {
      optional: true,
      status: STATUS.UNAVAILABLE,
      detail: `115 helper 依赖 POSIX 的 SIGALRM/ITIMER_REAL 定时机制，当前仅支持 macOS/Linux；Windows 暂不支持 115 分享解析。${notAffected}`,
      repair: '如需 115 解析，请在 macOS 或 Linux 上按 docs/LOCAL_INSTALL.md 配置。',
    });
  }
  // 解释器选择：MORI_PYTHON 是应用实际读取的设置；显式指定时只验证它，绝不静默回退，
  // 否则 doctor 的「就绪」可能来自一个应用根本不会使用的解释器。
  const explicit = env.MORI_PYTHON;
  const candidates = explicit ? [String(explicit)] : [...DEFAULT_P115_PYTHONS(), 'python3.12', 'python3.13', 'python3'];
  let python = null;
  for (const cand of candidates) {
    const v = probePythonVersion(cand, run, env);
    if (v && isSupportedPython(v)) {
      python = { command: cand, version: v };
      break;
    }
  }
  if (!python) {
    return makeCheck(base.id, base.title, {
      optional: true,
      status: STATUS.UNAVAILABLE,
      detail: explicit
        ? `MORI_PYTHON 指定的解释器「${explicit}」不可用，或不是 Python 3.12–3.x；应用运行 115 组件时也会同样失败。`
        : '未找到 Python 3.12 或更高版本的解释器（已探测默认虚拟环境位置与 PATH）。',
      repair: `请安装 Python >=3.12,<4，并把 MORI_PYTHON 指向要使用的解释器（例如虚拟环境中的 bin/python）。${notAffected}`,
    });
  }
  const pyLabel = `${python.command}（Python ${python.version.major}.${python.version.minor}）`;
  const helper = path.join(root, 'integrations', 'p115_resolver', 'main.py');
  if (!fs.existsSync(helper)) {
    return makeCheck(base.id, base.title, {
      optional: true,
      status: STATUS.UNCONFIGURED,
      detail: `已找到可用解释器 ${pyLabel}，但 115 组件文件缺失：${helper}。`,
      repair: `请从完整的 Mnemo 发布包恢复 integrations/p115_resolver 目录。${notAffected}`,
    });
  }
  // readiness 只采信 helper 的固定 health 协议：真实导入 SDK 与 normalizer 并核对精确版本。
  const health = parseHelperHealth(run(python.command, [helper], { timeout: 30000, env, input: P115_HEALTH_REQUEST }));
  if (health.state === 'error') {
    return makeCheck(base.id, base.title, {
      optional: true,
      status: STATUS.UNCONFIGURED,
      detail: `115 helper 健康检查未通过（${health.reason}）；解释器 ${pyLabel}。`,
      repair: `请按 integrations/p115_resolver/README.md 的锁定命令在该解释器环境重装依赖，并用 MORI_PYTHON 指向它。${notAffected}`,
    });
  }
  if (health.state === 'unavailable' || health.version !== PINNED_P115) {
    return makeCheck(base.id, base.title, {
      optional: true,
      status: STATUS.UNCONFIGURED,
      detail: `helper 真实导入 p115client 失败或版本不符：期望 ${PINNED_P115}；解释器 ${pyLabel}。`,
      repair: `请按锁定文件 requirements.in / requirements.lock 重装固定版本。${notAffected}`,
    });
  }
  return makeCheck(base.id, base.title, {
    optional: true,
    status: STATUS.HEALTHY,
    detail: `115 解析环境就绪：解释器 ${pyLabel}，helper health 通过（p115client ${health.version}）。${explicit ? '' : '未设置 MORI_PYTHON；若应用使用其他解释器，请显式设置以保持一致。'}`,
  });
}

function buildNextSteps(checks) {
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  const steps = [];
  if (byId.node.status !== STATUS.HEALTHY) steps.push(`安装或升级 Node.js 至 v${REQUIRED_NODE}+，然后重新运行 doctor。`);
  if (byId.npm.status !== STATUS.HEALTHY) steps.push('安装随 Node.js 附带的 npm。');
  if (byId.network?.status !== STATUS.HEALTHY) steps.push('修正 HOST/PORT 环境变量（PORT：0–65535 的整数；HOST：合法主机名或 IP）后重新运行 doctor。');
  if (byId.project.status !== STATUS.UNAVAILABLE && byId.project.status !== STATUS.HEALTHY) steps.push('恢复 package-lock.json 后运行 node scripts/local.mjs install。');
  if (byId.project.status === STATUS.UNAVAILABLE) steps.push('在完整的 Mnemo 安装目录中重新运行本工具。');
  if (byId.dependencies?.status === STATUS.UNCONFIGURED || byId.build?.status === STATUS.UNCONFIGURED) {
    steps.push('运行 node scripts/local.mjs install（安装锁定依赖并构建前端）。');
  }
  if (byId.dependencies?.status === STATUS.UNAVAILABLE) steps.push('检查 node_modules 是否损坏，必要时删除后重新 install。');
  if (byId.dataDir?.status === STATUS.UNAVAILABLE || byId.downloadDir?.status === STATUS.UNAVAILABLE) {
    steps.push('修复数据/下载目录配置、权限或文件系统限制（下载目录建议使用支持硬链接的文件系统，不支持时自动以拷贝回退发布），或通过 MORI_DATA_DIR / MORI_DOWNLOAD_DIR 指定可写位置。');
  }
  if (byId.p115 && byId.p115.status !== STATUS.HEALTHY) {
    steps.push('（可选）按 docs/LOCAL_INSTALL.md 配置 115 解析环境；不配置不影响其他功能。');
  }
  if (!steps.length) steps.push('环境就绪：运行 node scripts/local.mjs start，或双击 start-mori 启动器。');
  return steps;
}

export function runDoctor(options = {}) {
  const root = options.root ?? defaultProjectRoot();
  const env = options.env ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.version;
  const run = options.runCommand ?? defaultRunCommand;
  const config = resolveConfig(root, env);
  const npmInvocation = resolveNpmInvocation(env, run);

  const checks = [
    checkNode(nodeVersion),
    checkNpm(npmInvocation),
    checkProject(root),
    checkDependencies(root),
    checkBuild(root),
    checkNetwork(config),
    checkDirectory('dataDir', '数据目录', config.dataDir, config.errors.dataDir),
    checkDirectory('downloadDir', '下载目录', config.downloadDir, config.errors.downloadDir, { hardLink: true }),
    checkP115(env, run, root),
  ];

  const summary = {
    healthy: checks.filter((c) => c.status === STATUS.HEALTHY).length,
    unconfigured: checks.filter((c) => c.status === STATUS.UNCONFIGURED).length,
    unavailable: checks.filter((c) => c.status === STATUS.UNAVAILABLE).length,
  };
  const ok = checks.filter((c) => !c.optional).every((c) => c.status === STATUS.HEALTHY);
  const report = {
    tool: 'mori-local',
    toolVersion: TOOL_VERSION,
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    ok,
    summary,
    config: {
      host: config.host,
      port: config.port,
      dataDir: config.dataDir ?? '（未能解析：见 dataDir 检查项）',
      downloadDir: config.downloadDir ?? '（未能解析：见 downloadDir 检查项）',
    },
    checks,
    nextSteps: buildNextSteps(checks),
  };
  return { report, exitCode: ok ? 0 : 1 };
}

const STATUS_LABEL = {
  [STATUS.HEALTHY]: '[正常]',
  [STATUS.UNCONFIGURED]: '[未配置]',
  [STATUS.UNAVAILABLE]: '[不可用]',
};

export function formatHumanReport(report) {
  const lines = [];
  lines.push('============ Mnemo 本地自检（doctor） ============');
  lines.push(`项目根目录：${report.projectRoot}`);
  lines.push('------------------------------------------------');
  for (const c of report.checks) {
    lines.push(`${STATUS_LABEL[c.status]} ${c.title}${c.optional ? '（可选，不影响整体就绪判断）' : ''}`);
    lines.push(`       ${c.detail}`);
    if (c.repair) lines.push(`       修复建议：${c.repair}`);
  }
  lines.push('------------------------------------------------');
  lines.push(`生效配置：监听 http://${report.config.host === '0.0.0.0' ? '127.0.0.1' : report.config.host}:${report.config.port}（可用 HOST/PORT 修改）`);
  lines.push(`          数据目录 ${report.config.dataDir}（MORI_DATA_DIR 可修改）`);
  lines.push(`          下载目录 ${report.config.downloadDir}（MORI_DOWNLOAD_DIR 可修改）`);
  lines.push('          115 组件使用 MORI_PYTHON 指定的解释器（详见上方检查项）');
  lines.push('------------------------------------------------');
  lines.push(`概要：${report.summary.healthy} 项正常，${report.summary.unconfigured} 项未配置，${report.summary.unavailable} 项不可用。整体：${report.ok ? '已就绪' : '未就绪'}`);
  lines.push('后续步骤：');
  report.nextSteps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 前台子进程运行（start / install 共用）：转发取消信号并等待子进程清理完毕
// ---------------------------------------------------------------------------

export function signalExitCode(signal) {
  const num = os.constants.signals[signal];
  return typeof num === 'number' ? 128 + num : 1;
}

export function runForeground(command, args, { cwd, env = process.env, killTimeoutMs = 12000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: 'inherit',
        windowsHide: false,
        // POSIX：子进程位于独立进程组，终端 Ctrl+C 只送达本工具，由下方统一向该组转发一次，
        // 既覆盖孙进程，也避免组内信号重复投递。Windows 无 POSIX 进程组语义，见 forward 分支。
        detached: !IS_WINDOWS,
      });
    } catch (err) {
      process.stderr.write(`启动子进程失败：${err.message}\n`);
      resolve({ code: 1 });
      return;
    }
    let finished = false;
    let killTimer = null;
    let groupTimer = null;
    let childResult = null;
    let forced = false;
    const handlers = {};
    const finish = (result) => {
      if (finished) return;
      finished = true;
      for (const [sig, h] of Object.entries(handlers)) process.removeListener(sig, h);
      if (killTimer) clearTimeout(killTimer);
      if (groupTimer) clearTimeout(groupTimer);
      resolve(result);
    };
    const waitForGroup = () => {
      try {
        process.kill(-child.pid, 0);
      } catch (err) {
        if (err.code === 'ESRCH') finish(forced ? { code: null, signal: 'SIGKILL' } : childResult);
        else {
          process.stderr.write(`无法确认子进程组 ${child.pid} 已退出：${err.message}\n`);
          finish({ code: 1 });
        }
        return;
      }
      groupTimer = setTimeout(waitForGroup, 50);
    };
    const forceKill = () => {
      try {
        if (IS_WINDOWS) child.kill();
        else {
          process.kill(-child.pid, 'SIGKILL');
          forced = true;
        }
      } catch (err) {
        if (err.code !== 'ESRCH') {
          process.stderr.write(`强制终止子进程${IS_WINDOWS ? '' : '组'} ${child.pid} 失败：${err.message}\n`);
          finish({ code: 1 });
          return;
        }
      }
      killTimer = setTimeout(() => {
        process.stderr.write(`子进程${IS_WINDOWS ? '' : '组'} ${child.pid} 强制终止后仍未确认退出。\n`);
        finish({ code: 1 });
      }, 1000);
    };
    const forward = (sig) => {
      if (IS_WINDOWS) {
        // 控制台 Ctrl+C 已由 Windows 广播给共享控制台的整棵子进程树，这里不重复终止；
        // SIGHUP（关闭窗口）尽力终止直接子进程。SIGTERM 在 Windows 上没有等价投递路径。
        if (sig !== 'SIGINT') {
          try { child.kill(); } catch { /* 已退出 */ }
        }
        return;
      }
      try {
        process.kill(-child.pid, sig);
      } catch (err) {
        if (err.code !== 'ESRCH') {
          process.stderr.write(`向子进程组 ${child.pid} 转发 ${sig} 失败：${err.message}\n`);
          finish({ code: 1 });
        }
      }
    };
    const onSignal = (sig) => () => {
      if (finished) return;
      forward(sig);
      if (!finished && !killTimer) {
        killTimer = setTimeout(forceKill, killTimeoutMs);
      }
    };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      handlers[sig] = onSignal(sig);
      process.on(sig, handlers[sig]);
    }
    child.on('error', (err) => {
      process.stderr.write(`子进程出错：${err.message}\n`);
      finish({ code: 1 });
    });
    child.on('exit', (code, signal) => {
      if (finished) return;
      childResult = { code, signal };
      // 组长先退出时仍可能有孙进程，取消后的监督必须持续到整组退出。
      if (killTimer && !IS_WINDOWS) waitForGroup();
      else finish(childResult);
    });
  });
}

function portBusy(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const target = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const socket = net.createConnection({ host: target, port: Number(port) });
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// ---------------------------------------------------------------------------
// start / install 命令
// ---------------------------------------------------------------------------

export function missingRuntimePackages(root) {
  const nm = path.join(root, 'node_modules');
  if (!fs.existsSync(nm)) return RUNTIME_PACKAGES.slice();
  return RUNTIME_PACKAGES.filter((p) => !resolvableFrom(root, p));
}

export async function commandStart(options = {}) {
  const root = options.root ?? defaultProjectRoot();
  const env = options.env ?? process.env;
  const log = (msg) => process.stdout.write(`${msg}\n`);
  const config = resolveConfig(root, env);

  const problems = [];
  for (const message of [config.errors.host, config.errors.port, config.errors.dataDir, config.errors.downloadDir]) {
    if (message) problems.push(message);
  }
  if (!fs.existsSync(path.join(root, 'package.json')) || !fs.existsSync(path.join(root, 'server', 'index.ts'))) {
    problems.push(`${root} 不是完整的 Mnemo 安装目录（缺少 package.json 或 server/index.ts）。`);
  }
  if ((compareVersions(process.version, REQUIRED_NODE) ?? -1) < 0) {
    problems.push(`Node.js 版本过低（当前 ${process.version}，要求 ≥ v${REQUIRED_NODE}）。`);
  }
  const npm = resolveNpmInvocation(env);
  if (!npm.available) {
    problems.push(`未找到可用的 npm。${npm.detail}请先安装随 Node.js 附带的 npm，再运行本工具。`);
  }
  const missing = missingRuntimePackages(root);
  if (missing.length) {
    problems.push(`依赖尚未安装（缺少 ${missing.join('、')}）。请先完成安装：`);
  }
  if (problems.length) {
    for (const p of problems) log(`[错误] ${p}`);
    log('安装步骤：');
    log('  1. 打开终端，进入 Mnemo 安装目录');
    log('  2. 运行 node scripts/local.mjs install');
    log('  3. 运行 node scripts/local.mjs start，或双击 start-mori 启动器');
    log('说明：本工具不会自动下载 Node.js、Python 或远程脚本。');
    return 1;
  }

  if (distEntryProblem(root)) {
    log('[警告] 前端构建产物缺失或为空（dist/index.html），网页界面可能无法访问；建议先运行 node scripts/local.mjs install。');
  }
  if (await portBusy(config.host, config.port)) {
    log(`[警告] 端口 ${config.port} 已被占用：可能已有一个 Mnemo 实例在运行。继续启动可能失败；如需多实例请用 PORT 环境变量换端口。`);
  }

  const displayHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  log(`正在前台启动 Mnemo（内部执行 npm start，按 Ctrl+C 停止）…`);
  log(`启动后访问：http://${displayHost}:${config.port}`);
  const result = await runForeground(npm.command, [...npm.baseArgs, 'start'], { cwd: root, env });
  if (result.signal) {
    log(`已停止（收到 ${result.signal}；直接子进程已退出）。`);
    return signalExitCode(result.signal);
  }
  return result.code ?? 1;
}

export async function commandInstall(options = {}) {
  const root = options.root ?? defaultProjectRoot();
  const env = options.env ?? process.env;
  const log = (msg) => process.stdout.write(`${msg}\n`);

  const problems = [];
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    problems.push(`${root} 中没有 package.json，不是 Mnemo 安装目录。`);
  }
  if (!fs.existsSync(path.join(root, 'package-lock.json'))) {
    problems.push('缺少 package-lock.json：无法以锁定方式安装依赖。请从完整发布包恢复该文件（不自动改用浮动版本安装）。');
  }
  if ((compareVersions(process.version, REQUIRED_NODE) ?? -1) < 0) {
    problems.push(`Node.js 版本过低（当前 ${process.version}，要求 ≥ v${REQUIRED_NODE}）。`);
  }
  const npm = resolveNpmInvocation(env);
  if (!npm.available) {
    problems.push(`未找到可用的 npm。${npm.detail}请先安装随 Node.js 附带的 npm，再运行本工具。`);
  }
  if (problems.length) {
    for (const p of problems) log(`[错误] ${p}`);
    return 1;
  }

  const steps = [
    { title: '第 1/2 步：安装锁定依赖（npm ci --include=dev，确保构建工具一并安装）', args: ['ci', '--include=dev'] },
    { title: '第 2/2 步：构建前端（npm run build）', args: ['run', 'build'] },
  ];
  for (const step of steps) {
    log(`\n>>> ${step.title}`);
    const result = await runForeground(npm.command, [...npm.baseArgs, ...step.args], { cwd: root, env });
    if (result.signal) {
      log(`已取消（${result.signal}）。`);
      return signalExitCode(result.signal);
    }
    if ((result.code ?? 1) !== 0) {
      log(`[错误] 「${step.title}」失败，退出码 ${result.code ?? 1}。已停止后续步骤。`);
      log('常见原因：网络不可用、Node 版本不匹配、磁盘空间不足。解决问题后重新运行 node scripts/local.mjs install。');
      return result.code ?? 1;
    }
  }
  log('\n安装完成。后续步骤：');
  log('  1. 运行 node scripts/local.mjs doctor 确认环境');
  log('  2. 运行 node scripts/local.mjs start，或双击 start-mori 启动器');
  log('  （可选）115 分享解析功能需要单独配置 Python 环境，见 docs/LOCAL_INSTALL.md。');
  return 0;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const USAGE = `Mnemo 本地启动与安装自检工具 v${TOOL_VERSION}

用法：
  node scripts/local.mjs doctor [--json] [--root <Mnemo安装目录>]
      环境自检：Node 版本、npm（真实探测一次）、项目文件、依赖可解析、前端构建、
      HOST/PORT 校验、数据/下载目录（下载目录另探测硬链接支持，不支持时以拷贝回退发布）、可选 115 组件（经 helper 固定 health 协议真实验证，仅 macOS/Linux）。
      状态说明：[正常]=就绪；[未配置]=可按提示自行修复；[不可用]=当前环境不满足。
      --json 输出机器可读结果（便于后续界面集成）。
      退出码：0=就绪，1=存在问题，2=参数错误。
  node scripts/local.mjs start [--root <目录>]
      前台启动 Mnemo（复用 npm start）。Ctrl+C/SIGTERM 停止：POSIX 上信号向整个子进程组转发一次，
      等待清理退出，12 秒未退出按组强制终止；Windows 上由控制台广播信号，工具做 12 秒兜底终止。
  node scripts/local.mjs install [--root <目录>]
      安装锁定依赖（npm ci --include=dev，不受 NODE_ENV=production 影响）并构建前端（npm run build）。
  node scripts/local.mjs help
      显示本帮助。

环境变量：
  MORI_DATA_DIR / MORI_DOWNLOAD_DIR   数据与下载目录（默认 安装目录/data、安装目录/downloads；
                                       相对路径按安装目录解析；不支持以「~」开头的路径）
  HOST / PORT                          监听地址与端口（默认 127.0.0.1 / ${DEFAULT_PORT}；PORT 为 0–65535 的整数）
  MORI_PYTHON                          可选 115 组件的 Python 解释器（与应用读取的设置一致；
                                       未设置时按默认虚拟环境位置与 PATH 探测）

安全说明：本工具不读取账号凭据、数据库或私密状态；凭据与管理员只能在 Mnemo 网页界面配置。
所有子进程均以参数数组直呼（不经 shell 拼接）；目录可写检测只创建并删除一个独占随机临时探针文件。`;

function printUsage(stream = process.stdout) {
  stream.write(`${USAGE}\n`);
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`参数错误：${parsed.error}\n\n`);
    printUsage(process.stderr);
    process.exit(2);
  }
  const { command, flags } = parsed;
  if (flags.version) {
    process.stdout.write(`${TOOL_VERSION}\n`);
    process.exit(0);
  }
  if (!command || command === 'help' || flags.help) {
    printUsage();
    process.exit(0);
  }
  const root = flags.root ? path.resolve(flags.root) : defaultProjectRoot();
  if (!fs.existsSync(root)) {
    process.stderr.write(`[错误] 目录不存在：${root}\n`);
    process.exit(1);
  }
  if (command === 'doctor') {
    const { report, exitCode } = runDoctor({ root });
    if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`${formatHumanReport(report)}\n`);
    process.exit(exitCode);
  }
  const runner = command === 'start' ? commandStart : commandInstall;
  runner({ root })
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[错误] ${err && err.message ? err.message : err}\n`);
      process.exit(2);
    });
}

const isDirectRun = (() => {
  try {
    if (!process.argv[1]) return false;
    const invoked = fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : path.resolve(process.argv[1]);
    return pathToFileURL(invoked).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isDirectRun) main();
