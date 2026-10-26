// Manual only: pipe fresh isolated Emby or Jellyfin settings as JSON on stdin; never use real account settings.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../server/index.js";
import { createMediaService } from "../server/media.js";
import type { AppConfig, ChatReply, DownloadTask, MediaInfo } from "../shared/types.js";

const TITLE = "Mori Playback Fixture";
const QUERY = `${TITLE} 2026`;
const PLOT = "Self-generated three-second video for Mori isolated full-chain playback acceptance.";
const METADATA: MediaInfo = { type: "movie", title: TITLE, year: 2026, overview: PLOT };
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;

type Input = {
  root: string;
  profile: "emby" | "jellyfin";
  libraryBase: string;
  libraryToken: string;
  libraryUserId: string;
};
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function readInput(): Promise<Input> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    assert.ok(size <= 16_384, "stdin settings exceed the fixture limit");
    chunks.push(chunk);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.ok(input && typeof input === "object" && !Array.isArray(input), "expected stdin settings object");
  const settings = input as Record<string, unknown>;
  for (const field of ["root", "libraryBase", "libraryToken", "libraryUserId"])
    assert.ok(typeof settings[field] === "string" && settings[field].length > 0, `missing ${field}`);
  assert.ok(settings.profile === "emby" || settings.profile === "jellyfin", "profile must be emby or jellyfin");
  assert.ok((settings.libraryToken as string).length <= 4096 && !/[\r\n]/.test(settings.libraryToken as string));
  assert.ok(/^[a-zA-Z0-9_-]{1,128}$/.test(settings.libraryUserId as string), "invalid fixture user identifier");
  return settings as Input;
}

async function absent(file: string) {
  const exists = await lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  assert.equal(exists, false, "fixture output or state already exists");
}

async function listen(server: Server) {
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.notEqual(address.port, 4180);
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server?: Server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("fixture operation timed out")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function main() {
  const input = await bounded(readInput(), 5_000).finally(() => process.stdin.destroy());
  assert.ok(path.isAbsolute(input.root), "fixture root must be absolute");
  assert.match(path.basename(input.root), /^mori-fullchain-e2e-[a-zA-Z0-9_-]+$/);
  const rootStat = await lstat(input.root);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "fixture root must be a real directory");
  const root = await realpath(input.root);
  assert.match(path.basename(root), /^mori-fullchain-e2e-[a-zA-Z0-9_-]+$/);
  const libraryBase = new URL(input.libraryBase);
  assert.ok(libraryBase.protocol === "http:" && libraryBase.hostname === "127.0.0.1", "only a loopback media library is permitted");
  assert.ok(!libraryBase.username && !libraryBase.password && !libraryBase.search && !libraryBase.hash);
  const directory = path.join(root, "media");
  const mediaStat = await lstat(directory);
  assert.ok(mediaStat.isDirectory() && !mediaStat.isSymbolicLink());
  assert.equal((await readdir(directory)).length, 0, "media library fixture directory must start empty");
  const state = path.join(root, "mori-state");
  const servedPath = path.join(root, "served.mp4");
  const receiptPath = path.join(root, "receipt.json");
  await Promise.all([absent(state), absent(servedPath), absent(receiptPath)]);
  const sourcePath = path.join(root, "fixture-source.mp4");
  const sourceStat = await lstat(sourcePath);
  assert.ok(sourceStat.isFile() && !sourceStat.isSymbolicLink() && sourceStat.size > 0 && sourceStat.size <= MAX_VIDEO_BYTES);
  const video = await readFile(sourcePath);
  const sourceSha = sha256(video);
  const signal = AbortSignal.timeout(120_000);
  const keywords: string[] = [];
  const identifyQueries: string[] = [];
  const sourceFailures: string[] = [];
  let videoReads = 0;
  let stage = "start loopback source";
  let instance: ReturnType<typeof createApp> | undefined;
  let moriServer: Server | undefined;
  let sourceServer: Server | undefined;
  const receipt: Record<string, unknown> = {
    schemaVersion: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    query: QUERY,
    scope: {
      entry: "rule-supported bare title with trailing year via POST /api/chat",
      metadata: "identify is a single static metadata fixture; no live TMDB lookup",
      search: "native createMediaService search via loopback PanSou HTTP fixture",
      downloadAndNfo: "native download and scrape implementations",
      playback: `real isolated ${input.profile === "emby" ? "Emby" : "Jellyfin"} library verification and full direct stream`,
      model: "disabled by blank model settings",
      publicSource: false,
      qqBridge: false,
    },
    metadata: METADATA,
    source: { file: "fixture-source.mp4", bytes: video.length, sha256: sourceSha },
  };
  try {
    let sourceBase = "";
    const serve = async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method === "POST" && request.url === "/api/search") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          assert.ok(size <= 4096, "search fixture body too large");
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { kw?: unknown };
        assert.equal(body.kw, QUERY, "native PanSou keyword must preserve the selected title and year");
        keywords.push(body.kw as string);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ merged_by_type: { others: [{
          url: `${sourceBase}/video/fixture-source.mp4`,
          note: `${TITLE}.2026.mp4`, source: "isolated full-chain PanSou fixture",
        }] } }));
        return;
      }
      if ((request.method === "GET" || request.method === "HEAD") && request.url === "/video/fixture-source.mp4") {
        let start = 0, end = video.length - 1;
        if (request.headers.range) {
          const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
          if (!range || !Number.isSafeInteger(Number(range[1])) || Number(range[1]) >= video.length || (range[2] && Number(range[2]) < Number(range[1]))) {
            response.writeHead(416, { "Content-Range": `bytes */${video.length}` }).end();
            return;
          }
          start = Number(range[1]);
          end = range[2] ? Math.min(Number(range[2]), end) : end;
        }
        response.writeHead(request.headers.range ? 206 : 200, {
          "Content-Type": "video/mp4", "Content-Length": end - start + 1,
          "Accept-Ranges": "bytes", ETag: `"${sourceSha}"`,
          ...(request.headers.range ? { "Content-Range": `bytes ${start}-${end}/${video.length}` } : {}),
        });
        if (request.method === "GET") { videoReads++; response.end(video.subarray(start, end + 1)); }
        else response.end();
        return;
      }
      response.writeHead(404).end();
    };
    sourceServer = createServer((request, response) => {
      void serve(request, response).catch(() => {
        sourceFailures.push("loopback fixture request failed");
        if (response.headersSent) response.destroy();
        else response.writeHead(500).end();
      });
    });
    sourceBase = await bounded(listen(sourceServer), 5_000);
    stage = "start isolated Mori";
    const native = createMediaService(() => instance!.store.config());
    instance = createApp({
      dataDirectory: state, downloadDirectory: directory, startBackground: false, testMode: true,
      media: {
        ...native,
        identify: async (query, _type, identifySignal) => {
          identifySignal?.throwIfAborted();
          assert.ok(query === TITLE || query === QUERY, "unexpected metadata fixture query");
          identifyQueries.push(query);
          return [{ ...METADATA }];
        },
      },
    });
    moriServer = createServer(instance.app);
    const base = await bounded(listen(moriServer), 5_000);
    let cookie = "";
    const api = (route: string, method = "GET", body?: unknown) => fetch(base + route, {
      method, headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: "error",
    });
    const json = async <T>(route: string, method = "GET", body?: unknown): Promise<T> => {
      const response = await api(route, method, body);
      assert.equal(response.status, 200, `Mori HTTP ${route} failed`);
      return await response.json() as T;
    };
    stage = "HTTP setup and login";
    assert.equal((await api("/api/config", "PUT", { defaultTitleAction: "download" })).status, 401);
    const password = randomUUID() + randomUUID();
    const setup = await api("/api/setup", "POST", { password });
    assert.equal(setup.status, 200);
    await setup.arrayBuffer();
    const login = await api("/api/login", "POST", { password });
    assert.equal(login.status, 200);
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert.ok(cookie, "HTTP login must issue a session cookie");
    await login.arrayBuffer();
    stage = "save default title action and isolated settings";
    const configured = await json<AppConfig>("/api/config", "PUT", {
      defaultTitleAction: "download",
      model: { baseUrl: "", apiKey: "", model: "" },
      sources: { pansouUrl: sourceBase, tmdbApiKey: "", openlistUrl: "", moviePilotUrl: "", telegramChannels: [],
        p115Enabled: false, alipanEnabled: false },
      download: { directory, concurrency: 1, aria2Url: "", aria2Secret: "" },
      library: { profile: input.profile, artwork: false, rename: true, serverUrl: libraryBase.href,
        serverToken: input.libraryToken, userId: input.libraryUserId, pathFrom: directory, pathTo: "/library" },
    });
    assert.equal(configured.defaultTitleAction, "download");
    assert.ok(!instance.store.config().model.apiKey && !instance.store.config().sources.tmdbApiKey);
    assert.equal((await json<AppConfig>("/api/config")).defaultTitleAction, "download");
    stage = "bare title HTTP request and native search";
    const reply = await json<ChatReply>("/api/chat", "POST", { message: QUERY });
    const request = reply.request;
    assert.ok(request, "bare title must enter the Requests flow");
    assert.equal(request.intent, "download");
    assert.equal(request.stage, "completed");
    assert.equal(request.resources.length, 1);
    assert.equal(request.resources[0].match, "matched");
    assert.equal(request.searchDiagnostics?.status, "complete");
    assert.deepEqual(keywords, [QUERY]);
    assert.equal(identifyQueries.length, 1);
    receipt.entry = { intent: request.intent, stage: request.stage, requestId: request.id,
      taskId: request.taskId, resourceCount: request.resources.length, match: request.resources[0].match,
      identifyQueries, pansouPosts: keywords.map((kw) => ({ method: "POST", path: "/api/search", kw })),
      searchDiagnostics: request.searchDiagnostics };
    stage = "wait for native queue completion";
    let task: DownloadTask;
    for (;;) {
      signal.throwIfAborted();
      const tasks = instance.queue.tasks();
      assert.equal(tasks.length, 1, "one bare title must create exactly one task");
      task = tasks[0];
      assert.ok(!["failed", "paused", "needs_attention", "cancelled"].includes(task.status), "native task failed to complete");
      if (task.status === "completed" && !instance.queue.isBusy()) break;
      await delay(200, undefined, { signal });
    }
    assert.equal(task.id, request.taskId);
    assert.equal(task.profile, input.profile);
    assert.ok(task.path);
    const downloaded = await realpath(task.path);
    assert.equal(path.dirname(downloaded), directory);
    const fileStat = await lstat(task.path);
    assert.ok(fileStat.isFile() && !fileStat.isSymbolicLink());
    assert.equal(sha256(await readFile(downloaded)), sourceSha);
    assert.equal(fileStat.size, video.length);
    assert.ok(videoReads > 0, "native downloader must read the loopback video");
    stage = "read and assert native NFO";
    const nfoPath = path.join(directory, path.basename(downloaded, path.extname(downloaded)) + ".nfo");
    const nfoStat = await lstat(nfoPath);
    assert.ok(nfoStat.isFile() && !nfoStat.isSymbolicLink());
    const nfo = await readFile(nfoPath, "utf8");
    assert.equal(/<title>([^<]*)<\/title>/.exec(nfo)?.[1], TITLE);
    assert.equal(/<year>(\d+)<\/year>/.exec(nfo)?.[1], "2026");
    assert.equal(/<plot>([^<]*)<\/plot>/.exec(nfo)?.[1], PLOT);
    assert.ok(!nfo.includes('type="tmdb"'), "fixture NFO must not invent a TMDB identity");
    receipt.download = { taskId: task.id, status: task.status, file: path.relative(root, downloaded),
      bytes: fileStat.size, sha256: sourceSha, sourceHttpReads: videoReads,
      nfo: { file: path.relative(root, nfoPath), sha256: sha256(Buffer.from(nfo)), title: TITLE, year: 2026, plot: PLOT } };
    stage = "verify actual media library and playback source";
    let verified = await instance.queue.verifyLibrary(task.id, signal);
    for (let attempt = 1; attempt < 3 && verified.library?.status === "pending"; attempt++) {
      await delay(1_000, undefined, { signal });
      verified = await instance.queue.verifyLibrary(task.id, signal);
    }
    assert.equal(verified.library?.status, "verified");
    assert.equal(verified.library.playable, true);
    assert.equal(verified.library.serverPath, `/library/${path.basename(downloaded)}`);
    const itemId = verified.library.itemId;
    assert.ok(itemId && /^[a-zA-Z0-9_-]{1,128}$/.test(itemId), "media library must return a safe playable item identifier");
    receipt.library = { profile: input.profile, status: verified.library.status, playable: verified.library.playable,
      itemId, serverPath: verified.library.serverPath };
    stage = "read full actual media library stream";
    const stream = new URL(libraryBase);
    stream.pathname = stream.pathname.replace(/\/$/, "") + `/Videos/${encodeURIComponent(itemId)}/stream.mp4`;
    stream.searchParams.set("Static", "true");
    if (input.profile === "emby") stream.searchParams.set("UserId", input.libraryUserId);
    const response = await fetch(stream, {
      headers: { "X-Emby-Token": input.libraryToken, "Accept-Encoding": "identity" }, signal, redirect: "error",
    });
    assert.equal(response.status, 200);
    const served = Buffer.from(await response.arrayBuffer());
    assert.equal(served.length, video.length);
    assert.equal(sha256(served), sourceSha, "full media library stream must equal the generated source");
    assert.equal(instance.queue.tasks().length, 1);
    assert.deepEqual(sourceFailures, []);
    stage = "publish served video artifact";
    await writeFile(servedPath, served, { flag: "wx" });
    receipt.stream = { status: response.status, file: "served.mp4", bytes: served.length, sha256: sha256(served) };
    receipt.status = "passed";
  } catch {
    receipt.status = "failed";
    receipt.failedStage = stage;
    process.exitCode = 1;
  } finally {
    const failures: string[] = [];
    const closers: [string, () => Promise<void>][] = [
      ["Mori", async () => { await instance?.close(); }],
      ["Mori HTTP", () => closeServer(moriServer)],
      ["source HTTP", () => closeServer(sourceServer)],
    ];
    for (const [name, close] of closers) {
      try { await bounded(close(), 10_000); }
      catch { failures.push(name); }
    }
    receipt.cleanup = { servicesClosed: failures.length === 0, failures, rootAndDocker: "owned by caller" };
    if (failures.length) { receipt.status = "failed"; receipt.failedStage ??= "close own services"; process.exitCode = 1; }
  }
  receipt.finishedAt = new Date().toISOString();
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify({ status: receipt.status, receipt: receiptPath, failedStage: receipt.failedStage }) + "\n");
}

main().catch(() => {
  // Raw errors can contain authenticated upstream URLs or settings; keep failure output credential-free.
  process.stderr.write("Full-chain fixture failed before a safe receipt could be written.\n");
  process.exitCode = 1;
});
