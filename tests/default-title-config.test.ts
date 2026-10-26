import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store, defaults, publicConfig, validateConfig } from "../server/store.js";
import type { AppConfig } from "../shared/types.js";

test("bare-title action defaults safely, validates exact choices and preserves old-client edits", () => {
  const cfg = defaults(path.join(os.tmpdir(), "mori-title-config"));
  assert.equal(cfg.defaultTitleAction, "search");
  for (const action of ["search", "download", "subscribe"] as const) {
    const saved = validateConfig({ defaultTitleAction: action }, cfg);
    assert.equal(saved.defaultTitleAction, action);
    assert.equal(publicConfig(saved).defaultTitleAction, action);
    const oldClient = publicConfig(saved) as Partial<AppConfig>;
    delete oldClient.defaultTitleAction;
    assert.equal(validateConfig(oldClient, saved).defaultTitleAction, action);
  }
  for (const value of ["execute", "DOWNLOAD", "", null, false, 1, {}, []])
    assert.throws(() => validateConfig({ defaultTitleAction: value }, cfg));
  const legacy = { ...cfg };
  delete (legacy as Partial<AppConfig>).defaultTitleAction;
  assert.equal(validateConfig({}, legacy).defaultTitleAction, "search");
  assert.equal(validateConfig({ defaultTitleAction: "subscribe" }, legacy).defaultTitleAction, "subscribe");
});

test("encrypted legacy configuration migrates to search and explicit preference survives restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-title-migration-"));
  let store: Store | undefined;
  try {
    store = new Store(root, path.join(root, "files"));
    const legacy = store.config();
    delete (legacy as Partial<AppConfig>).defaultTitleAction;
    store.setConfig(legacy);
    store.close();
    store = new Store(root);
    assert.equal(store.config().defaultTitleAction, "search");
    store.setConfig(validateConfig({ defaultTitleAction: "download" }, store.config()));
    store.close();
    store = new Store(root);
    assert.equal(store.config().defaultTitleAction, "download");
    store.setConfig(validateConfig({ library: { language: "en-US" } }, store.config()));
    assert.equal(store.config().defaultTitleAction, "download");
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
