import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { DownloadTask, ShareService } from "../shared/types.ts";
import {
  createMediaService, downloadResponse, MediaError, typescriptDownloadResponse,
  type DownloadResponseInput,
} from "../server/media.ts";
import { runRustCore, RustCoreError } from "../server/rust-core.ts";
import { defaults } from "../server/store.ts";

const LIMIT = 200 * 1024 ** 3;
const MODIFIED = "Fri, 23 Oct 2026 00:00:00 GMT";
const REFERENCE = `mori-share:${"a".repeat(64)}`;
const input = (overrides: Partial<DownloadResponseInput> = {}): DownloadResponseInput => ({
  status: 200, offset: 0, contentLength: "128", contentEncoding: "identity",
  etag: '"v1"', lastModified: "", contentRange: "", ...overrides,
});
const resumed = input({
  status: 206, offset: 64, priorTotal: 128, priorValidator: '"v1"',
  contentLength: "64", contentRange: "bytes 64-127/128",
});
type Decision = ReturnType<typeof typescriptDownloadResponse>;
const rangeError = ["INVALID_RANGE", "服务器返回不匹配的断点范围，未追加临时文件"] as const;
const lengthError = ["FILE_TOO_LARGE", "媒体文件大小无效或超过 200 GiB 上限"] as const;
const cases: {
  name: string;
  input: DownloadResponseInput;
  result?: Decision;
  error?: readonly [string, string];
}[] = [
  { name: "200 starts a file", input: input(), result: { offset: 0, total: 128, validator: '"v1"' } },
  { name: "200 restarts an old partial", input: { ...resumed, status: 200, contentLength: "256", etag: '"v2"' }, result: { offset: 0, total: 256, validator: '"v2"' } },
  { name: "200 restart preserves a 9002-character ASCII ETag", input: { ...resumed, status: 200, contentLength: "256", etag: '"' + "a".repeat(9000) + '"' }, result: { offset: 0, total: 256, validator: '"' + "a".repeat(9000) + '"' } },
  { name: "200 restart preserves a 9002-character Latin1 ETag", input: { ...resumed, status: 200, contentLength: "256", etag: '"' + "é".repeat(9000) + '"' }, result: { offset: 0, total: 256, validator: '"' + "é".repeat(9000) + '"' } },
  { name: "206 appends a matching partial", input: resumed, result: { offset: 64, total: 128, validator: '"v1"' } },
  { name: "206 may start at zero without prior metadata", input: input({ status: 206, contentRange: "bytes 0-127/128" }), result: { offset: 0, total: 128, validator: '"v1"' } },
  { name: "206 uses the range total when Content-Length is absent", input: { ...resumed, contentLength: "" }, result: { offset: 64, total: 128, validator: '"v1"' } },
  { name: "weak ETag uses Last-Modified", input: { ...resumed, etag: 'W/"v2"', lastModified: MODIFIED, priorValidator: MODIFIED }, result: { offset: 64, total: 128, validator: MODIFIED } },
  { name: "missing ETag uses Last-Modified", input: input({ etag: "", lastModified: MODIFIED }), result: { offset: 0, total: 128, validator: MODIFIED } },
  { name: "a strong ETag wins over Last-Modified", input: input({ lastModified: MODIFIED }), result: { offset: 0, total: 128, validator: '"v1"' } },
  { name: "weak ETag alone is not a resume validator", input: input({ etag: 'W/"v1"' }), result: { offset: 0, total: 128, validator: "" } },
  { name: "validator changed", input: { ...resumed, etag: '"v2"' }, error: rangeError },
  { name: "validator disappeared", input: { ...resumed, etag: "" }, error: rangeError },
  { name: "range total changed", input: { ...resumed, contentRange: "bytes 64-127/129" }, error: rangeError },
  { name: "range start changed", input: { ...resumed, contentRange: "bytes 0-63/128" }, error: rangeError },
  { name: "range end precedes start", input: { ...resumed, contentRange: "bytes 64-63/128" }, error: rangeError },
  { name: "range total must exceed end", input: { ...resumed, contentRange: "bytes 64-128/128" }, error: rangeError },
  { name: "range syntax must match exactly", input: { ...resumed, contentRange: "bytes 64-127/*" }, error: rangeError },
  { name: "a resumed range requires its prior metadata", input: { ...resumed, priorTotal: null, priorValidator: null }, error: rangeError },
  { name: "segment length must match", input: { ...resumed, contentLength: "63" }, error: ["INVALID_RANGE", "服务器返回的分段长度不匹配"] },
  { name: "compressed response", input: input({ contentEncoding: "gzip" }), error: ["INVALID_RANGE", "下载服务返回压缩内容，无法安全校验文件长度"] },
  { name: "encoding is compared exactly", input: input({ contentEncoding: "Identity" }), error: ["INVALID_RANGE", "下载服务返回压缩内容，无法安全校验文件长度"] },
  { name: "200 GiB is allowed", input: input({ contentLength: String(LIMIT) }), result: { offset: 0, total: LIMIT, validator: '"v1"' } },
  { name: "200 GiB plus one is rejected", input: input({ contentLength: String(LIMIT + 1) }), error: lengthError },
  { name: "range total cannot exceed 200 GiB", input: input({ status: 206, contentLength: "1", contentRange: `bytes 0-0/${LIMIT + 1}` }), error: ["FILE_TOO_LARGE", "媒体文件超过 200 GiB 上限"] },
  { name: "NaN length", input: input({ contentLength: "NaN" }), error: lengthError },
  { name: "infinite length", input: input({ contentLength: "Infinity" }), error: lengthError },
  { name: "negative length", input: input({ contentLength: "-1" }), error: lengthError },
  { name: "fractional length", input: input({ contentLength: "1.5" }), error: lengthError },
  { name: "an unsafe integer length", input: input({ contentLength: "9007199254740992" }), error: lengthError },
  { name: "absent length is zero", input: input({ contentLength: "" }), result: { offset: 0, total: 0, validator: '"v1"' } },
  { name: "whitespace length is zero", input: input({ contentLength: " \t " }), result: { offset: 0, total: 0, validator: '"v1"' } },
  { name: "decimal exponent follows Number semantics", input: input({ contentLength: "1.28e2" }), result: { offset: 0, total: 128, validator: '"v1"' } },
  { name: "hexadecimal follows Number semantics", input: input({ contentLength: "0x80" }), result: { offset: 0, total: 128, validator: '"v1"' } },
  { name: "binary follows Number semantics", input: input({ contentLength: "0b10000000" }), result: { offset: 0, total: 128, validator: '"v1"' } },
  { name: "octal follows Number semantics", input: input({ contentLength: "0o200" }), result: { offset: 0, total: 128, validator: '"v1"' } },
  { name: "cloud record supplies an absent length", input: input({ contentLength: "", expectedSize: 128 }), result: { offset: 0, total: 128, validator: '"v1"' } },
  { name: "cloud record matches a resumed total", input: { ...resumed, expectedSize: 128 }, result: { offset: 64, total: 128, validator: '"v1"' } },
  { name: "cloud record cannot disagree with response", input: input({ expectedSize: 129 }), error: ["SIZE_MISMATCH", "下载响应大小与云盘记录不符，未写入媒体"] },
];

function engine(t: TestContext, value: "rust" | "typescript") {
  const previous = process.env.MNEMO_CORE;
  process.env.MNEMO_CORE = value;
  t.after(() => {
    if (previous === undefined) delete process.env.MNEMO_CORE;
    else process.env.MNEMO_CORE = previous;
  });
}

test("download response TypeScript reference and real Rust preserve the legacy decisions", async (t) => {
  engine(t, "rust");
  for (const row of cases) await t.test(row.name, async () => {
    if (row.error) {
      const [code, message] = row.error;
      assert.throws(() => typescriptDownloadResponse(row.input), { name: "MediaError", code, message });
      await assert.rejects(downloadResponse(row.input), { name: "MediaError", code, message });
    } else {
      assert.deepEqual(typescriptDownloadResponse(row.input), row.result);
      assert.deepEqual(await downloadResponse(row.input), row.result);
    }
  });
});

test("the explicit TypeScript rollback uses the same decision contract", async (t) => {
  engine(t, "typescript");
  for (const row of cases) {
    if (row.error) {
      const [code, message] = row.error;
      await assert.rejects(downloadResponse(row.input), { name: "MediaError", code, message });
    } else assert.deepEqual(await downloadResponse(row.input), row.result);
  }
});

test("native download response overload and cancellation stay visible without fallback", async (t) => {
  engine(t, "rust");
  const payload = JSON.stringify(input());
  const running = Promise.allSettled(Array.from({ length: 18 }, () => runRustCore("download_response", payload)));
  await assert.rejects(downloadResponse(input()), { name: "RustCoreError", code: "CORE_BUSY" });
  assert((await running).every(result => result.status === "fulfilled"));
  const reason = new Error("fixture cancellation");
  await assert.rejects(downloadResponse(input(), AbortSignal.abort(reason)), error => error === reason);
});

function task(kind: DownloadTask["kind"] = "cloud"): DownloadTask {
  return {
    id: "decision-fixture", title: "Example", url: kind === "cloud" ? REFERENCE : "https://download.example/Example.mp4",
    kind, status: "queued", progress: 0, bytes: 0, total: 0,
    media: { type: "movie", title: "Example" }, profile: "jellyfin",
    createdAt: "2026-10-26T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z",
  };
}

test("a rejected native response cancels its reader before creating partial files", async (t) => {
  engine(t, "rust");
  const directory = await mkdtemp(path.join(os.tmpdir(), "mnemo-download-decision-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 1-127/128", "content-length": "127" } }));
  const service = createMediaService(() => defaults(directory));
  t.after(() => service.close?.());
  await assert.rejects(service.download(task("direct"), new AbortController().signal, () => {}), { code: "INVALID_RANGE" });
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(directory), []);
});

test("cloud download preserves core errors and cancellation while sanitizing unknown provider failures", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mnemo-cloud-decision-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = defaults(directory);
  const controller = new AbortController();
  const reason = new Error("fixture cancellation");
  let cancelOnResolve = false;
  let failure: unknown;
  const shares: ShareService = {
    capture: resource => resource, browse: async () => [],
    directory: () => { throw new Error("unexpected directory"); },
    scan: async () => { throw new Error("unexpected scan"); },
    resolve: async () => {
      if (cancelOnResolve) controller.abort(reason);
      throw failure;
    },
    testConnection: async () => ({ ok: true, message: "fixture" }),
  };
  const service = createMediaService(() => config, shares);
  t.after(() => service.close?.());
  for (const code of ["CORE_UNAVAILABLE", "CORE_BUSY"]) {
    failure = new RustCoreError(code, `fixture ${code}`);
    await assert.rejects(service.download(task(), controller.signal, () => {}), error => error === failure);
  }
  failure = new Error("private provider response");
  await assert.rejects(service.download(task(), controller.signal, () => {}), error =>
    error instanceof MediaError && error.code === "CLOUD_DOWNLOAD_FAILED" && !error.message.includes("private"));
  cancelOnResolve = true;
  await assert.rejects(service.download(task(), controller.signal, () => {}), error => error === reason);
  assert.deepEqual(await readdir(directory), []);
});
