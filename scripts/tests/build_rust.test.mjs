import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { buildRust, CORE_VERSION } from '../build_rust.mjs';

function fixture(t, platform = 'darwin') {
  const rootDir = mkdtempSync(join(tmpdir(), 'mnemo-rust-build-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const name = platform === 'win32' ? 'mnemo-core.exe' : 'mnemo-core';
  const binary = join(rootDir, 'bin', name);
  const built = join(rootDir, 'rust-core', 'target', 'release', name);
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    return command === 'cargo' ? { status: 0 } : { status: 0, stdout: CORE_VERSION + '\n' };
  };
  const put = (path, data = 'native') => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
  put(join(rootDir, 'rust-core', 'Cargo.toml'), '[package]\nname="mnemo-core"\n');
  return { rootDir, binary, built, calls, run, put, options: { rootDir, platform, env: {}, run } };
}

test('valid packaged binary starts without calling Cargo', (t) => {
  const f = fixture(t);
  f.put(f.binary);
  assert.equal(buildRust({ ...f.options, ifMissing: true }).status, 'existing');
  assert.deepEqual(f.calls.map((call) => call.command), [f.binary]);
});

test('empty or incompatible packaged binary is rebuilt with the locked release command', (t) => {
  const f = fixture(t);
  f.put(f.binary, '');
  f.put(f.built, 'new-native');
  const result = buildRust({ ...f.options, ifMissing: true });
  assert.equal(result.status, 'built');
  assert.equal(readFileSync(f.binary, 'utf8'), 'new-native');
  assert.deepEqual(f.calls[0].args, ['build', '--release', '--locked', '--manifest-path', 'rust-core/Cargo.toml']);
  if (process.platform !== 'win32') assert.equal(statSync(f.binary).mode & 0o777, 0o755);
});

test('protocol mismatch cannot be accepted as an existing binary', (t) => {
  const f = fixture(t);
  f.put(f.binary);
  const run = (command) => command === 'cargo' ? { error: new Error('cargo missing') } : { status: 0, stdout: 'mnemo-core 0.1.1 protocol=2' };
  assert.throws(() => buildRust({ ...f.options, ifMissing: true, run }), /Install the Rust toolchain/);
});

test('0.1.0 binary is rebuilt for new operations, or rejected without sources', (t) => {
  const f = fixture(t);
  f.put(f.binary, 'old-native');
  f.put(f.built, 'new-native');
  const calls = [];
  const run = (command) => {
    calls.push(command);
    if (command === 'cargo') return { status: 0 };
    return { status: 0, stdout: command === f.binary ? 'mnemo-core 0.1.0 protocol=1' : 'mnemo-core 0.1.1 protocol=1' };
  };
  assert.equal(buildRust({ ...f.options, ifMissing: true, run }).status, 'built');
  assert.deepEqual(calls, [f.binary, 'cargo', f.built]);
  assert.equal(readFileSync(f.binary, 'utf8'), 'new-native');
  unlinkSync(join(f.rootDir, 'rust-core', 'Cargo.toml'));
  f.put(f.binary, 'old-native');
  calls.length = 0;
  assert.throws(() => buildRust({ ...f.options, ifMissing: true, run }), /mnemo-core 0\.1\.1 protocol=1/);
  assert.deepEqual(calls, [f.binary]);
});

test('explicit build rebuilds even when a packaged binary exists', (t) => {
  const f = fixture(t, 'win32');
  f.put(f.binary);
  f.put(f.built);
  assert.equal(buildRust(f.options).status, 'built');
  assert.equal(f.calls[0].command, 'cargo');
  assert.ok(f.binary.endsWith('.exe'));
});

test('failed build preserves the previous binary', (t) => {
  const f = fixture(t);
  f.put(f.binary, 'previous');
  assert.throws(() => buildRust({ ...f.options, run: () => ({ status: 7 }) }), /cargo build failed \(7\)/);
  assert.equal(readFileSync(f.binary, 'utf8'), 'previous');
});

test('portable client validates its binary without needing Rust sources or Cargo', (t) => {
  const f = fixture(t);
  unlinkSync(join(f.rootDir, 'rust-core', 'Cargo.toml'));
  f.put(f.binary);
  assert.equal(buildRust(f.options).status, 'existing');
  assert.deepEqual(f.calls.map((call) => call.command), [f.binary]);
  f.put(f.binary, '');
  assert.throws(() => buildRust(f.options), /Compatible mnemo-core is missing/);
  assert.equal(f.calls.length, 1);
});

test('explicit TypeScript mode skips native build, with MNEMO taking precedence', (t) => {
  const f = fixture(t);
  assert.equal(buildRust({ ...f.options, env: { MNEMO_CORE: 'typescript' } }).status, 'typescript');
  assert.equal(buildRust({ ...f.options, env: { MORI_CORE: 'typescript' } }).status, 'typescript');
  assert.equal(f.calls.length, 0);
  assert.throws(() => buildRust({ ...f.options, env: { MNEMO_CORE: 'invalid', MORI_CORE: 'typescript' } }), /must be rust or typescript/);
});
