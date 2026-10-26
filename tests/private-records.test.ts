import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store, publicConfig, validateConfig } from "../server/store.js";

test("protected records share the encrypted envelope without exposing values in record metadata or SQLite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-private-records-"));
  let store: Store | undefined;
  const value = { receiveCode: "A7z9", fixture: randomUUID() + randomUUID() };
  try {
    store = new Store(root, path.join(root, "files"));
    const privateId = store.privateId(value);
    assert.match(privateId, /^[a-f0-9]{64}$/);
    assert.equal(store.privateId(value), privateId);
    const other = new Store(path.join(root, "other"));
    assert.notEqual(other.privateId(value), privateId);
    other.close();
    store.putPrivate("share-reference", "fixture", value, "2099-01-01T00:00:00Z");
    const metadata = store.record<any>("share-reference", "fixture")!;
    assert.deepEqual(Object.keys(metadata).sort(), ["expiresAt", "id", "sealed"]);
    assert.ok(!JSON.stringify(metadata).includes(value.fixture));
    assert.deepEqual(store.privateRecord("share-reference", "fixture"), value);
    assert.equal(store.privateRecord("share-reference", "missing"), undefined);
    assert.throws(() => store!.transaction(() => {
      store!.putPrivate("share-reference", "rolled-back", value, "2099-01-01T00:00:00Z");
      throw new Error("fixture rollback");
    }));
    assert.equal(store.privateRecord("share-reference", "rolled-back"), undefined);
    store.close();
    store = undefined;
    assert.ok(!(await readFile(path.join(root, "mori.sqlite"))).includes(Buffer.from(value.fixture)));
    store = new Store(root);
    assert.equal(store.privateId(value), privateId);
    assert.deepEqual(store.privateRecord("share-reference", "fixture"), value);
    const envelope = JSON.parse(metadata.sealed);
    envelope.tag = envelope.tag[0] === "0" ? "1" + envelope.tag.slice(1) : "0" + envelope.tag.slice(1);
    store.put("share-reference", { ...metadata, sealed: JSON.stringify(envelope) });
    assert.throws(() => store!.privateRecord("share-reference", "fixture"));
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("115 configuration defaults are compatible and cookie edits preserve secret semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-115-config-"));
  const store = new Store(root, path.join(root, "files"));
  try {
    const legacy = store.config();
    delete (legacy.sources as any).p115Enabled;
    delete (legacy.sources as any).p115Cookie;
    store.setConfig(legacy);
    assert.equal(store.config().sources.p115Enabled, false);
    assert.equal(store.config().sources.p115Cookie, "");
    const configured = validateConfig({ sources: { p115Enabled: true, p115Cookie: "UID=fixture; CID=fixture" } }, legacy);
    assert.equal(configured.sources.p115Enabled, true);
    const view = publicConfig(configured);
    assert.equal(view.sources.p115Cookie, "");
    assert.equal(view.secretStatus["sources.p115Cookie"], true);
    assert.equal(validateConfig(view, configured).sources.p115Cookie, configured.sources.p115Cookie);
    assert.equal(validateConfig({ clearSecrets: ["sources.p115Cookie"] }, configured).sources.p115Cookie, "");
    assert.throws(() => validateConfig({ sources: { p115Enabled: "yes" } }, configured));
    assert.throws(() => validateConfig({ sources: { p115Cookie: "fixture\r\nheader" } }, configured));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
