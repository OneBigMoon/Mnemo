import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readEnv } from "./env.js";
import type { CmsDetail } from "./cms-detail.js";

export const CORE_PAYLOAD_LIMIT = 4 * 1024 * 1024;
const BINARY = fileURLToPath(new URL(`../bin/mnemo-core${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const MAX_ACTIVE = 2;
const MAX_WAITING = 16;
let active = 0;
const waiting: (() => void)[] = [];

export class RustCoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RustCoreError";
  }
}

export function coreEngine(): "rust" | "typescript" {
  const value = readEnv("CORE") ?? "rust";
  if (value !== "rust" && value !== "typescript")
    throw new RustCoreError("CORE_CONFIG", "MNEMO_CORE 只支持 rust 或 typescript");
  return value;
}

interface CoreResults {
  password_verify: { matches: boolean };
  download_response: { offset: number; total: number; validator: string };
  cms_list: { items: { id: string; name: string; remarks?: string }[] };
  cms_detail: { details: CmsDetail[] };
  feed: {
    kind: "rss" | "atom";
    items: { title: string | null; url: string | null; guid: string | null; published: string | null; description: string | null; size_bytes: number | null }[];
    skipped: number;
  };
}

async function acquire(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  if (active >= MAX_ACTIVE) {
    if (waiting.length >= MAX_WAITING)
      throw new RustCoreError("CORE_BUSY", "解析任务已满，请稍后重试");
    await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener("abort", abort); resolve(); };
      const abort = () => {
        const index = waiting.indexOf(ready);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      };
      waiting.push(ready);
      signal.addEventListener("abort", abort, { once: true });
    });
  } else {
    active++;
  }
  return () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validResult(op: keyof CoreResults, value: unknown): boolean {
  if (!record(value)) return false;
  if (op === "password_verify") return typeof value.matches === "boolean";
  if (op === "download_response") return Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 &&
    Number.isSafeInteger(value.total) && Number(value.total) >= 0 && Number(value.total) <= 200 * 1024 ** 3 &&
    Number(value.offset) <= Number(value.total) && typeof value.validator === "string" && value.validator.length <= 16384;
  if (op === "cms_list") return Array.isArray(value.items) && value.items.length <= 1000 &&
    value.items.every(item => record(item) && typeof item.id === "string" && typeof item.name === "string" &&
      (item.remarks === undefined || typeof item.remarks === "string"));
  if (op === "cms_detail") return Array.isArray(value.details) && value.details.length <= 1000 &&
    value.details.every(item => record(item) && typeof item.id === "string" && typeof item.name === "string" &&
      Array.isArray(item.playGroups) && item.playGroups.every(group => Array.isArray(group) &&
        group.every(episode => record(episode) && typeof episode.name === "string" && typeof episode.url === "string")));
  return ["rss", "atom"].includes(String(value.kind)) && Number.isSafeInteger(value.skipped) &&
    Array.isArray(value.items) && value.items.length <= 1000 && value.items.every(item => record(item) &&
      ["title", "url", "guid", "published", "description"].every(key => item[key] === null || typeof item[key] === "string") &&
      (item.size_bytes === null || (Number.isSafeInteger(item.size_bytes) && Number(item.size_bytes) >= 0)));
}

/** Bounded native calls use stdin, never command arguments or the server environment. */
export async function runRustCore<K extends keyof CoreResults>(
  op: K, payload: string, signal?: AbortSignal,
): Promise<CoreResults[K]> {
  signal?.throwIfAborted();
  if (Buffer.byteLength(payload) > CORE_PAYLOAD_LIMIT)
    throw new RustCoreError("LIMIT", "核心请求超过 4 MiB 上限");
  const deadline = AbortSignal.timeout(10_000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let release: (() => void) | undefined;
  try {
    release = await acquire(combined);
    combined.throwIfAborted();
    const input = JSON.stringify({ version: 1, op, payload });
    return await new Promise<CoreResults[K]>((resolve, reject) => {
      let inputError: Error | undefined;
      const child = execFile(BINARY, ["--stdio"], {
        encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true, killSignal: "SIGKILL",
        // The parser only needs the Windows loader path, never the server environment.
        env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {},
      }, (error, stdout) => {
        combined.removeEventListener("abort", abort);
        if (combined.aborted) { reject(combined.reason); return; }
        if (error) {
          reject(new RustCoreError("CORE_UNAVAILABLE", "Rust 核心无法运行，请执行 npm run build 或检查安装包"));
          return;
        }
        let response: unknown;
        try { response = JSON.parse(stdout); }
        catch { reject(new RustCoreError("CORE_PROTOCOL", "Rust 解析核心返回了无效响应")); return; }
        if (record(response) && response.ok === false && record(response.error)) {
          const code = typeof response.error.code === "string" && /^[A-Z_]{1,40}$/.test(response.error.code)
            ? response.error.code : "CORE_PROTOCOL";
          reject(new RustCoreError(code, `资源解析失败（${code}）`));
        } else if (inputError || !record(response) || response.ok !== true || !validResult(op, response.result)) {
          reject(new RustCoreError("CORE_PROTOCOL", "Rust 解析核心响应结构不正确"));
        } else {
          resolve(response.result as CoreResults[K]);
        }
      });
      const abort = () => { child.kill("SIGKILL"); };
      combined.addEventListener("abort", abort, { once: true });
      if (combined.aborted) abort();
      child.stdin!.on("error", (error: Error) => { inputError = error; });
      child.stdin!.end(input);
    });
  } catch (error) {
    if (deadline.aborted && !signal?.aborted)
      throw new RustCoreError("CORE_TIMEOUT", "Rust 解析任务超时，请稍后重试");
    throw error;
  } finally {
    release?.();
  }
}
