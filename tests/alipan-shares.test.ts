import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.js";
import { Shares, type ShareHelperInput, type ShareHelperRunner } from "../server/shares.js";
import type { DownloadTask, SearchResult } from "../shared/types.js";

const KIND = "share-reference";
const PREFIX = "mori-share:";
const SHARE = "AlipanFixture10";
const CODE = "C7d9";
const REFRESH = "synthetic-fixture-refresh";
const DRIVE = "fixture-share-drive";
const FILE_ID = "abcdef0123456789abcdef0123456789";
const FOLDER_ID = "fedcba9876543210fedcba9876543210";
type Page = { marker: string; index: number };
type Entry = { id: string; name: string; directory: boolean; size: number; driveId?: string; updatedAt?: string };
type ListInput = { shareCode: string; receiveCode: string; parentId: string; page?: Page };
type ListResult = { entries: Entry[]; next?: Page };
type LinkInput = { shareCode: string; receiveCode: string; fileId: string; driveId: string };
type Adapter = {
  authorize(signal?: AbortSignal): Promise<void>;
  list(input: ListInput, signal?: AbortSignal): Promise<ListResult>;
  link(input: LinkInput, signal?: AbortSignal): Promise<{ url: string }>;
  testConnection(signal?: AbortSignal): Promise<{ ok: boolean; message: string }>;
  close?(): Promise<void>;
};
const file: Entry = { id: FILE_ID, name: "Fixture.S01E01.mkv", directory: false, size: 1234, driveId: DRIVE, updatedAt: "2026-10-24T00:00:00.000Z" };
const folder: Entry = { id: FOLDER_ID, name: "Fixture", directory: true, size: 0 };
const source = (url = `https://www.alipan.com/s/${SHARE}?pwd=${CODE}`, extra: Partial<SearchResult> = {}): SearchResult => ({
  id: "fixture-source", title: "Fixture", source: "fixture", kind: "share", url, ...extra,
});
function referenceId(reference: string) { return reference.slice(PREFIX.length); }
function privateRecord(store: Store, reference: string) { return store.privateRecord<any>(KIND, referenceId(reference)); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(t: TestContext, overrides: Partial<Adapter> = {}, options: { enabled?: boolean; token?: string; runner?: ShareHelperRunner } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mori-alipan-shares-"));
  const store = new Store(path.join(directory, "state"), path.join(directory, "files"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const config = store.config();
  config.sources.alipanEnabled = options.enabled ?? true;
  config.sources.alipanRefreshToken = options.token ?? REFRESH;
  config.sources.p115Enabled = true;
  config.sources.p115Cookie = "synthetic-fixture-cookie";
  store.setConfig(config);
  const calls = { list: [] as ListInput[], link: [] as LinkInput[], authorize: 0, health: 0, close: 0, p115: [] as ShareHelperInput[] };
  const adapter: Adapter = {
    async authorize(signal) {
      calls.authorize++;
      if (overrides.authorize) await overrides.authorize(signal);
    },
    async list(input, signal) {
      calls.list.push(structuredClone(input));
      return overrides.list ? overrides.list(input, signal) : { entries: [{ ...file }] };
    },
    async link(input, signal) {
      calls.link.push(structuredClone(input));
      return overrides.link ? overrides.link(input, signal) : { url: "https://cdn.invalid/fixture" };
    },
    async testConnection(signal) {
      calls.health++;
      return overrides.testConnection ? overrides.testConnection(signal) : { ok: true, message: "fixture adapter ready" };
    },
    async close() { calls.close++; await overrides.close?.(); },
  };
  const runner: ShareHelperRunner = async (input, signal) => {
    calls.p115.push(structuredClone(input));
    if (options.runner) return options.runner(input, signal);
    throw new Error("Alipan operations must not invoke the 115 helper");
  };
  return { store, shares: new Shares(store, runner, adapter), calls };
}

test("Alipan capture encrypts access codes while disabled and recognizes only the four share hosts", async (t) => {
  const { store, shares, calls } = fixture(t, {}, { enabled: false });
  const captured = shares.capture(source(undefined, { extractionCode: "T9u2", title: "Fixture 提取码：T9u2", source: "fixture pwd=T9u2" }));
  assert.equal(captured.provider, "alipan");
  assert.equal(captured.kind, "share");
  assert.match(captured.shareRef!, /^mori-share:[a-f0-9]{64}$/);
  assert.equal(new URL(captured.url).pathname, `/s/${SHARE}`);
  assert.equal(new URL(captured.url).search, "");
  assert.equal(new URL(captured.url).hash, "");
  assert.equal(Object.hasOwn(captured, "extractionCode"), false);
  assert.equal(privateRecord(store, captured.shareRef!).provider, "alipan");
  assert.equal(privateRecord(store, captured.shareRef!).receiveCode, "T9u2");
  for (const value of [JSON.stringify(captured), JSON.stringify(store.list(KIND))]) {
    for (const forbidden of [CODE, "T9u2", "receiveCode", REFRESH]) assert.equal(value.includes(forbidden), false);
  }
  for (const host of ["aliyundrive.com", "www.aliyundrive.com", "alipan.com", "www.alipan.com"]) {
    const alias = shares.capture(source(`https://${host}/s/${SHARE}?pwd=T9u2#private-fragment`));
    assert.equal(alias.shareRef, captured.shareRef);
    assert.equal(alias.provider, "alipan");
  }
  assert.equal(store.list(KIND).length, 1);
  await assert.rejects(shares.browse(captured.shareRef!), { code: "not_configured" });
  assert.deepEqual(calls.list, []);
  assert.deepEqual(calls.p115, []);
  const config = store.config();
  config.sources.alipanEnabled = true;
  store.setConfig(config);
  await shares.browse(captured.shareRef!);
  const lastInput = calls.list[0] as ListInput;
  assert.equal(lastInput.shareCode, SHARE);
  assert.equal(lastInput.receiveCode, "T9u2");
  assert.equal(lastInput.parentId, "0");
});

test("unsupported Alipan-like URLs and source-supplied refs cannot become playable shares", (t) => {
  const { store, shares, calls } = fixture(t);
  for (const url of [
    `https://alipan.com.evil.invalid/s/${SHARE}?pwd=${CODE}`,
    `https://evilalipan.com/s/${SHARE}?pwd=${CODE}`,
    `https://api.alipan.com/s/${SHARE}?pwd=${CODE}`,
    `https://alipan.com/drive?pwd=${CODE}`,
    `https://www.aliyundrive.com/s/${SHARE}/extra?pwd=${CODE}`,
    `https://alipan.com:8443/s/${SHARE}?pwd=${CODE}`,
  ]) {
    const captured = shares.capture(source(url, { extractionCode: CODE, shareRef: `${PREFIX}${"a".repeat(64)}`, provider: "alipan", navigation: "folder" }));
    assert.equal(captured.kind, "share");
    assert.equal(captured.shareRef, undefined);
    assert.equal(captured.provider, undefined);
    assert.equal(captured.navigation, undefined);
    assert.equal(captured.extractionCode, undefined);
    assert.equal(JSON.stringify(captured).includes(CODE), false);
  }
  const trusted = store.list<any>(KIND).map((envelope) => store.privateRecord<any>(KIND, envelope.id)).filter((record) => record.kind === "share");
  assert.deepEqual(trusted, []);
  assert.deepEqual(calls.list, []);
  assert.deepEqual(calls.p115, []);
});

test("hex IDs, residual provider pages and empty pages keep markers private and restore the parent page", async (t) => {
  const residual: Page = { marker: "", index: 20 };
  const empty: Page = { marker: "FixtureNextProviderMarker", index: 0 };
  const last: Page = { marker: "FixtureLastProviderMarker", index: 0 };
  const firstEntries = [folder, ...Array.from({ length: 19 }, (_, index) => ({ ...file, id: `aaaabbbbccccdddd${index.toString(16).padStart(16, "0")}`, name: `Fixture.${index + 1}.mkv` }))];
  const { store, shares, calls } = fixture(t, { list: async (input) => {
    if (input.parentId === FOLDER_ID) return { entries: [{ ...file, name: "Child.mkv" }] };
    assert.equal(input.parentId, "0");
    const page = input.page ?? { marker: "", index: 0 };
    if (page.marker === "" && page.index === 0) return { entries: firstEntries, next: residual };
    if (page.marker === "" && page.index === 20) return { entries: [folder, file], next: empty };
    if (page.marker === empty.marker) return { entries: [], next: last };
    assert.deepEqual(page, last);
    return { entries: [{ ...file, id: "bbbbaaaaddddcccc1111222233334444", name: "Last.mkv" }] };
  } });
  const captured = shares.capture(source());
  const canonical = shares.directory(captured.shareRef!);
  assert.equal(canonical.provider, "alipan");
  const first = await shares.browse(captured.shareRef!);
  assert.equal(first.filter((entry) => entry.navigation !== "next").length, 20);
  const firstFolder = first.find((entry) => entry.navigation === "folder")!;
  const next = first.find((entry) => entry.navigation === "next")!;
  assert.ok(firstFolder && next);
  assert.deepEqual(privateRecord(store, next.url).page, residual);
  assert.equal(shares.directory(next.url).reference, canonical.reference);
  const second = await shares.browse(next.url);
  assert.deepEqual(calls.list[1].page, residual);
  const secondFolder = second.find((entry) => entry.navigation === "folder")!;
  assert.ok(secondFolder);
  assert.deepEqual(privateRecord(store, secondFolder.url).parents.at(-1).page, residual);
  assert.equal(shares.directory(firstFolder.url).reference, shares.directory(secondFolder.url).reference);
  const children = await shares.browse(secondFolder.url);
  assert.equal(calls.list[2].parentId, FOLDER_ID);
  assert.deepEqual(calls.list[2].page ?? { marker: "", index: 0 }, { marker: "", index: 0 });
  const parent = children.find((entry) => entry.navigation === "parent")!;
  assert.ok(parent);
  const returned = await shares.browse(parent.url);
  assert.deepEqual(calls.list[3].page, residual);
  assert.deepEqual(returned.map((entry) => [entry.title, entry.navigation]), second.map((entry) => [entry.title, entry.navigation]));
  const emptyRef = second.find((entry) => entry.navigation === "next")!;
  const emptyPage = await shares.browse(emptyRef.url);
  assert.deepEqual(calls.list[4].page, empty);
  assert.equal(emptyPage.length, 1);
  assert.equal(emptyPage[0].navigation, "next");
  assert.equal(shares.directory(emptyPage[0].url).reference, canonical.reference);
  const final = await shares.browse(emptyPage[0].url);
  assert.deepEqual(calls.list[5].page, last);
  assert.equal(final.length, 1);
  assert.equal(final[0].title, "Last.mkv");
  const publicResults = JSON.stringify([first, second, children, emptyPage, final]);
  for (const forbidden of [CODE, "FixtureNextProviderMarker", "FixtureLastProviderMarker", "receiveCode", "driveId", REFRESH])
    assert.equal(publicResults.includes(forbidden), false);
  for (const entry of [...first, ...second, ...children, ...emptyPage, ...final]) {
    assert.equal(entry.provider, "alipan");
    assert.equal(entry.url, entry.shareRef);
  }
  assert.deepEqual(calls.p115, []);
});

test("Alipan scans reuse the directory frontier and retain relative directory context", async (t) => {
  const seasonId = "ccccddddaaaabbbb1111222233334444";
  const { shares, calls } = fixture(t, { list: async (input) => {
    if (input.parentId === "0") return { entries: [folder] };
    if (input.parentId === FOLDER_ID) return { entries: [file, { ...folder, id: seasonId, name: "Season 02" }] };
    assert.equal(input.parentId, seasonId);
    return { entries: [{ ...file, id: "ddddeeeeffffaaaa1111222233334444", name: "Fixture.S02E01.mkv" }] };
  } });
  const root = shares.capture(source());
  const selected = (await shares.browse(root.shareRef!))[0];
  const directory = shares.directory(selected.url);
  assert.equal(directory.provider, "alipan");
  const first = await shares.scan(directory.reference);
  assert.equal(first.complete, false);
  assert.deepEqual(first.files.map((entry) => [entry.resource.title, entry.directories]), [[file.name, [folder.name]]]);
  assert.ok(first.cursor);
  const second = await shares.scan(directory.reference, first.cursor);
  assert.equal(second.complete, true);
  assert.equal(second.cursor, undefined);
  assert.deepEqual(second.files.map((entry) => [entry.resource.title, entry.directories]), [["Fixture.S02E01.mkv", [folder.name, "Season 02"]]]);
  assert.ok([...first.files, ...second.files].every((entry) => entry.resource.provider === "alipan" && entry.resource.url === entry.resource.shareRef));
  assert.deepEqual(calls.p115, []);
});

test("anonymous Alipan browsing is allowed but scan and resolve require a configured account", async (t) => {
  const { store, shares, calls } = fixture(t, {}, { token: "" });
  const root = shares.capture(source());
  const selected = (await shares.browse(root.shareRef!))[0];
  assert.equal(calls.authorize, 0);
  await assert.rejects(shares.scan(root.shareRef!), { code: "auth_required", status: 409 });
  await assert.rejects(shares.resolve(selected.url), { code: "auth_required", status: 409 });
  assert.equal(calls.list.length, 1);
  assert.equal(calls.link.length, 0);
  assert.equal(calls.authorize, 0);
  const config = store.config();
  config.sources.alipanRefreshToken = REFRESH;
  store.setConfig(config);
  assert.equal((await shares.scan(root.shareRef!)).files.length, 1);
  assert.equal(calls.authorize, 1);
  assert.equal((await shares.resolve(selected.url)).provider, "alipan");
  assert.deepEqual(await shares.testConnection("alipan"), { ok: true, message: "fixture adapter ready" });
  assert.equal(calls.health, 1);
  assert.deepEqual(calls.p115, []);
});

test("unknown Alipan authorization prevents automated listing and candidate persistence", async (t) => {
  const { store, shares, calls } = fixture(t, { authorize: async () => {
    throw Object.assign(new Error("fixture account state is unknown"), { code: "alipan_auth_unknown", status: 409 });
  } });
  const root = shares.capture(source());
  const before = JSON.stringify(store.list(KIND));
  await assert.rejects(shares.scan(root.shareRef!), { code: "alipan_auth_unknown", status: 409 });
  assert.equal(calls.authorize, 1);
  assert.deepEqual(calls.list, []);
  assert.equal(JSON.stringify(store.list(KIND)), before);
  await shares.browse(root.shareRef!);
  assert.equal(calls.authorize, 1);
  assert.equal(calls.list.length, 1);
  assert.deepEqual(calls.p115, []);
});

test("Alipan files without their own drive ID are rejected before refs or links are created", async (t) => {
  const { driveId: _drive, ...withoutDrive } = file;
  const { store, shares, calls } = fixture(t, { list: async () => ({ entries: [withoutDrive] }) });
  const root = shares.capture(source());
  const before = JSON.stringify(store.list(KIND));
  await assert.rejects(shares.browse(root.shareRef!), { code: "upstream_error" });
  assert.equal(JSON.stringify(store.list(KIND)), before);
  await assert.rejects(shares.scan(root.shareRef!), { code: "upstream_error" });
  assert.equal(JSON.stringify(store.list(KIND)), before);
  assert.deepEqual(calls.link, []);
  assert.deepEqual(calls.p115, []);
});

test("Alipan link refresh keeps identity stable, binds updated metadata and forwards only fixed CDN headers", async (t) => {
  let selected = { ...file };
  let links = 0;
  const { store, shares, calls } = fixture(t, {
    list: async () => ({ entries: [selected] }),
    link: async () => ({ url: `https://cdn.invalid/fixture?generation=${++links}` }),
  });
  const root = shares.capture(source());
  const first = (await shares.browse(root.shareRef!))[0];
  assert.equal((await shares.browse(root.shareRef!))[0].url, first.url);
  const resolved = await shares.resolve(first.url);
  const refreshed = await shares.resolve(first.url);
  assert.equal(resolved.provider, "alipan");
  assert.equal(resolved.name, file.name);
  assert.equal(resolved.size, file.size);
  assert.equal(resolved.sha1, undefined);
  assert.match(resolved.contentId, /^alipan:/);
  assert.notEqual(resolved.url, refreshed.url);
  assert.equal(resolved.contentId, refreshed.contentId);
  assert.deepEqual(resolved.headers, { "User-Agent": "Mozilla/5.0", Referer: "https://www.alipan.com/" });
  assert.deepEqual(refreshed.headers, resolved.headers);
  assert.deepEqual(calls.link[0], { shareCode: SHARE, receiveCode: CODE, fileId: FILE_ID, driveId: DRIVE });
  selected = { ...file, updatedAt: "2026-10-24T01:00:00.000Z" };
  const changed = (await shares.browse(root.shareRef!))[0];
  assert.notEqual(changed.url, first.url);
  assert.notEqual((await shares.resolve(changed.url)).contentId, resolved.contentId);
  selected = { ...file, id: "1111222233334444aaaabbbbccccdddd", driveId: "another-fixture-share-drive" };
  const other = (await shares.browse(root.shareRef!))[0];
  await shares.resolve(other.url);
  assert.equal(calls.link.at(-1)!.driveId, selected.driveId);
  const privateRecords = store.list<any>(KIND).map((envelope) => store.privateRecord<any>(KIND, envelope.id));
  for (const forbidden of ["cdn.invalid", "generation=", "User-Agent", "Referer", "Mozilla/5.0", REFRESH, "synthetic-fixture-cookie"])
    assert.equal(JSON.stringify(privateRecords).includes(forbidden), false);
  assert.deepEqual(calls.p115, []);
});

test("cancelled Alipan listing and scanning cannot persist late entries, page markers or access code changes", async (t) => {
  for (const operation of ["browse", "scan"] as const) {
    await t.test(operation, async (t) => {
      const pending = deferred<ListResult>();
      const controller = new AbortController();
      let receivedSignal: AbortSignal | undefined;
      const { store, shares, calls } = fixture(t, { list: async (_input, signal) => {
        receivedSignal = signal;
        return pending.promise;
      } });
      t.after(() => pending.resolve({ entries: [] }));
      const root = shares.capture(source());
      const before = JSON.stringify(store.list(KIND));
      const work = operation === "browse"
        ? shares.browse(root.shareRef!, "N3w4", controller.signal)
        : shares.scan(root.shareRef!, undefined, controller.signal);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(receivedSignal);
      assert.equal(calls.list.length, 1);
      controller.abort();
      assert.equal(receivedSignal.aborted, true);
      pending.resolve({ entries: [folder, file], next: { marker: "CancelledFixtureMarker", index: 0 } });
      await assert.rejects(work, { name: "AbortError" });
      assert.equal(JSON.stringify(store.list(KIND)), before);
      assert.equal(privateRecord(store, root.shareRef!).receiveCode, CODE);
      assert.deepEqual(calls.p115, []);
    });
  }
});

test("Alipan and 115 listings share the existing two-operation concurrency limit", async (t) => {
  const aliPending = deferred<ListResult>();
  const p115Pending = deferred<unknown>();
  const { shares, calls } = fixture(t, { list: async () => aliPending.promise }, { runner: async () => p115Pending.promise });
  t.after(() => { aliPending.resolve({ entries: [] }); p115Pending.resolve({ ok: true, data: { entries: [] } }); });
  const ali = shares.capture(source());
  const p115 = shares.capture(source("https://115.com/s/SWfixture?password=AB12"));
  const first = shares.browse(ali.shareRef!);
  const second = shares.browse(p115.shareRef!);
  await assert.rejects(shares.browse(ali.shareRef!), { code: "busy", status: 429 });
  await assert.rejects(shares.browse(p115.shareRef!), { code: "busy", status: 429 });
  assert.equal(calls.list.length, 1);
  assert.equal(calls.p115.length, 1);
  aliPending.resolve({ entries: [] });
  p115Pending.resolve({ ok: true, data: { entries: [] } });
  assert.deepEqual(await Promise.all([first, second]), [[], []]);
});

test("task-pinned Alipan refs survive TTL pruning and expire after the task is removed", async (t) => {
  const { store, shares } = fixture(t);
  const root = shares.capture(source());
  const selected = (await shares.browse(root.shareRef!))[0];
  const abandoned = shares.capture(source("https://alipan.com/s/AbandonedFixture"));
  const task: DownloadTask = {
    id: "alipan-fixture-task", title: "Fixture", url: selected.url, kind: "cloud", status: "paused",
    progress: 0, bytes: 0, total: 0, profile: "emby", media: { title: "Fixture", type: "movie" },
    createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z",
  };
  store.put("task", task);
  for (const envelope of store.list<any>(KIND)) store.put(KIND, { ...envelope, expiresAt: "2000-01-01T00:00:00.000Z" });
  shares.capture(source("https://alipan.com/s/NewFixture"));
  assert.ok(store.record(KIND, referenceId(root.shareRef!)));
  assert.ok(store.record(KIND, referenceId(selected.url)));
  assert.equal(store.record(KIND, referenceId(abandoned.shareRef!)), undefined);
  assert.equal((await shares.resolve(selected.url)).name, file.name);
  store.remove("task", task.id);
  await assert.rejects(shares.resolve(selected.url), { code: "expired" });
  shares.capture(source("https://alipan.com/s/NewerFixture"));
  assert.equal(store.record(KIND, referenceId(selected.url)), undefined);
  assert.equal(store.record(KIND, referenceId(root.shareRef!)), undefined);
});

test("Alipan scan shares one 25 second deadline across authorization and listing", async (t) => {
  const authorized = deferred<void>();
  const listed = deferred<ListResult>();
  let receivedSignal: AbortSignal | undefined;
  const { store, shares, calls } = fixture(t, {
    authorize: async () => authorized.promise,
    list: async (_input, signal) => { receivedSignal = signal; return listed.promise; },
  });
  const root = shares.capture(source());
  const before = JSON.stringify(store.list(KIND));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const work = shares.scan(root.shareRef!);
  try {
    t.mock.timers.tick(20_000);
    authorized.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls.list.length, 1);
    t.mock.timers.tick(5000);
    assert.equal(receivedSignal!.aborted, true);
    listed.resolve({ entries: [file] });
    await assert.rejects(work, { name: "TimeoutError" });
    assert.equal(JSON.stringify(store.list(KIND)), before);
  } finally {
    authorized.resolve();
    listed.resolve({ entries: [] });
    await work.catch(() => {});
    t.mock.timers.reset();
  }
});

test("Shares close drains helper and token checks before provider close and rejects all new work", async (t) => {
  const helper = deferred<unknown>();
  const token = deferred<{ ok: boolean; message: string }>();
  const providerDrain = deferred<void>();
  let helperSignal: AbortSignal | undefined;
  let tokenSignal: AbortSignal | undefined;
  const { store, shares, calls } = fixture(t, {
    testConnection: async (signal) => { tokenSignal = signal; return token.promise; },
    close: async () => providerDrain.promise,
  }, { runner: async (_input, signal) => { helperSignal = signal; return helper.promise; } });
  t.after(() => { helper.resolve({ ok: true, data: { available: false, version: null } }); token.resolve({ ok: false, message: "fixture stopped" }); providerDrain.resolve(); });
  const helperWork = shares.testConnection();
  const tokenWork = shares.testConnection("alipan");
  const helperRejected = assert.rejects(helperWork, { name: "AbortError" });
  const tokenRejected = assert.rejects(tokenWork, { name: "AbortError" });
  const before = JSON.stringify(store.list(KIND));
  const closing = shares.close();
  assert.equal(shares.close(), closing);
  assert.equal(helperSignal!.aborted, true);
  assert.equal(tokenSignal!.aborted, true);
  let drained = false;
  void closing.then(() => { drained = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  assert.equal(calls.close, 0);
  await assert.rejects(shares.testConnection(), { code: "closed" });
  await assert.rejects(shares.browse(`${PREFIX}${"a".repeat(64)}`), { code: "closed" });
  assert.throws(() => shares.capture(source()), { code: "closed" });
  assert.throws(() => shares.directory(`${PREFIX}${"a".repeat(64)}`), { code: "closed" });
  helper.resolve({ ok: true, data: { available: true, version: "0.0.9.7.2" } });
  token.resolve({ ok: true, message: "fixture late token result" });
  await Promise.all([helperRejected, tokenRejected]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.close, 1);
  assert.equal(drained, false);
  providerDrain.resolve();
  await closing;
  await shares.close();
  assert.equal(drained, true);
  assert.equal(calls.close, 1);
  assert.equal(JSON.stringify(store.list(KIND)), before);
});

test("Shares close cancels an in-flight Alipan listing and cannot publish its late refs", async (t) => {
  const listed = deferred<ListResult>();
  let receivedSignal: AbortSignal | undefined;
  const { store, shares, calls } = fixture(t, { list: async (_input, signal) => { receivedSignal = signal; return listed.promise; } });
  t.after(() => listed.resolve({ entries: [] }));
  const root = shares.capture(source());
  const before = JSON.stringify(store.list(KIND));
  const work = shares.browse(root.shareRef!, "N3w4");
  const rejected = assert.rejects(work, { name: "AbortError" });
  const closing = shares.close();
  assert.equal(receivedSignal!.aborted, true);
  assert.equal(calls.close, 0);
  listed.resolve({ entries: [file, folder], next: { marker: "LateCloseMarker", index: 0 } });
  await rejected;
  await closing;
  assert.equal(calls.close, 1);
  assert.equal(JSON.stringify(store.list(KIND)), before);
  assert.equal(privateRecord(store, root.shareRef!).receiveCode, CODE);
});

test("mixed provider vault roots keep independent task pins and release only the removed task", async (t) => {
  const { store, shares } = fixture(t, {}, { runner: async () => ({ ok: true, data: { entries: [{ id: "42", name: file.name, size: file.size, directory: false }] } }) });
  const ali = shares.capture(source());
  const legacy = shares.capture(source(`https://115.com/s/${SHARE}?password=A1b2`));
  const aliFile = (await shares.browse(ali.shareRef!))[0];
  const legacyFile = (await shares.browse(legacy.shareRef!))[0];
  assert.notEqual(ali.shareRef, legacy.shareRef);
  assert.notEqual(aliFile.url, legacyFile.url);
  const base = { title: "Fixture", kind: "cloud" as const, status: "paused" as const, progress: 0, bytes: 0, total: 0, profile: "emby" as const, media: { type: "tv" as const, title: "Fixture" }, createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z" };
  store.put("task", { ...base, id: "mixed-alipan", url: aliFile.url });
  store.put("task", { ...base, id: "mixed-p115", url: legacyFile.url });
  for (const envelope of store.list<any>(KIND)) store.put(KIND, { ...envelope, expiresAt: "2000-01-01T00:00:00.000Z" });
  shares.capture(source("https://alipan.com/s/MixedPrune1"));
  for (const value of [ali.shareRef!, legacy.shareRef!, aliFile.url, legacyFile.url]) assert.ok(store.record(KIND, referenceId(value)));
  store.remove("task", "mixed-alipan");
  shares.capture(source("https://alipan.com/s/MixedPrune2"));
  for (const value of [ali.shareRef!, aliFile.url]) assert.equal(store.record(KIND, referenceId(value)), undefined);
  for (const value of [legacy.shareRef!, legacyFile.url]) assert.ok(store.record(KIND, referenceId(value)));
});
