import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { getEventListeners } from "node:events";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.js";
import { Shares, type ShareHelperRunner } from "../server/shares.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, provider: "p115" | "alipan" = "p115") {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mori-share-capacity-"));
  const store = new Store(path.join(directory, "state"), path.join(directory, "files"));
  const config = store.config();
  config.sources.p115Enabled = true;
  config.sources.alipanEnabled = true;
  config.sources.alipanRefreshToken = "synthetic-capacity-fixture";
  store.setConfig(config);
  const gates = Array.from({ length: 8 }, () => deferred<void>());
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const errors = new Map<string, unknown>();
  let active = 0;
  let peak = 0;
  let providerClosed = 0;
  const entries = gates.map((_, index) => ({ id: String(index + 1), name: `Fixture-${index + 1}.mkv`, directory: false, size: 123 }));
  const link = async (id: string, signal?: AbortSignal) => {
    calls.push(id);
    signals.push(signal!);
    peak = Math.max(peak, ++active);
    try {
      await gates[Number(id) - 1].promise;
      if (errors.has(id)) throw errors.get(id);
      return { url: `https://cdn.invalid/fixture-${id}`, name: `Fixture-${id}.mkv`, size: 123 };
    } finally { active--; }
  };
  const runner: ShareHelperRunner = async (input, signal) => {
    if (provider !== "p115") throw new Error("unexpected 115 operation");
    if (input.op === "list") return { ok: true, data: { entries } };
    if (input.op !== "link") throw new Error("unexpected fixture operation");
    return { ok: true, data: await link(String(input.fileId), signal) };
  };
  const shares = new Shares(store, runner, {
    async authorize() { throw new Error("unexpected Alipan operation"); },
    async list() {
      if (provider !== "alipan") throw new Error("unexpected Alipan operation");
      return { entries: entries.map((entry) => ({ ...entry, driveId: "fixture-share-drive" })) };
    },
    async link(input, signal) {
      if (provider !== "alipan") throw new Error("unexpected Alipan operation");
      return link(input.fileId, signal);
    },
    async testConnection() { throw new Error("unexpected Alipan operation"); },
    async close() { providerClosed++; },
  });
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    await shares.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const source = shares.capture({ id: "fixture-source", title: "Fixture", source: "fixture", kind: "share", url: provider === "p115" ? "https://115.com/s/CapacityFixture" : "https://www.alipan.com/s/CapacityFixture" });
  const files = await shares.browse(source.shareRef!);
  return { store, shares, files, source, gates, calls, signals, errors, peak: () => peak, providerClosed: () => providerClosed };
}

test("four legal cloud resolutions finish once each with at most two dispatched at a time", async (t) => {
  for (const provider of ["p115", "alipan"] as const) await t.test(provider, async (t) => {
    const { shares, files, gates, calls, peak } = await fixture(t, provider);
    const pending = Promise.allSettled(files.slice(0, 4).map((file) => shares.resolve(file.url)));
    assert.deepEqual(calls, ["1", "2"]);
    for (const gate of gates) gate.resolve();
    const results = await pending;
    assert.deepEqual(results.map((result) => result.status === "rejected" ? result.reason.code : result.status), ["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
    assert.deepEqual(calls, ["1", "2", "3", "4"]);
    assert.equal(peak(), 2);
  });
});

test("resolve waits FIFO with four bounded waiters while other operations retain immediate backpressure", async (t) => {
  const { shares, files, source, gates, calls, peak } = await fixture(t);
  const running = files.slice(0, 2).map((file) => shares.resolve(file.url));
  const observedRunning = Promise.allSettled(running);
  const controller = new AbortController();
  const cancelled = assert.rejects(shares.resolve(files[2].url, controller.signal), { name: "AbortError" });
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  await cancelled;
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const waiting = Promise.allSettled(files.slice(3, 7).map((file) => shares.resolve(file.url)));
  await assert.rejects(shares.resolve(files[7].url), { code: "busy", status: 429 });
  await assert.rejects(shares.resolve("invalid-reference"), { code: "invalid_reference" });
  await assert.rejects(shares.resolve(source.shareRef!), { code: "invalid_reference" });
  await assert.rejects(shares.browse(source.shareRef!), { code: "busy", status: 429 });
  await assert.rejects(shares.scan(source.shareRef!), { code: "busy", status: 429 });
  await assert.rejects(shares.testConnection(), { code: "busy", status: 429 });
  gates[0].resolve();
  await running[0];
  assert.deepEqual(calls, ["1", "2", "4"]);
  for (const gate of gates) gate.resolve();
  for (const result of [...await observedRunning, ...await waiting]) assert.equal(result.status, "fulfilled");
  assert.deepEqual(calls, ["1", "2", "4", "5", "6", "7"]);
  assert.equal(peak(), 2);
});

test("queued resolutions have independent bounded wait deadlines and remove abort listeners", async (t) => {
  const { shares, files, gates, calls } = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const running = Promise.allSettled(files.slice(0, 2).map((file) => shares.resolve(file.url)));
  const first = new AbortController();
  const timeout = assert.rejects(shares.resolve(files[2].url, first.signal), { code: "busy", status: 429, message: "分享解析等待超时，请稍后再试" });
  t.mock.timers.tick(30_000);
  const second = new AbortController();
  const later = shares.resolve(files[3].url, second.signal);
  t.mock.timers.tick(30_000);
  await timeout;
  assert.equal(getEventListeners(first.signal, "abort").length, 0);
  assert.equal(getEventListeners(second.signal, "abort").length, 1);
  assert.deepEqual(calls, ["1", "2"]);
  for (const gate of gates) gate.resolve();
  await later;
  for (const result of await running) assert.equal(result.status, "fulfilled");
  assert.equal(getEventListeners(second.signal, "abort").length, 0);
  assert.deepEqual(calls, ["1", "2", "4"]);
});

test("queued resolve revalidates authorization before dispatch and never retries an unknown provider result", async (t) => {
  await t.test("authorization", async (t) => {
    const { store, shares, files, gates, calls } = await fixture(t, "alipan");
    const running = Promise.allSettled(files.slice(0, 2).map((file) => shares.resolve(file.url)));
    const queued = assert.rejects(shares.resolve(files[2].url), { code: "auth_required" });
    const config = store.config();
    config.sources.alipanRefreshToken = "";
    store.setConfig(config);
    await assert.rejects(shares.resolve(files[3].url), { code: "auth_required" });
    for (const gate of gates) gate.resolve();
    await queued;
    for (const result of await running) assert.equal(result.status, "fulfilled");
    assert.deepEqual(calls, ["1", "2"]);
  });
  await t.test("unknown", async (t) => {
    const { shares, files, gates, calls, errors } = await fixture(t, "alipan");
    errors.set("1", Object.assign(new Error("fixture authorization outcome unknown"), { code: "alipan_auth_unknown", status: 409 }));
    const pending = Promise.allSettled(files.slice(0, 4).map((file) => shares.resolve(file.url)));
    for (const gate of gates) gate.resolve();
    const results = await pending;
    assert.equal(results[0].status, "rejected");
    assert.equal(results[0].status === "rejected" && results[0].reason.code, "alipan_auth_unknown");
    for (const result of results.slice(1)) assert.equal(result.status, "fulfilled");
    assert.deepEqual(calls, ["1", "2", "3", "4"]);
  });
});

test("close revokes queued resolutions, drains dispatched work and rejects new work idempotently", async (t) => {
  const { shares, files, gates, calls, signals, providerClosed } = await fixture(t);
  const controllers = files.slice(0, 6).map(() => new AbortController());
  const pending = Promise.allSettled(controllers.map((controller, index) => shares.resolve(files[index].url, controller.signal)));
  const closing = shares.close();
  assert.equal(shares.close(), closing);
  let closed = false;
  void closing.then(() => { closed = true; });
  await assert.rejects(shares.resolve(files[6].url), { code: "closed" });
  assert.deepEqual(calls, ["1", "2"]);
  assert.equal(signals.every((signal) => signal.aborted), true);
  assert.equal(providerClosed(), 0);
  assert.equal(closed, false);
  for (const controller of controllers.slice(2)) assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  for (const gate of gates) gate.resolve();
  const results = await pending;
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.equal(result.status === "rejected" && result.reason.name, "AbortError");
  }
  await closing;
  assert.equal(providerClosed(), 1);
  assert.deepEqual(calls, ["1", "2"]);
  for (const controller of controllers) assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
