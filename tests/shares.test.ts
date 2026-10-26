import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.js";
import { Shares, createShareHelperRunner, type ShareHelperInput, type ShareHelperRunner } from "../server/shares.js";
import type { DownloadTask, SearchResult } from "../shared/types.js";

const KIND = "share-reference";
const SHA1 = "A".repeat(40);
const file = { id: "42", name: "Fixture.2026.mkv", directory: false, size: 1234, sha1: SHA1 };
const source = (url = "https://115.com/s/SWfixture?password=AB12", extra: Partial<SearchResult> = {}): SearchResult => ({
  id: "source", title: "Fixture", source: "fixture", kind: "share", url, ...extra,
});
function id(reference: string) { return reference.slice("mori-share:".length); }
function fixture(t: TestContext, runner: ShareHelperRunner) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mori-shares-"));
  const store = new Store(path.join(root, "state"), path.join(root, "files"));
  const config = store.config();
  config.sources.p115Enabled = true;
  config.sources.p115Cookie = "local-fixture-cookie";
  store.setConfig(config);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, shares: new Shares(store, runner) };
}
function listing(entries: unknown[] = [file], extra: Record<string, unknown> = {}) {
  return { ok: true, data: { entries, ...extra } };
}
function task(reference: string): DownloadTask {
  return { id: "task-fixture", title: "Fixture", url: reference, kind: "cloud", status: "paused", progress: 0, bytes: 0, total: 0, profile: "emby", media: { title: "Fixture", type: "movie" }, createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z" };
}
function childRunner(code: string, observe?: (child: ReturnType<typeof spawn>, command: string, args: readonly string[]) => void) {
  return createShareHelperRunner(((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
    const child = spawn(process.execPath, ["-e", code], options);
    observe?.(child, command, args);
    return child;
  }) as typeof spawn);
}

test("capture encrypts passcodes while disabled, canonicalizes trusted URLs and preserves extraction codes for later enablement", async (t) => {
  const inputs: ShareHelperInput[] = [];
  const { store, shares } = fixture(t, async (input) => { inputs.push(input); return listing(); });
  const config = store.config();
  config.sources.p115Enabled = false;
  store.setConfig(config);
  const captured = shares.capture(source(undefined, { extractionCode: "CD34" }));
  assert.equal(captured.url, "https://115.com/s/SWfixture");
  assert.match(captured.shareRef!, /^mori-share:[a-f0-9]{64}$/);
  assert.equal(captured.kind, "share");
  assert.equal(Object.hasOwn(captured, "extractionCode"), false);
  assert.equal(Object.hasOwn(captured, "navigation"), false);
  const root = store.privateRecord<any>(KIND, id(captured.shareRef!));
  assert.equal(root.receiveCode, "CD34");
  const envelopes = JSON.stringify(store.list(KIND));
  for (const forbidden of ["CD34", "AB12", "SWfixture", "receiveCode", "local-fixture-cookie"])
    assert.equal(envelopes.includes(forbidden), false);
  await assert.rejects(shares.browse(captured.shareRef!), { code: "not_configured" });
  await assert.rejects(shares.resolve(captured.shareRef!), { code: "not_configured" });
  assert.equal(inputs.length, 0);
  for (const url of ["https://115cdn.com/s/SWfixture#private-fragment", "https://share.115.com/SWfixture"])
    assert.equal(shares.capture(source(url)).shareRef, captured.shareRef);
  assert.equal(store.list(KIND).length, 1);
  config.sources.p115Enabled = true;
  store.setConfig(config);
  await shares.browse(captured.shareRef!);
  assert.equal(inputs[0].receiveCode, "CD34");
  assert.equal(inputs[0].parentId, "0");
  assert.equal(inputs[0].cookie, "local-fixture-cookie");
});

test("capture does not turn unsupported domains, account routes or source-supplied refs into trusted shares", (t) => {
  const { store, shares } = fixture(t, async () => { throw new Error("must not invoke helper"); });
  for (const url of ["https://115.com.evil.invalid/s/code", "https://evil115.com/s/code", "https://www.115.com/s/code", "https://anxia.com/s/code", "https://115.com/?ct=file", "https://115.com/s/code/extra", "https://115.com:8443/s/code"] ) {
    const captured = shares.capture({ ...source(url, { extractionCode: "AB12", shareRef: `mori-share:${"a".repeat(64)}`, navigation: "folder" }), password: "not-public" } as SearchResult);
    assert.equal(captured.url, url);
    for (const key of ["shareRef", "navigation", "extractionCode", "password"]) assert.equal(Object.hasOwn(captured, key), false);
  }
  const contexts = store.list<any>(KIND).map((entry) => store.privateRecord<any>(KIND, entry.id));
  assert.equal(contexts.length, 7);
  assert.ok(contexts.every((entry) => entry.kind === "access-only"));
});

test("unsupported shares and telegram retain encrypted access context without exposing codes or SDK refs", async (t) => {
  let helperCalls = 0;
  const { store, shares } = fixture(t, async () => { helperCalls++; throw new Error("must not invoke helper"); });
  const cases: { url: string; code?: string; kind: "share" | "telegram"; secrets: string[] }[] = [
    { url: "https://pan.baidu.com/s/query?pwd=AB12&keep=1", kind: "share", secrets: ["AB12"] },
    { url: "https://pan.baidu.com/s/fragment?keep=1#fragment-secret", kind: "share", secrets: ["fragment-secret"] },
    { url: "https://pan.baidu.com/s/standalone?keep=1", code: "CD34", kind: "share", secrets: ["CD34"] },
    { url: "https://pan.baidu.com/s/aliases?Password=AQ12&PWD=BQ34&receive_code=CQ56&PASSCODE=DQ78&Access_Code=EQ90&keep=1", kind: "share", secrets: ["AQ12", "BQ34", "CQ56", "DQ78", "EQ90"] },
    { url: "https://user:account-secret@pan.baidu.com/s/user?pwd=AB12&keep=1", kind: "share", secrets: ["account-secret", "AB12"] },
    { url: "https://t.me/c/123/45?Password=TQ56&keep=1#message-secret", code: "RS78", kind: "telegram", secrets: ["TQ56", "message-secret", "RS78"] },
  ];
  for (const [index, value] of cases.entries()) {
    const input = source(value.url, { kind: value.kind, extractionCode: value.code });
    const captured = shares.capture(input);
    const publicUrl = new URL(captured.url);
    assert.equal(publicUrl.hash, "");
    assert.equal(publicUrl.username, "");
    assert.equal(publicUrl.password, "");
    assert.equal(publicUrl.searchParams.get("keep"), "1");
    assert.ok([...publicUrl.searchParams.keys()].every((key) => !/^(password|pwd|receive_code|passcode|access_code)$/i.test(key)));
    assert.equal(captured.kind, value.kind);
    for (const key of ["shareRef", "navigation", "extractionCode"]) assert.equal(Object.hasOwn(captured, key), false);
    store.put("request", { id: `unsupported-${index}`, resources: [captured] });
    const publicRecords = JSON.stringify(store.list("request"));
    const envelopes = store.list<any>(KIND);
    for (const secret of value.secrets) {
      assert.equal(JSON.stringify(captured).includes(secret), false);
      assert.equal(publicRecords.includes(secret), false);
      assert.equal(JSON.stringify(envelopes).includes(secret), false);
    }
    const envelope = envelopes.find((entry) => {
      const context = store.privateRecord<any>(KIND, entry.id);
      return context.url === value.url && context.extractionCode === value.code;
    })!;
    assert.match(envelope.id, /^[a-f0-9]{64}$/);
    assert.deepEqual(store.privateRecord(KIND, envelope.id), { kind: "access-only", url: value.url, ...(value.code !== undefined ? { extractionCode: value.code } : {}) });
    const count = envelopes.length;
    shares.capture(input);
    assert.equal(store.list(KIND).length, count);
    await assert.rejects(shares.browse(`mori-share:${envelope.id}`), { code: "invalid_reference" });
    await assert.rejects(shares.resolve(`mori-share:${envelope.id}`), { code: "invalid_reference" });
  }
  const expired = store.list<any>(KIND)[0];
  store.put(KIND, { ...expired, expiresAt: "2000-01-01T00:00:00.000Z" });
  shares.capture(source("https://pan.baidu.com/s/replacement?pwd=ZX98"));
  assert.equal(store.record(KIND, expired.id), undefined);
  assert.equal(store.list(KIND).length, cases.length);
  assert.equal(helperCalls, 0);
});

test("captured result IDs are keyed and metadata redaction keeps unlabelled movie years", (t) => {
  let helperCalls = 0;
  const { store, shares } = fixture(t, async () => { helperCalls++; throw new Error("must not invoke helper"); });
  for (const url of ["https://115.com/s/SWmetadata?password=AB12", "https://pan.baidu.com/s/metadata?pwd=AB12#fragment-code"]) {
    const rawId = createHash("sha256").update(url).digest("hex").slice(0, 24);
    const input = source(url, { id: rawId, extractionCode: "CD34", title: `Movie 2026 (${url}) 提取码:AB12 密码：CD34`, source: `Provider ${url} pwd:AB12 password:CD34` });
    input.title += " receive_code:AB12 passcode:AB12 access_code:AB12";
    input.source += " receive_code:AB12 passcode:AB12 access_code:AB12";
    const captured = shares.capture(input);
    assert.notEqual(captured.id, rawId);
    assert.equal(captured.id, store.privateId(["share-result", rawId, url, "CD34"]));
    assert.match(captured.id, /^[a-f0-9]{64}$/);
    assert.equal(shares.capture(input).id, captured.id);
    assert.equal(shares.capture(input).shareRef, captured.shareRef);
    for (const field of [captured.title, captured.source]) {
      assert.equal(field.includes(url), false);
      assert.equal(field.includes("AB12"), false);
      assert.equal(field.includes("CD34"), false);
      assert.ok(field.includes(captured.url));
    }
    assert.ok(captured.title.includes("Movie 2026"));
    store.put("request", { id: captured.id, resources: [captured] });
    const ordinary = JSON.stringify(store.list("request"));
    assert.equal(ordinary.includes(rawId), false);
    assert.equal(ordinary.includes("AB12"), false);
    assert.equal(ordinary.includes("CD34"), false);
  }
  for (const url of ["https://115.com/s/SWyear?password=2026", "https://pan.baidu.com/s/year?pwd=2026"]) {
    const captured = shares.capture(source(url, { extractionCode: "2026", title: `Movie 2026 ${url} 提取码：2026`, source: "Provider 2026 password:2026" }));
    assert.ok(captured.title.includes("Movie 2026"));
    assert.equal(captured.title.match(/2026/g)?.length, 1);
    assert.equal(captured.source, "Provider 2026 password:[已隐藏]");
  }
  assert.equal(helperCalls, 0);
});

test("browse exposes twenty entries and advances by twenty while keeping trusted parent navigation", async (t) => {
  const calls: ShareHelperInput[] = [];
  const { shares } = fixture(t, async (input) => {
    calls.push(input);
    const offset = input.offset ?? 0;
    const entries = Array.from({ length: 100 }, (_, i) => ({ ...file, id: String((input.parentId === "900" ? 1000 : 0) + offset + i + 1), name: `Fixture.${offset + i + 1}.mkv` }));
    if (input.parentId === "0" && offset === 0) entries[0] = { ...entries[0], id: "900", name: "Season", directory: true };
    return listing(entries, { total: 250, nextOffset: offset + 100 });
  });
  const captured = shares.capture(source());
  const first = await shares.browse(captured.shareRef!);
  assert.equal(first.length, 21);
  assert.equal(first.filter((entry) => !entry.navigation || entry.navigation === "folder").length, 20);
  assert.ok(first.every((entry) => entry.url === entry.shareRef));
  const next = first.find((entry) => entry.navigation === "next")!;
  const second = await shares.browse(next.shareRef!);
  assert.equal(calls[1].offset, 20);
  assert.equal(second[0].title, "Fixture.21.mkv");
  const folder = first.find((entry) => entry.navigation === "folder")!;
  const children = await shares.browse(folder.shareRef!);
  assert.equal(children.length, 22);
  assert.equal(calls[2].parentId, "900");
  assert.equal(calls[2].offset, 0);
  assert.ok(children.some((entry) => entry.navigation === "parent"));
  assert.ok(children.some((entry) => entry.navigation === "next"));
  const parent = children.find((entry) => entry.navigation === "parent")!;
  await shares.browse(parent.shareRef!);
  assert.equal(calls[3].parentId, "0");
  assert.equal(calls[3].offset, 0);
  const selected = first.find((entry) => entry.kind === "cloud")!;
  await assert.rejects(shares.browse(selected.shareRef!), /文件/);
  await assert.rejects(shares.resolve(folder.shareRef!), /具体文件/);
  await assert.rejects(shares.browse("mori-share:../../arbitrary-cid"), /引用无效/);
});

test("file refs bind share, provider file ID and metadata; refreshed links keep a stable content identity without persisting URLs or headers", async (t) => {
  let links = 0;
  let selected = { ...file };
  let linkChange: Record<string, unknown> = {};
  const { store, shares } = fixture(t, async (input) => input.op === "list" ? listing([selected]) : ({ ok: true, data: { url: `https://download.invalid/fixture?temporary=${++links}`, name: selected.name, size: selected.size, sha1: selected.sha1, headers: { "User-Agent": "Mozilla/5.0" }, ...linkChange } }));
  const captured = shares.capture(source());
  const first = (await shares.browse(captured.shareRef!))[0];
  assert.equal(first.kind, "cloud");
  assert.equal(first.url, first.shareRef);
  const repeated = (await shares.browse(captured.shareRef!))[0];
  assert.equal(repeated.url, first.url);
  const resolved = await shares.resolve(first.url);
  const refreshed = await shares.resolve(first.url);
  assert.notEqual(resolved.url, refreshed.url);
  assert.equal(resolved.contentId, refreshed.contentId);
  assert.deepEqual(resolved.headers, { "User-Agent": "Mozilla/5.0" });
  assert.equal(resolved.sha1, SHA1);
  const metadata = store.list<any>(KIND).map((envelope) => store.privateRecord<any>(KIND, envelope.id));
  const persisted = JSON.stringify(metadata);
  for (const forbidden of ["download.invalid", "temporary=", "User-Agent", "Mozilla/5.0", "local-fixture-cookie"]) assert.equal(persisted.includes(forbidden), false);
  const references = new Set([first.url]);
  for (const change of [{ name: "Renamed.mkv" }, { size: 4321 }, { sha1: "B".repeat(40) }, { id: "43" }]) {
    selected = { ...file, ...change };
    const changed = (await shares.browse(captured.shareRef!))[0];
    assert.equal(references.has(changed.url), false);
    references.add(changed.url);
  }
  selected = { ...file };
  const other = shares.capture(source("https://115.com/s/SWother"));
  assert.notEqual((await shares.browse(other.shareRef!))[0].url, first.url);
  for (const change of [{ name: "Changed.mkv" }, { size: 999 }, { sha1: "B".repeat(40) }, { sha1: undefined }]) {
    linkChange = change;
    await assert.rejects(shares.resolve(first.url), { code: "identity_changed" });
  }
  for (const change of [{ headers: { Cookie: "must-not-forward" } }, { headers: { "User-Agent": "other" } }, { url: "file:///private/fixture" }, { url: "https://user:pass@download.invalid/file" }]) {
    linkChange = change;
    await assert.rejects(shares.resolve(first.url), { code: "upstream_error" });
  }
});

test("explicit browse extraction codes update only encrypted context after a successful result", async (t) => {
  let denied = false;
  const inputs: ShareHelperInput[] = [];
  const { store, shares } = fixture(t, async (input) => { inputs.push(input); return denied ? { ok: false, error: { code: "access_denied", message: "raw-provider-cookie-and-url" } } : listing(); });
  const captured = shares.capture(source());
  await shares.browse(captured.shareRef!, "XY98");
  assert.equal(inputs[0].receiveCode, "XY98");
  assert.equal(store.privateRecord<any>(KIND, id(captured.shareRef!)).receiveCode, "XY98");
  denied = true;
  await assert.rejects(shares.browse(captured.shareRef!, "WRONG"), (error: any) => error.code === "access_denied" && !error.message.includes("raw-provider"));
  assert.equal(store.privateRecord<any>(KIND, id(captured.shareRef!)).receiveCode, "XY98");
});

test("source capture cannot replace the working access code of queued or paused tasks", async (t) => {
  const inputs: ShareHelperInput[] = [];
  const { store, shares } = fixture(t, async (input) => {
    inputs.push(input);
    if (!["GOOD1", "GOOD2"].includes(input.receiveCode!))
      return { ok: false, error: { code: "access_denied", message: "fixture denied" } };
    return input.op === "list" ? listing() : { ok: true, data: { url: "https://download.invalid/fixture", name: file.name, size: file.size, sha1: SHA1 } };
  });
  const captured = shares.capture(source("https://115.com/s/SWfixture?password=GOOD1"));
  const selected = (await shares.browse(captured.shareRef!))[0];
  for (const status of ["queued", "paused"] as const) {
    store.put("task", { ...task(selected.url), status });
    shares.capture(source("https://115.com/s/SWfixture?password=BAD1"));
    shares.capture(source(undefined, { extractionCode: "BAD2" }));
    assert.equal(store.privateRecord<any>(KIND, id(captured.shareRef!)).receiveCode, "GOOD1");
    assert.equal((await shares.resolve(selected.url)).name, file.name);
    assert.equal(inputs.at(-1)!.receiveCode, "GOOD1");
  }
  await shares.browse(captured.shareRef!, "GOOD2");
  shares.capture(source("https://115.com/s/SWfixture?password=BAD3"));
  assert.equal((await shares.resolve(selected.url)).name, file.name);
  assert.equal(inputs.at(-1)!.receiveCode, "GOOD2");
  store.remove("task", "task-fixture");
  shares.capture(source(undefined, { extractionCode: "NEW1" }));
  assert.equal(store.privateRecord<any>(KIND, id(captured.shareRef!)).receiveCode, "NEW1");
});

test("expired unreferenced metadata is pruned but task-referenced files retain their encrypted share context", async (t) => {
  const { store, shares } = fixture(t, async (input) => input.op === "list" ? listing() : ({ ok: true, data: { url: "https://download.invalid/fixture", name: file.name, size: file.size, sha1: SHA1 } }));
  const captured = shares.capture(source());
  const selected = (await shares.browse(captured.shareRef!))[0];
  const abandoned = shares.capture(source("https://115.com/s/SWabandoned"));
  store.put("task", task(selected.url));
  for (const envelope of store.list<any>(KIND)) store.put(KIND, { ...envelope, expiresAt: "2000-01-01T00:00:00.000Z" });
  shares.capture(source("https://115.com/s/SWnew"));
  assert.ok(store.record(KIND, id(selected.url)));
  assert.ok(store.record(KIND, id(captured.shareRef!)));
  assert.equal(store.record(KIND, id(abandoned.shareRef!)), undefined);
  assert.equal((await shares.resolve(selected.url)).name, file.name);
  store.remove("task", "task-fixture");
  await assert.rejects(shares.resolve(selected.url), { code: "expired" });
  shares.capture(source("https://115.com/s/SWnewer"));
  assert.equal(store.record(KIND, id(selected.url)), undefined);
  assert.equal(store.record(KIND, id(captured.shareRef!)), undefined);
});

test("metadata capacity rejects a browse atomically and does not discard active references", async (t) => {
  let helperCalls = 0;
  const { store, shares } = fixture(t, async () => { helperCalls++; return listing([file, { ...file, id: "43", name: "Second.mkv" }]); });
  const captured = shares.capture(source());
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  store.transaction(() => {
    for (let i = 0; i < 9998; i++) store.putPrivate(KIND, `capacity-${i}`, { kind: "share", shareCode: `S${i}`, receiveCode: "" }, expiresAt);
  });
  await assert.rejects(shares.browse(captured.shareRef!, "NEW1"), { status: 429, code: "capacity" });
  assert.equal(store.list(KIND).length, 9999);
  assert.equal(store.privateRecord<any>(KIND, id(captured.shareRef!)).receiveCode, "AB12");
  shares.capture(source("https://115.com/s/SWlast"));
  assert.equal(store.list(KIND).length, 10_000);
  assert.throws(() => shares.capture(source("https://115.com/s/SWoverflow")), { status: 429, code: "capacity" });
  const envelope = store.record<any>(KIND, "capacity-0");
  store.put(KIND, { ...envelope, expiresAt: "2000-01-01T00:00:00.000Z" });
  shares.capture(source("https://115.com/s/SWafterprune"));
  assert.equal(store.list(KIND).length, 10_000);
  assert.equal(store.record(KIND, "capacity-0"), undefined);
  const before = helperCalls;
  const unsupported = source("https://pan.baidu.com/s/capacity?pwd=AB12");
  assert.throws(() => shares.capture(unsupported), { status: 429, code: "capacity" });
  store.put(KIND, { ...store.record<any>(KIND, "capacity-1"), expiresAt: "2000-01-01T00:00:00.000Z" });
  const capturedUnsupported = shares.capture(unsupported);
  assert.equal(capturedUnsupported.url, "https://pan.baidu.com/s/capacity");
  assert.equal(capturedUnsupported.shareRef, undefined);
  assert.equal(store.list(KIND).length, 10_000);
  assert.equal(store.record(KIND, "capacity-1"), undefined);
  shares.capture(unsupported);
  assert.equal(store.list(KIND).length, 10_000);
  assert.equal(helperCalls, before);
});

test("two helper operations apply immediate backpressure and an aborted late result creates no refs or code changes", async (t) => {
  const waiting: ((value: unknown) => void)[] = [];
  const { store, shares } = fixture(t, async () => await new Promise((resolve) => waiting.push(resolve)));
  const captured = shares.capture(source());
  const controller = new AbortController();
  const first = shares.browse(captured.shareRef!, "NEW1", controller.signal);
  const second = shares.browse(captured.shareRef!);
  await assert.rejects(shares.browse(captured.shareRef!), { code: "busy", status: 429 });
  assert.equal(waiting.length, 2);
  controller.abort();
  waiting[0](listing());
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(store.list(KIND).length, 1);
  assert.equal(store.privateRecord<any>(KIND, id(captured.shareRef!)).receiveCode, "AB12");
  waiting[1](listing([]));
  assert.deepEqual(await second, []);
});

test("helper failures and readiness never expose provider messages or imply account validation", async (t) => {
  let reply: unknown = { ok: true, data: { available: true, version: "0.0.9.7.2" } };
  const inputs: ShareHelperInput[] = [];
  const { shares } = fixture(t, async (input) => { inputs.push(input); return reply; });
  const ready = await shares.testConnection();
  assert.equal(ready.ok, true);
  assert.match(ready.message, /尚未验证账号或分享/);
  assert.deepEqual(inputs, [{ op: "health" }]);
  reply = { ok: true, data: { available: false, version: null } };
  assert.equal((await shares.testConnection()).ok, false);
  const captured = shares.capture(source());
  for (const code of ["access_denied", "unavailable", "not-found-private-detail"]) {
    reply = { ok: false, error: { code, message: "Cookie=private-details https://signed.invalid/private" } };
    await assert.rejects(shares.browse(captured.shareRef!), (error: any) => !error.message.includes("private") && !error.message.includes("https:"));
  }
});

test("metadata and helper envelopes reject unsafe or oversized values before writing file refs", async (t) => {
  let reply: unknown = listing();
  const { store, shares } = fixture(t, async () => reply);
  const captured = shares.capture(source());
  for (const entry of [{ ...file, id: "../../42" }, { ...file, name: "../Fixture.mkv" }, { ...file, size: -1 }, { ...file, sha1: "not-a-sha1" }]) {
    reply = listing([entry]);
    await assert.rejects(shares.browse(captured.shareRef!), { code: "upstream_error" });
    assert.equal(store.list(KIND).length, 1);
  }
  reply = listing(Array.from({ length: 101 }, (_, i) => ({ ...file, id: String(i + 1) })));
  await assert.rejects(shares.browse(captured.shareRef!), { code: "upstream_error" });
  reply = { ok: true, data: { entries: [], padding: "x".repeat(256 * 1024) } };
  await assert.rejects(shares.browse(captured.shareRef!), /输出过大/);
  const config = store.config();
  config.sources.p115Cookie = "non-ascii-中文";
  store.setConfig(config);
  await assert.rejects(shares.browse(captured.shareRef!), /Cookie 配置无效/);
});

test("owned helper children receive secrets only on stdin and return bounded JSON", async () => {
  let observed = false;
  const runner = childRunner("let body=''; process.stdin.on('data', x => body += x); process.stdin.on('end', () => { const input=JSON.parse(body); process.stderr.write('private-stderr-must-stay-local'); process.stdout.write(JSON.stringify({ok:true,data:{op:input.op,bytes:Buffer.byteLength(body)}})); });", (_child, command, args) => {
    observed = true;
    assert.equal(typeof command, "string");
    assert.equal(args.length, 1);
    assert.ok(args[0].endsWith("integrations/p115_resolver/main.py"));
    assert.equal(JSON.stringify(args).includes("owned-fixture-cookie"), false);
    assert.equal(JSON.stringify(args).includes("AB12"), false);
  });
  const reply = await runner({ op: "list", shareCode: "SWfixture", receiveCode: "AB12", cookie: "owned-fixture-cookie", parentId: "0", offset: 0 }) as any;
  assert.equal(observed, true);
  assert.equal(reply.data.op, "list");
  assert.equal(JSON.stringify(reply).includes("private-stderr"), false);
  assert.ok(reply.data.bytes > 50);
});

test("owned helper cancellation, timeout and output overflow wait for child close", async (t) => {
  for (const mode of ["cancel", "timeout", "overflow"] as const) {
    let closed = false;
    const runner = childRunner(mode === "overflow" ? "process.stdout.write('x'.repeat(256*1024+1)); setInterval(()=>{}, 1000);" : "setInterval(()=>{}, 1000);", (child) => child.once("close", () => { closed = true; }));
    const controller = new AbortController();
    if (mode === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
    const work = runner({ op: "health" }, controller.signal);
    if (mode === "cancel") controller.abort();
    if (mode === "timeout") t.mock.timers.tick(25_000);
    await assert.rejects(work, mode === "overflow" ? /输出过大/ : { name: mode === "cancel" ? "AbortError" : "TimeoutError" });
    assert.equal(closed, true);
    if (mode === "timeout") t.mock.timers.reset();
  }
  let spawned = false;
  const runner = createShareHelperRunner((() => { spawned = true; throw new Error("must not spawn"); }) as typeof spawn);
  await assert.rejects(runner({ op: "health", cookie: "x".repeat(64 * 1024) }), /输入过大/);
  assert.equal(spawned, false);
});

test("legacy 115 vault records keep their original opaque refs, cursor keys and resume content identity", async (t) => {
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const inputs: ShareHelperInput[] = [];
  const { store, shares } = fixture(t, async (input) => {
    inputs.push(input);
    return input.op === "list" ? listing() : { ok: true, data: { url: "https://download.invalid/legacy", name: file.name, size: file.size, sha1: SHA1, headers: { "User-Agent": "Mozilla/5.0" } } };
  });
  const shareCode = "SWlegacy";
  const shareId = hash(["p115", "share", shareCode]);
  const savedShare = { kind: "share", shareCode, receiveCode: "AB12" };
  const savedFile = { kind: "file", shareId, fileId: file.id, name: file.name, size: file.size, sha1: SHA1 };
  const fileId = hash(["p115", shareCode, savedFile]);
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  store.putPrivate(KIND, shareId, savedShare, expiresAt);
  store.putPrivate(KIND, fileId, savedFile, expiresAt);
  const resolved = await shares.resolve(`mori-share:${fileId}`);
  assert.equal(resolved.contentId, `p115:${hash([shareCode, file.id, { name: file.name, size: file.size, sha1: SHA1 }])}`);
  assert.deepEqual(store.privateRecord(KIND, fileId), savedFile);
  assert.deepEqual(store.privateRecord(KIND, shareId), savedShare);
  const directory = shares.directory(`mori-share:${shareId}`);
  const key = store.privateId(["share-directory", shareId, "0"]);
  assert.equal(directory.reference, `mori-share:${key}`);
  const next = { kind: "folder", shareId, parentId: "0", name: "115 分享根目录", offset: 20, parents: [] };
  const nextId = hash(["p115", shareCode, next]);
  store.putPrivate(KIND, nextId, next, expiresAt);
  const cursor = { version: 1 as const, root: directory.reference, frontier: [{ reference: `mori-share:${nextId}`, directoryKey: key, depth: 0 }], visited: [key], pages: 1, entries: 20 };
  const page = await shares.scan(directory.reference, cursor);
  assert.equal(page.complete, true);
  assert.equal(page.files[0].resource.url, `mori-share:${fileId}`);
  assert.equal(inputs.at(-1)!.offset, 20);
  assert.equal(inputs.at(-1)!.receiveCode, "AB12");
  assert.equal(inputs.at(-1)!.cookie, "local-fixture-cookie");
});

test("Shares close kills its owned helper and waits for the child close event", async (t) => {
  let childClosed = false;
  const runner = childRunner("setInterval(()=>{},1000);", (child) => child.once("close", () => { childClosed = true; }));
  const { shares } = fixture(t, runner);
  const work = shares.testConnection();
  const rejected = assert.rejects(work, { name: "AbortError" });
  await shares.close();
  await rejected;
  assert.equal(childClosed, true);
  await assert.rejects(shares.testConnection(), { code: "closed" });
});
