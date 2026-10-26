// Explicit opt-in: only an owned temporary Emby instance and generated media fixture.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { createApp } from "../server/index.js";
import { listLibraryUsers } from "../server/library.js";

const root = path.resolve(process.argv[2] || "");
assert.ok(
  path.basename(root).startsWith("mori-library-e2e-"),
  "Only use the isolated fixture root",
);
const session = JSON.parse(
  await readFile(path.join(root, "session.json"), "utf8"),
);
assert.equal(
  new URL(session.base).hostname,
  "127.0.0.1",
  "Only a loopback test server is allowed",
);
const content = await readFile(path.join(root, "fixture-source.mp4"));
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const source = createServer((req, res) => {
  if (req.url !== "/fixture.mp4") {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Content-Length": content.length,
  });
  res.end(content);
});
source.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => source.once("listening", resolve));
const instance = createApp({
  dataDirectory: path.join(root, "mori-state"),
  downloadDirectory: path.join(root, "media"),
  startBackground: false,
});
let receipt: Record<string, unknown>;
try {
  const config = instance.store.config();
  config.library = {
    ...config.library,
    profile: "emby",
    serverUrl: session.base,
    serverToken: session.token,
    userId: session.userId,
    pathFrom: path.join(root, "media"),
    pathTo: "/library",
    artwork: false,
  };
  instance.store.setConfig(config);
  const users = await listLibraryUsers(config);
  assert.ok(
    users.some((user) => user.id === session.userId),
    "The configured playback account must exist",
  );
  const task = instance.queue.add({
    title: "Mori Playback Fixture",
    url: `http://127.0.0.1:${(source.address() as any).port}/fixture.mp4`,
    kind: "direct",
    media: {
      type: "movie",
      title: "Mori Playback Fixture",
      year: 2026,
      overview: "A self-generated integration-test video.",
    },
  });
  const deadline = Date.now() + 60000;
  while (
    instance.queue.isBusy() ||
    instance.queue.tasks().find((x) => x.id === task.id)?.status === "queued"
  ) {
    assert.ok(Date.now() < deadline, "Pipeline exceeded its deadline");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  let completed = instance.queue.tasks().find((x) => x.id === task.id)!;
  assert.equal(completed.status, "completed", completed.error);
  assert.equal(digest(await readFile(completed.path!)), digest(content));
  for (
    let attempt = 0;
    completed.library?.status === "pending" && attempt < 2;
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 3000));
    completed = await instance.queue.verifyLibrary(completed.id);
  }
  assert.equal(
    completed.library?.status,
    "verified",
    completed.library?.message,
  );
  const url = new URL(
    session.base +
      "/Videos/" +
      encodeURIComponent(completed.library!.itemId!) +
      "/stream",
  );
  url.search = new URLSearchParams({
    Static: "true",
    Container: "mp4",
  }).toString();
  const response = await fetch(url, {
    headers: { "X-Emby-Token": session.token },
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  assert.equal(response.status, 200, "Actual media stream must be accessible");
  const streamed = Buffer.from(await response.arrayBuffer());
  assert.equal(
    digest(streamed),
    digest(content),
    "Served media must match downloaded bytes",
  );
  await writeFile(path.join(root, "served.mp4"), streamed, { flag: "wx" });
  const info = (await (
    await fetch(session.base + "/System/Info/Public")
  ).json()) as any;
  receipt = {
    at: new Date().toISOString(),
    server: "Emby",
    version: info.Version,
    fixture: "self-generated three-second video",
    bytes: content.length,
    sha256: digest(content),
    downloaded: true,
    metadataWritten: true,
    library: completed.library,
    streamedBytesMatch: true,
    accountListed: true,
    scope: "Isolated server; no physical NAS or real provider accounts",
  };
  await writeFile(
    path.join(root, "receipt.json"),
    JSON.stringify(receipt, null, 2),
    { flag: "wx" },
  );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await instance.close();
  source.closeAllConnections();
  await new Promise<void>((resolve) => source.close(() => resolve()));
}
