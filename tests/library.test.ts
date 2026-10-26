import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { listLibraryUsers, syncLibrary } from "../server/library.ts";
import type { AppConfig, DownloadTask } from "../shared/types.ts";

const VIDEO = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom"),
  Buffer.alloc(4096, 7),
]);

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
      serverToken: "private-fixture-token",
    },
    channels: {
      telegram: { enabled: false, token: "", allowedChatIds: [], model: "" },
      bridge: { enabled: false, secret: "", model: "" },
    },
  };
}

function task(file: string): DownloadTask {
  return {
    id: "library-fixture",
    title: "影片",
    url: "https://media.invalid/movie.mp4",
    kind: "direct",
    status: "completed",
    progress: 100,
    bytes: VIDEO.length,
    total: VIDEO.length,
    media: { type: "movie", title: "影片", year: 2024, tmdbId: 123 },
    profile: "jellyfin",
    path: file,
    createdAt: "2026-10-23T00:00:00Z",
    updatedAt: "2026-10-23T00:00:00Z",
  };
}

function json(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
function item(file: string) {
  return {
    Id: "movie-id",
    Type: "Movie",
    Path: file,
    ProductionYear: 2024,
    ProviderIds: { Tmdb: "123" },
    LocationType: "FileSystem",
  };
}
function source(file: string) {
  return {
    Id: "source-id",
    Path: file,
    Protocol: "File",
    Size: VIDEO.length,
    RunTimeTicks: 30 * 10_000_000,
    SupportsDirectPlay: true,
    MediaStreams: [{ Type: "Video", Codec: "h264", Width: 320, Height: 180 }],
  };
}

async function fixture(
  handler?: (
    request: IncomingMessage,
    response: ServerResponse,
    local: Fixture,
  ) => void | Promise<void>,
) {
  const originalDirectory = await mkdtemp(
    path.join(os.tmpdir(), "mori-library-"),
  );
  const directory = await realpath(originalDirectory);
  const file = path.join(directory, "movie.mp4");
  await writeFile(file, VIDEO);
  const requests: { path: string; method: string }[] = [];
  const failures: unknown[] = [];
  let local: Fixture;
  const server = createServer((request, response) => {
    requests.push({ path: request.url!, method: request.method! });
    try {
      assert.equal(
        request.headers["x-emby-token"],
        local.config.library.serverToken,
      );
      Promise.resolve(
        handler
          ? handler(request, response, local)
          : defaultHandler(request, response, local),
      ).catch((error) => {
        failures.push(error);
        response.destroy();
      });
    } catch (error) {
      failures.push(error);
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const settings = config(directory);
  settings.library.serverUrl = `http://127.0.0.1:${address.port}`;
  local = {
    directory,
    file,
    config: settings,
    task: task(file),
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
      if (failures.length)
        throw new AggregateError(failures, "HTTP fixture assertions failed");
    },
  };
  return local;
}

type Fixture = {
  directory: string;
  file: string;
  config: AppConfig;
  task: DownloadTask;
  requests: { path: string; method: string }[];
  close(): Promise<void>;
};

function defaultHandler(
  request: IncomingMessage,
  response: ServerResponse,
  local: Fixture,
) {
  const url = new URL(request.url!, local.config.library.serverUrl);
  if (url.pathname === "/Library/Refresh") {
    assert.equal(request.method, "POST");
    response.writeHead(204);
    response.end();
  } else if (url.pathname === "/Items")
    json(response, { Items: [item(local.file)], TotalRecordCount: 1 });
  else if (url.pathname === "/Items/movie-id/PlaybackInfo")
    json(response, { MediaSources: [source(local.file)] });
  else assert.fail(`Unexpected route ${url.pathname}`);
}

test("Jellyfin refresh is followed by exact path, identity and probed playback-source verification", async () => {
  const local = await fixture();
  try {
    const verified = await syncLibrary(local.config, local.task);
    assert.equal(verified.status, "verified");
    assert.equal(verified.playable, true);
    assert.equal(verified.itemId, "movie-id");
    assert.equal(verified.serverPath, local.file);
    assert(!Number.isNaN(Date.parse(verified.checkedAt)));
    assert.equal(
      local.requests.filter((request) => request.method === "POST").length,
      1,
    );
    assert.equal(
      local.requests.filter((request) => request.path.startsWith("/Users"))
        .length,
      0,
    );
    assert.equal(
      local.requests.filter((request) => request.path.includes("/PlaybackInfo"))
        .length,
      1,
    );
  } finally {
    await local.close();
  }
});

test("Emby carries the explicitly selected user and uses its supported Path filter", async () => {
  const local = await fixture((request, response, local) => {
    const url = new URL(request.url!, local.config.library.serverUrl);
    if (url.pathname === "/Items" || url.pathname.includes("/PlaybackInfo"))
      assert.equal(url.searchParams.get("UserId"), "chosen-user");
    if (url.pathname === "/Items")
      assert.equal(url.searchParams.get("Path"), local.file);
    defaultHandler(request, response, local);
  });
  try {
    local.config.library.profile = "emby";
    local.config.library.userId = "chosen-user";
    assert.equal(
      (await syncLibrary(local.config, local.task)).status,
      "verified",
    );
  } finally {
    await local.close();
  }
});

test("unconfigured, missing Emby account and unsupported vendors perform no API requests", async () => {
  const local = await fixture();
  try {
    local.config.library.serverUrl = "";
    assert.equal(
      (await syncLibrary(local.config, local.task)).status,
      "not_configured",
    );
    local.config.library.profile = "emby";
    local.config.library.serverUrl = "http://127.0.0.1:9";
    assert.equal(
      (await syncLibrary(local.config, local.task)).status,
      "not_configured",
    );
    for (const profile of ["fnos", "ugreen", "kodi"] as const) {
      local.config.library.profile = profile;
      assert.equal(
        (await syncLibrary(local.config, local.task)).status,
        "unsupported",
      );
    }
    assert.equal(local.requests.length, 0);
  } finally {
    await local.close();
  }
});

test("refresh HTTP 204 with no matching item remains pending after bounded polling", async () => {
  const local = await fixture((request, response) => {
    if (request.method === "POST") {
      response.writeHead(204);
      response.end();
    } else json(response, { Items: [], TotalRecordCount: 0 });
  });
  try {
    const result = await syncLibrary(local.config, local.task);
    assert.equal(result.status, "pending");
    assert.equal(result.playable, false);
    assert.equal(result.itemId, undefined);
    assert.equal(
      local.requests.filter((request) => request.path.startsWith("/Items"))
        .length,
      5,
    );
  } finally {
    await local.close();
  }
});

test("same metadata at the wrong path is not mistaken for the downloaded file", async () => {
  const local = await fixture((request, response) => {
    if (request.method === "POST") {
      response.writeHead(200);
      response.end("accepted");
    } else
      json(response, {
        Items: [item("/unrelated/movie.mp4")],
        TotalRecordCount: 1,
      });
  });
  try {
    const result = await syncLibrary(local.config, local.task);
    assert.equal(result.status, "pending");
    assert.equal(result.playable, false);
    assert(
      !local.requests.some((request) => request.path.includes("PlaybackInfo")),
    );
  } finally {
    await local.close();
  }
});

test("wrong media type, year or TMDB identity fails without reporting playable", async () => {
  for (const mismatch of [
    { Type: "Episode" },
    { ProductionYear: 1999 },
    { ProviderIds: { Tmdb: "999" } },
  ]) {
    const local = await fixture((request, response, local) => {
      if (request.method === "POST") {
        response.writeHead(204);
        response.end();
      } else
        json(response, {
          Items: [{ ...item(local.file), ...mismatch }],
          TotalRecordCount: 1,
        });
    });
    try {
      const result = await syncLibrary(local.config, local.task);
      assert.equal(result.status, "failed");
      assert.equal(result.playable, false);
    } finally {
      await local.close();
    }
  }
});

test("TV identity checks season and episode, and compares TMDB to the series rather than the episode", async () => {
  let wrongEpisode = false;
  const local = await fixture((request, response, local) => {
    const url = new URL(request.url!, local.config.library.serverUrl);
    if (request.method === "POST") {
      response.writeHead(204);
      response.end();
    } else if (url.pathname.includes("PlaybackInfo"))
      json(response, { MediaSources: [source(local.file)] });
    else if (url.searchParams.get("Ids"))
      json(response, {
        Items: [
          { Id: "series-id", Type: "Series", ProviderIds: { Tmdb: "123" } },
        ],
        TotalRecordCount: 1,
      });
    else
      json(response, {
        Items: [
          {
            ...item(local.file),
            Type: "Episode",
            SeriesId: "series-id",
            ParentIndexNumber: 2,
            IndexNumber: wrongEpisode ? 4 : 3,
            ProviderIds: { Tmdb: "99999" },
          },
        ],
        TotalRecordCount: 1,
      });
  });
  try {
    local.task.media = {
      type: "tv",
      title: "剧集",
      season: 2,
      episode: 3,
      tmdbId: 123,
    };
    assert.equal(
      (await syncLibrary(local.config, local.task)).status,
      "verified",
    );
    wrongEpisode = true;
    const result = await syncLibrary(local.config, local.task);
    assert.equal(result.status, "failed");
    assert.match(result.message, /季集/);
  } finally {
    await local.close();
  }
});

test("a playback response needs the same local path, size and video stream, not only HTTP 200", async () => {
  let probes = 0;
  const local = await fixture((request, response, local) => {
    if (request.url?.includes("PlaybackInfo")) {
      probes++;
      const invalid =
        probes === 1
          ? { Path: "https://external.invalid/media.mp4", Protocol: "Http" }
          : probes === 2
            ? { Size: VIDEO.length + 1 }
            : probes === 3
              ? { MediaStreams: [{ Type: "Audio", Codec: "aac" }] }
              : {};
      json(response, { MediaSources: [{ ...source(local.file), ...invalid }] });
    } else defaultHandler(request, response, local);
  });
  try {
    assert.equal(
      (await syncLibrary(local.config, local.task)).status,
      "verified",
    );
    assert.equal(probes, 4);
    assert.equal(
      local.requests.filter((request) => request.method === "POST").length,
      1,
    );
  } finally {
    await local.close();
  }
});

test("path mapping converts only a complete local directory prefix, including Windows server paths", async () => {
  let serverPath = "/media/movie.mp4";
  const local = await fixture((request, response) => {
    if (request.method === "POST") {
      response.writeHead(204);
      response.end();
    } else if (request.url?.includes("PlaybackInfo"))
      json(response, { MediaSources: [source(serverPath)] });
    else json(response, { Items: [item(serverPath)], TotalRecordCount: 1 });
  });
  try {
    local.config.library.pathFrom = local.directory;
    local.config.library.pathTo = "/media";
    const result = await syncLibrary(local.config, local.task);
    assert.equal(result.status, "verified");
    assert.equal(result.serverPath, serverPath);
    serverPath = "z:/media/MOVIE.mp4";
    local.config.library.pathTo = "Z:\\Media";
    const windows = await syncLibrary(local.config, local.task);
    assert.equal(windows.status, "verified");
    assert.equal(windows.serverPath, "Z:\\Media\\movie.mp4");
    const sibling = `${local.directory}-different`;
    await mkdir(sibling);
    try {
      local.config.library.pathFrom = sibling;
      const requests = local.requests.length;
      assert.equal(
        (await syncLibrary(local.config, local.task)).status,
        "failed",
      );
      assert.equal(local.requests.length, requests);
    } finally {
      await rm(sibling, { recursive: true });
    }
  } finally {
    await local.close();
  }
});

test("auth errors are explicit and never expose response content or tokens", async () => {
  const local = await fixture((_request, response) => {
    response.writeHead(401);
    response.end("private-fixture-token password=private");
  });
  try {
    const result = await syncLibrary(local.config, local.task);
    assert.equal(result.status, "failed");
    assert.match(result.message, /认证/);
    assert(!JSON.stringify(result).includes("private-fixture-token"));
    assert(!JSON.stringify(result).includes("password="));
  } finally {
    await local.close();
  }
});

test("a timed out refresh is pending with unknown outcome, never verified or retried", async () => {
  const local = await fixture(() => {});
  try {
    const result = await syncLibrary(local.config, local.task);
    assert.equal(result.status, "pending");
    assert.match(result.message, /超时/);
    assert.equal(result.playable, false);
    assert.equal(local.requests.length, 1);
  } finally {
    await local.close();
  }
});

test("external cancellation propagates and prevents follow-up verification calls", async () => {
  const controller = new AbortController();
  const local = await fixture((request, response, local) => {
    if (request.url?.startsWith("/Items")) {
      controller.abort(new Error("fixture cancelled"));
      response.end();
    } else defaultHandler(request, response, local);
  });
  try {
    const already = new AbortController();
    already.abort();
    await assert.rejects(syncLibrary(local.config, local.task, already.signal));
    assert.equal(local.requests.length, 0);
    await assert.rejects(
      syncLibrary(local.config, local.task, controller.signal),
      /fixture cancelled/,
    );
    await delay(20);
    assert.equal(local.requests.length, 2);
    assert(
      !local.requests.some((request) => request.path.includes("PlaybackInfo")),
    );
  } finally {
    await local.close();
  }
});

test("redirects are refused before library tokens reach another origin", async () => {
  let reached = 0;
  const other = createServer((_request, response) => {
    reached++;
    response.end();
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  const address = other.address();
  assert(address && typeof address !== "string");
  const local = await fixture((_request, response) => {
    response.writeHead(302, {
      Location: `http://127.0.0.1:${address.port}/stolen`,
    });
    response.end();
  });
  try {
    const result = await syncLibrary(local.config, local.task);
    assert.equal(result.status, "failed");
    assert.equal(reached, 0);
  } finally {
    await local.close();
    other.closeAllConnections();
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }
});

test("account loading is explicit and returns only usable account IDs and names", async () => {
  const local = await fixture((request, response) => {
    assert.equal(request.url, "/Users");
    json(response, [
      {
        Id: "user-1",
        Name: "本地账户",
        Password: "not returned",
        Policy: { IsDisabled: false },
      },
      { Id: "disabled", Name: "停用", Policy: { IsDisabled: true } },
      { Id: "../unsafe", Name: "bad id" },
    ]);
  });
  try {
    local.config.library.profile = "emby";
    assert.deepEqual(await listLibraryUsers(local.config), [
      { id: "user-1", name: "本地账户" },
    ]);
    assert.equal(local.requests.length, 1);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(listLibraryUsers(local.config, aborted.signal));
    assert.equal(local.requests.length, 1);
  } finally {
    await local.close();
  }
});
