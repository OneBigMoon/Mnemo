import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";
import type { DownloadTask, MediaService } from "../shared/types.js";

test("completed downloads stream with byte ranges and stay inside the download root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-playback-"));
  const downloadDirectory = path.join(root, "downloads");
  await mkdir(downloadDirectory, { recursive: true });
  const payload = Buffer.from(
    "0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  );
  let mediaFile = "";
  const media: MediaService = {
    search: async () => [],
    identify: async () => [],
    download: async () => {
      const folder = path.join(downloadDirectory, "Fixture Film (2026)");
      await mkdir(folder, { recursive: true });
      mediaFile = path.join(folder, "Fixture Film (2026).mp4");
      await writeFile(mediaFile, payload);
      return mediaFile;
    },
    scrape: async () => ({ files: [], warnings: [] }),
    testConnection: async () => ({ ok: true, message: "fixture" }),
  };
  const instance = createApp({
    dataDirectory: path.join(root, "data"),
    downloadDirectory,
    media,
    startBackground: false,
    testMode: true,
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  let cookie = "";
  const request = (route: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + route, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const setup = await request("/api/setup", "POST", {
      password: "playback-fixture-password",
    });
    assert.equal(setup.status, 200);
    cookie = setup.headers.get("set-cookie")!.split(";")[0];

    const created = await request("/api/tasks", "POST", {
      title: "Fixture Film",
      url: "https://example.invalid/fixture.mp4",
      kind: "direct",
      media: { title: "Fixture Film", year: 2026, type: "movie" },
    });
    assert.equal(created.status, 201);
    const id = ((await created.json()) as any).task.id as string;
    let task: DownloadTask | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      const listing = (await (await request("/api/tasks")).json()) as { tasks: DownloadTask[] };
      task = listing.tasks.find((item) => item.id === id);
      if (["completed", "failed"].includes(task?.status || "")) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(task?.status, "completed", task?.error);
    assert.equal(task?.downloadRoot, downloadDirectory);

    assert.equal((await fetch(`${base}/api/tasks/${id}/stream`)).status, 401);

    const full = await request(`/api/tasks/${id}/stream`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "video/mp4");
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(full.headers.get("content-length"), String(payload.length));
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), payload);

    const partial = await request(`/api/tasks/${id}/stream`, "GET", undefined, {
      range: "bytes=3-7",
    });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), `bytes 3-7/${payload.length}`);
    assert.equal(partial.headers.get("content-length"), "5");
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), payload.subarray(3, 8));

    const openEnded = await request(`/api/tasks/${id}/stream`, "GET", undefined, {
      range: `bytes=${payload.length - 4}-`,
    });
    assert.equal(openEnded.status, 206);
    assert.deepEqual(Buffer.from(await openEnded.arrayBuffer()), payload.subarray(payload.length - 4));

    const suffix = await request(`/api/tasks/${id}/stream`, "GET", undefined, {
      range: "bytes=-6",
    });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), payload.subarray(payload.length - 6));

    const clamped = await request(`/api/tasks/${id}/stream`, "GET", undefined, {
      range: "bytes=10-99999",
    });
    assert.equal(clamped.status, 206);
    assert.equal(clamped.headers.get("content-range"), `bytes 10-${payload.length - 1}/${payload.length}`);
    assert.equal((await clamped.arrayBuffer()).byteLength, payload.length - 10);

    for (const invalid of ["bytes=99999-", "bytes=0-1,3-4", "bytes=4-2", "items=0-1"]) {
      const rejected = await request(`/api/tasks/${id}/stream`, "GET", undefined, {
        range: invalid,
      });
      assert.equal(rejected.status, 416, invalid);
      assert.equal(rejected.headers.get("content-range"), `bytes */${payload.length}`);
    }

    const head = await request(`/api/tasks/${id}/stream`, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(payload.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const pending = await request("/api/tasks/not-ready/stream");
    assert.equal(pending.status, 404);

    const queued = instance.queue.tasks().find((item) => item.id === id)!;
    instance.store.put<DownloadTask>("task", {
      ...queued,
      id: "queued-fixture",
      path: undefined,
      status: "downloading",
    });
    assert.equal((await request("/api/tasks/queued-fixture/stream")).status, 409);

    const outsideFile = path.join(root, "outside.mp4");
    await writeFile(outsideFile, payload);
    instance.store.put<DownloadTask>("task", {
      ...queued,
      id: "outside-fixture",
      path: outsideFile,
      downloadRoot: downloadDirectory,
    });
    assert.equal((await request("/api/tasks/outside-fixture/stream")).status, 404);

    const linkPath = path.join(downloadDirectory, "linked.mp4");
    await symlink(outsideFile, linkPath);
    instance.store.put<DownloadTask>("task", {
      ...queued,
      id: "symlink-fixture",
      path: linkPath,
      downloadRoot: downloadDirectory,
    });
    assert.equal((await request("/api/tasks/symlink-fixture/stream")).status, 404);

    await rm(mediaFile);
    assert.equal((await request(`/api/tasks/${id}/stream`)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await instance.close();
    await rm(root, { recursive: true, force: true });
  }
});
