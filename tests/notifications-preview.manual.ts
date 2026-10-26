// Isolated local UI fixture. No provider transport, user data, or real credentials.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";
import type { MediaService, NotificationDestination } from "../shared/types.js";

delete process.env.MORI_PANSOU_URL;
const root = await mkdtemp(path.join(os.tmpdir(), "mori-notification-qa-"));
const files = path.join(root, "files");
await mkdir(files, { recursive: true });
const evidencePath = path.resolve("output/playwright/notifications-fixture.json");
await mkdir(path.dirname(evidencePath), { recursive: true });
const bytes = Buffer.from("Mori isolated notification QA bytes. No real media or accounts.\n");
let downloads = 0;
const media: MediaService = {
  search: async () => [],
  identify: async () => [],
  testConnection: async () => ({ ok: true, message: "Isolated fake transport" }),
  download: async (task, signal, progress) => {
    signal.throwIfAborted();
    const file = path.join(files, `${task.id}.mp4`);
    await writeFile(file, bytes);
    downloads++;
    progress({ bytes: bytes.length, total: bytes.length, progress: 100 });
    return file;
  },
  scrape: async () => ({ files: [], warnings: [] }),
};
const instance = createApp({
  dataDirectory: path.join(root, "state"),
  downloadDirectory: files,
  startBackground: false,
  testMode: true,
  media,
});
instance.store.setup("Mori-notification-qa-local-only");
const config = instance.store.config();
config.setupComplete = true;
config.library.artwork = false;
instance.store.setConfig(config);
let seeded = false;
let closing = false;
let base = "";
const evidence: Record<string, unknown> = {
  isolated: true,
  testMode: true,
  background: false,
  realProviderCalls: 0,
  realMessagesSent: 0,
  fixtureBytes: bytes.length,
  fixtureSha256: createHash("sha256").update(bytes).digest("hex"),
  startedAt: new Date().toISOString(),
};
async function saveEvidence() {
  const notifications = instance.queue.notifications.list();
  Object.assign(evidence, {
    downloads,
    notifications: notifications.map(({ id, taskId, destination, status }) => ({
      id, taskId, channel: destination.platform, status,
    })),
  });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
}
async function seed() {
  if (seeded) return;
  seeded = true;
  const samples: {
    title: string;
    destination: NotificationDestination;
    outcome?: "unknown" | "rejected" | "delivered";
  }[] = [
    { title: "站内未读样例", destination: { platform: "web", peer: "admin" } },
    { title: "TG结果未知样例", destination: { platform: "telegram", botId: "12345", peer: "-10042" }, outcome: "unknown" },
    { title: "QQ结果未知样例", destination: { platform: "qq", peer: "fixture:FriendMessage:42" }, outcome: "unknown" },
    { title: "QQ拒绝样例", destination: { platform: "qq", peer: "fixture:GroupMessage:43" }, outcome: "rejected" },
    { title: "QQ送达样例", destination: { platform: "qq", peer: "fixture:GroupMessage:44" }, outcome: "delivered" },
  ];
  for (const [index, sample] of samples.entries()) {
    const task = instance.queue.add({
      title: sample.title,
      url: `${base}/fixture-only/${index}.mp4`,
      kind: "direct",
      media: { type: "movie", title: sample.title, year: 2026 },
    }, sample.destination);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (instance.queue.tasks().find((item) => item.id === task.id)?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const finished = instance.queue.tasks().find((item) => item.id === task.id);
    assert.equal(finished?.status, "completed");
    assert.deepEqual(await readFile(finished!.path!), bytes);
    if (sample.outcome) {
      const [claim] = instance.queue.notifications.claim(sample.destination);
      assert.ok(claim);
      instance.queue.notifications.acknowledge(sample.destination, claim.id, claim.claimToken, sample.outcome, "isolated-fake-ack");
    }
  }
  // A reservation is intentionally not a message and must stay absent from UI.
  instance.queue.add({ title: "预留不是通知样例", url: `${base}/fixture-only/share`, kind: "share" });
  await saveEvidence();
}
instance.app.post("/__notification_fixture/seed", async (_req, res) => {
  try { await seed(); res.json({ ok: true }); }
  catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : "Fixture seed failed" }); }
});
instance.app.post("/__notification_fixture/evidence", async (_req, res) => {
  await saveEvidence(); res.json({ ok: true });
});
instance.app.post("/__notification_fixture/stop", (_req, res) => {
  res.json({ ok: true }); setImmediate(() => void close());
});
const server = instance.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
Object.assign(evidence, { base });
await saveEvidence();
console.log(JSON.stringify({ ready: true, base, testMode: true, background: false }));
async function close() {
  if (closing) return;
  closing = true;
  evidence.closedAt = new Date().toISOString();
  await saveEvidence();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await instance.close();
  assert.ok(path.basename(root).startsWith("mori-notification-qa-"));
  await rm(root, { recursive: true, force: true });
  console.log("Isolated notification fixture stopped and temporary state removed.");
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
