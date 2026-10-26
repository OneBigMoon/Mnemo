import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";
import type { MediaService } from "../shared/types.js";

test("HTTP administrator setup, auth, CSRF, safe config and validated tasks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-http-"));
  const media: MediaService = {
    search: async (q) => [
      {
        id: "fixture",
        title: q,
        url: "https://example.invalid/share",
        source: "fixture",
        kind: "share",
      },
    ],
    identify: async () => [],
    download: async () => {
      throw new Error("fixture download disabled");
    },
    scrape: async () => ({ files: [], warnings: [] }),
    testConnection: async () => ({ ok: true, message: "fixture" }),
  };
  const instance = createApp({
    dataDirectory: root,
    downloadDirectory: path.join(root, "downloads"),
    media,
    startBackground: false,
    testMode: true,
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  let cookie = "";
  async function request(
    route: string,
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    return fetch(base + route, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  try {
    assert.equal((await request("/api/config")).status, 401);
    assert.equal((await request("/api/library/users")).status, 401);
    assert.equal(
      (
        await request("/api/config", "GET", undefined, {
          host: "192.168.1.20:4180",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(
          "/api/setup",
          "POST",
          { password: "hostile-fixture-password" },
          { host: "attacker.invalid", origin: "http://attacker.invalid" },
        )
      ).status,
      403,
    );
    const session = await request("/api/session");
    assert.equal(session.status, 200);
    assert.equal((await session.json() as any).testMode, true);
    assert.equal(
      (await request("/api/setup", "POST", { password: "short" })).status,
      400,
    );
    const setup = await request("/api/setup", "POST", {
      password: "http-fixture-password",
    });
    assert.equal(setup.status, 200);
    cookie = setup.headers.get("set-cookie")!.split(";")[0];
    assert.match(setup.headers.get("set-cookie")!, /HttpOnly/);
    assert.match(setup.headers.get("set-cookie")!, /SameSite=Strict/);
    assert.equal(
      (await request("/api/setup", "POST", { password: "another-password" }))
        .status,
      409,
    );
    assert.equal(
      (
        await request(
          "/api/config",
          "PUT",
          {},
          { origin: "https://evil.invalid" },
        )
      ).status,
      403,
    );
    const config = (await (await request("/api/config")).json()) as any;
    config.model.apiKey = "http-fixture-secret";
    const saved = await request("/api/config", "PUT", config);
    assert.equal(saved.status, 200);
    const publicValue = (await saved.json()) as any;
    assert.equal(publicValue.model.apiKey, "");
    assert.equal(publicValue.secretStatus["model.apiKey"], true);
    assert.equal(
      JSON.stringify(publicValue).includes("http-fixture-secret"),
      false,
    );
    const search = (await (
      await request("/api/search?q=example")
    ).json()) as any;
    assert.equal(search.results[0].title, "example");
    assert.equal(
      (
        await request("/api/tasks", "POST", {
          title: "bad",
          url: "file:///etc/passwd",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/api/tasks", "POST", {
          title: "tv",
          url: "https://example.invalid/a.mp4",
          media: { type: "tv", title: "show" },
        })
      ).status,
      400,
    );
    const pending = (await (
      await request("/api/tasks", "POST", {
        title: "share",
        url: "https://example.invalid/share",
        kind: "share",
      })
    ).json()) as any;
    assert.equal(pending.task.status, "needs_attention");
    assert.equal(
      (await request(`/api/tasks/${pending.task.id}/library`, "POST", {}))
        .status,
      400,
    );
    assert.equal(
      (
        await request("/api/channels/bridge/qq", "POST", {
          eventId: "x",
          peer: "1",
          text: "search",
        })
      ).status >= 400,
      true,
    );
    await request("/api/logout", "POST", {});
    assert.equal((await request("/api/tasks")).status, 401);
    assert.equal(
      (await request("/api/login", "POST", { password: "wrong" })).status,
      401,
    );
    assert.equal(
      (
        await request("/api/login", "POST", {
          password: "http-fixture-password",
        })
      ).status,
      200,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await instance.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("full HTTP pipeline searches, downloads fixture bytes, writes NFO and survives restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mori-e2e-"));
  const directory = path.join(root, "downloads");
  const payload = Buffer.concat([
    Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex"),
    Buffer.alloc(4096, 7),
  ]);
  let sourceBase = "";
  const source = createServer((req, res) => {
    if (req.url === "/api/search") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          merged_by_type: {
            others: [
              { url: sourceBase + "/fixture.mp4", note: "Fixture Film 2026" },
            ],
          },
          results: [],
        }),
      );
      return;
    }
    if (req.url === "/fixture.mp4") {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": payload.length,
      });
      res.end(payload);
      return;
    }
    res.writeHead(404).end();
  });
  source.listen(0, "127.0.0.1");
  await new Promise<void>((r) => source.once("listening", r));
  sourceBase = `http://127.0.0.1:${(source.address() as any).port}`;
  let instance = createApp({
    dataDirectory: path.join(root, "data"),
    downloadDirectory: directory,
    startBackground: false,
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  let cookie = "";
  let closed = false;
  const request = (route: string, method = "GET", body?: unknown) =>
    fetch(base + route, {
      method,
      headers: {
        cookie,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const setup = await request("/api/setup", "POST", {
      password: "end-to-end-fixture-password",
    });
    assert.equal(setup.status, 200);
    cookie = setup.headers.get("set-cookie")!.split(";")[0];
    const config = (await (await request("/api/config")).json()) as any;
    config.sources.pansouUrl = sourceBase;
    config.library.artwork = false;
    assert.equal((await request("/api/config", "PUT", config)).status, 200);
    const found = (await (
      await request("/api/search?q=Fixture")
    ).json()) as any;
    assert.ok(
      found.results.some((x: any) => x.url === sourceBase + "/fixture.mp4"),
    );
    const response = await request("/api/tasks", "POST", {
      title: "Fixture Film",
      url: sourceBase + "/fixture.mp4",
      kind: "direct",
      media: { title: "Fixture Film", year: 2026, type: "movie" },
    });
    assert.equal(response.status, 201);
    const added = (await response.json()) as any;
    let task: any;
    for (let i = 0; i < 100; i++) {
      const all = (await (await request("/api/tasks")).json()) as any;
      task = all.tasks.find((x: any) => x.id === added.task.id);
      if (["completed", "failed"].includes(task?.status)) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(task.status, "completed", task.error);
    assert.equal(task.bytes, payload.length);
    assert.equal(task.total, payload.length);
    assert.deepEqual(await readFile(task.path), payload);
    const files = await readdir(directory, { recursive: true });
    assert.ok(files.some((x) => x.endsWith(".nfo")));
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await instance.close();
    closed = true;
    instance = createApp({
      dataDirectory: path.join(root, "data"),
      downloadDirectory: directory,
      startBackground: false,
    });
    assert.equal(instance.queue.tasks()[0].status, "completed");
    await instance.close();
  } finally {
    if (!closed) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await instance.close();
    }
    source.closeAllConnections();
    await new Promise<void>((r) => source.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
