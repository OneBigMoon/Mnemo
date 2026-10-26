import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store, ALIPAN_AUTH_ID, ALIPAN_AUTH_KIND } from "../server/store.js";
import { Alipan, type AlipanPagePosition } from "../server/alipan.js";
import { AlipanError } from "../server/alipan-auth.js";

const API = {
  refresh: "https://auth.alipan.com/v2/account/token",
  share: "https://api.alipan.com/v2/share_link/get_share_token",
  list: "https://api.alipan.com/adrive/v3/file/list",
  link: "https://api.alipan.com/v2/file/get_share_link_download_url",
};
const INPUT = { shareCode: "fixture_share-1", receiveCode: "A9B8", parentId: "0" };
const LINK = { shareCode: INPUT.shareCode, receiveCode: INPUT.receiveCode, fileId: "file:opaque-id", driveId: "sharing-owner-drive" };
const PRIVATE = "fixture-private-provider-content";
const CDN = "https://download.example.invalid/file?sign=fixture-ticket";

interface Call { url: string; body: Record<string, any>; headers: Headers; signal: AbortSignal }
type Handler = (call: Call) => Response | Promise<Response>;
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const file = (index: number) => ({ file_id: `opaque:${index}+file`, name: `episode-${index}.mp4`, type: "file", size: index, drive_id: "sharing-owner-drive" });
const refresh = (index = 1, extra: Record<string, unknown> = {}) => reply({ access_token: `fixture-access-${index}`, refresh_token: `fixture-refresh-${index}`, expires_in: 3600, ...extra });

async function fixture(t: TestContext, handler?: Handler, credential = "fixture-initial-refresh") {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-alipan-http-"));
  const store = new Store(root, path.join(root, "files"));
  const config = store.config();
  config.sources.alipanEnabled = true;
  config.sources.alipanRefreshToken = credential;
  store.setConfig(config);
  const calls: Call[] = [];
  let refreshCount = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(typeof input, "string");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const call = { url: String(input), body: JSON.parse(String(init.body)), headers: new Headers(init.headers), signal: init.signal };
    assert.ok(Object.values(API).includes(call.url), "API hosts and paths must be fixed");
    calls.push(call);
    if (handler) return handler(call);
    if (call.url === API.refresh) return refresh(++refreshCount);
    if (call.url === API.share) return reply({ share_token: "fixture-share-token" });
    if (call.url === API.list) return reply({ items: [file(1)], next_marker: "" });
    return reply({ download_url: CDN });
  }) as typeof fetch;
  const adapter = new Alipan(store, fetcher);
  t.after(async () => { await adapter.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, calls, adapter };
}

function failure(code: string, status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof AlipanError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    assert.ok(!error.message.includes(PRIVATE));
    assert.ok(!error.message.includes(CDN));
    return true;
  };
}

test("Alipan anonymous list maps root and sends only share authorization to fixed APIs", async (t) => {
  const f = await fixture(t, undefined, "");
  const page = await f.adapter.list(INPUT);
  assert.deepEqual(page, { entries: [{ id: "opaque:1+file", name: "episode-1.mp4", directory: false, size: 1, driveId: "sharing-owner-drive" }] });
  assert.deepEqual(f.calls.map((call) => call.url), [API.share, API.list]);
  assert.deepEqual(f.calls[0].body, { share_id: INPUT.shareCode, share_pwd: INPUT.receiveCode });
  assert.deepEqual(f.calls[1].body, { share_id: INPUT.shareCode, parent_file_id: "root", limit: 20, marker: "", order_by: "name", order_direction: "ASC" });
  assert.equal(f.calls[1].headers.get("x-share-token"), "fixture-share-token");
  assert.equal(f.calls[1].headers.get("x-canary"), "client=web,app=share,version=v2.3.1");
  for (const call of f.calls) {
    assert.equal(call.headers.get("authorization"), null);
    assert.equal(call.headers.get("cookie"), null);
  }
  await assert.rejects(f.adapter.authorize(), failure("alipan_auth_required", 409));
  await assert.rejects(f.adapter.link(LINK), failure("alipan_auth_required", 409));
  assert.equal(f.calls.length, 2);
});

test("Alipan consumes a 200-entry provider page in twenty-entry slices without skipping opaque IDs", async (t) => {
  const f = await fixture(t, (call) => {
    if (call.url === API.share) return reply({ share_token: "fixture-share-token" });
    assert.equal(call.url, API.list);
    return call.body.marker === "" ? reply({ items: Array.from({ length: 200 }, (_, index) => file(index)), next_marker: "next:opaque+marker" })
      : reply({ items: [file(200), file(201)], next_marker: "" });
  }, "");
  let position: AlipanPagePosition | undefined;
  const ids: string[] = [];
  for (let index = 0; index < 10; index++) {
    const page = await f.adapter.list({ ...INPUT, page: position });
    assert.equal(page.entries.length, 20);
    ids.push(...page.entries.map((item) => item.id));
    position = page.next;
    assert.deepEqual(position, index < 9 ? { marker: "", index: (index + 1) * 20 } : { marker: "next:opaque+marker", index: 0 });
  }
  const page = await f.adapter.list({ ...INPUT, page: position });
  ids.push(...page.entries.map((item) => item.id));
  assert.equal(page.next, undefined);
  assert.deepEqual(ids, Array.from({ length: 202 }, (_, index) => `opaque:${index}+file`));
  assert.deepEqual(f.calls.filter((call) => call.url === API.list).map((call) => call.body.marker), [...Array(10).fill(""), "next:opaque+marker"]);
});

test("Alipan normalizes folder metadata but never manufactures SHA1 or an account drive ID", async (t) => {
  const f = await fixture(t, (call) => call.url === API.share ? reply({ share_token: "fixture-share-token" }) : reply({ items: [
    { file_id: "目录:opaque", name: "Season 01", type: "folder", updated_at: "2026-01-01T10:00:00+08:00" },
    { ...file(1), drive_id: undefined, content_hash: "a".repeat(40), content_hash_name: "sha1", cookie: PRIVATE },
  ], next_marker: "" }), "");
  const result = await f.adapter.list({ ...INPUT, receiveCode: "", parentId: "目录:opaque" });
  assert.equal(f.calls[0].body.share_pwd, undefined);
  assert.equal(f.calls[1].body.parent_file_id, "目录:opaque");
  assert.deepEqual(result.entries[0], { id: "目录:opaque", name: "Season 01", directory: true, size: 0, updatedAt: "2026-01-01T02:00:00.000Z" });
  assert.equal(result.entries[1].driveId, undefined);
  assert.equal(Object.hasOwn(result.entries[1], "sha1"), false);
  assert.ok(!JSON.stringify(result).includes(PRIVATE));
});

test("Alipan empty pages advance once while repeated, oversized or stale page positions fail", async (t) => {
  let data: unknown = { items: [], next_marker: "fresh-marker" };
  const f = await fixture(t, (call) => call.url === API.share ? reply({ share_token: "fixture-share-token" }) : reply(data), "");
  assert.deepEqual(await f.adapter.list(INPUT), { entries: [], next: { marker: "fresh-marker", index: 0 } });
  assert.equal(f.calls.length, 2, "one list operation must not walk a second provider page");
  for (const [body, page] of [
    [{ items: [file(1)], next_marker: "repeat" }, { marker: "repeat", index: 0 }],
    [{ items: [], next_marker: "x".repeat(4097) }, undefined],
    [{ items: [], next_marker: null }, undefined],
    [{ items: [file(1)], next_marker: "" }, { marker: "", index: 1 }],
    [{ items: Array.from({ length: 201 }, (_, index) => file(index)), next_marker: "" }, undefined],
  ] as const) {
    data = body;
    await assert.rejects(f.adapter.list({ ...INPUT, page }), failure("alipan_upstream_error"));
  }
});

test("Alipan rejects invalid input and disabled access before network dispatch", async (t) => {
  const f = await fixture(t, () => { throw new Error("must not dispatch"); });
  for (const extra of [{ shareCode: "https://api.example.invalid" }, { receiveCode: "ABC" }, { parentId: "bad\nparent" }, { parentId: "x".repeat(257) }, { page: null }, { page: {} }, { page: { marker: "x".repeat(4097), index: 0 } }, { page: { marker: "", index: 200 } }, { page: { marker: "", index: -1 } }, { page: { marker: "", index: 0.5 } }])
    await assert.rejects(f.adapter.list({ ...INPUT, ...extra } as any), failure("alipan_invalid_input", 400));
  await assert.rejects(f.adapter.link({ ...LINK, driveId: "" }), failure("alipan_invalid_input"));
  const config = f.store.config(); config.sources.alipanEnabled = false; f.store.setConfig(config);
  await assert.rejects(f.adapter.list(INPUT), failure("alipan_unavailable", 503));
  assert.equal(f.calls.length, 0);
});

test("Alipan rejects malformed entries and duplicate identities without exposing provider fields", async (t) => {
  let items: unknown = [];
  const f = await fixture(t, (call) => call.url === API.share ? reply({ share_token: "fixture-share-token" }) : reply({ items, next_marker: "" }), "");
  for (const value of [null, [{ ...file(1), file_id: 1 }], [{ ...file(1), name: "../file.mp4" }], [{ ...file(1), size: true }], [{ ...file(1), type: "link" }], [{ ...file(1), drive_id: "x\ny" }], [file(1), file(1)]]) {
    items = value;
    await assert.rejects(f.adapter.list(INPUT), failure("alipan_upstream_error"));
  }
});

test("Alipan link uses the sharing drive and isolates API credentials from the returned CDN URL", async (t) => {
  const f = await fixture(t);
  assert.equal(f.calls.length, 0, "constructing the adapter must not refresh an account");
  assert.deepEqual(await f.adapter.link(LINK), { url: CDN });
  assert.deepEqual(f.calls.map((call) => call.url), [API.refresh, API.share, API.link]);
  assert.deepEqual(f.calls[0].body, { refresh_token: "fixture-initial-refresh", grant_type: "refresh_token" });
  assert.equal(f.calls[0].headers.get("authorization"), null);
  assert.equal(f.calls[1].headers.get("authorization"), null);
  assert.deepEqual(f.calls[2].body, { share_id: INPUT.shareCode, drive_id: "sharing-owner-drive", file_id: "file:opaque-id", expire_sec: 600 });
  assert.equal(f.calls[2].headers.get("authorization"), "Bearer fixture-access-1");
  assert.equal(f.calls[2].headers.get("x-share-token"), "fixture-share-token");
  assert.equal(f.calls[2].headers.get("cookie"), null);
  assert.ok(f.calls.every((call) => call.url !== CDN));
});

test("Alipan testConnection validates Web login and rotates using response-derived millisecond expiry", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let count = 0;
  const f = await fixture(t, (call) => {
    if (call.url === API.refresh) return refresh(++count, { expire_time: new Date(Date.now() + 1800_000).toISOString() });
    if (call.url === API.share) return reply({ share_token: "fixture-share-token" });
    return reply({ download_url: CDN });
  });
  assert.deepEqual(await f.adapter.testConnection(), { ok: true, message: "阿里网页登录凭据已验证；尚未验证分享权限或下载权益" });
  assert.equal(f.calls.length, 1);
  await f.adapter.authorize();
  await f.adapter.link(LINK);
  assert.equal(count, 1);
  t.mock.timers.tick(1800_001);
  await f.adapter.authorize();
  assert.equal(count, 2);
  assert.deepEqual(f.calls.filter((call) => call.url === API.refresh).map((call) => call.body.refresh_token), ["fixture-initial-refresh", "fixture-refresh-1"]);
});

test("Alipan retains a complete rotated pair without expiry instead of inventing a cache lifetime", async (t) => {
  let count = 0;
  const f = await fixture(t, () => refresh(++count, { expires_in: undefined, expire_time: undefined }));
  assert.equal((await f.adapter.testConnection()).ok, true);
  await f.adapter.authorize();
  assert.equal(count, 2);
  assert.equal(f.calls[1].body.refresh_token, "fixture-refresh-1");
});

test("Alipan invalid, malformed and network-unknown refreshes never auto-replay through testConnection", async (t) => {
  for (const kind of ["invalid", "network", "malformed"] as const) await t.test(kind, async (child) => {
    const f = await fixture(child, () => {
      if (kind === "invalid") return reply({ code: "InvalidParameter.RefreshToken", message: PRIVATE }, 400);
      if (kind === "malformed") return reply({ access_token: "fixture-access", message: PRIVATE });
      throw new Error(PRIVATE + CDN);
    });
    const expected = kind === "invalid" ? "alipan_auth_invalid" : "alipan_auth_unknown";
    const first = await f.adapter.testConnection();
    assert.equal(first.ok, false);
    assert.equal(first.code, expected);
    assert.ok(!first.message.includes(PRIVATE));
    const second = await f.adapter.testConnection();
    assert.equal(second.code, expected);
    assert.equal(f.calls.length, 1);
  });
});

test("Alipan bounds AccessTokenInvalid to one refresh and one read retry", async (t) => {
  for (const recover of [true, false]) await t.test(String(recover), async (child) => {
    let refreshes = 0, reads = 0;
    const f = await fixture(child, (call) => {
      if (call.url === API.refresh) return refresh(++refreshes);
      if (call.url === API.share) return reply({ share_token: "fixture-share-token" });
      reads++;
      return recover && reads === 2 ? reply({ download_url: CDN }) : reply({ code: "AccessTokenInvalid", message: PRIVATE }, 400);
    });
    if (recover) assert.deepEqual(await f.adapter.link(LINK), { url: CDN });
    else await assert.rejects(f.adapter.link(LINK), failure("alipan_share_unavailable", 403));
    assert.equal(refreshes, 2);
    assert.equal(reads, 2);
    assert.equal(f.calls.filter((call) => call.url === API.share).length, 1);
  });
});

test("Alipan does not loop on invalid share tokens or leak arbitrary API error bodies", async (t) => {
  for (const [status, code, expected] of [[429, undefined, "alipan_rate_limited"], [400, "NotFound.FileId", "alipan_file_not_found"], [400, "ShareLinkTokenInvalid", "alipan_share_unavailable"], [403, undefined, "alipan_share_unavailable"], [400, PRIVATE, "alipan_upstream_error"], [500, undefined, "alipan_upstream_error"]] as const) {
    const f = await fixture(t, () => reply({ code, message: PRIVATE + CDN }, status), "");
    await assert.rejects(f.adapter.list(INPUT), failure(expected));
    assert.equal(f.calls.length, 1);
  }
});

test("Alipan rejects redirect responses and unsafe download URLs", async (t) => {
  const redirect = await fixture(t, () => new Response(PRIVATE, { status: 302, headers: { Location: "https://untrusted.example.invalid/" } }), "");
  await assert.rejects(redirect.adapter.list(INPUT), failure("alipan_upstream_error"));
  assert.equal(redirect.calls.length, 1);
  let url = "";
  const f = await fixture(t, (call) => call.url === API.refresh ? refresh() : call.url === API.share ? reply({ share_token: "fixture-share-token" }) : reply({ download_url: url }));
  for (const value of ["", "file:///etc/passwd", "https://user:pass@example.invalid/file", CDN + "#fragment", CDN + "\r\nx"]) {
    url = value;
    await assert.rejects(f.adapter.link(LINK), failure("alipan_upstream_error"));
  }
});

test("Alipan enforces both advertised and streamed JSON byte limits and closes the stream", async (t) => {
  for (const advertised of [true, false]) await t.test(String(advertised), async (child) => {
    let closed = false;
    const f = await fixture(child, () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
      cancel() { closed = true; },
    }), { headers: advertised ? { "Content-Length": String(1024 * 1024 + 1) } : {} }), "");
    await assert.rejects(f.adapter.list(INPUT), failure("alipan_upstream_error"));
    assert.equal(closed, true);
  });
});

test("Alipan propagates cancellation before dispatch and during a request", async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, (call) => new Promise<Response>((_resolve, reject) => call.signal.addEventListener("abort", () => reject(new DOMException(PRIVATE, "AbortError")), { once: true })), "");
  controller.abort();
  await assert.rejects(f.adapter.list(INPUT, controller.signal), failure("alipan_cancelled", 409));
  assert.equal(f.calls.length, 0);
  const active = new AbortController();
  const pending = f.adapter.list(INPUT, active.signal);
  assert.equal(f.calls.length, 1);
  active.abort();
  await assert.rejects(pending, failure("alipan_cancelled", 409));
  assert.equal(f.calls[0].signal.aborted, true);
});

test("Alipan applies an eight-second request timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t, (call) => new Promise<Response>((_resolve, reject) => call.signal.addEventListener("abort", () => reject(new DOMException(PRIVATE, "AbortError")), { once: true })), "");
  const pending = f.adapter.list(INPUT);
  const rejected = assert.rejects(pending, failure("alipan_upstream_error", 504));
  t.mock.timers.tick(8000);
  await rejected;
  assert.equal(f.calls[0].signal.aborted, true);
});

test("Alipan bounds the complete multi-request operation and does not replay an unknown refresh", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let refreshes = 0;
  const f = await fixture(t, (call) => new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (call.url === API.refresh) resolve(refresh(++refreshes));
      else if (call.url === API.share) resolve(reply({ share_token: "fixture-share-token" }));
      else resolve(reply({ code: "AccessTokenInvalid", message: PRIVATE }, 400));
    }, 7000);
    call.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException(PRIVATE, "AbortError")); }, { once: true });
  }));
  const pending = f.adapter.link(LINK);
  const rejected = assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof AlipanError);
    assert.ok(["alipan_cancelled", "alipan_auth_unknown", "alipan_upstream_error"].includes(error.code));
    assert.ok(!error.message.includes(PRIVATE));
    return true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (const elapsed of [7000, 7000, 7000, 4000]) {
    t.mock.timers.tick(elapsed);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await rejected;
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[3].signal.aborted, true);
  const calls = f.calls.length;
  await assert.rejects(f.adapter.authorize(), failure("alipan_auth_unknown", 409));
  assert.equal(f.calls.length, calls);
});

test("Alipan close is idempotent, drains an active HTTP operation and refuses new work", async (t) => {
  let release!: (response: Response) => void;
  const f = await fixture(t, () => new Promise<Response>((resolve) => { release = resolve; }), "");
  const pending = f.adapter.list(INPUT);
  const rejected = assert.rejects(pending, failure("alipan_cancelled", 409));
  const closing = f.adapter.close();
  assert.equal(f.adapter.close(), closing);
  let settled = false;
  void closing.then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "close must wait for an already owned HTTP operation");
  assert.equal(f.calls[0].signal.aborted, true);
  release(reply({ share_token: "fixture-share-token" }));
  await Promise.all([closing, rejected]);
  await assert.rejects(f.adapter.list(INPUT), failure("alipan_closed", 409));
  await assert.rejects(f.adapter.link(LINK), failure("alipan_closed", 409));
  await assert.rejects(f.adapter.authorize(), failure("alipan_closed", 409));
  assert.equal((await f.adapter.testConnection()).code, "alipan_closed");
  assert.equal(f.calls.length, 1, "closing cannot dispatch a following API request");
});

test("Alipan HTTP refresh preserves a complete late credential pair before close returns cancellation", async (t) => {
  let release!: (response: Response) => void;
  const f = await fixture(t, () => new Promise<Response>((resolve) => { release = resolve; }));
  const testing = f.adapter.testConnection();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  const closing = f.adapter.close();
  let settled = false;
  void closing.then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(f.calls[0].signal.aborted, true);
  release(refresh(7));
  const result = await testing;
  await closing;
  assert.equal(result.ok, false);
  assert.equal(result.code, "alipan_cancelled");
  const saved = f.store.privateRecord<{ phase: string; refreshToken: string; accessToken: string; expiresAt: number }>(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID)!;
  assert.equal(saved.phase, "ready");
  assert.equal(saved.refreshToken, "fixture-refresh-7");
  assert.equal(saved.accessToken, "fixture-access-7");
  assert.ok(saved.expiresAt > Date.now());
});

test("Alipan interrupted partial refresh bytes persist unknown and cannot be replayed", async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, (call) => new Response(new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(Buffer.from('{"access_token":"incomplete'));
      call.signal.addEventListener("abort", () => stream.error(new DOMException(PRIVATE, "AbortError")), { once: true });
    },
  })));
  const testing = f.adapter.testConnection(controller.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await testing;
  assert.equal(result.ok, false);
  assert.equal(result.code, "alipan_cancelled");
  assert.equal(f.store.privateRecord<{ phase: string }>(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID)?.phase, "unknown");
  await assert.rejects(f.adapter.authorize(), failure("alipan_auth_unknown", 409));
  assert.equal(f.calls.length, 1);
});

test("Alipan close drains other HTTP work before reporting a refresh persistence failure", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-alipan-close-failure-"));
  const store = new Store(root, path.join(root, "files"));
  const config = store.config();
  config.sources.alipanEnabled = true;
  config.sources.alipanRefreshToken = "fixture-close-failure-refresh";
  store.setConfig(config);
  const putPrivate = store.putPrivate.bind(store);
  const storage = t.mock.method(store, "putPrivate", (kind: string, id: string, value: unknown, expiresAt: string) => {
    if (kind === ALIPAN_AUTH_KIND && (value as { phase?: string }).phase !== "pending") throw new Error("fixture storage unavailable");
    return putPrivate(kind, id, value, expiresAt);
  });
  let releaseList: ((response: Response) => void) | undefined;
  let releaseRefresh: ((response: Response) => void) | undefined;
  const adapter = new Alipan(store, (async (input) => {
    const url = String(input);
    if (url === API.share) return new Promise<Response>((resolve) => { releaseList = resolve; });
    if (url === API.refresh) return new Promise<Response>((resolve) => { releaseRefresh = resolve; });
    throw new Error("unexpected fixture endpoint");
  }) as typeof fetch);
  const listing = adapter.list(INPUT);
  const rejected = assert.rejects(listing, failure("alipan_cancelled", 409));
  const testing = adapter.testConnection();
  let observedClose: Promise<unknown> | undefined;
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(releaseList);
    assert.ok(releaseRefresh);
    let closeSettled = false;
    const closing = adapter.close();
    observedClose = closing.then(
      () => { closeSettled = true; return undefined; },
      (error: unknown) => { closeSettled = true; return error; },
    );
    releaseRefresh(refresh(8));
    const result = await testing;
    assert.equal(result.ok, false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closeSettled, false, "a failed auth receipt cannot bypass the owned HTTP drain");
    releaseList(reply({ share_token: "fixture-share-after-close" }));
    await rejected;
    const error = await observedClose;
    assert.ok(error instanceof AlipanError);
    assert.equal(error.code, "alipan_auth_unknown");
    assert.equal(error.status, 409);
    assert.equal(adapter.close(), closing);
  } finally {
    releaseList?.(reply({ share_token: "fixture-share-after-close" }));
    releaseRefresh?.(refresh(8));
    await Promise.allSettled([listing, rejected, testing, observedClose, adapter.close()]);
    storage.mock.restore();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
