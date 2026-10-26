import assert from "node:assert/strict";
import test from "node:test";
import {
  filterMediaPlaylist,
  isEncryptedPlaylist,
  parsePlaylist,
} from "../server/hls.js";

const PLAYLIST_URL = "https://cdn.example.org/show/index.m3u8";

const MEDIA = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXTINF:6.0,",
  "seg001.ts",
  "#EXTINF:6.0,",
  "seg002.ts",
  "#EXT-X-DISCONTINUITY",
  "#EXTINF:2.0,",
  "https://ad-publisher.net/ad1.ts",
  "#EXTINF:2.5,",
  "https://ad-publisher.net/ad2.ts",
  "#EXT-X-DISCONTINUITY",
  "#EXTINF:7.0,",
  "seg003.ts",
  "#EXT-X-ENDLIST",
].join("\n");

const proxy = (absolute: string) => `/api/cms/segment?url=${encodeURIComponent(absolute)}`;

test("parsePlaylist resolves segment URLs against the playlist base", () => {
  const parsed = parsePlaylist(MEDIA, PLAYLIST_URL);
  assert.equal(parsed.kind, "media");
  assert.equal(parsed.items.length, 5);
  assert.equal(parsed.items[0].url, "https://cdn.example.org/show/seg001.ts");
  assert.equal(parsed.items[0].durationSeconds, 6.0);
  assert.equal(parsed.items[2].url, "https://ad-publisher.net/ad1.ts");
  const master = parsePlaylist(
    ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=800000", "720/index.m3u8"].join("\n"),
    PLAYLIST_URL,
  );
  assert.equal(master.kind, "master");
  assert.equal(master.items[0].url, "https://cdn.example.org/show/720/index.m3u8");
});

test("filterMediaPlaylist drops cross-domain ad runs and keeps the show", () => {
  const result = filterMediaPlaylist(MEDIA, PLAYLIST_URL, proxy);
  assert.equal(result.kind, "media");
  assert.equal(result.dropped, 2, "两个广告分片被剔除");
  assert.equal(result.kept, 3);
  // 输出的分片全部走代理且只剩正片。
  const segmentLines = result.playlist.split("\n").filter((line) => line.startsWith("/api/cms/segment"));
  assert.equal(segmentLines.length, 3);
  assert.ok(segmentLines.every((line) => line.includes("seg00") && !line.includes("ad-publisher")));
  // 诚实标注过滤数量。
  assert.match(result.playlist, /#EXT-X-LUCERNA-FILTERED: 2/);
  // 广告标记与 DISCONTINUITY 残留被清理。
  assert.ok(!result.playlist.includes("ad-publisher"));
  assert.ok(result.playlist.includes("#EXTINF:7.0,"));
});

test("short discontinuity runs are dropped even same-domain; long cross-domain shows survive", () => {
  const shortSameDomain = [
    "#EXTM3U",
    "#EXTINF:6.0,",
    "a.ts",
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:1.5,",
    "b.ts",
    "#EXTINF:1.5,",
    "c.ts",
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:6.0,",
    "d.ts",
    "#EXT-X-ENDLIST",
  ].join("\n");
  const result = filterMediaPlaylist(shortSameDomain, PLAYLIST_URL, proxy);
  assert.equal(result.dropped, 2, "短同域组（3 秒）被剔除");
  assert.equal(result.kept, 2);

  const longCrossDomain = [
    "#EXTM3U",
    "#EXTINF:90.0,",
    "https://mirror.example.net/part1.ts",
    "#EXTINF:90.0,",
    "https://mirror.example.net/part2.ts",
    "#EXT-X-ENDLIST",
  ].join("\n");
  const kept = filterMediaPlaylist(longCrossDomain, PLAYLIST_URL, proxy);
  assert.equal(kept.dropped, 0, "长跨域（180 秒）视为正片镜像，不剔除");
  assert.equal(kept.kept, 2);
});

test("marked ad cues drop even without domain or duration signals", () => {
  const marked = [
    "#EXTM3U",
    "#EXT-X-CUE:TYPE=AD",
    "#EXTINF:30.0,",
    "sponsored.ts",
    "#EXTINF:30.0,",
    "main.ts",
    "#EXT-X-ENDLIST",
  ].join("\n");
  const result = filterMediaPlaylist(marked, PLAYLIST_URL, proxy);
  assert.equal(result.dropped, 1, "明确 CUE 标记的分片被剔除");
  assert.equal(result.kept, 1);
  assert.ok(result.playlist.includes("main.ts"));
});

test("master playlists are rewritten without filtering; encrypted playlists detected", () => {
  const master = ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=800000", "720/index.m3u8", "#EXT-X-STREAM-INF:BANDWIDTH=2000000", "1080/index.m3u8"].join("\n");
  const result = filterMediaPlaylist(master, PLAYLIST_URL, proxy);
  assert.equal(result.kind, "master");
  assert.equal(result.dropped, 0);
  assert.ok(result.playlist.includes("/api/cms/segment"));
  assert.ok(!result.playlist.includes("720/index.m3u8\n"), "变体地址被代理替换");

  assert.ok(isEncryptedPlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.key\""));
  assert.ok(!isEncryptedPlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=NONE"));
  assert.ok(!isEncryptedPlaylist(MEDIA));
});
