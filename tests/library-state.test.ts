import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.js";
import { Queue } from "../server/queue.js";
import { syncLibrary } from "../server/library.js";
import type { DownloadTask, MediaService } from "../shared/types.js";

test("library evidence is bound to target configuration, including changes during verification", async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "mori-library-state-")),
  );
  const file = path.join(root, "movie.mp4");
  await writeFile(file, Buffer.alloc(64, 7));
  const store = new Store(path.join(root, "state"), root);
  let gate: Promise<void> | undefined;
  let entered = () => {};
  const server = createServer(async (req, res) => {
    if (req.url === "/Library/Refresh") {
      res.writeHead(204).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url!.startsWith("/Items?")) {
      entered();
      if (gate) await gate;
      res.end(
        JSON.stringify({
          Items: [
            {
              Id: "movie",
              Type: "Movie",
              Path: file,
              ProductionYear: 2026,
              LocationType: "FileSystem",
            },
          ],
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        MediaSources: [
          {
            Id: "source",
            Path: file,
            Protocol: "File",
            Size: 64,
            RunTimeTicks: 30000000,
            SupportsDirectPlay: true,
            MediaStreams: [{ Type: "Video", Codec: "h264" }],
          },
        ],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const cfg = store.config();
  cfg.library = {
    ...cfg.library,
    profile: "jellyfin",
    serverUrl: `http://127.0.0.1:${(server.address() as any).port}`,
    serverToken: "isolated-test-only",
  };
  store.setConfig(cfg);
  const record: DownloadTask = {
    id: "fixture",
    title: "Fixture",
    url: "https://fixture.invalid/file.mp4",
    kind: "direct",
    status: "completed",
    progress: 100,
    bytes: 64,
    total: 64,
    media: { type: "movie", title: "Fixture", year: 2026 },
    profile: "jellyfin",
    path: file,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.put("task", record);
  const queue = new Queue(store, {} as MediaService);
  try {
    const first = await queue.verifyLibrary(record.id);
    assert.equal(first.library?.status, "verified");
    assert.ok(first.library?.targetId);
    assert.equal(queue.tasks()[0].library?.status, "verified");
    store.setConfig({
      ...cfg,
      library: { ...cfg.library, userId: "another-user" },
    });
    assert.equal(queue.tasks()[0].library?.status, "pending");
    assert.equal(queue.tasks()[0].library?.playable, false);
    store.setConfig(cfg);
    let release!: () => void;
    gate = new Promise((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const pending = queue.verifyLibrary(record.id);
    await started;
    store.setConfig({
      ...cfg,
      library: { ...cfg.library, serverUrl: "http://different.invalid" },
    });
    release();
    const outdated = await pending;
    assert.equal(outdated.library?.status, "pending");
    assert.equal(outdated.library?.playable, false);
    assert.match(outdated.library!.message, /配置已变更/);
  } finally {
    await queue.stop();
    store.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "POSIX backslashes cannot escape a Windows media-library mapping",
  { skip: process.platform === "win32" },
  async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "mori-windows-map-")),
    );
    const store = new Store(path.join(root, "state"), root);
    try {
      const folder = path.join(root, "..\\outside");
      await mkdir(folder);
      const file = path.join(folder, "movie.mp4");
      await writeFile(file, "fixture");
      const cfg = store.config();
      cfg.download.directory = folder;
      cfg.library = {
        ...cfg.library,
        profile: "jellyfin",
        serverUrl: "http://127.0.0.1:1",
        serverToken: "fixture-only",
        pathFrom: root,
        pathTo: "C:\\Media",
      };
      const record: DownloadTask = {
        id: "fixture",
        title: "Fixture",
        url: "https://fixture.invalid/a.mp4",
        kind: "direct",
        status: "completed",
        progress: 100,
        bytes: 7,
        total: 7,
        media: { type: "movie", title: "Fixture" },
        profile: "jellyfin",
        path: file,
        createdAt: "",
        updatedAt: "",
      };
      const result = await syncLibrary(cfg, record);
      assert.equal(result.status, "failed");
      assert.match(result.message, /映射后超出/);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
