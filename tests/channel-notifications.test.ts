import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import type {
  AgentDeps,
  AppConfig,
  NotificationClaim,
  NotificationDestination,
  NotificationService,
} from "../shared/types.ts";
import {
  sendTelegramNotificationsBatch,
  startTelegramNotifications,
} from "../server/telegram-notifications.ts";

type Outcome = Parameters<NotificationService["acknowledge"]>[3];
type Entry = {
  id: string;
  destination: NotificationDestination;
  status: "pending" | "dispatching" | Outcome;
  receipt?: string;
};

function entry(id: string, peer = "42", botId = "101"): Entry {
  return { id, destination: { platform: "telegram", peer, botId }, status: "pending" };
}

function harness(entries: Entry[] = [entry("notice")], peers = ["42"]) {
  const telegram = { enabled: true, token: "101:fixture", allowedChatIds: peers, model: "" };
  const claims: NotificationDestination[] = [];
  const acks: { destination: NotificationDestination; id: string; outcome: Outcome; receipt?: string }[] = [];
  const hooks: { afterClaim?: () => void; afterAck?: () => void; claimError?: Error } = {};
  const service: Pick<NotificationService, "claim" | "acknowledge"> = {
    claim(destination, limit): NotificationClaim[] {
      if (hooks.claimError) throw hooks.claimError;
      assert.equal(limit, 1);
      claims.push({ ...destination });
      const found = entries.find((candidate) =>
        candidate.status === "pending" &&
        candidate.destination.platform === destination.platform &&
        candidate.destination.botId === destination.botId &&
        candidate.destination.peer === destination.peer,
      );
      if (!found) return [];
      found.status = "dispatching";
      hooks.afterClaim?.();
      return [{
        id: found.id,
        taskId: `task-${found.id}`,
        text: `通知 ${found.id}`,
        claimToken: `claim-${found.id}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }];
    },
    acknowledge(destination, id, claimToken, outcome, receipt) {
      const found = entries.find((candidate) => candidate.id === id)!;
      assert.deepEqual(destination, found.destination);
      assert.equal(found.status, "dispatching");
      assert.equal(claimToken, `claim-${id}`);
      found.status = outcome;
      found.receipt = receipt;
      acks.push({ destination, id, outcome, receipt });
      hooks.afterAck?.();
    },
  };
  const deps = {
    config: () => ({ channels: { telegram } }) as AppConfig,
    notifications: service as NotificationService,
  } as AgentDeps;
  return { deps, telegram, entries, claims, acks, hooks };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

test("Telegram persists the exact destination claim before sending and records its receipt once", async (t) => {
  const h = harness();
  const outbound = t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(h.entries[0].status, "dispatching");
    assert.equal(String(input), "https://api.telegram.org/bot101:fixture/sendMessage");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.deepEqual(JSON.parse(String(init?.body)), { chat_id: "42", text: "通知 notice" });
    return json({ ok: true, result: { message_id: 705 } });
  });
  const signal = new AbortController().signal;
  await sendTelegramNotificationsBatch(h.deps, signal);
  await sendTelegramNotificationsBatch(h.deps, signal);
  assert.deepEqual(h.claims[0], { platform: "telegram", botId: "101", peer: "42" });
  assert.equal(h.acks.length, 1);
  assert.equal(h.entries[0].status, "delivered");
  assert.equal(h.entries[0].receipt, "705");
  assert.equal(outbound.mock.callCount(), 1);
});

const responses: { label: string; response: () => Promise<Response>; outcome: Outcome }[] = [
  ...[400, 401, 403, 429].map((status) => ({
    label: `HTTP ${status}`,
    response: async () => json({ ok: false }, status),
    outcome: "rejected" as const,
  })),
  ...[400, 401, 403, 429].map((error_code) => ({
    label: `API error ${error_code}`,
    response: async () => json({ ok: false, error_code }),
    outcome: "rejected" as const,
  })),
  { label: "HTTP 503", response: async () => json({ ok: false, error_code: 400 }, 503), outcome: "unknown" },
  { label: "network error", response: async () => { throw new Error("fixture provider detail"); }, outcome: "unknown" },
  { label: "malformed JSON", response: async () => new Response("invalid"), outcome: "unknown" },
  { label: "missing receipt", response: async () => json({ ok: true, result: {} }), outcome: "unknown" },
  { label: "invalid receipt", response: async () => json({ ok: true, result: { message_id: 0 } }), outcome: "unknown" },
  { label: "string receipt", response: async () => json({ ok: true, result: { message_id: "7" } }), outcome: "unknown" },
  { label: "unexpected success status", response: async () => json({ ok: true, result: { message_id: 7 } }, 201), outcome: "unknown" },
];
for (const sample of responses) {
  test(`Telegram ${sample.label} is ${sample.outcome} and is never automatically resent`, async (t) => {
    const h = harness();
    const outbound = t.mock.method(globalThis, "fetch", sample.response);
    const signal = new AbortController().signal;
    await sendTelegramNotificationsBatch(h.deps, signal);
    await sendTelegramNotificationsBatch(h.deps, signal);
    assert.equal(h.entries[0].status, sample.outcome);
    assert.equal(h.entries[0].receipt, undefined);
    assert.equal(h.acks.length, 1);
    assert.equal(outbound.mock.callCount(), 1);
  });
}

test("Telegram bounds response bytes and cancels an oversized body", async (t) => {
  const h = harness();
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
    cancel() { cancelled = true; },
  })));
  await sendTelegramNotificationsBatch(h.deps, new AbortController().signal);
  assert.equal(h.entries[0].status, "unknown");
  assert.equal(cancelled, true);
});

test("Telegram never claims another bot's notifications or a disabled peer", async (t) => {
  const h = harness([entry("old-bot", "42", "99"), entry("disabled", "43"), entry("current")]);
  const outbound = t.mock.method(globalThis, "fetch", async () => json({ ok: true, result: { message_id: 8 } }));
  await sendTelegramNotificationsBatch(h.deps, new AbortController().signal);
  assert.deepEqual(h.entries.map((value) => value.status), ["pending", "pending", "delivered"]);
  assert.equal(outbound.mock.callCount(), 1);
  h.telegram.enabled = false;
  const before = h.claims.length;
  await sendTelegramNotificationsBatch(h.deps, new AbortController().signal);
  assert.equal(h.claims.length, before);
});

for (const outcome of ["delivered", "unknown"] as const) {
  test(`Telegram filters invalid peers without starving a valid ${outcome} notification`, async (t) => {
    const h = harness([entry("alias", "42"), entry("valid", "43")], ["0", "00042", "-0", "-00042", "123456789012345678901", "43"]);
    const service = h.deps.notifications!;
    const claim = service.claim;
    service.claim = (destination, limit) => {
      assert.match(destination.botId!, /^[1-9]\d{0,19}$/u);
      assert.match(destination.peer, /^-?[1-9]\d{0,19}$/u);
      return claim(destination, limit);
    };
    const outbound = t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(JSON.parse(String(init?.body)).chat_id, "43");
      if (outcome === "unknown") throw new Error("fixture network outcome unknown");
      return json({ ok: true, result: { message_id: 43 } });
    });
    const signal = new AbortController().signal;
    const cursor = await sendTelegramNotificationsBatch(h.deps, signal);
    await sendTelegramNotificationsBatch(h.deps, signal, cursor);
    assert.deepEqual(h.claims.map((destination) => destination.peer), ["43", "43"]);
    assert.deepEqual(h.entries.map((value) => value.status), ["pending", outcome]);
    assert.equal(h.acks.length, 1);
    assert.equal(outbound.mock.callCount(), 1);
  });
}

test("Telegram disables noncanonical bot identities and an allowlist with no valid peer", async (t) => {
  const outbound = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected send"); });
  const signal = new AbortController().signal;
  for (const token of ["0:fixture", "00101:fixture", "123456789012345678901:fixture"]) {
    const h = harness();
    h.telegram.token = token;
    await sendTelegramNotificationsBatch(h.deps, signal);
    await startTelegramNotifications(h.deps, signal)();
    assert.equal(h.claims.length, 0);
  }
  const h = harness([], ["0", "00042", "-0"]);
  await sendTelegramNotificationsBatch(h.deps, signal);
  await startTelegramNotifications(h.deps, signal)();
  assert.equal(h.claims.length, 0);
  assert.equal(outbound.mock.callCount(), 0);
});

for (const change of ["disable", "peer", "bot", "abort"] as const) {
  test(`Telegram rechecks ${change} after claiming and acknowledges unknown without sending`, async (t) => {
    const h = harness();
    const lifetime = new AbortController();
    h.hooks.afterClaim = () => {
      if (change === "disable") h.telegram.enabled = false;
      if (change === "peer") h.telegram.allowedChatIds = ["43"];
      if (change === "bot") h.telegram.token = "102:fixture";
      if (change === "abort") lifetime.abort();
    };
    const outbound = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected send"); });
    await sendTelegramNotificationsBatch(h.deps, lifetime.signal);
    assert.equal(outbound.mock.callCount(), 0);
    assert.equal(h.entries[0].status, "unknown");
    assert.equal(h.acks.length, 1);
  });
}

test("Telegram uses refreshed credentials for the same public bot identity", async (t) => {
  const h = harness();
  h.hooks.afterClaim = () => { h.telegram.token = "101:rotated_fixture"; };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    assert.equal(String(input), "https://api.telegram.org/bot101:rotated_fixture/sendMessage");
    return json({ ok: true, result: { message_id: 9 } });
  });
  await sendTelegramNotificationsBatch(h.deps, new AbortController().signal);
  assert.equal(h.entries[0].status, "delivered");
});

test("Telegram dispatches at most four serial sends and rotates fairly through peers", async (t) => {
  const peers = ["1", "2", "3", "4", "5", "6"];
  const h = harness(peers.flatMap((peer) => [entry(`${peer}-a`, peer), entry(`${peer}-b`, peer)]), peers);
  const sent: string[] = [];
  let active = 0;
  let peak = 0;
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    sent.push(JSON.parse(String(init?.body)).chat_id);
    active--;
    return json({ ok: true, result: { message_id: sent.length } });
  });
  const signal = new AbortController().signal;
  const cursor = await sendTelegramNotificationsBatch(h.deps, signal);
  assert.deepEqual(sent, ["1", "2", "3", "4"]);
  await sendTelegramNotificationsBatch(h.deps, signal, cursor);
  assert.deepEqual(sent, ["1", "2", "3", "4", "5", "6", "1", "2"]);
  assert.equal(peak, 1);
  const empty = harness([], Array.from({ length: 100 }, (_, index) => String(index + 1)));
  await sendTelegramNotificationsBatch(empty.deps, signal);
  assert.equal(empty.claims.length, 100);
});

test("Telegram request timeout is ten seconds and records unknown", async (t) => {
  const h = harness();
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 10_000);
    return timeout.signal;
  });
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      queueMicrotask(() => timeout.abort(new DOMException("fixture timeout", "TimeoutError")));
    });
  });
  await sendTelegramNotificationsBatch(h.deps, new AbortController().signal);
  assert.equal(h.entries[0].status, "unknown");
  assert.equal(h.acks.length, 1);
});

test("Telegram stop cancels the active send, persists unknown and prevents another claim", { timeout: 1000 }, async (t) => {
  const h = harness([entry("first"), entry("second")]);
  let started!: () => void;
  let acknowledged!: () => void;
  const sending = new Promise<void>((resolve) => { started = resolve; });
  const cleaned = new Promise<void>((resolve) => { acknowledged = resolve; });
  h.hooks.afterAck = acknowledged;
  const outbound = t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal);
    started();
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const stop = startTelegramNotifications(h.deps, new AbortController().signal);
  await sending;
  const drained = stop();
  await cleaned;
  await drained;
  assert.deepEqual(h.entries.map((value) => value.status), ["unknown", "pending"]);
  assert.equal(h.claims.length, 1);
  assert.equal(outbound.mock.callCount(), 1);
});

test("Telegram stop waits for a delayed cancelled send to acknowledge unknown before resolving", { timeout: 1000 }, async (t) => {
  const h = harness([entry("first"), entry("second")]);
  const events: string[] = [];
  const errors: string[] = [];
  let started!: () => void;
  let rejectSend!: (reason: unknown) => void;
  let requestSignal!: AbortSignal;
  const sending = new Promise<void>((resolve) => { started = resolve; });
  h.hooks.afterAck = () => { events.push("ack"); };
  const outbound = t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(init?.signal);
    requestSignal = init.signal;
    const response = new Promise<Response>((_resolve, reject) => { rejectSend = reject; });
    started();
    return response;
  });
  const stop = startTelegramNotifications(h.deps, new AbortController().signal, (message) => { errors.push(message); });
  await sending;
  const drained = stop();
  assert.equal(requestSignal.aborted, true);
  assert.equal(stop(), drained);
  let finished = false;
  const observed = drained.then(() => { finished = true; events.push("stopped"); });
  await nextTurn();
  assert.equal(finished, false);
  assert.equal(h.entries[0].status, "dispatching");
  assert.equal(h.acks.length, 0);
  rejectSend(requestSignal.reason);
  await observed;
  await nextTurn();
  assert.deepEqual(events, ["ack", "stopped"]);
  assert.deepEqual(h.entries.map((value) => value.status), ["unknown", "pending"]);
  assert.equal(h.claims.length, 1);
  assert.equal(outbound.mock.callCount(), 1);
  assert.deepEqual(errors, []);
});

test("Telegram captures a rejected background error callback until stop drains it", async () => {
  const h = harness();
  h.hooks.claimError = new Error("fixture claim failure");
  const failure = new Error("fixture callback failure");
  const stop = startTelegramNotifications(h.deps, new AbortController().signal, () => { throw failure; });
  await nextTurn();
  const drained = stop();
  assert.equal(stop(), drained);
  await assert.rejects(drained, (error: unknown) => error === failure);
});

test("Telegram loop waits five seconds between batches", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness([entry("first"), entry("second")]);
  const outbound = t.mock.method(globalThis, "fetch", async () => json({ ok: true, result: { message_id: 7 } }));
  const stop = startTelegramNotifications(h.deps, new AbortController().signal);
  try {
    await nextTurn();
    assert.equal(outbound.mock.callCount(), 1);
    t.mock.timers.tick(4999);
    await nextTurn();
    assert.equal(outbound.mock.callCount(), 1);
    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(outbound.mock.callCount(), 2);
  } finally {
    await stop();
  }
});

test("Telegram loop reports storage errors without leaking the original error", { timeout: 1000 }, async (t) => {
  const h = harness();
  h.hooks.claimError = new Error("fixture provider body and credential");
  const lifetime = new AbortController();
  const errors: string[] = [];
  let reported!: () => void;
  const done = new Promise<void>((resolve) => { reported = resolve; });
  const outbound = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected send"); });
  const stop = startTelegramNotifications(h.deps, lifetime.signal, (message) => {
    errors.push(message);
    lifetime.abort();
    reported();
  });
  await done;
  await stop();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Telegram/u);
  assert.doesNotMatch(errors[0], /fixture|credential|provider/u);
  assert.equal(outbound.mock.callCount(), 0);
});

test("Telegram without a notification service or with an aborted lifetime does no work", async (t) => {
  const h = harness();
  let reads = 0;
  h.deps.config = () => { reads++; throw new Error("unexpected config read"); };
  const outbound = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected send"); });
  const noService = startTelegramNotifications({ ...h.deps, notifications: undefined }, new AbortController().signal);
  const stopped = startTelegramNotifications(h.deps, AbortSignal.abort());
  const disabled = harness();
  disabled.telegram.enabled = false;
  const noConfig = startTelegramNotifications(disabled.deps, new AbortController().signal);
  await nextTurn();
  await Promise.all([noService(), stopped(), noConfig()]);
  assert.equal(reads, 0);
  assert.equal(h.claims.length, 0);
  assert.equal(disabled.claims.length, 0);
  assert.equal(outbound.mock.callCount(), 0);
});
