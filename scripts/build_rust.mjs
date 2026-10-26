import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORE_VERSION = 'mnemo-core 0.1.1 protocol=1';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function buildRust({ rootDir = projectRoot, ifMissing = false, env = process.env, platform = process.platform, run = spawnSync } = {}) {
  const mode = env.MNEMO_CORE ?? env.MORI_CORE ?? 'rust';
  if (mode === 'typescript') return { status: 'typescript' };
  if (mode !== 'rust') throw new Error('MNEMO_CORE must be rust or typescript');

  const name = platform === 'win32' ? 'mnemo-core.exe' : 'mnemo-core';
  const binary = resolve(rootDir, 'bin', name);
  const valid = (path) => {
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size === 0) return false;
      const result = run(path, ['--version'], { cwd: rootDir, env, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
      return !result.error && result.status === 0 && result.stdout?.trim() === CORE_VERSION;
    } catch {
      return false;
    }
  };
  const hasSource = existsSync(resolve(rootDir, 'rust-core', 'Cargo.toml'));
  if ((ifMissing || !hasSource) && valid(binary)) return { status: 'existing', binary };
  if (!hasSource) throw new Error(`Compatible mnemo-core is missing: provide ${binary} (${CORE_VERSION}), or restore rust-core sources to build it`);

  const build = run('cargo', ['build', '--release', '--locked', '--manifest-path', 'rust-core/Cargo.toml'], {
    cwd: rootDir, env, stdio: 'inherit',
  });
  if (build.error) throw new Error(`Cannot build mnemo-core: ${build.error.message}. Install the Rust toolchain, or provide a compatible ${binary}.`);
  if (build.status !== 0) throw new Error(`cargo build failed (${build.signal ?? build.status}); mnemo-core was not replaced`);
  const targetDir = env.CARGO_TARGET_DIR ? resolve(rootDir, env.CARGO_TARGET_DIR) : resolve(rootDir, 'rust-core', 'target');
  const built = resolve(targetDir, env.CARGO_BUILD_TARGET || '', 'release', name);
  if (!valid(built)) throw new Error(`Built mnemo-core is not compatible: expected ${CORE_VERSION} from ${built}`);
  mkdirSync(dirname(binary), { recursive: true });
  copyFileSync(built, binary);
  if (platform !== 'win32') chmodSync(binary, 0o755);
  return { status: 'built', binary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--if-missing')) throw new Error('Usage: node scripts/build_rust.mjs [--if-missing]');
    const result = buildRust({ ifMissing: args.includes('--if-missing') });
    console.log(`[mnemo-core] ${result.status}${result.binary ? `: ${result.binary}` : ''}`);
  } catch (error) {
    console.error(`[mnemo-core] ${error.message}`);
    process.exitCode = 1;
  }
}
