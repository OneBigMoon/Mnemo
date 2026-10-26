// Local-only UI fixture: no real accounts, provider calls, downloads, or messages.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";
import type { MediaService } from "../shared/types.js";

delete process.env.MORI_PANSOU_URL;
const root = await mkdtemp(path.join(os.tmpdir(), "mori-title-action-qa-"));
const evidencePath = path.resolve("output/playwright/title-action-fixture.json");
await mkdir(path.dirname(evidencePath), { recursive: true });
const calls = { search: [] as string[], identify: 0, download: 0, connectionTest: 0 };
const media: MediaService = {
  search: async (query) => { calls.search.push(query); return []; },
  identify: async () => { calls.identify++; return []; },
  download: async () => { calls.download++; throw new Error("UI QA must not start a download"); },
  scrape: async () => ({ files: [], warnings: [] }),
  testConnection: async () => { calls.connectionTest++; return { ok: true, message: "Isolated fake provider" }; },
};
const instance = createApp({
  dataDirectory: path.join(root, "state"),
  downloadDirectory: path.join(root, "files"),
  testMode: true,
  startBackground: false,
  media,
});
instance.store.setup("Mori-title-action-qa-local-only");
assert.equal(instance.store.config().defaultTitleAction, "search");
const evidence: Record<string, unknown> = {
  isolated: true,
  testMode: true,
  startBackground: false,
  initialDefaultTitleAction: "search",
  startedAt: new Date().toISOString(),
  realProviderCalls: 0,
  realMessagesSent: 0,
};
async function saveEvidence() {
  Object.assign(evidence, {
    defaultTitleAction: instance.store.config().defaultTitleAction,
    setupComplete: instance.store.config().setupComplete,
    tasks: instance.queue.tasks().length,
    subscriptions: instance.queue.subscriptions().length,
    fixtureCalls: calls,
  });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
}
instance.app.post("/__title_action_fixture/evidence", async (_req, res) => {
  await saveEvidence(); res.json(evidence);
});
instance.app.post("/__title_action_fixture/stop", (_req, res) => {
  res.json({ ok: true }); setImmediate(() => void close());
});
const server = instance.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const config = instance.store.config();
config.library.artwork = false;
config.sources.pansouUrl = `${base}/fixture-only/search`;
instance.store.setConfig(config);
Object.assign(evidence, { base });
await saveEvidence();
console.log(JSON.stringify({ ready: true, base, testMode: true, startBackground: false }));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  evidence.closedAt = new Date().toISOString();
  await saveEvidence();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await instance.close();
  assert.ok(path.basename(root).startsWith("mori-title-action-qa-"));
  await rm(root, { recursive: true, force: true });
  console.log("Isolated title-action fixture stopped and temporary state removed.");
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
