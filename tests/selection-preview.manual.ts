// Local UI verification only: deterministic identities and self-generated video, never real provider accounts.
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";
import { createMediaService } from "../server/media.js";
import type { AppConfig, MediaInfo, SearchResult } from "../shared/types.js";

const videoPath = process.argv[2];
if (!videoPath) throw new Error("Pass a self-generated local video fixture");
const video = await readFile(videoPath);
if (video.length > 1024 * 1024) throw new Error("Use a small test video");
const reuseRoot = process.argv[3];
if (reuseRoot && !path.basename(reuseRoot).startsWith('mori-selection-ui-')) throw new Error('Only reuse an isolated selection fixture');
const root = reuseRoot || await mkdtemp(path.join(os.tmpdir(), "mori-selection-ui-"));
await mkdir(path.join(root, "files"), { recursive: true });
const source = createServer((req, res) => {
  if (!/^\/\d+\.mp4$/.test(req.url || "")) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Content-Length": video.length,
  });
  res.end(video);
});
source.listen(0, "127.0.0.1");
await new Promise<void>((r) => source.once("listening", r));
const origin = `http://127.0.0.1:${(source.address() as any).port}`;
let cfg: AppConfig;
const native = createMediaService(() => cfg);
const candidates: MediaInfo[] = [
  { type: "movie", title: "回声", year: 2020, tmdbId: 990001 },
  { type: "movie", title: "回声", year: 2026, tmdbId: 990002 },
];
const resources: SearchResult[] = [
  "回声.2020.1080p",
  "回声.2026.1080p",
  "回声.2026.2160p",
  "回声.1080p",
].map((title, i) => ({
  id: `fixture-${i}`,
  title,
  url: `${origin}/${i}.mp4`,
  kind: "direct",
  source: "隔离测试源 · 自生成视频",
}));
const instance = createApp({
  dataDirectory: path.join(root, "state"),
  downloadDirectory: path.join(root, "files"),
  startBackground: false,
  testMode: true,
  media: {
    ...native,
    identify: async query => query.includes('回声') ? candidates : [],
    search: async query => query.includes('回声') ? resources : [],
  },
});
cfg = instance.store.config();
cfg.setupComplete = true;
cfg.library.artwork = false;
instance.store.setConfig(cfg);
if (!instance.store.initialized()) instance.store.setup("Mori-selection-ui-fixture-2026");
for (const record of instance.store.list<any>('request')) {
  if (!record.query.includes('回声') && record.stage !== 'completed') {
    instance.store.put('request', { ...record, stage: 'failed', candidates: [], resources: [], message: '此实例是隔离测试，不能搜索真实片名。请打开正式实例并配置真实来源。', revision: record.revision + 1, updatedAt: new Date().toISOString() });
  }
}
const server = instance.app.listen(4183, "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      preview: "http://127.0.0.1:4183",
      isolatedDirectory: root,
      fixtureOnly: true,
    }),
  ),
);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await instance.close();
  source.closeAllConnections();
  await new Promise<void>((r) => source.close(() => r()));
  console.log('Isolated fixture stopped; state retained for inspection');
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
