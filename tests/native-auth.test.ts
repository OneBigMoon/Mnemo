import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm, mkdir, copyFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../server/store.js";
import { createApp } from "../server/index.js";
import { RustCoreError } from "../server/rust-core.js";

const fixturePassword = "native-auth-fixture-password";
const stateRows = (store: Store) => ({
  kv: store.db.prepare("SELECT * FROM kv ORDER BY key").all(),
  records: store.db.prepare("SELECT * FROM records ORDER BY kind,id").all(),
  sessions: store.db.prepare("SELECT * FROM sessions ORDER BY token").all(),
});

test("native verification reads legacy scrypt records without rewriting data or sessions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mnemo-auth-legacy-"));
  const previous = process.env.MNEMO_CORE;
  t.after(async () => {
    if (previous === undefined) delete process.env.MNEMO_CORE; else process.env.MNEMO_CORE = previous;
    await rm(root, { recursive: true, force: true });
  });
  const passwords = [fixturePassword, "中文测试口令".repeat(2), "📺".repeat(6), "x".repeat(256), "x".repeat(11) + "\ud800"];
  for (const [index, password] of passwords.entries()) {
    const directory = path.join(root, String(index));
    let store = new Store(directory);
    try {
      store.setup(password); // The existing Node/OpenSSL writer is the compatibility oracle.
      store.putPrivate("fixture", "item", { text: "synthetic value" }, "2099-01-01T00:00:00.000Z");
      const session = store.session();
      const before = stateRows(store);
      const key = Buffer.from(store.masterKey);
      process.env.MNEMO_CORE = "rust";
      assert.equal(await store.checkPassword(password), true);
      assert.equal(await store.checkPassword("wrong fixture password"), false);
      assert.equal(await store.checkPassword("x".repeat(257)), false);
      assert.equal(await store.checkPassword(null), false);
      assert.deepEqual(stateRows(store), before);
      store.close();
      store = new Store(directory);
      assert.equal(await store.checkPassword(password), true);
      assert.equal(store.authenticated(session), true);
      assert.deepEqual(store.privateRecord("fixture", "item"), { text: "synthetic value" });
      assert.deepEqual(Buffer.from(store.masterKey), key);
      process.env.MNEMO_CORE = "typescript";
      assert.equal(await store.checkPassword(password), true);
      assert.deepEqual(stateRows(store), before);
    } finally { store.close(); }
  }
});

test("native password verification cancels and reports malformed records without mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mnemo-auth-cancel-"));
  const store = new Store(root);
  try {
    store.setup(fixturePassword);
    const before = stateRows(store);
    const controller = new AbortController();
    const work = store.checkPassword(fixturePassword, controller.signal);
    setImmediate(() => controller.abort());
    await assert.rejects(work, { name: "AbortError" });
    assert.deepEqual(stateRows(store), before);
    store.db.prepare("UPDATE kv SET value=? WHERE key='password'").run("invalid fixture record");
    await assert.rejects(store.checkPassword(fixturePassword), { code: "PASSWORD_RECORD" });
    assert.equal(store.get("password"), "invalid fixture record");
    assert.equal(stateRows(store).sessions.length, 0);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mnemo-auth-http-"));
  const instance = createApp({ dataDirectory: root, downloadDirectory: path.join(root, "downloads"), startBackground: false, testMode: true });
  instance.store.setup(fixturePassword);
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    await instance.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const login = (password: string, signal?: AbortSignal) => fetch(`${base}/api/login`, {
    method: "POST", headers: { Origin: base, "content-type": "application/json" },
    body: JSON.stringify({ password }), signal,
  });
  return { instance, login };
}

test("HTTP login awaits native verification and never issues a session on wrong password or core failure", async (t) => {
  const { instance, login } = await fixture(t);
  const wrong = await login("wrong fixture password");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("set-cookie"), null);
  assert.equal(stateRows(instance.store).sessions.length, 0);
  const correct = await login(fixturePassword);
  assert.equal(correct.status, 200);
  assert.match(correct.headers.get("set-cookie") ?? "", /^mnemo_session=/);
  const before = stateRows(instance.store).sessions;
  t.mock.method(instance.store, "checkPassword", async () => { throw new RustCoreError("CORE_UNAVAILABLE", "fixture unavailable"); });
  const unavailable = await login(fixturePassword);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("set-cookie"), null);
  assert.deepEqual(stateRows(instance.store).sessions, before);
});

test("shutdown cancels pending login and does not create a late session", async (t) => {
  const { instance, login } = await fixture(t);
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  t.mock.method(instance.store, "checkPassword", (_password: unknown, signal: AbortSignal) => new Promise<boolean>((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    started();
  }));
  let issued = 0;
  t.mock.method(instance.store, "session", () => { issued++; return "fixture-token"; });
  const response = login(fixturePassword, AbortSignal.timeout(3000));
  await entered;
  await instance.close();
  const result = await response;
  assert.equal(result.status, 503);
  assert.equal(result.headers.get("set-cookie"), null);
  assert.equal(aborted, true);
  assert.equal(issued, 0);
});

test("an installed host without its native binary fails visibly and never falls back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mnemo-auth-core-missing-"));
  try {
    await mkdir(path.join(root, "server"));
    await writeFile(path.join(root, "package.json"), '{"type":"module"}');
    for (const file of ["rust-core.ts", "env.ts"])
      await copyFile(new URL(`../server/${file}`, import.meta.url), path.join(root, "server", file));
    const missing = await import(pathToFileURL(path.join(root, "server/rust-core.ts")).href);
    await assert.rejects(missing.runRustCore("password_verify", "{}"), { code: "CORE_UNAVAILABLE" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
