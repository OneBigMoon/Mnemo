import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".ts": "video/mp2t",
  ".m2ts": "video/mp2t",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".ogv": "video/ogg",
};

export type ByteRange = { start: number; end: number };

export class PlaybackError extends Error {}

export function mediaContentType(filename: string): string {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] || "application/octet-stream";
}

/**
 * Parse one RFC 7233 byte range. Multi-range and malformed headers are
 * rejected: a video element only needs single ranges, and answering with a
 * partial multipart body would add a parser for no benefit.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): ByteRange | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return "invalid";
  if (size <= 0) return "invalid";

  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1 };
  }

  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    start >= size
  )
    return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Resolve a completed task's file for playback. The path must be a regular,
 * non-symlink file inside one of the trusted download roots; a recorded path
 * alone is never treated as proof of ownership.
 */
export async function resolvePlayableFile(
  candidate: string,
  roots: string[],
): Promise<{ path: string; size: number }> {
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0)
    throw new PlaybackError("媒体文件不可用");

  const resolved = await realpath(candidate);
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue;
    }
    const relative = path.relative(realRoot, resolved);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return { path: resolved, size: info.size };
    }
  }
  throw new PlaybackError("媒体文件不在已配置的下载目录内");
}
