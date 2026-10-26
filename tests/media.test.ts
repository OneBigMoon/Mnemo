import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  classifyResourceUrl,
  createMediaService,
  escapeXml,
  normalizePanSou,
  sanitizeFilename,
} from "../server/media.ts";
import type { AppConfig, DownloadTask, ProfileId } from "../shared/types.ts";

const VIDEO = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom"),
  Buffer.alloc(192 * 1024, 7),
]);
const signal = () => new AbortController().signal;

// 与 server/media.ts 相同的 fs.promises 对象；替换 link/rename 模拟不支持
// 硬链接的文件系统（exFAT/FAT32）。返回恢复函数。
const fspPatch = fsp as unknown as {
  link: (from: string, to: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
};
function refuseLinks(): () => void {
  const original = fspPatch.link;
  fspPatch.link = async () => {
    throw Object.assign(new Error("operation not supported"), {
      code: "ENOTSUP",
    });
  };
  return () => {
    fspPatch.link = original;
  };
}

function config(directory: string): AppConfig {
  return {
    setupComplete: true,
    defaultTitleAction: "search",
    model: { baseUrl: "", apiKey: "", model: "" },
    sources: {
      pansouUrl: "",
      tmdbApiKey: "",
      moviePilotUrl: "",
      moviePilotToken: "",
      openlistUrl: "",
      openlistToken: "",
      telegramChannels: [],
      p115Enabled: false,
      p115Cookie: "",
      alipanEnabled: false,
      alipanRefreshToken: "",
    },
    download: { directory, concurrency: 2, aria2Url: "", aria2Secret: "" },
    library: {
      profile: "jellyfin",
      language: "zh-CN",
      rename: true,
      artwork: false,
      serverUrl: "",
      serverToken: "",
    },
    channels: {
      telegram: { enabled: false, token: "", allowedChatIds: [], model: "" },
      bridge: { enabled: false, secret: "", model: "" },
    },
  };
}

function task(
  url: string,
  overrides: Partial<DownloadTask> = {},
): DownloadTask {
  return {
    id: "local-media-fixture",
    title: "测试影片",
    url,
    kind: "direct",
    status: "queued",
    progress: 0,
    bytes: 0,
    total: 0,
    media: { type: "movie", title: "测试影片", year: 2024 },
    profile: "jellyfin",
    createdAt: "2026-10-23T00:00:00Z",
    updatedAt: "2026-10-23T00:00:00Z",
    ...overrides,
  };
}

async function fixture(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mori-media-test-"));
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.destroy(
        error instanceof Error ? error : new Error("fixture error"),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    directory,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function body(request: IncomingMessage): Promise<Record<string, any>> {
  const parts: Buffer[] = [];
  for await (const chunk of request) parts.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

function sendJson(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
function sendVideo(response: ServerResponse) {
  response.writeHead(200, {
    "Content-Type": "video/mp4",
    "Content-Length": VIDEO.length,
    ETag: '"fixture-v1"',
  });
  response.end(VIDEO);
}

test("PanSou normalizes merged resources and original links without pretending share pages are files", async () => {
  let received: Record<string, unknown> = {};
  const local = await fixture(async (request, response) => {
    assert.equal(request.url, "/api/search");
    assert.equal(request.method, "POST");
    received = await body(request);
    sendJson(response, {
      code: 0,
      data: {
        merged_by_type: {
          baidu: [
            {
              url: "https://pan.baidu.com/s/example",
              note: "影片分享",
              source: "fixture",
            },
          ],
        },
        results: [
          {
            title: "磁力影片",
            channel: "fixture",
            links: [
              { url: `magnet:?xt=urn:btih:${"a".repeat(40)}`, type: "magnet" },
              { url: "https://pan.baidu.com/s/example" },
            ],
          },
        ],
      },
    });
  });
  try {
    const settings = config(local.directory);
    settings.sources.pansouUrl = local.url;
    const results = await createMediaService(() => settings).search("影片");
    assert.equal(received.kw, "影片");
    assert.equal(results.length, 2);
    assert.equal(
      results.find((item) => item.url.startsWith("https:"))?.kind,
      "share",
    );
    assert.equal(
      results.find((item) => item.url.startsWith("magnet:"))?.kind,
      "magnet",
    );
    assert.equal(
      normalizePanSou({
        results: [{ content: "https://media.example/film.mp4", title: "影片" }],
      })[0].kind,
      "direct",
    );
  } finally {
    await local.close();
  }
});

test("native download writes actual bytes, emits completion only after publishing and names episodes", async () => {
  const local = await fixture((_request, response) => sendVideo(response));
  try {
    const service = createMediaService(() => config(local.directory));
    const reports: number[] = [];
    const downloaded = await service.download(
      task(`${local.url}/movie.mp4`, {
        media: { type: "tv", title: "剧集", year: 2025, season: 2, episode: 3 },
      }),
      signal(),
      (report) => reports.push(report.progress),
    );
    assert.equal(path.basename(downloaded), "剧集 (2025) - S02E03.mp4");
    assert.equal(
      downloaded,
      path.join(
        await realpath(local.directory),
        "剧集 (2025)",
        "Season 02",
        "剧集 (2025) - S02E03.mp4",
      ),
    );
    assert.deepEqual(await readFile(downloaded), VIDEO);
    assert.equal(reports.at(-1), 100);
    assert.equal((await stat(downloaded)).mode & 0o777, 0o644);
    assert.equal(
      (await stat(path.dirname(downloaded))).mode & 0o777,
      0o755,
    );
    assert.equal(
      (await stat(path.dirname(path.dirname(downloaded)))).mode & 0o777,
      0o755,
    );
    assert.deepEqual(await readdir(local.directory), ["剧集 (2025)"]);
  } finally {
    await local.close();
  }
});

test("new download roots and season directories are readable by other local users", async () => {
  const local = await fixture((_request, response) => sendVideo(response));
  const directory = path.join(local.directory, "new-root");
  try {
    const service = createMediaService(() => config(directory));
    const downloaded = await service.download(
      task(`${local.url}/movie.mp4`, {
        media: { type: "tv", title: "剧集", year: 2025, season: 2, episode: 3 },
      }),
      signal(),
      () => {},
    );
    assert.equal((await stat(directory)).mode & 0o777, 0o755);
    assert.equal((await stat(path.dirname(path.dirname(downloaded)))).mode & 0o777, 0o755);
    assert.equal((await stat(path.dirname(downloaded))).mode & 0o777, 0o755);
    assert.equal((await stat(downloaded)).mode & 0o777, 0o644);
  } finally {
    await local.close();
  }
});

test("TV scrape writes the episode NFO and one stable tvshow.nfo for the series", async () => {
  const local = await fixture((_request, response) => sendVideo(response));
  try {
    const service = createMediaService(() => config(local.directory));
    const media = {
      type: "tv" as const,
      title: "剧集",
      year: 2025,
      season: 2,
      episode: 3,
    };
    const downloaded = await service.download(
      task(`${local.url}/episode.mp4`, { media }),
      signal(),
      () => {},
    );
    const first = await service.scrape(downloaded, media, "emby");
    const episodeNfo = downloaded.replace(/\.mp4$/u, ".nfo");
    const seriesNfo = path.join(
      await realpath(local.directory),
      "剧集 (2025)",
      "tvshow.nfo",
    );
    assert.ok(first.files.includes(episodeNfo));
    assert.ok(first.files.includes(seriesNfo));
    assert.equal((await stat(episodeNfo)).mode & 0o777, 0o644);
    assert.equal((await stat(seriesNfo)).mode & 0o777, 0o644);
    const episodeText = await readFile(episodeNfo, "utf8");
    assert.match(episodeText, /<episodedetails>/u);
    assert.match(episodeText, /<showtitle>剧集<\/showtitle>/u);
    assert.match(episodeText, /<season>2<\/season>/u);
    assert.match(episodeText, /<episode>3<\/episode>/u);
    const seriesText = await readFile(seriesNfo, "utf8");
    assert.match(seriesText, /<tvshow>/u);
    assert.match(seriesText, /<title>剧集<\/title>/u);
    assert.match(seriesText, /<year>2025<\/year>/u);
    assert.ok(!seriesText.includes("<episode>"));

    const secondFile = path.join(
      local.directory,
      "剧集 (2025)",
      "Season 02",
      "剧集 (2025) - S02E04.mp4",
    );
    await writeFile(secondFile, VIDEO);
    const second = await service.scrape(
      secondFile,
      { ...media, episode: 4 },
      "emby",
    );
    assert.ok(second.files.includes(seriesNfo));
    assert.equal(await readFile(seriesNfo, "utf8"), seriesText);
    await mkdir(path.join(local.directory, "nested"));
    const nestedMovie = path.join(local.directory, "nested", "movie.mp4");
    await writeFile(nestedMovie, VIDEO);
    await assert.rejects(
      service.scrape(
        nestedMovie,
        { type: "movie", title: "movie" },
        "emby",
      ),
      /只允许刮削/u,
    );
  } finally {
    await local.close();
  }
});

test("concurrent TV scrapes share tvshow.nfo without failing on the publish window", async () => {
  const local = await fixture((_request, response) => sendVideo(response));
  try {
    const service = createMediaService(() => config(local.directory));
    const title = "并发剧集";
    const series = path.join(local.directory, `${title} (2026)`);
    await mkdir(path.join(series, "Season 01"), { recursive: true });
    const files: string[] = [];
    for (let episode = 1; episode <= 12; episode += 1) {
      const file = path.join(
        series,
        "Season 01",
        `${title} (2026) - S01E${String(episode).padStart(2, "0")}.mp4`,
      );
      await writeFile(file, VIDEO);
      files.push(file);
    }
    const results = await Promise.all(
      files.map((file, index) =>
        service.scrape(
          file,
          { type: "tv", title, year: 2026, season: 1, episode: index + 1 },
          "emby",
        ),
      ),
    );
    for (const result of results) assert.ok(result.files.length > 0);
    const seriesNfo = path.join(series, "tvshow.nfo");
    assert.match(await readFile(seriesNfo, "utf8"), /<title>并发剧集<\/title>/u);
    assert.deepEqual(
      (await readdir(series)).filter((name) => name.includes(".mori-")),
      [],
    );
  } finally {
    await local.close();
  }
});

test("HTML is rejected even when disguised as octet-stream and no media file is published", async () => {
  const local = await fixture((request, response) => {
    response.writeHead(200, {
      "Content-Type": request.url?.includes("disguised")
        ? "application/octet-stream"
        : "text/html",
    });
    response.end("<!DOCTYPE html><html><body>sign in</body></html>");
  });
  try {
    const service = createMediaService(() => config(local.directory));
    await assert.rejects(
      service.download(task(`${local.url}/login.mp4`), signal(), () => {}),
      /网页|非视频/,
    );
    await assert.rejects(
      service.download(
        task(`${local.url}/disguised.mp4`, { id: "disguised" }),
        signal(),
        () => {},
      ),
      /HTML\/JSON/,
    );
    assert.equal(
      (await readdir(local.directory)).some((name) => name.endsWith(".mp4")),
      false,
    );
  } finally {
    await local.close();
  }
});

test("completed media is never overwritten", async () => {
  const local = await fixture((_request, response) => sendVideo(response));
  try {
    const service = createMediaService(() => config(local.directory));
    const destination = path.join(local.directory, "测试影片 (2024).mp4");
    await writeFile(destination, "existing media");
    await assert.rejects(
      service.download(task(`${local.url}/movie.mp4`), signal(), () => {}),
      /已存在/,
    );
    assert.equal(await readFile(destination, "utf8"), "existing media");
  } finally {
    await local.close();
  }
});

test("a filesystem without hard links publishes by copy fallback with identical bytes and no leftovers", async () => {
  const local = await fixture((_request, response) => sendVideo(response));
  const restore = refuseLinks();
  try {
    const service = createMediaService(() => config(local.directory));
    const downloaded = await service.download(
      task(`${local.url}/movie.mp4`, {
        media: { type: "tv", title: "剧集", year: 2025, season: 2, episode: 3 },
      }),
      signal(),
      () => {},
    );
    assert.equal(path.basename(downloaded), "剧集 (2025) - S02E03.mp4");
    assert.deepEqual(await readFile(downloaded), VIDEO);
    assert.equal((await stat(downloaded)).mode & 0o777, 0o644);
    assert.equal((await stat(downloaded)).nlink, 1);
    assert.equal(
      (await stat(path.dirname(downloaded))).mode & 0o777,
      0o755,
    );
    assert.deepEqual(await readdir(local.directory), ["剧集 (2025)"]);
  } finally {
    restore();
    await local.close();
  }
});

test("copy fallback never overwrites an existing destination and leaves no copies behind", async () => {
  const local = await fixture((_request, response) => sendVideo(response));
  const restore = refuseLinks();
  try {
    const service = createMediaService(() => config(local.directory));
    const destination = path.join(local.directory, "测试影片 (2024).mp4");
    await writeFile(destination, "existing media");
    await assert.rejects(
      service.download(task(`${local.url}/movie.mp4`), signal(), () => {}),
      /已存在/,
    );
    assert.equal(await readFile(destination, "utf8"), "existing media");
    assert.deepEqual(await readdir(local.directory), ["测试影片 (2024).mp4"]);
  } finally {
    restore();
    await local.close();
  }
});

test("copy fallback cleans a failed rename, preserves the part, and the retry publishes it", async () => {
  const local = await fixture((_request, response) => sendVideo(response));
  const restore = refuseLinks();
  const originalRename = fspPatch.rename;
  let renames = 0;
  fspPatch.rename = async (from: string, to: string) => {
    renames += 1;
    if (renames === 1)
      throw Object.assign(new Error("rename hiccup"), { code: "EPERM" });
    return originalRename(from, to);
  };
  try {
    const service = createMediaService(() => config(local.directory));
    await assert.rejects(
      service.download(task(`${local.url}/movie.mp4`), signal(), () => {}),
      /rename hiccup/,
    );
    const entries = await readdir(local.directory);
    assert.ok(
      entries.some((name) => name.endsWith(".part")),
      `part must remain: ${entries.join(", ")}`,
    );
    assert.ok(
      entries.some((name) => name.endsWith(".json")),
      `resume metadata must remain: ${entries.join(", ")}`,
    );
    assert.ok(
      entries.every((name) => !name.includes(".mori-publish-")),
      `copy must be cleaned: ${entries.join(", ")}`,
    );
    const downloaded = await service.download(
      task(`${local.url}/movie.mp4`),
      signal(),
      () => {},
    );
    assert.equal(renames, 2);
    assert.deepEqual(await readFile(downloaded), VIDEO);
    assert.equal((await stat(downloaded)).nlink, 1);
    assert.deepEqual(await readdir(local.directory), ["测试影片 (2024).mp4"]);
  } finally {
    fspPatch.rename = originalRename;
    restore();
    await local.close();
  }
});

test("hostile names stay in the configured root and OpenList traversal is rejected", async () => {
  const local = await fixture((_request, response) => sendVideo(response));
  try {
    const service = createMediaService(() => config(local.directory));
    const destination = await service.download(
      task(`${local.url}/movie.mp4`, {
        media: { type: "movie", title: '../../outside:*?<>|"' },
      }),
      signal(),
      () => {},
    );
    assert.equal(
      path.dirname(destination),
      await import("node:fs/promises").then((fs) =>
        fs.realpath(local.directory),
      ),
    );
    assert(!/[<>:"/\\|?*]/.test(path.basename(destination)));
    assert.equal(sanitizeFilename("CON"), "_CON");
    assert(Buffer.byteLength(sanitizeFilename("中".repeat(300))) <= 170);
    await assert.rejects(
      service.download(
        task("openlist:/%2e%2e/secrets.mp4", {
          id: "traversal",
          kind: "openlist",
        }),
        signal(),
        () => {},
      ),
      /路径|配置/,
    );
  } finally {
    await local.close();
  }
});

test("symlink destination and temporary files cannot overwrite files outside the root", async () => {
  const local = await fixture((_request, response) => sendVideo(response));
  const outside = await mkdtemp(path.join(os.tmpdir(), "mori-media-outside-"));
  try {
    const victim = path.join(outside, "untouched");
    await writeFile(victim, "untouched");
    await symlink(victim, path.join(local.directory, "测试影片 (2024).mp4"));
    const service = createMediaService(() => config(local.directory));
    await assert.rejects(
      service.download(task(`${local.url}/movie.mp4`), signal(), () => {}),
      /已存在/,
    );
    const partialId = "symlink-part";
    const partialName = `.mori-${createHash("sha256").update(partialId).digest("hex").slice(0, 24)}.part`;
    await symlink(victim, path.join(local.directory, partialName));
    await assert.rejects(
      service.download(
        task(`${local.url}/movie.mp4`, {
          id: partialId,
          media: { type: "movie", title: "different" },
        }),
        signal(),
        () => {},
      ),
      /链接/,
    );
    assert.equal(await readFile(victim, "utf8"), "untouched");
    const linkedDirectory = path.join(outside, "root-link");
    await symlink(local.directory, linkedDirectory);
    await assert.rejects(
      createMediaService(() => config(linkedDirectory)).download(
        task(`${local.url}/movie.mp4`),
        signal(),
        () => {},
      ),
      /符号链接/,
    );
  } finally {
    await local.close();
    await rm(outside, { recursive: true, force: true });
  }
});

test("an interrupted download resumes only with the matching entity and Content-Range", async () => {
  const ranges: string[] = [];
  const local = await fixture((request, response) => {
    const start = Number(
      request.headers.range?.match(/bytes=(\d+)-/)?.[1] ?? 0,
    );
    if (request.headers.range) {
      ranges.push(request.headers.range);
      assert.equal(request.headers["if-range"], '"fixture-v1"');
    }
    response.writeHead(start ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Content-Length": VIDEO.length - start,
      ETag: '"fixture-v1"',
      ...(start
        ? {
            "Content-Range": `bytes ${start}-${VIDEO.length - 1}/${VIDEO.length}`,
          }
        : {}),
    });
    let offset = start;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      if (offset >= VIDEO.length) {
        response.end();
        return;
      }
      response.write(VIDEO.subarray(offset, offset + 8192));
      offset += 8192;
      timer = setTimeout(next, 5);
    };
    response.on("close", () => clearTimeout(timer));
    next();
  });
  try {
    const service = createMediaService(() => config(local.directory));
    const controller = new AbortController();
    const item = task(`${local.url}/movie.mp4`);
    await assert.rejects(
      service.download(item, controller.signal, (report) => {
        if (report.bytes > 0) controller.abort();
      }),
    );
    assert(
      (await readdir(local.directory)).some((name) => name.endsWith(".part")),
    );
    const destination = await service.download(item, signal(), () => {});
    assert.equal(ranges.length, 1);
    assert.deepEqual(await readFile(destination), VIDEO);
  } finally {
    await local.close();
  }
});

test("mismatched range responses never append and publish an incomplete file", async () => {
  let mismatched = false;
  const local = await fixture((request, response) => {
    if (request.headers.range) {
      mismatched = true;
      response.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Length": VIDEO.length,
        ETag: '"fixture-v1"',
        "Content-Range": `bytes 0-${VIDEO.length - 1}/${VIDEO.length}`,
      });
      response.end(VIDEO);
    } else {
      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": VIDEO.length,
        ETag: '"fixture-v1"',
      });
      response.write(VIDEO.subarray(0, 4096));
    }
  });
  try {
    const service = createMediaService(() => config(local.directory));
    const controller = new AbortController();
    const item = task(`${local.url}/movie.mp4`);
    await assert.rejects(
      service.download(item, controller.signal, (report) => {
        if (report.bytes) controller.abort();
      }),
    );
    await assert.rejects(
      service.download(item, signal(), () => {}),
      /断点范围/,
    );
    assert(mismatched);
    assert.equal(
      (await readdir(local.directory)).some((name) => name.endsWith(".mp4")),
      false,
    );
  } finally {
    await local.close();
  }
});

test("OpenList resolves an authenticated file to a real raw URL without forwarding its token", async () => {
  let resolvedPath = "";
  let fileAuthorization: string | undefined;
  const local = await fixture(async (request, response) => {
    if (request.url === "/api/fs/get") {
      assert.equal(request.headers.authorization, "openlist-fixture-token");
      resolvedPath = String((await body(request)).path);
      sendJson(response, {
        code: 200,
        data: { is_dir: false, raw_url: `${local.url}/raw.mp4` },
      });
    } else if (request.url === "/api/fs/search") {
      assert.equal((await body(request)).keywords, "film");
      sendJson(response, {
        code: 200,
        data: {
          content: [
            {
              parent: "/movies",
              name: "film.mp4",
              is_dir: false,
              size: VIDEO.length,
            },
          ],
        },
      });
    } else {
      fileAuthorization = request.headers.authorization;
      sendVideo(response);
    }
  });
  try {
    const settings = config(local.directory);
    settings.sources.openlistUrl = local.url;
    settings.sources.openlistToken = "openlist-fixture-token";
    const service = createMediaService(() => settings);
    const results = await service.search("film");
    assert.equal(results[0].url, "openlist:/movies/film.mp4");
    const downloaded = await service.download(
      task(results[0].url, { kind: "openlist" }),
      signal(),
      () => {},
    );
    assert.equal(resolvedPath, "/movies/film.mp4");
    assert.equal(fileAuthorization, undefined);
    assert.deepEqual(await readFile(downloaded), VIDEO);
    await assert.rejects(
      service.download(
        task("openlist:/a/../../escape.mp4", {
          id: "bad-path",
          kind: "openlist",
        }),
        signal(),
        () => {},
      ),
      /路径穿越/,
    );
  } finally {
    await local.close();
  }
});

test("share pages and Telegram messages require resolvers, while magnets require aria2", async () => {
  const local = await fixture((_request, response) => sendVideo(response));
  try {
    const service = createMediaService(() => config(local.directory));
    assert.equal(classifyResourceUrl("https://t.me/channel/10"), "telegram");
    for (const source of [
      "https://pan.quark.cn/s/example",
      "https://t.me/channel/10",
    ])
      await assert.rejects(
        service.download(task(source), signal(), () => {}),
        /分享页|Telegram/,
      );
    await assert.rejects(
      service.download(
        task(`magnet:?xt=urn:btih:${"b".repeat(40)}`, { kind: "magnet" }),
        signal(),
        () => {},
      ),
      /需要配置 aria2/,
    );
    assert.deepEqual(await readdir(local.directory), []);
  } finally {
    await local.close();
  }
});

test("aria2 completes only after one real local video file is verified", async () => {
  let state: Record<string, any> | undefined;
  const local = await fixture(async (request, response) => {
    if (request.url !== "/jsonrpc") {
      sendVideo(response);
      return;
    }
    const rpc = await body(request);
    assert.equal(rpc.params[0], "token:aria-fixture-token");
    if (rpc.method === "aria2.tellStatus") {
      sendJson(
        response,
        state
          ? { jsonrpc: "2.0", id: rpc.id, result: state }
          : {
              jsonrpc: "2.0",
              id: rpc.id,
              error: { code: 1, message: "GID not found" },
            },
      );
    } else if (rpc.method === "aria2.addUri") {
      const options = rpc.params[2];
      const file = path.join(options.dir, options.out);
      assert.equal(options["allow-overwrite"], "false");
      assert.equal(options["auto-file-renaming"], "false");
      await writeFile(file, VIDEO);
      state = {
        status: "complete",
        dir: options.dir,
        totalLength: String(VIDEO.length),
        completedLength: String(VIDEO.length),
        files: [
          {
            path: file,
            length: String(VIDEO.length),
            completedLength: String(VIDEO.length),
            selected: "true",
          },
        ],
      };
      sendJson(response, { jsonrpc: "2.0", id: rpc.id, result: options.gid });
    } else assert.fail(`Unexpected RPC ${rpc.method}`);
  });
  try {
    const settings = config(local.directory);
    settings.download.aria2Url = `${local.url}/jsonrpc`;
    settings.download.aria2Secret = "aria-fixture-token";
    const destination = await createMediaService(() => settings).download(
      task(`${local.url}/movie.mp4`),
      signal(),
      () => {},
    );
    assert.deepEqual(await readFile(destination), VIDEO);
    assert.equal((await readdir(local.directory)).length, 1);
  } finally {
    await local.close();
  }
});

test("aria2 metadata-only completion is not a downloaded video, and abort pauses an active job", async () => {
  let mode = "metadata";
  let state: Record<string, any> | undefined;
  const paused: string[] = [];
  const local = await fixture(async (request, response) => {
    const rpc = await body(request);
    if (rpc.method === "aria2.tellStatus")
      sendJson(
        response,
        state
          ? { jsonrpc: "2.0", id: rpc.id, result: state }
          : { jsonrpc: "2.0", id: rpc.id, error: { code: 1 } },
      );
    else if (rpc.method === "aria2.addUri") {
      const options = rpc.params[1];
      state = {
        status: mode === "metadata" ? "complete" : "active",
        dir: options.dir,
        totalLength: "10",
        completedLength: "0",
        files: [
          {
            path: path.join(options.dir, "metadata.torrent"),
            length: "10",
            completedLength: "10",
            selected: "true",
          },
        ],
      };
      sendJson(response, { jsonrpc: "2.0", id: rpc.id, result: options.gid });
    } else if (rpc.method === "aria2.pause") {
      paused.push(rpc.params[0]);
      sendJson(response, { jsonrpc: "2.0", id: rpc.id, result: rpc.params[0] });
    } else assert.fail(`Unexpected RPC ${rpc.method}`);
  });
  try {
    const settings = config(local.directory);
    settings.download.aria2Url = local.url;
    const service = createMediaService(() => settings);
    const source = `magnet:?xt=urn:btih:${"c".repeat(40)}`;
    await assert.rejects(
      service.download(task(source, { kind: "magnet" }), signal(), () => {}),
      /元数据|单个视频/,
    );
    mode = "active";
    state = undefined;
    const controller = new AbortController();
    await assert.rejects(
      service.download(
        task(source, { id: "cancelled-aria", kind: "magnet" }),
        controller.signal,
        () => controller.abort(),
      ),
    );
    assert.equal(paused.length, 1);
    assert.equal(
      (await readdir(local.directory)).some((name) => name.endsWith(".mp4")),
      false,
    );
  } finally {
    await local.close();
  }
});

test("all presets write escaped common NFO without fabricated metadata and preserve conflicting NFO", async () => {
  const local = await fixture((_request, response) => sendVideo(response));
  try {
    const service = createMediaService(() => config(local.directory));
    for (const profile of [
      "emby",
      "jellyfin",
      "fnos",
      "ugreen",
      "kodi",
    ] as ProfileId[]) {
      const file = path.join(local.directory, `${profile}.mp4`);
      await writeFile(file, VIDEO);
      const metadata = {
        type: "movie" as const,
        title: 'A & <B> "quoted"',
        overview: "plot & <script>",
      };
      const scraped = await service.scrape(file, metadata, profile);
      const nfo = await readFile(scraped.files[0], "utf8");
      assert(
        nfo.includes("<title>A &amp; &lt;B&gt; &quot;quoted&quot;</title>"),
      );
      assert(nfo.includes("<plot>plot &amp; &lt;script&gt;</plot>"));
      assert(!nfo.includes("<year>"));
      assert(!nfo.includes("uniqueid"));
      assert(scraped.warnings.length > 0);
      assert.equal(
        (await service.scrape(file, metadata, profile)).files[0],
        scraped.files[0],
      );
      await assert.rejects(
        service.scrape(file, { ...metadata, title: "other identity" }, profile),
        /已存在/,
      );
      assert.equal(await readFile(scraped.files[0], "utf8"), nfo);
    }
    assert.equal(escapeXml("&<\u0001"), "&amp;&lt;");
  } finally {
    await local.close();
  }
});

test("TMDB identification and details use configured credentials and bounded trusted artwork", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mori-tmdb-test-"));
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: URL | string | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url.pathname);
    if (url.hostname === "image.tmdb.org")
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]), {
        headers: { "Content-Type": "image/jpeg" },
      });
    assert.equal(url.hostname, "api.themoviedb.org");
    assert.equal(url.searchParams.get("api_key"), "tmdb-fixture-key");
    const data = {
      id: 123,
      media_type: "movie",
      title: "真实条目",
      release_date: "2024-05-01",
      overview: "来自固定测试数据",
      poster_path: "/poster.jpg",
    };
    return new Response(
      JSON.stringify(
        url.pathname.includes("/search/")
          ? {
              results: [
                data,
                { id: 321, media_type: "person", name: "not a movie" },
              ],
            }
          : data,
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  try {
    const settings = config(directory);
    settings.sources.tmdbApiKey = "tmdb-fixture-key";
    settings.library.artwork = true;
    const service = createMediaService(() => settings);
    const identified = await service.identify("测试名称");
    assert.equal(identified.length, 1);
    assert.equal(identified[0].tmdbId, 123);
    const file = path.join(directory, "movie.mp4");
    await writeFile(file, VIDEO);
    const scraped = await service.scrape(file, identified[0], "jellyfin");
    assert.equal(scraped.warnings.length, 0);
    assert.equal(scraped.files.length, 2);
    assert(
      (await readFile(scraped.files[0], "utf8")).includes(
        '<uniqueid type="tmdb" default="true">123</uniqueid>',
      ),
    );
    assert(requests.includes("/3/movie/123"));
    assert(requests.includes("/t/p/original/poster.jpg"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scrape cancellation propagates through artwork fetch and never publishes NFO or artwork afterwards", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mori-scrape-abort-"));
  const settings = config(directory);
  settings.library.artwork = true;
  const file = path.join(directory, "existing.mp4");
  await writeFile(file, VIDEO);
  const metadata = {
    type: "movie" as const,
    title: "取消测试",
    posterUrl: "https://image.tmdb.org/t/p/original/poster.jpg",
  };
  const service = createMediaService(() => settings);
  let calls = 0;
  const duringFetch = new AbortController();
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: unknown, init: RequestInit) => {
      calls++;
      assert(init.signal);
      assert.equal(init.signal.aborted, false);
      duringFetch.abort();
      assert.equal(init.signal.aborted, true);
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), {
        headers: { "Content-Type": "image/jpeg" },
      });
    },
  );
  try {
    const beforeStart = new AbortController();
    beforeStart.abort();
    await assert.rejects(
      service.scrape(file, metadata, "jellyfin", beforeStart.signal),
    );
    assert.equal(calls, 0);
    await assert.rejects(
      service.scrape(file, metadata, "jellyfin", duringFetch.signal),
    );
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(directory), ["existing.mp4"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("connection tests validate API shapes and unsupported vendor integrations remain explicit", async () => {
  const local = await fixture((_request, response) =>
    sendJson(response, { unrelated: true }),
  );
  try {
    const settings = config(local.directory);
    settings.sources.pansouUrl = local.url;
    settings.library.serverUrl = local.url;
    const service = createMediaService(() => settings);
    assert.equal((await service.testConnection("pansou")).ok, false);
    assert.equal((await service.testConnection("library")).ok, false);
    settings.library.profile = "fnos";
    assert.match((await service.testConnection("library")).message, /通用 NFO/);
    assert.equal((await service.testConnection("directory")).ok, true);
  } finally {
    await local.close();
  }
});
