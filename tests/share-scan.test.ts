import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.js";
import { Shares, type ShareHelperInput, type ShareHelperRunner } from "../server/shares.js";
import type { ShareDirectory, ShareScanCursor, Subscription } from "../shared/types.js";

const KIND = "share-reference";
type Entry = { id: string; name: string; directory: boolean; size: number; sha1?: string };
const file = (id: number, name = `Fixture.E${id}.mkv`): Entry => ({ id: String(id), name, directory: false, size: id * 100 });
const folder = (id: number, name: string): Entry => ({ id: String(id), name, directory: true, size: 0 });
const reference = (id: string) => `mori-share:${id}`;
const refId = (value: string) => value.slice("mori-share:".length);
const source = (url = "https://115.com/s/SWscan?password=AB12") => ({ id: "fixture", title: "Fixture", source: "fixture", kind: "share" as const, url });

function treeRunner(tree: Map<string, Entry[]>, calls: ShareHelperInput[] = []): ShareHelperRunner {
  return async (input) => {
    calls.push(input);
    assert.equal(input.op, "list");
    const entries = tree.get(input.parentId!) ?? [];
    const offset = input.offset ?? 0;
    return { ok: true, data: { entries: entries.slice(offset, offset + 100), total: entries.length, ...(offset + 100 < entries.length ? { nextOffset: offset + 100 } : {}) } };
  };
}

function fixture(t: TestContext, runner: ShareHelperRunner) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mori-share-scan-"));
  const directory = path.join(root, "state");
  const store = new Store(directory, path.join(root, "files"));
  const config = store.config();
  config.sources.p115Enabled = true;
  store.setConfig(config);
  const state = { root, directory, store, shares: new Shares(store, runner) };
  t.after(() => { state.store.close(); rmSync(root, { recursive: true, force: true }); });
  return state;
}

function subscription(share: ShareDirectory): Subscription {
  return { id: "scan-subscription", title: "Fixture", query: "Fixture", enabled: true, autoDownload: true, createdAt: "2026-10-24T00:00:00.000Z", seen: [], share };
}

test("directory canonicalizes share, folder and next references without a provider call", async (t) => {
  const calls: ShareHelperInput[] = [];
  const tree = new Map([ ["0", [folder(900, "Season 2"), ...Array.from({ length: 24 }, (_, i) => file(i + 1))]], ["900", Array.from({ length: 25 }, (_, i) => file(100 + i))] ]);
  const { store, shares } = fixture(t, treeRunner(tree, calls));
  const captured = shares.capture(source());
  const root = shares.directory(captured.shareRef!);
  assert.equal(root.title, "115 分享根目录");
  assert.equal(calls.length, 0);
  const first = await shares.browse(captured.shareRef!);
  const next = first.find((entry) => entry.navigation === "next")!;
  const season = first.find((entry) => entry.navigation === "folder")!;
  assert.deepEqual(shares.directory(next.shareRef!), root);
  const selected = shares.directory(season.shareRef!);
  const children = await shares.browse(season.shareRef!);
  assert.deepEqual(shares.directory(children.find((entry) => entry.navigation === "next")!.shareRef!), selected);
  const aliasId = store.privateId(["directory-alias-fixture"]);
  const seasonRecord = store.privateRecord<any>(KIND, refId(season.shareRef!));
  store.putPrivate(KIND, aliasId, { ...seasonRecord, offset: 20, parents: seasonRecord.parents.map((parent: any) => ({ ...parent, offset: 40 })) }, new Date(Date.now() + 86_400_000).toISOString());
  assert.equal(shares.directory(reference(aliasId)).reference, selected.reference);
  assert.equal(selected.title, "Season 2");
  assert.notEqual(root.reference, selected.reference);
  const before = calls.length;
  assert.throws(() => shares.directory(first.find((entry) => entry.kind === "cloud")!.url), { code: "invalid_reference" });
  shares.capture(source("https://pan.baidu.com/s/unsupported?pwd=AB12"));
  const access = store.list<any>(KIND).find((entry) => store.privateRecord<any>(KIND, entry.id).kind === "access-only")!;
  assert.throws(() => shares.directory(reference(access.id)), { code: "invalid_reference" });
  assert.equal(calls.length, before);
});

test("scan advances beyond twenty files and resumes the persisted cursor after a real Store reopen", async (t) => {
  const calls: ShareHelperInput[] = [];
  const tree = new Map([["0", Array.from({ length: 45 }, (_, i) => file(i + 1))]]);
  const runner = treeRunner(tree, calls);
  const state = fixture(t, runner);
  const directory = state.shares.directory(state.shares.capture(source()).shareRef!);
  const first = await state.shares.scan(directory.reference);
  assert.equal(first.files.length, 20);
  assert.equal(first.complete, false);
  assert.equal(first.cursor!.pages, 1);
  assert.equal(first.cursor!.entries, 20);
  state.store.put("subscription", { ...subscription(directory), scan: { pending: first.files, cursor: first.cursor, complete: false } });
  state.store.close();
  state.store = new Store(state.directory, path.join(state.root, "files"));
  state.shares = new Shares(state.store, runner);
  const resumed = state.store.record<Subscription>("subscription", "scan-subscription")!;
  const snapshot = JSON.stringify(resumed.scan!.cursor);
  const second = await state.shares.scan(directory.reference, resumed.scan!.cursor);
  assert.equal(JSON.stringify(resumed.scan!.cursor), snapshot);
  const third = await state.shares.scan(directory.reference, second.cursor);
  assert.deepEqual(calls.map((input) => input.offset), [0, 20, 40]);
  assert.equal(third.files.length, 5);
  assert.equal(third.complete, true);
  assert.equal(third.cursor, undefined);
  const files = [...first.files, ...second.files, ...third.files];
  assert.equal(new Set(files.map((item) => item.resource.url)).size, 45);
  assert.ok(files.every((item) => item.resource.kind === "cloud" && item.resource.url === item.resource.shareRef));
  assert.ok(files.every((item) => item.directories.length === 0));
  tree.get("0")!.push(file(46));
  const nextRound = await state.shares.scan(directory.reference);
  const nextPage = await state.shares.scan(directory.reference, nextRound.cursor);
  const lastPage = await state.shares.scan(directory.reference, nextPage.cursor);
  assert.equal(lastPage.complete, true);
  assert.ok(lastPage.files.some((item) => item.resource.title === "Fixture.E46.mkv"));
});

test("directory scans ignore parent loops and repeated physical directories instead of revisiting forever", async (t) => {
  const calls: ShareHelperInput[] = [];
  const tree = new Map([
    ["0", [folder(1, "Season 2")]],
    ["1", [folder(1, "Self"), folder(2, "Sub"), folder(2, "Duplicate Sub"), folder(3, "Other")]],
    ["2", [folder(1, "Parent Loop"), folder(3, "Duplicate Other"), file(201)]],
    ["3", [folder(2, "Duplicate Sub"), file(301)]],
  ]);
  const { shares } = fixture(t, treeRunner(tree, calls));
  const root = shares.capture(source());
  const selected = shares.directory((await shares.browse(root.shareRef!))[0].shareRef!);
  calls.length = 0;
  const first = await shares.scan(selected.reference);
  const second = await shares.scan(selected.reference, first.cursor);
  const third = await shares.scan(selected.reference, second.cursor);
  assert.deepEqual(calls.map((input) => input.parentId), ["1", "2", "3"]);
  assert.equal(third.complete, true);
  assert.deepEqual(second.files[0].directories, ["Season 2", "Sub"]);
  assert.deepEqual(third.files[0].directories, ["Season 2", "Other"]);
  assert.equal(first.cursor!.visited.length, 3);
});

test("scan schedules a discovered child before returning to a large parent next page", async (t) => {
  const calls: ShareHelperInput[] = [];
  const tree = new Map([["0", [folder(900, "Season 1"), ...Array.from({ length: 24 }, (_, i) => file(i + 1))]], ["900", [file(9001)]]]);
  const { shares } = fixture(t, treeRunner(tree, calls));
  const directory = shares.directory(shares.capture(source()).shareRef!);
  const first = await shares.scan(directory.reference);
  assert.equal(first.files.length, 19);
  assert.ok(first.files.every((item) => item.directories.length === 0));
  const second = await shares.scan(directory.reference, first.cursor);
  const third = await shares.scan(directory.reference, second.cursor);
  assert.deepEqual(calls.map((input) => [input.parentId, input.offset]), [["0", 0], ["900", 0], ["0", 20]]);
  assert.equal(second.files[0].resource.title, "Fixture.E9001.mkv");
  assert.deepEqual(second.files[0].directories, ["Season 1"]);
  assert.ok(third.files.every((item) => item.directories.length === 0));
  assert.equal(third.complete, true);
});

test("file directory context starts at the bound directory and excludes its ancestors", async (t) => {
  const tree = new Map([
    ["0", [folder(10, "Show")]], ["10", [folder(20, "Season 1")]],
    ["20", [folder(30, "Season 2")]], ["30", [file(501, "Show.E03.mkv"), folder(40, "Extras")]],
    ["40", [file(502, "Show.E04.mkv")]],
  ]);
  const { shares } = fixture(t, treeRunner(tree));
  let selected = shares.capture(source()).shareRef!;
  for (let i = 0; i < 3; i++) selected = (await shares.browse(selected))[0].shareRef!;
  const directory = shares.directory(selected);
  const first = await shares.scan(directory.reference);
  const second = await shares.scan(directory.reference, first.cursor);
  assert.deepEqual(first.files[0].directories, ["Season 2"]);
  assert.deepEqual(second.files[0].directories, ["Season 2", "Extras"]);
  assert.equal(JSON.stringify([first.files, second.files]).includes("Season 1"), false);
  assert.equal(second.complete, true);
});

test("scan enforces all traversal limits without mutating input state or silently completing", async (t) => {
  const calls: ShareHelperInput[] = [];
  const tree = new Map([["0", Array.from({ length: 21 }, (_, i) => file(i + 1))]]);
  const { store, shares } = fixture(t, treeRunner(tree, calls));
  const directory = shares.directory(shares.capture(source()).shareRef!);
  const page = await shares.scan(directory.reference);
  const base = page.cursor!;
  for (const change of [{ pages: 1024 }, { entries: 10_000 }, { frontier: [{ ...base.frontier[0], depth: 65 }] }, { visited: Array.from(new Set([base.root.slice(11), ...Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(64, "0"))])) }]) {
    const cursor = { ...structuredClone(base), ...change } as ShareScanCursor;
    const snapshot = JSON.stringify(cursor);
    const before = calls.length;
    await assert.rejects(shares.scan(directory.reference, cursor), { code: "scan_limit" });
    assert.equal(JSON.stringify(cursor), snapshot);
    assert.equal(calls.length, before);
  }
  const remaining = { ...structuredClone(base), entries: 9995 };
  const count = store.list(KIND).length;
  tree.set("0", Array.from({ length: 50 }, (_, i) => file(i + 1)));
  await assert.rejects(shares.scan(directory.reference, remaining), { code: "scan_limit" });
  assert.equal(remaining.entries, 9995);
  assert.equal(store.list(KIND).length, count);
  const shareId = store.privateRecord<any>(KIND, refId(directory.reference)).shareId;
  const parents = Array.from({ length: 64 }, (_, i) => ({ id: String(i), name: `Level ${i}`, offset: 0 }));
  const deepId = store.privateId(["deep-scan-fixture"]);
  const deep = { kind: "folder", shareId, parentId: "64", name: "Level 64", offset: 0, parents };
  store.putPrivate(KIND, deepId, deep, new Date(Date.now() + 86_400_000).toISOString());
  const key = store.privateId(["share-directory", shareId, "64"]);
  const depthCursor: ShareScanCursor = { version: 1, root: directory.reference, frontier: [{ reference: reference(deepId), directoryKey: key, depth: 64 }], visited: [...Array.from({ length: 65 }, (_, i) => store.privateId(["share-directory", shareId, String(i)]))], pages: 1, entries: 1 };
  tree.set("64", [folder(65, "Level 65")]);
  await assert.rejects(shares.scan(directory.reference, depthCursor), { code: "scan_limit" });
  const directoryCursor = { ...structuredClone(base), frontier: [{ reference: directory.reference, directoryKey: refId(directory.reference), depth: 0 }], visited: Array.from(new Set([refId(directory.reference), ...Array.from({ length: 255 }, (_, i) => i.toString(16).padStart(64, "0"))])) };
  tree.set("0", [folder(900, "Too Many Directories")]);
  await assert.rejects(shares.scan(directory.reference, directoryCursor), { code: "scan_limit" });
});

test("scan rejects forged directory keys and sibling scope, and cancellation writes no late refs", async (t) => {
  let release: ((value: unknown) => void) | undefined;
  let runnerSignal: AbortSignal | undefined;
  const { store, shares } = fixture(t, async (_input, signal) => { runnerSignal = signal; return await new Promise((resolve) => { release = resolve; }); });
  const directory = shares.directory(shares.capture(source()).shareRef!);
  const key = refId(directory.reference);
  const cursor: ShareScanCursor = { version: 1, root: directory.reference, frontier: [{ reference: directory.reference, directoryKey: key, depth: 0 }], visited: [key], pages: 0, entries: 0 };
  await assert.rejects(shares.scan(directory.reference, { ...cursor, root: reference("a".repeat(64)) }), { code: "invalid_input" });
  await assert.rejects(shares.scan(directory.reference, { ...cursor, frontier: [{ ...cursor.frontier[0], directoryKey: "b".repeat(64) }] }), { code: "invalid_input" });
  const shareId = store.privateRecord<any>(KIND, refId(directory.reference)).shareId;
  const siblings = [1, 2].map((parentId) => {
    const id = store.privateId(["sibling-scan-fixture", parentId]);
    store.putPrivate(KIND, id, { kind: "folder", shareId, parentId: String(parentId), name: `Season ${parentId}`, offset: 0, parents: [{ id: "0", name: "115 分享根目录", offset: 0 }] }, new Date(Date.now() + 86_400_000).toISOString());
    return shares.directory(reference(id));
  });
  const siblingCursor: ShareScanCursor = { version: 1, root: siblings[0].reference, frontier: [{ reference: siblings[1].reference, directoryKey: refId(siblings[1].reference), depth: 1 }], visited: siblings.map((item) => refId(item.reference)), pages: 0, entries: 0 };
  await assert.rejects(shares.scan(siblings[0].reference, siblingCursor), { code: "invalid_input" });
  assert.equal(runnerSignal, undefined);
  const snapshot = JSON.stringify(cursor);
  const before = store.list(KIND).length;
  const controller = new AbortController();
  const running = shares.scan(directory.reference, cursor, controller.signal);
  const observedSignal = runnerSignal as AbortSignal | undefined;
  assert.ok(observedSignal);
  controller.abort();
  assert.equal(observedSignal.aborted, true);
  release!({ ok: true, data: { entries: [file(1)] } });
  await assert.rejects(running, { name: "AbortError" });
  assert.equal(store.list(KIND).length, before);
  assert.equal(JSON.stringify(cursor), snapshot);
});

test("disabled subscriptions retain cursor, pending files and share access until deletion releases them", async (t) => {
  const tree = new Map([["0", [folder(900, "Season 2"), ...Array.from({ length: 24 }, (_, i) => file(i + 1))]], ["900", [file(9001)]]]);
  const { store, shares } = fixture(t, treeRunner(tree));
  const captured = shares.capture(source());
  const directory = shares.directory(captured.shareRef!);
  const page = await shares.scan(directory.reference);
  const sub: Subscription = { ...subscription(directory), enabled: false, scan: { pending: page.files, cursor: page.cursor, complete: false } };
  store.put("subscription", sub);
  const protectedRefs = new Set([directory.reference, page.cursor!.root, ...page.cursor!.frontier.map((item) => item.reference), ...page.files.flatMap((item) => [item.resource.url, item.resource.shareRef!]), captured.shareRef!]);
  for (const record of store.list<any>(KIND)) store.put(KIND, { ...record, expiresAt: "2000-01-01T00:00:00.000Z" });
  shares.capture(source("https://115.com/s/SWother"));
  for (const value of protectedRefs) assert.ok(store.record(KIND, refId(value)));
  shares.capture(source("https://115.com/s/SWscan?password=BAD1"));
  assert.equal(store.privateRecord<any>(KIND, refId(captured.shareRef!)).receiveCode, "AB12");
  const next = await shares.scan(directory.reference, page.cursor);
  assert.equal(next.files[0].resource.title, "Fixture.E9001.mkv");
  assert.equal(JSON.stringify([sub.share, sub.scan, page.files]).includes("AB12"), false);
  store.remove("subscription", sub.id);
  for (const record of store.list<any>(KIND)) store.put(KIND, { ...record, expiresAt: "2000-01-01T00:00:00.000Z" });
  shares.capture(source("https://115.com/s/SWafterdelete"));
  for (const value of protectedRefs) assert.equal(store.record(KIND, refId(value)), undefined);
});
