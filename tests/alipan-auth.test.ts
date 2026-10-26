import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { AlipanAuth, AlipanError, type AlipanCredentials } from "../server/alipan-auth.js";
import { ALIPAN_AUTH_ID, ALIPAN_AUTH_KIND, Store } from "../server/store.js";

type AuthState = AlipanCredentials & {
  fingerprint: string;
  phase: "pending" | "ready" | "unknown" | "invalid";
  operationId: string;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function pair(label: string, expiresAt = Date.now() + 60_000): AlipanCredentials {
  return { accessToken: `fixture-access-${label}`, refreshToken: `fixture-refresh-${label}`, expiresAt };
}

function configure(store: Store, refresh = "fixture-config-seed", enabled = true) {
  const config = store.config();
  config.sources.alipanEnabled = enabled;
  config.sources.alipanRefreshToken = refresh;
  store.setConfig(config);
}

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mori-alipan-auth-"));
  let store = new Store(root, path.join(root, "downloads"));
  configure(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return {
    get store() { return store; },
    reopen() { store.close(); store = new Store(root, path.join(root, "downloads")); return store; },
  };
}

function state(store: Store): AuthState {
  const result = store.privateRecord<AuthState>(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID);
  assert.ok(result);
  return result;
}

function failure(code: string, status = 409, operationId?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof AlipanError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    if (operationId) assert.equal(error.operationId, operationId);
    assert.doesNotMatch(error.message, /fixture-|provider-raw/u);
    return true;
  };
}

test("rotation is encrypted before access returns and restart reuses the rotated pair", async (t) => {
  const f = fixture(t);
  const supplied: string[] = [];
  const first = pair("first");
  const auth = new AlipanAuth(f.store, async (refresh) => {
    supplied.push(refresh);
    assert.equal(state(f.store).phase, "pending");
    return first;
  });
  assert.equal(await auth.access(), first.accessToken);
  const saved = state(f.store);
  assert.equal(saved.phase, "ready");
  assert.equal(saved.refreshToken, first.refreshToken);
  assert.equal(saved.expiresAt, first.expiresAt);
  const ordinary = JSON.stringify(f.store.list(ALIPAN_AUTH_KIND));
  assert.doesNotMatch(ordinary, /fixture-/u);
  assert.equal(f.store.list(ALIPAN_AUTH_KIND).length, 1);
  const second = pair("second");
  const reopened = new AlipanAuth(f.reopen(), async (refresh) => { supplied.push(refresh); return second; });
  assert.equal(await reopened.access(), first.accessToken);
  assert.deepEqual(supplied, ["fixture-config-seed"]);
  assert.equal(await reopened.access(undefined, true), second.accessToken);
  assert.deepEqual(supplied, ["fixture-config-seed", first.refreshToken]);
  assert.notEqual(state(f.store).operationId, saved.operationId);
});

test("cache uses actual expiry and zero expiry is usable only for its fresh flight", async (t) => {
  const f = fixture(t);
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const responses = [pair("expires", 10_050), pair("no-expiry", 0), pair("forced", 10_100)];
  const supplied: string[] = [];
  const auth = new AlipanAuth(f.store, async (refresh) => {
    supplied.push(refresh);
    return responses[supplied.length - 1]!;
  });
  assert.equal(await auth.access(), responses[0]!.accessToken);
  now = 10_049;
  assert.equal(await auth.access(), responses[0]!.accessToken);
  assert.equal(supplied.length, 1);
  now = 10_050;
  const fresh = await Promise.all([auth.access(), auth.access()]);
  assert.deepEqual(fresh, [responses[1]!.accessToken, responses[1]!.accessToken]);
  assert.equal(supplied.length, 2);
  assert.equal(await auth.access(), responses[2]!.accessToken);
  assert.deepEqual(supplied, ["fixture-config-seed", responses[0]!.refreshToken, responses[1]!.refreshToken]);
});

test("disabled, missing authorization and pre-cancelled calls never dispatch", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const auth = new AlipanAuth(f.store, async () => { calls++; return pair("unused"); });
  configure(f.store, "fixture-config-seed", false);
  await assert.rejects(auth.access(), failure("alipan_auth_required"));
  configure(f.store, "");
  await assert.rejects(auth.access(), failure("alipan_auth_required"));
  configure(f.store);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(auth.access(controller.signal), failure("alipan_cancelled"));
  assert.equal(calls, 0);
  assert.equal(f.store.record(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID), undefined);
});

test("same-Store instances share one claimed flight including forced callers", async (t) => {
  const f = fixture(t);
  const started = deferred<void>();
  const response = deferred<AlipanCredentials>();
  let calls = 0;
  const auth = new AlipanAuth(f.store, async () => {
    calls++;
    assert.equal(state(f.store).phase, "pending");
    started.resolve();
    return response.promise;
  });
  const first = auth.access();
  await started.promise;
  const operationId = state(f.store).operationId;
  const other = new AlipanAuth(f.store, async () => { throw new Error("must share the owner"); });
  const waiting = [first, auth.access(), other.access(undefined, true)];
  assert.equal(state(f.store).phase, "pending");
  assert.equal(state(f.store).operationId, operationId);
  response.resolve(pair("shared"));
  assert.deepEqual(await Promise.all(waiting), Array(3).fill(pair("shared").accessToken));
  assert.equal(calls, 1);
});

test("waiting callers have a fixed capacity without aborting accepted callers", async (t) => {
  const f = fixture(t);
  const response = deferred<AlipanCredentials>();
  let calls = 0;
  const auth = new AlipanAuth(f.store, async () => { calls++; return response.promise; });
  const waiting = Array.from({ length: 16 }, () => auth.access());
  await assert.rejects(auth.access(), failure("alipan_busy", 429, state(f.store).operationId));
  response.resolve(pair("capacity"));
  assert.equal((await Promise.all(waiting)).length, 16);
  assert.equal(calls, 1);
});

test("cancelling one caller does not cancel the shared rotation", async (t) => {
  const f = fixture(t);
  const started = deferred<AbortSignal>();
  const response = deferred<AlipanCredentials>();
  const auth = new AlipanAuth(f.store, async (_refresh, signal) => {
    started.resolve(signal);
    return response.promise;
  });
  const controller = new AbortController();
  const first = auth.access(controller.signal);
  const second = auth.access();
  const signal = await started.promise;
  const rejected = assert.rejects(first, failure("alipan_cancelled", 409, state(f.store).operationId));
  controller.abort();
  await rejected;
  assert.equal(signal.aborted, false);
  response.resolve(pair("remaining"));
  assert.equal(await second, pair("remaining").accessToken);
  assert.equal(state(f.store).phase, "ready");
});

test("last cancellation aborts transport and drains its unknown receipt before returning", async (t) => {
  const f = fixture(t);
  const started = deferred<AbortSignal>();
  const release = deferred<void>();
  let calls = 0;
  const auth = new AlipanAuth(f.store, async (_refresh, signal) => {
    calls++;
    started.resolve(signal);
    await release.promise;
    signal.throwIfAborted();
    return pair("unused");
  });
  const controller = new AbortController();
  const waiting = auth.access(controller.signal);
  const signal = await started.promise;
  const operationId = state(f.store).operationId;
  const rejected = assert.rejects(waiting, failure("alipan_cancelled", 409, operationId));
  let settled = false;
  void waiting.then(() => { settled = true; }, () => { settled = true; });
  controller.abort();
  await setImmediate();
  assert.equal(signal.aborted, true);
  assert.equal(settled, false);
  await assert.rejects(auth.access(), failure("alipan_busy", 429, operationId));
  release.resolve();
  await rejected;
  assert.equal(state(f.store).phase, "unknown");
  await assert.rejects(auth.access(undefined, true), failure("alipan_auth_unknown", 409, operationId));
  assert.equal(calls, 1);
});

test("all callers cancelling still persist a late known pair before the last caller finishes", async (t) => {
  const f = fixture(t);
  const started = deferred<AbortSignal>();
  const response = deferred<AlipanCredentials>();
  let calls = 0;
  const auth = new AlipanAuth(f.store, async (_refresh, signal) => {
    calls++;
    started.resolve(signal);
    return response.promise;
  });
  const controllers = [new AbortController(), new AbortController()];
  const waiting = controllers.map((controller) => auth.access(controller.signal));
  const signal = await started.promise;
  const rejected = waiting.map((promise) => assert.rejects(promise,
    failure("alipan_cancelled", 409, state(f.store).operationId)));
  controllers[0]!.abort();
  await rejected[0];
  assert.equal(signal.aborted, false);
  controllers[1]!.abort();
  assert.equal(signal.aborted, true);
  const rotated = pair("late");
  response.resolve(rotated);
  await Promise.all(rejected);
  assert.equal(state(f.store).phase, "ready");
  assert.equal(state(f.store).refreshToken, rotated.refreshToken);
  assert.equal(await auth.access(), rotated.accessToken);
  assert.equal(calls, 1);
});

test("configuration replacement, clearing and ABA cannot revive old rotation results", async (t) => {
  for (const mode of ["replace", "clear", "aba"] as const) await t.test(mode, async (t) => {
    const f = fixture(t);
    const started = deferred<void>();
    const response = deferred<AlipanCredentials>();
    const supplied: string[] = [];
    const auth = new AlipanAuth(f.store, async (refresh) => {
      supplied.push(refresh);
      if (supplied.length === 1) { started.resolve(); return response.promise; }
      return pair("current");
    });
    const waiting = auth.access();
    await started.promise;
    const operationId = state(f.store).operationId;
    const rejected = assert.rejects(waiting, failure("alipan_config_changed", 409, operationId));
    configure(f.store, mode === "clear" ? "" : "fixture-config-new");
    if (mode === "aba") configure(f.store);
    assert.equal(f.store.privateRecord(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID), undefined);
    await assert.rejects(auth.access(), failure(mode === "clear" ? "alipan_auth_required" : "alipan_busy", mode === "clear" ? 409 : 429));
    response.resolve(pair("obsolete"));
    await rejected;
    assert.equal(f.store.privateRecord(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID), undefined);
    if (mode === "clear") configure(f.store, "fixture-config-new");
    assert.equal(await auth.access(), pair("current").accessToken);
    assert.equal(supplied[1], mode === "aba" ? "fixture-config-seed" : "fixture-config-new");
  });
});

test("restart converts an abandoned pending claim to unknown without redispatch", async (t) => {
  const f = fixture(t);
  const operationId = randomUUID();
  f.store.putPrivate(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID, {
    fingerprint: f.store.privateId(["alipan-auth-config", "fixture-config-seed"]),
    phase: "pending", operationId,
    refreshToken: "fixture-config-seed", accessToken: "", expiresAt: 0,
  }, "9999-12-31T23:59:59.999Z");
  let calls = 0;
  const auth = new AlipanAuth(f.reopen(), async () => { calls++; return pair("unused"); });
  assert.equal(state(f.store).phase, "unknown");
  for (const force of [false, true])
    await assert.rejects(auth.access(undefined, force), failure("alipan_auth_unknown", 409, operationId));
  assert.equal(calls, 0);
});

test("only explicit invalid authorization is terminal invalid; unsafe outcomes stay unknown", async (t) => {
  for (const kind of ["invalid", "network", "timeout", "malformed"] as const) await t.test(kind, async (t) => {
    const f = fixture(t);
    let calls = 0;
    const auth = new AlipanAuth(f.store, async () => {
      calls++;
      if (kind === "invalid") throw new AlipanError("alipan_auth_invalid", "provider-raw-private-body", 409);
      if (kind === "network") throw new Error("provider-raw-private-body");
      if (kind === "timeout") throw new DOMException("provider-raw-private-body", "TimeoutError");
      return { ...pair("bad"), refreshToken: "" };
    });
    const code = kind === "invalid" ? "alipan_auth_invalid" : "alipan_auth_unknown";
    await assert.rejects(auth.access(), failure(code));
    const saved = state(f.store);
    assert.equal(saved.phase, kind === "invalid" ? "invalid" : "unknown");
    assert.ok(saved.operationId);
    await assert.rejects(auth.access(undefined, true), failure(code, 409, saved.operationId));
    assert.equal(calls, 1);
  });
});

test("a failed ready commit retains the known rotated pair privately as unknown", async (t) => {
  const f = fixture(t);
  const put = f.store.putPrivate.bind(f.store);
  t.mock.method(f.store, "putPrivate", (...args: Parameters<Store["putPrivate"]>) => {
    if ((args[2] as AuthState).phase === "ready") throw new Error("provider-raw-storage-detail");
    return put(...args);
  });
  const rotated = pair("unpublished");
  let calls = 0;
  const auth = new AlipanAuth(f.store, async () => { calls++; return rotated; });
  await assert.rejects(auth.access(), failure("alipan_auth_unknown"));
  const saved = state(f.store);
  assert.equal(saved.phase, "unknown");
  assert.equal(saved.refreshToken, rotated.refreshToken);
  assert.equal(saved.accessToken, rotated.accessToken);
  await assert.rejects(auth.access(undefined, true), failure("alipan_auth_unknown", 409, saved.operationId));
  assert.equal(calls, 1);
});

test("persistent receipt failures remain unknown and the durable claim blocks unsafe retry", async (t) => {
  for (const invalid of [false, true]) await t.test(invalid ? "invalid response" : "known pair", async (t) => {
    const f = fixture(t);
    const put = f.store.putPrivate.bind(f.store);
    const mocked = t.mock.method(f.store, "putPrivate", (...args: Parameters<Store["putPrivate"]>) => {
      if ((args[2] as AuthState).phase !== "pending") throw new Error("provider-raw-storage-detail");
      return put(...args);
    });
    let calls = 0;
    const auth = new AlipanAuth(f.store, async () => {
      calls++;
      if (invalid) throw new AlipanError("alipan_auth_invalid", "provider-raw-invalid", 409);
      return pair("not-durable");
    });
    await assert.rejects(auth.access(), failure("alipan_auth_unknown"));
    const saved = state(f.store);
    assert.equal(saved.phase, "pending");
    await assert.rejects(auth.access(undefined, true), failure("alipan_auth_unknown", 409, saved.operationId));
    mocked.mock.restore();
    const restarted = new AlipanAuth(f.reopen(), async () => { calls++; return pair("unused"); });
    assert.equal(state(f.store).phase, "unknown");
    await assert.rejects(restarted.access(undefined, true), failure("alipan_auth_unknown", 409, saved.operationId));
    assert.equal(calls, 1);
  });
});

test("failed pending claims never send a refresh request", async (t) => {
  const f = fixture(t);
  const mocked = t.mock.method(f.store, "putPrivate", () => { throw new Error("provider-raw-storage-detail"); });
  let calls = 0;
  const auth = new AlipanAuth(f.store, async () => { calls++; return pair("after-repair"); });
  await assert.rejects(auth.access(), (error: unknown) => {
    failure("alipan_auth_unknown")(error);
    assert.ok((error as AlipanError).operationId);
    return true;
  });
  assert.equal(calls, 0);
  assert.equal(f.store.record(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID), undefined);
  mocked.mock.restore();
  assert.equal(await auth.access(), pair("after-repair").accessToken);
  assert.equal(calls, 1);
});

test("close is idempotent across same-Store instances and rejects every new access", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const refresh = async () => { calls++; return pair("unused"); };
  const auth = new AlipanAuth(f.store, refresh);
  const other = new AlipanAuth(f.store, refresh);
  const closing = auth.close();
  assert.equal(other.close(), closing);
  assert.equal(auth.close(), closing);
  await closing;
  const createdAfterClose = new AlipanAuth(f.store, refresh);
  for (const instance of [auth, other, createdAfterClose])
    await assert.rejects(instance.access(undefined, true), failure("alipan_closed"));
  assert.equal(calls, 0);
  assert.equal(f.store.record(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID), undefined);
});

test("close aborts a pending transport and waits until unknown is durable", async (t) => {
  const f = fixture(t);
  const started = deferred<AbortSignal>();
  const release = deferred<void>();
  const auth = new AlipanAuth(f.store, async (_refresh, signal) => {
    started.resolve(signal);
    await release.promise;
    signal.throwIfAborted();
    return pair("unused");
  });
  const waiting = auth.access();
  const signal = await started.promise;
  const operationId = state(f.store).operationId;
  const rejected = assert.rejects(waiting, failure("alipan_cancelled", 409, operationId));
  const closing = auth.close();
  assert.equal(auth.close(), closing);
  let closed = false;
  void closing.then(() => { closed = true; });
  await setImmediate();
  assert.equal(signal.aborted, true);
  assert.equal(closed, false);
  assert.equal(state(f.store).phase, "pending");
  await assert.rejects(auth.access(), failure("alipan_closed"));
  release.resolve();
  await Promise.all([closing, rejected]);
  assert.equal(state(f.store).phase, "unknown");
  const restarted = new AlipanAuth(f.reopen(), async () => { throw new Error("must not replay unknown"); });
  await assert.rejects(restarted.access(undefined, true), failure("alipan_auth_unknown", 409, operationId));
});

test("close drains and saves a late known pair before Store can close", async (t) => {
  const f = fixture(t);
  const started = deferred<AbortSignal>();
  const response = deferred<AlipanCredentials>();
  const auth = new AlipanAuth(f.store, async (_refresh, signal) => {
    started.resolve(signal);
    return response.promise;
  });
  const waiting = [auth.access(), auth.access()];
  const signal = await started.promise;
  const rejected = waiting.map((promise) => assert.rejects(promise,
    failure("alipan_cancelled", 409, state(f.store).operationId)));
  const closing = auth.close();
  assert.equal(signal.aborted, true);
  const rotated = pair("close-late");
  response.resolve(rotated);
  await Promise.all([closing, ...rejected]);
  assert.equal(state(f.store).phase, "ready");
  assert.equal(state(f.store).refreshToken, rotated.refreshToken);
  const restarted = new AlipanAuth(f.reopen(), async () => { throw new Error("must reuse saved pair"); });
  assert.equal(await restarted.access(), rotated.accessToken);
});

test("close before dispatch never invokes refresh and still drains its claim", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const auth = new AlipanAuth(f.store, async () => { calls++; return pair("unused"); });
  const waiting = auth.access();
  const rejected = assert.rejects(waiting, failure("alipan_cancelled", 409, state(f.store).operationId));
  await auth.close();
  await rejected;
  assert.equal(calls, 0);
  assert.equal(state(f.store).phase, "unknown");
});

test("cancellation and close cannot hide a failed credential receipt", async (t) => {
  for (const mode of ["cancel", "close"] as const) await t.test(mode, async (t) => {
    const f = fixture(t);
    const started = deferred<void>();
    const response = deferred<AlipanCredentials>();
    const put = f.store.putPrivate.bind(f.store);
    t.mock.method(f.store, "putPrivate", (...args: Parameters<Store["putPrivate"]>) => {
      if ((args[2] as AuthState).phase !== "pending") throw new Error("provider-raw-storage-detail");
      return put(...args);
    });
    const auth = new AlipanAuth(f.store, async () => { started.resolve(); return response.promise; });
    const controller = new AbortController();
    const waiting = auth.access(controller.signal);
    await started.promise;
    const operationId = state(f.store).operationId;
    const rejected = assert.rejects(waiting, failure("alipan_auth_unknown", 409, operationId));
    let rejectedClose = Promise.resolve();
    if (mode === "close") rejectedClose = assert.rejects(auth.close(), failure("alipan_auth_unknown", 409, operationId));
    else controller.abort();
    response.resolve(pair("receipt-failed"));
    await Promise.all([rejected, rejectedClose]);
    assert.equal(state(f.store).phase, "pending");
  });
});
