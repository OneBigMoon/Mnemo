import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, appendFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DownloadTask, ResolvedShareFile, ShareService } from "../shared/types.ts";
import { createMediaService, normalizePanSou } from "../server/media.ts";
import { defaults } from "../server/store.ts";

const REFERENCE = `mori-share:${"a".repeat(64)}`;
const VIDEO = Buffer.concat([
  Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]),
  Buffer.alloc(128 * 1024, 7),
]);
const SHA1 = createHash("sha1").update(VIDEO).digest("hex");
const CUT = 8192;

function task(id = "cloud-fixture"): DownloadTask {
  return {
    id,
    title: "测试影片",
    url: REFERENCE,
    kind: "cloud",
    status: "queued",
    progress: 0,
    bytes: 0,
    total: 0,
    media: { type: "movie", title: "测试影片", year: 2024 },
    profile: "jellyfin",
    createdAt: "2026-10-24T00:00:00Z",
    updatedAt: "2026-10-24T00:00:00Z",
  };
}

function resolved(url: string, overrides: Partial<ResolvedShareFile> = {}): ResolvedShareFile {
  return {
    url,
    name: "测试影片.2024.mkv",
    size: VIDEO.length,
    sha1: SHA1,
    contentId: "fixture-share-file-content",
    headers: { "User-Agent": "Mozilla/5.0" },
    ...overrides,
  };
}

function resolvedAlipan(
  url: string,
  overrides: Partial<ResolvedShareFile> = {},
): ResolvedShareFile {
  return resolved(url, {
    provider: "alipan",
    sha1: undefined,
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.alipan.com/" },
    ...overrides,
  });
}

function shares(
  resolve: ShareService["resolve"],
  overrides: Partial<ShareService> = {},
): ShareService {
  return {
    capture: (resource) => resource,
    browse: async () => [],
    directory: () => { throw new Error("Unexpected directory lookup in selected-file download"); },
    scan: async () => { throw new Error("Unexpected directory scan in selected-file download"); },
    resolve,
    testConnection: async () => ({ ok: true, message: "helper ready; account unverified" }),
    ...overrides,
  };
}

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mori-cloud-test-"));
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const config = defaults(directory);
  config.sources.p115Enabled = true;
  return {
    directory,
    config,
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

function sendVideo(
  request: IncomingMessage,
  response: ServerResponse,
  etag = '"cloud-v1"',
  chunked = false,
) {
  const offset = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? "")?.[1] ?? 0);
  response.writeHead(offset ? 206 : 200, {
    "Content-Type": "video/mp4",
    ...(chunked ? {} : { "Content-Length": VIDEO.length - offset }),
    ...(etag ? { ETag: etag } : {}),
    ...(offset ? { "Content-Range": `bytes ${offset}-${VIDEO.length - 1}/${VIDEO.length}` } : {}),
  });
  if (offset) response.end(VIDEO.subarray(offset));
  else {
    response.write(VIDEO.subarray(0, CUT));
    const timer = setTimeout(() => response.end(VIDEO.subarray(CUT)), 50);
    response.once("close", () => clearTimeout(timer));
  }
}

// Paused downloads abort on their first byte report. Only answering the resumed
// Range request completes the body, so the partial cannot race a timer and grow
// into a complete file before cancellation is observed.
function sendInterruptedVideo(
  request: IncomingMessage,
  response: ServerResponse,
  etag = '"cloud-v1"',
  chunked = false,
) {
  const offset = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? "")?.[1] ?? 0);
  response.writeHead(offset ? 206 : 200, {
    "Content-Type": "video/mp4",
    ...(chunked ? {} : { "Content-Length": VIDEO.length - offset }),
    ...(etag ? { ETag: etag } : {}),
    ...(offset ? { "Content-Range": `bytes ${offset}-${VIDEO.length - 1}/${VIDEO.length}` } : {}),
  });
  if (offset) response.end(VIDEO.subarray(offset));
  else response.write(VIDEO.subarray(0, CUT));
}

async function pauseDownload(
  service: ReturnType<typeof createMediaService>,
  item: DownloadTask,
  directory: string,
) {
  const controller = new AbortController();
  const progress: number[] = [];
  await assert.rejects(service.download(item, controller.signal, (report) => {
    progress.push(report.progress);
    if (report.bytes) controller.abort();
  }));
  assert(!progress.includes(100));
  const part = await partial(directory);
  assert(part.bytes.length > 0 && part.bytes.length < VIDEO.length);
}

async function partial(directory: string) {
  const filename = (await readdir(directory)).find((name) => name.endsWith(".part"));
  assert(filename);
  return { filename, bytes: await readFile(path.join(directory, filename)) };
}

test("PanSou keeps independent extraction codes through duplicate normalization", () => {
  const url = "https://115.com/s/fixture";
  const normalized = normalizePanSou({ data: {
    merged_by_type: { p115: [{ url, title: "测试影片", password: "ab12" }] },
    results: [{ links: [{ url }] }],
  } });
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].extractionCode, "ab12");
  assert.equal(normalizePanSou({ results: [{
    title: "测试影片", password: "cd34", links: [{ url }],
  }] })[0].extractionCode, "cd34");
  assert.equal(normalizePanSou({ results: [{ url, 提取码: "ef56" }] })[0].extractionCode, "ef56");
});

test("search captures private share context, omits public codes and rejects forged cloud URIs", async () => {
  const local = await fixture((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ results: [
      { url: "https://115.com/s/fixture?password=ab12", title: "测试影片", password: "ab12" },
      { url: REFERENCE, title: "forged file", kind: "cloud" },
    ] }));
  });
  try {
    local.config.sources.pansouUrl = local.url;
    local.config.sources.p115Enabled = false;
    let capturedCode: string | undefined;
    const provider = shares(async () => { throw new Error("not dispatched"); }, {
      capture(resource) {
        capturedCode = resource.extractionCode;
        return { ...resource, url: "https://115.com/s/fixture", shareRef: REFERENCE };
      },
    });
    const results = await createMediaService(() => local.config, provider).search("测试影片");
    assert.equal(capturedCode, "ab12");
    assert.equal(results.length, 1);
    assert.equal(results[0].kind, "share");
    assert.equal(results[0].shareRef, REFERENCE);
    assert.equal("extractionCode" in results[0], false);
    assert.equal(results[0].url, "https://115.com/s/fixture");
    const withoutProvider = await createMediaService(() => local.config).search("测试影片");
    assert.equal("extractionCode" in withoutProvider[0], false);
  } finally {
    await local.close();
  }
});

test("share browsing and readiness delegate without treating readiness as account acceptance", async () => {
  const local = await fixture((_request, response) => response.end());
  try {
    const controller = new AbortController();
    const resources = [{ id: "folder", title: "folder", source: "115", url: REFERENCE, shareRef: REFERENCE, kind: "share" as const, navigation: "folder" as const }];
    const provider = shares(async () => resolved("unused"), {
      async browse(reference, code, signal) {
        assert.equal(reference, REFERENCE);
        assert.equal(code, "ab12");
        assert.equal(signal, controller.signal);
        return resources;
      },
    });
    const service = createMediaService(() => local.config, provider);
    assert.deepEqual(await service.browseShare!(REFERENCE, "ab12", controller.signal), resources);
    assert.match((await service.testConnection("p115")).message, /account unverified/);
    assert.equal((await createMediaService(() => local.config).testConnection("p115")).ok, false);
  } finally {
    await local.close();
  }
});

test("cloud refreshes temporary URLs, resumes chunked content and uses native even with aria2 configured", async () => {
  const requests: { path?: string; range?: string; ua?: string }[] = [];
  let rpcCalls = 0;
  const local = await fixture((request, response) => {
    if (request.url === "/jsonrpc") rpcCalls++;
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.authorization, undefined);
    requests.push({ path: request.url, range: request.headers.range, ua: request.headers["user-agent"] });
    sendInterruptedVideo(request, response, '"cloud-v1"', !request.headers.range);
  });
  try {
    local.config.download.aria2Url = `${local.url}/jsonrpc`;
    let resolutions = 0;
    const provider = shares(async (reference) => {
      assert.equal(reference, REFERENCE);
      return resolved(`${local.url}/attempt-${++resolutions}.mp4?temporary=fixture`);
    });
    const service = createMediaService(() => local.config, provider);
    const item = task();
    const initialTask = JSON.stringify(item);
    await pauseDownload(service, item, local.directory);
    const before = await partial(local.directory);
    assert(before.bytes.length > 0 && before.bytes.length < VIDEO.length);
    const metadataName = (await readdir(local.directory)).find((name) => name.endsWith(".json"));
    assert(metadataName);
    const metadata = await readFile(path.join(local.directory, metadataName), "utf8");
    assert(!metadata.includes(local.url));
    assert(!metadata.includes("temporary="));
    assert(!metadata.includes("User-Agent"));
    const reports: number[] = [];
    const downloaded = await service.download(item, new AbortController().signal, (report) => reports.push(report.progress));
    assert.equal(resolutions, 2);
    assert.equal(rpcCalls, 0);
    assert.match(requests[0].path!, /^\/attempt-1/);
    assert.match(requests[1].path!, /^\/attempt-2/);
    assert.equal(requests[1].range, `bytes=${before.bytes.length}-`);
    assert(requests.every((request) => request.ua === "Mozilla/5.0"));
    assert.equal(path.basename(downloaded), "测试影片 (2024).mkv");
    assert.deepEqual(await readFile(downloaded), VIDEO);
    assert.equal(reports.at(-1), 100);
    assert.deepEqual(await readdir(local.directory), [path.basename(downloaded)]);
    assert.equal(JSON.stringify(item), initialTask);
  } finally {
    await local.close();
  }
});

test("weak ETags resume by Last-Modified across refreshed cloud URLs and reject changed validators", async (t) => {
  const firstModified = "Fri, 23 Oct 2026 00:00:00 GMT";
  for (const [name, modified] of [
    ["stable", firstModified],
    ["changed", "Sat, 24 Oct 2026 00:00:00 GMT"],
    ["missing", ""],
  ]) await t.test(name, async () => {
    const requests: { path?: string; range?: string }[] = [];
    const local = await fixture((request, response) => {
      const resumed = requests.length > 0;
      if (resumed) assert.equal(request.headers["if-range"], firstModified);
      const lastModified = resumed ? modified : firstModified;
      if (lastModified) response.setHeader("Last-Modified", lastModified);
      requests.push({ path: request.url, range: request.headers.range });
      sendInterruptedVideo(request, response, 'W/"cloud-v1"');
    });
    try {
      let resolutions = 0;
      const service = createMediaService(() => local.config, shares(async () =>
        resolved(`${local.url}/attempt-${++resolutions}.mp4`),
      ));
      await pauseDownload(service, task(), local.directory);
      const before = await partial(local.directory);
      const progress: number[] = [];
      const download = service.download(task(), new AbortController().signal, (report) => progress.push(report.progress));
      if (name === "stable") {
        const downloaded = await download;
        assert.deepEqual(await readFile(downloaded), VIDEO);
        assert.equal(progress.at(-1), 100);
      } else {
        await assert.rejects(download, /断点范围/);
        assert.deepEqual((await partial(local.directory)).bytes, before.bytes);
        assert(!progress.includes(100));
      }
      assert.equal(resolutions, 2);
      assert.deepEqual(requests.map((request) => request.path), ["/attempt-1.mp4", "/attempt-2.mp4"]);
      assert.equal(requests[1].range, `bytes=${before.bytes.length}-`);
    } finally {
      await local.close();
    }
  });
});

test("a transfer completing before cancellation is reused as a verified complete partial", async () => {
  let requests = 0;
  const local = await fixture((request, response) => {
    requests++;
    response.setHeader("Last-Modified", "Fri, 23 Oct 2026 00:00:00 GMT");
    sendInterruptedVideo(request, response, 'W/"cloud-v1"', !request.headers.range);
  });
  try {
    let resolutions = 0;
    const service = createMediaService(() => local.config, shares(async () =>
      resolved(`${local.url}/attempt-${++resolutions}.mp4`),
    ));
    await pauseDownload(service, task(), local.directory);
    const before = await partial(local.directory);
    assert(before.bytes.length > 0 && before.bytes.length < VIDEO.length);
    // Models a loaded event loop in which the tail had already arrived and been
    // written before cancellation was observed, leaving a complete but unpublished
    // part. Reuse must verify and publish it without issuing a Range request
    // against a refreshed URL.
    await appendFile(path.join(local.directory, before.filename), VIDEO.subarray(before.bytes.length));
    const progress: number[] = [];
    const downloaded = await service.download(task(), new AbortController().signal, (report) => progress.push(report.progress));
    assert.deepEqual(await readFile(downloaded), VIDEO);
    assert.equal(progress.at(-1), 100);
    assert.equal(resolutions, 2);
    assert.equal(requests, 1);
  } finally {
    await local.close();
  }
});

test("cloud uses the fixed User-Agent across a redirect without account headers", async () => {
  const seen: string[] = [];
  const local = await fixture((request, response) => {
    assert.equal(request.headers["user-agent"], "Mozilla/5.0");
    assert.equal(request.headers.referer, undefined);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    seen.push(request.url!);
    if (request.url === "/redirect") response.writeHead(302, { Location: "/media.mp4" }).end();
    else sendVideo(request, response);
  });
  try {
    const service = createMediaService(() => local.config, shares(async () => resolved(`${local.url}/redirect`)));
    const downloaded = await service.download(task(), new AbortController().signal, () => {});
    assert.deepEqual(seen, ["/redirect", "/media.mp4"]);
    assert.deepEqual(await readFile(downloaded), VIDEO);
  } finally {
    await local.close();
  }
});

test("changed cloud identity, expected size or SHA1 refuses to append an existing partial", async (t) => {
  for (const changed of [
    { contentId: "different-content" },
    { size: VIDEO.length + 1 },
    { sha1: "0".repeat(40) },
  ]) await t.test(Object.keys(changed)[0], async () => {
    let requests = 0;
    const local = await fixture((request, response) => { requests++; sendInterruptedVideo(request, response); });
    try {
      let resolutions = 0;
      const provider = shares(async () => resolved(`${local.url}/media.mp4`, ++resolutions === 1 ? {} : changed));
      const service = createMediaService(() => local.config, provider);
      await pauseDownload(service, task(), local.directory);
      const before = await partial(local.directory);
      await assert.rejects(service.download(task(), new AbortController().signal, () => {}), /临时文件与当前下载不匹配/);
      assert.equal(requests, 1);
      assert.deepEqual((await partial(local.directory)).bytes, before.bytes);
    } finally {
      await local.close();
    }
  });
});

test("changed or missing response ETag cannot append a cloud partial", async (t) => {
  for (const etag of ['"cloud-v2"', ""]) await t.test(etag || "missing", async () => {
    let requests = 0;
    const local = await fixture((request, response) => sendInterruptedVideo(request, response, ++requests === 1 ? '"cloud-v1"' : etag));
    try {
      const service = createMediaService(() => local.config, shares(async () => resolved(`${local.url}/media.mp4`)));
      await pauseDownload(service, task(), local.directory);
      const before = await partial(local.directory);
      await assert.rejects(service.download(task(), new AbortController().signal, () => {}), /断点范围/);
      assert.deepEqual((await partial(local.directory)).bytes, before.bytes);
    } finally {
      await local.close();
    }
  });
});

test("cloud filename mismatch, unsafe headers and malformed references stop before HTTP dispatch", async (t) => {
  const cases: Partial<ResolvedShareFile>[] = [
    { name: "测试影片.1999.mkv" },
    { headers: { "User-Agent": "Mozilla/5.0", Cookie: "fixture-private" } },
    { headers: { "User-Agent": "Mozilla/5.0", Authorization: "fixture-private" } },
    { headers: { "User-Agent": "different-agent" } },
  ];
  for (const changed of cases) await t.test(changed.name ? "name" : "headers", async () => {
    let requests = 0;
    const local = await fixture((_request, response) => { requests++; response.end(); });
    try {
      const service = createMediaService(() => local.config, shares(async () => resolved(`${local.url}/media.mp4`, changed)));
      await assert.rejects(service.download(task(), new AbortController().signal, () => {}), /不匹配|User-Agent/);
      await assert.rejects(service.download({ ...task(), url: "mori-share:not-issued" }, new AbortController().signal, () => {}), /引用无效/);
      assert.equal(requests, 0);
      assert.deepEqual(await readdir(local.directory), []);
    } finally {
      await local.close();
    }
  });
});

test("size and SHA1 failures never publish or report completion, including complete-partial retry", async (t) => {
  for (const changed of [{ size: VIDEO.length + 1 }, { sha1: "0".repeat(40) }])
    await t.test(Object.keys(changed)[0], async () => {
      const local = await fixture(sendVideo);
      try {
        const service = createMediaService(() => local.config, shares(async () => resolved(`${local.url}/media.mp4`, changed)));
        const progress: number[] = [];
        for (let attempt = 0; attempt < 2; attempt++)
          await assert.rejects(service.download(task(), new AbortController().signal, (report) => progress.push(report.progress)), /大小|SHA1/);
        assert(!progress.includes(100));
        assert((await readdir(local.directory)).every((name) => name.startsWith(".mori-")));
      } finally {
        await local.close();
      }
    });
});

test("cloud no-replace publication preserves an existing media file", async () => {
  const local = await fixture(sendVideo);
  try {
    const destination = path.join(local.directory, "测试影片 (2024).mkv");
    await writeFile(destination, "existing-media");
    const service = createMediaService(() => local.config, shares(async () => resolved(`${local.url}/media.mp4`)));
    await assert.rejects(service.download(task(), new AbortController().signal, () => {}), /已存在/);
    assert.equal(await readFile(destination, "utf8"), "existing-media");
  } finally {
    await local.close();
  }
});

test("media close awaits the delegated Shares drain", async () => {
  const settings = defaults(os.tmpdir());
  let release!: () => void;
  const draining = new Promise<void>((resolve) => { release = resolve; });
  let forwarded = 0;
  const provider = shares(async () => resolved("unused"), {
    async close() {
      forwarded++;
      await draining;
    },
  });
  const service = createMediaService(() => settings, provider);
  assert.equal(typeof service.close, "function");
  let settled = false;
  const closing = service.close!();
  void closing.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(forwarded, 1);
  assert.equal(settled, false);
  release();
  await closing;
  assert.equal(settled, true);
  assert.equal(forwarded, 1);
  await createMediaService(() => settings).close!();
  await createMediaService(() => settings, shares(async () => resolved("unused"))).close!();
});

test("identify cancellation reaches actual TMDB fetch and keeps legacy calls", { timeout: 2000 }, async (t) => {
  const settings = defaults(os.tmpdir());
  settings.sources.tmdbApiKey = "fixture-identify-key";
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let observed: AbortSignal | undefined;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, "https://api.themoviedb.org");
    assert.equal(url.pathname, "/3/search/tv");
    if (++calls === 1) {
      const signal = init?.signal;
      assert(signal);
      assert.equal(signal.aborted, false);
      observed = signal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        entered();
      });
    }
    return new Response(JSON.stringify({ results: [{
      id: 7, media_type: "tv", name: "Fixture Show", first_air_date: "2023-01-01",
    }] }), { headers: { "Content-Type": "application/json" } });
  });
  const service = createMediaService(() => settings);
  const controller = new AbortController();
  const pending = service.identify("Fixture Show", "tv", controller.signal);
  await started;
  const reason = new DOMException("fixture identify cancellation", "AbortError");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(observed?.aborted, true);
  const legacy = await service.identify("Fixture Show", "tv");
  assert.equal(legacy[0].title, "Fixture Show");
  assert.equal(legacy[0].tmdbId, 7);
  assert.equal(calls, 2);
});

test("Alipan readiness preserves stable authorization codes", async () => {
  const expected = { ok: false, message: "fixture authorization required", code: "ALIPAN_AUTH_REQUIRED" };
  const provider = shares(async () => resolvedAlipan("unused"), {
    async testConnection(provider) {
      assert.equal(provider, "alipan");
      return expected;
    },
  });
  const service = createMediaService(() => defaults(os.tmpdir()), provider);
  assert.equal(await service.testConnection("alipan"), expected);
});

test("Alipan readiness forwards its provider while p115 remains the default", async () => {
  const local = await fixture((_request, response) => response.end());
  try {
    const checked: string[] = [];
    const provider = shares(async () => resolvedAlipan("unused"), {
      async testConnection(provider = "p115") {
        checked.push(provider);
        return { ok: true, message: "local adapter ready; account unverified" };
      },
    });
    const service = createMediaService(() => local.config, provider);
    assert.equal((await service.testConnection("alipan")).ok, true);
    assert.equal((await service.testConnection("p115")).ok, true);
    assert.equal((await provider.testConnection()).ok, true);
    assert.equal((await provider.testConnection("p115")).ok, true);
    assert.deepEqual(checked, ["alipan", "p115", "p115", "p115"]);
    assert.equal((await createMediaService(() => local.config).testConnection("alipan")).ok, false);
  } finally {
    await local.close();
  }
});

test("Alipan sends only fixed public headers through a CDN redirect without inventing a SHA1", async () => {
  const payload = Buffer.from(VIDEO);
  payload[payload.length - 1] ^= 1;
  assert.notEqual(createHash("sha1").update(payload).digest("hex"), SHA1);
  const seen: string[] = [];
  const checkHeaders = (request: IncomingMessage) => {
    assert.equal(request.headers["user-agent"], "Mozilla/5.0");
    assert.equal(request.headers.referer, "https://www.alipan.com/");
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["x-share-token"], undefined);
  };
  const cdn = await fixture((request, response) => {
    checkHeaders(request);
    seen.push("cdn");
    response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": payload.length });
    response.end(payload);
  });
  const local = await fixture((request, response) => {
    checkHeaders(request);
    seen.push("redirect");
    response.writeHead(302, { Location: `${cdn.url}/file.mp4?temporary=cdn-fixture` }).end();
  });
  try {
    local.config.sources.alipanEnabled = true;
    const service = createMediaService(() => local.config, shares(async () => resolvedAlipan(`${local.url}/file`, {
      headers: { "uSeR-aGeNt": "Mozilla/5.0", rEfErEr: "https://www.alipan.com/" },
    })));
    const downloaded = await service.download(task(), new AbortController().signal, () => {});
    assert.deepEqual(seen, ["redirect", "cdn"]);
    assert.deepEqual(await readFile(downloaded), payload);
  } finally {
    await local.close();
    await cdn.close();
  }
});

test("Alipan refreshes signed links and resumes by stable content identity and Last-Modified without SHA1", async () => {
  const modified = "Fri, 23 Oct 2026 00:00:00 GMT";
  const requests: { url?: string; range?: string; validator?: string | string[] }[] = [];
  let rpcCalls = 0;
  const local = await fixture((request, response) => {
    if (request.url === "/jsonrpc") rpcCalls++;
    assert.equal(request.headers["user-agent"], "Mozilla/5.0");
    assert.equal(request.headers.referer, "https://www.alipan.com/");
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["x-share-token"], undefined);
    requests.push({ url: request.url, range: request.headers.range, validator: request.headers["if-range"] });
    response.setHeader("Last-Modified", modified);
    sendInterruptedVideo(request, response, 'W/"alipan-content"', !request.headers.range);
  });
  try {
    local.config.sources.alipanEnabled = true;
    local.config.download.aria2Url = `${local.url}/jsonrpc`;
    let attempts = 0;
    const service = createMediaService(() => local.config, shares(async () =>
      resolvedAlipan(`${local.url}/link-${++attempts}.mp4?signature=fixture-${attempts}`),
    ));
    const item = task("alipan-resume");
    const initial = JSON.stringify(item);
    await pauseDownload(service, item, local.directory);
    const before = await partial(local.directory);
    const metadataName = (await readdir(local.directory)).find((name) => name.endsWith(".json"));
    assert(metadataName);
    const raw = await readFile(path.join(local.directory, metadataName), "utf8");
    const metadata = JSON.parse(raw);
    assert.equal(metadata.source, createHash("sha256").update(`fixture-share-file-content\0${VIDEO.length}\0`).digest("hex"));
    assert.equal(metadata.validator, modified);
    assert.equal("sha1" in metadata, false);
    assert(!raw.includes(local.url));
    assert(!raw.includes("signature="));
    assert(!raw.includes("fixture-1"));
    assert(!raw.includes("Referer"));
    const downloaded = await service.download(item, new AbortController().signal, () => {});
    assert.equal(attempts, 2);
    assert.equal(rpcCalls, 0);
    assert.deepEqual(requests.map((request) => request.url), ["/link-1.mp4?signature=fixture-1", "/link-2.mp4?signature=fixture-2"]);
    assert.equal(requests[1].range, `bytes=${before.bytes.length}-`);
    assert.equal(requests[1].validator, modified);
    assert.deepEqual(await readFile(downloaded), VIDEO);
    assert.equal(JSON.stringify(item), initial);
  } finally {
    await local.close();
  }
});

test("Alipan rejects oversized or undersized streamed bytes without SHA1 and never publishes", async (t) => {
  for (const difference of [-1, 1]) await t.test(difference < 0 ? "oversized bytes" : "undersized bytes", async () => {
    const local = await fixture((request, response) => sendVideo(request, response, '"alipan-size"', true));
    try {
      const service = createMediaService(() => local.config, shares(async () => resolvedAlipan(`${local.url}/file.mp4`, { size: VIDEO.length + difference })));
      const reports: number[] = [];
      await assert.rejects(service.download(task(), new AbortController().signal, (report) => reports.push(report.progress)), /大小|长度/);
      assert(!reports.includes(100));
      assert((await readdir(local.directory)).every((name) => name.startsWith(".mori-")));
    } finally {
      await local.close();
    }
  });
});

test("Alipan rejects credentials, arbitrary or duplicate headers before dispatch and p115 cannot gain a Referer", async (t) => {
  const fixed = { "User-Agent": "Mozilla/5.0", Referer: "https://www.alipan.com/" };
  const cases: Partial<ResolvedShareFile>[] = [
    { headers: { "User-Agent": "Mozilla/5.0" } },
    { headers: { Referer: fixed.Referer } },
    { headers: { ...fixed, "User-Agent": "custom-agent" } },
    { headers: { ...fixed, Referer: "https://www.alipan.com" } },
    { headers: { ...fixed, Referer: "https://untrusted.invalid/" } },
    { headers: { ...fixed, Cookie: "fixture-private-cookie" } },
    { headers: { ...fixed, Authorization: "fixture-private-authorization" } },
    { headers: { ...fixed, "x-share-token": "fixture-private-share" } },
    { headers: { ...fixed, "X-Custom": "fixture-custom" } },
    { headers: { ...fixed, "user-agent": fixed["User-Agent"] } },
    { headers: { ...fixed, referer: fixed.Referer } },
    { headers: { "User-Agent": "Mozilla/5.0", "user-agent": "Mozilla/5.0" } },
    { provider: "p115", headers: fixed },
    { provider: undefined, headers: fixed },
  ];
  for (const [index, changed] of cases.entries()) await t.test(`headers-${index}`, async () => {
    let requests = 0;
    const local = await fixture((_request, response) => { requests++; response.end(); });
    try {
      const service = createMediaService(() => local.config, shares(async () => resolvedAlipan(`${local.url}/file.mp4?signature=fixture-private-query`, changed)));
      await assert.rejects(service.download(task(), new AbortController().signal, () => {}), (error: Error) => {
        assert.match(error.message, /固定|User-Agent|Referer/);
        assert(!error.message.includes("fixture-private"));
        assert(!error.message.includes(local.url));
        return true;
      });
      assert.equal(requests, 0);
      assert.deepEqual(await readdir(local.directory), []);
    } finally {
      await local.close();
    }
  });
});

test("an explicit unknown cloud provider is rejected rather than receiving the p115 header contract", async () => {
  let requests = 0;
  const local = await fixture((_request, response) => { requests++; sendVideo(_request, response); });
  try {
    const invalid = { ...resolved(`${local.url}/file.mp4`), provider: "unrecognized" } as unknown as ResolvedShareFile;
    const service = createMediaService(() => local.config, shares(async () => invalid));
    await assert.rejects(service.download(task(), new AbortController().signal, () => {}), /无效/);
    assert.equal(requests, 0);
    assert.deepEqual(await readdir(local.directory), []);
  } finally {
    await local.close();
  }
});

test("Alipan HTTP failures do not expose signed query parameters or provider response bodies", async () => {
  const local = await fixture((_request, response) => {
    response.writeHead(403, { "Content-Type": "text/plain" });
    response.end("fixture-provider-private-body");
  });
  try {
    const service = createMediaService(() => local.config, shares(async () => resolvedAlipan(`${local.url}/file.mp4?signature=fixture-private-query`)));
    const item = task();
    await assert.rejects(service.download(item, new AbortController().signal, () => {}), (error: Error) => {
      assert.match(error.message, /HTTP 403/);
      assert(!error.message.includes(local.url));
      assert(!error.message.includes("fixture-private-query"));
      assert(!error.message.includes("fixture-provider-private-body"));
      return true;
    });
    assert.equal(item.url, REFERENCE);
    assert.deepEqual(await readdir(local.directory), []);
  } finally {
    await local.close();
  }
});

test("cancellation during share resolution prevents late HTTP work and unsafe errors omit temporary URLs", async () => {
  let requests = 0;
  const local = await fixture((_request, response) => { requests++; response.end(); });
  try {
    const controller = new AbortController();
    const service = createMediaService(() => local.config, shares(async (_reference, signal) => {
      assert.equal(signal, controller.signal);
      controller.abort();
      return resolved(`${local.url}/late.mp4`);
    }));
    await assert.rejects(service.download(task(), controller.signal, () => {}));
    assert.equal(requests, 0);
    assert.deepEqual(await readdir(local.directory), []);
    const failed = createMediaService(() => local.config, shares(async () => { throw new Error(`${local.url}/temporary-private`); }));
    await assert.rejects(failed.download(task(), new AbortController().signal, () => {}), (error: Error) => {
      assert(!error.message.includes(local.url));
      assert(!error.message.includes("temporary-private"));
      return true;
    });
  } finally {
    await local.close();
  }
});
