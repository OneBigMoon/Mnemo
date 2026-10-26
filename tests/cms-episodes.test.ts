import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Requests } from "../server/requests.js";
import { Store } from "../server/store.js";
import type {
  DownloadTask,
  MediaInfo,
  MediaService,
  SearchResult,
} from "../shared/types.js";

const DETAIL_PAYLOAD = JSON.stringify({
  code: 1,
  list: [
    {
      vod_id: 101,
      vod_name: "三体",
      vod_play_url:
        "第01集$https://cdn.example.org/e01.m3u8#第02集$https://cdn.example.org/e02.mp4$$$备用线路$https://backup.example.org/e02.mp4",
    },
  ],
});

const cmsEntry: SearchResult = {
  id: "cms-a:101",
  title: "三体",
  url: "https://a.example.org/api.php/provide/vod?wd=%E4%B8%89%E4%BD%93",
  kind: "share",
  source: "采集 A",
  size: "全30集",
  cmsRef: {
    sourceId: "cms-a",
    vodId: "101",
    endpoint: "https://a.example.org/api.php/provide/vod",
    sourceName: "采集 A",
  },
};

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mori-cms-episodes-"));
  const store = new Store(directory, path.join(directory, "files"));
  const createdTasks: { url: string; kind: string; media?: MediaInfo }[] = [];
  const media: MediaService = {
    search: async () => [cmsEntry],
    identify: async () => [{ type: "tv", title: "三体", year: 2023, season: 1, episode: 2 }],
    download: async () => {
      throw new Error("fixture download disabled");
    },
    scrape: async () => ({ files: [], warnings: [] }),
    testConnection: async () => ({ ok: true, message: "fixture" }),
    browseCms: async (ref) => {
      assert.equal(ref.vodId, "101");
      // 与 media.ts browseCms 相同的映射逻辑（单测内联镜像，真实实现由
      // registry-search/cms-detail 套件背书）。
      const parsed = JSON.parse(DETAIL_PAYLOAD) as {
        list: { vod_play_url: string; vod_name: string; vod_id: number }[];
      };
      const detail = parsed.list[0];
      const results: SearchResult[] = [];
      for (const raw of detail.vod_play_url.split("$$$")[0].split("#")) {
        const at = raw.indexOf("$");
        const name = raw.slice(0, at).trim();
        const url = raw.slice(at + 1).trim();
        const extension = url.slice(url.lastIndexOf(".")).toLowerCase();
        const kind: SearchResult["kind"] = extension === ".mp4" ? "direct" : "share";
        results.push({
          id: `${ref.sourceId}:${name}`.slice(0, 300),
          title: `${detail.vod_name} ${name}`,
          url,
          kind,
          source: ref.sourceName,
        });
      }
      return results;
    },
  };
  const actions = {
    addTask(input: { title: string; url: string; kind?: string; media?: MediaInfo }): DownloadTask {
      const kind = (input.kind || "direct") as DownloadTask["kind"];
      createdTasks.push({ url: input.url, kind, media: input.media });
      const now = new Date().toISOString();
      const task: DownloadTask = {
        id: randomUUID(), title: input.title, url: input.url, kind,
        media: input.media!, profile: "emby", status: "queued", progress: 0, bytes: 0, total: 0,
        createdAt: now, updatedAt: now,
      };
      store.put("task", task);
      return task;
    },
    subscribe(): never {
      throw new Error("本测试不涉及订阅");
    },
  };
  const requests = new Requests(store, media, actions);
  const owner = "web:fixture";
  t.after(async () => {
    await requests.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { requests, owner, createdTasks };
}

test("CMS entry browses to episodes and an mp4 episode creates a direct task", async (t) => {
  const f = fixture(t);
  // 1) 发起选片 → 按阶段推进到资源阶段（候选已含季集，details 自动通过）。
  let request = await f.requests.begin(f.owner, "三体", "download");
  for (let guard = 0; guard < 4 && request.stage !== "resource"; guard++) {
    request = await f.requests.select(f.owner, request.id, {
      expectedRevision: request.revision,
      ...(request.stage === "media" ? { candidateId: request.candidates[0].id } : {}),
    });
  }
  assert.equal(request.stage, "resource");
  // 2) 资源阶段：CMS 条目在列。
  assert.equal(request.stage, "resource");
  const cms = request.resources.find((resource) => resource.cmsRef);
  assert.ok(cms, "CMS 条目应出现在资源列表");
  assert.equal(cms.kind, "share");
  // 3) 浏览分集。
  request = await f.requests.select(f.owner, request.id, {
    expectedRevision: request.revision,
    resourceId: cms.id,
  });
  assert.equal(request.stage, "resource");
  const mp4 = request.resources.find((resource) => resource.url.endsWith(".mp4"));
  const m3u8 = request.resources.find((resource) => resource.url.endsWith(".m3u8"));
  assert.ok(mp4, "mp4 分集应可下载");
  assert.ok(m3u8, "m3u8 分集保留为 share（不支持直接下载）");
  assert.equal(mp4.kind, "direct");
  assert.equal(m3u8.kind, "share");
  assert.match(mp4.title, /第02集/);
  // 4) 选择 mp4 分集 → 创建 direct 任务（身份含集数证据，直接匹配或需确认）。
  request = await f.requests.select(f.owner, request.id, {
    expectedRevision: request.revision,
    resourceId: mp4.id,
    confirmUncertain: true,
  });
  assert.equal(request.stage, "completed");
  assert.ok(request.taskId, "完成后应记录任务 id");
  assert.equal(f.createdTasks.length, 1);
  assert.equal(f.createdTasks[0].url, "https://cdn.example.org/e02.mp4");
  assert.equal(f.createdTasks[0].kind, "direct");
});

test("browseCms failure keeps the resource and reports a retryable message", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mori-cms-fail-"));
  const store = new Store(directory, path.join(directory, "files"));
  const media: MediaService = {
    search: async () => [cmsEntry],
    identify: async () => [{ type: "tv", title: "三体", year: 2023, season: 1, episode: 2 }],
    download: async () => {
      throw new Error("fixture download disabled");
    },
    scrape: async () => ({ files: [], warnings: [] }),
    testConnection: async () => ({ ok: true, message: "fixture" }),
    browseCms: async () => {
      throw new Error("HTTP_ERROR: CMS 详情返回 HTTP 503");
    },
  };
  const requests = new Requests(store, media, {
    addTask: () => {
      throw new Error("不应创建任务");
    },
    subscribe: () => {
      throw new Error("本测试不涉及订阅");
    },
  });
  t.after(async () => {
    await requests.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let request = await requests.begin("web:fixture", "三体", "download");
  for (let guard = 0; guard < 4 && request.stage !== "resource"; guard++) {
    request = await requests.select("web:fixture", request.id, {
      expectedRevision: request.revision,
      ...(request.stage === "media" ? { candidateId: request.candidates[0].id } : {}),
    });
  }
  assert.equal(request.stage, "resource");
  const cms = request.resources.find((resource) => resource.cmsRef)!;
  request = await requests.select("web:fixture", request.id, {
    expectedRevision: request.revision,
    resourceId: cms.id,
  });
  assert.match(request.message, /分集解析失败/);
  assert.equal(request.resources.some((resource) => resource.cmsRef), true, "资源保留可重试");
});
