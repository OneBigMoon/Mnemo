import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ALIPAN_AUTH_ID, ALIPAN_AUTH_KIND, Store, publicConfig, validateConfig } from "../server/store.js";
import type { AppConfig } from "../shared/types.js";

test("Alipan configuration preserves legacy values, encrypts credentials and atomically fences rotated sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-alipan-config-"));
  const state = path.join(root, "state");
  let store = new Store(state, path.join(root, "files"));
  let open = true;
  const token = randomUUID(), rotated = randomUUID(), access = randomUUID(), replacement = randomUUID();
  try {
    const legacy = store.config();
    delete (legacy.sources as Partial<AppConfig["sources"]>).alipanEnabled;
    delete (legacy.sources as Partial<AppConfig["sources"]>).alipanRefreshToken;
    store.setConfig(legacy);
    assert.equal(store.config().sources.alipanEnabled, false);
    assert.equal(store.config().sources.alipanRefreshToken, "");

    store.setConfig(validateConfig({ sources: { alipanEnabled: true, alipanRefreshToken: token } }, store.config()));
    const session = { phase: "ready", fingerprint: store.privateId(["alipan-config", token]), refreshToken: rotated, accessToken: access };
    store.putPrivate(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID, session, new Date(Date.now() + 86400000).toISOString());
    store.setConfig(validateConfig({ model: { model: "fixture-model" }, sources: { alipanRefreshToken: "" } }, store.config()));
    assert.equal(store.config().sources.alipanRefreshToken, token);
    assert.deepEqual(store.privateRecord(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID), session);
    store.setConfig(validateConfig({ sources: { alipanEnabled: false } }, store.config()));
    assert.deepEqual(store.privateRecord(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID), session, "temporarily disabling a source retains its encrypted account");
    const view = publicConfig(store.config());
    assert.equal(view.sources.alipanRefreshToken, "");
    assert.equal(view.secretStatus["sources.alipanRefreshToken"], true);
    assert.ok(!JSON.stringify(view).includes(token));

    assert.throws(() => store.transaction(() => {
      store.setConfig(validateConfig({ sources: { alipanRefreshToken: replacement } }, store.config()));
      throw new Error("fixture rollback");
    }), /fixture rollback/);
    assert.equal(store.config().sources.alipanRefreshToken, token);
    assert.deepEqual(store.privateRecord(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID), session);

    store.close();
    open = false;
    const database = await readFile(path.join(state, "mori.sqlite"));
    for (const secret of [token, rotated, access]) assert.equal(database.includes(Buffer.from(secret)), false);
    store = new Store(state, path.join(root, "files"));
    open = true;
    assert.equal(store.config().sources.alipanRefreshToken, token);
    assert.deepEqual(store.privateRecord(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID), session);

    store.setConfig(validateConfig({ sources: { alipanRefreshToken: replacement } }, store.config()));
    assert.equal(store.privateRecord(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID), undefined);
    store.putPrivate(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID, session, new Date(Date.now() + 86400000).toISOString());
    store.setConfig(validateConfig({ clearSecrets: ["sources.alipanRefreshToken"] }, store.config()));
    assert.equal(store.config().sources.alipanRefreshToken, "");
    assert.equal(store.privateRecord(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID), undefined);
    assert.equal(publicConfig(store.config()).secretStatus["sources.alipanRefreshToken"], false);

    assert.throws(() => validateConfig({ sources: { alipanEnabled: "yes" } }, store.config()));
    for (const value of ["value with space", "value\ninside", "中文凭据", "x".repeat(4097)])
      assert.throws(() => validateConfig({ sources: { alipanRefreshToken: value } }, store.config()));
  } finally {
    if (open) store.close();
    await rm(root, { recursive: true, force: true });
  }
});
