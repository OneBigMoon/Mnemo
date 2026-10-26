// CMS V10 详情解析（M6 链路补全）：把详情接口（?ac=videolist&ids=…）的
// 播放组字符串拆为分集列表——与 mnemo-core cms::parse_vod_detail 同语义。
// 纯函数；抓取由调用方完成。

export interface CmsEpisode {
  name: string;
  url: string;
}

export interface CmsDetail {
  id: string;
  name: string;
  /** 播放组：每组一串分集（多线路 = 多组）。 */
  playGroups: CmsEpisode[][];
}

interface VodDetailPayload {
  code?: number;
  list?: { vod_id?: number | string; vod_name?: string; vod_play_url?: string }[];
}

/** 解析 V10 详情 JSON；播放组以 `$$$` 分隔，分集以 `#` 分隔、`名称$地址`。 */
export function parseVodDetail(payload: string): { details: CmsDetail[]; error?: string } {
  let parsed: VodDetailPayload;
  try {
    parsed = JSON.parse(payload) as VodDetailPayload;
  } catch (error) {
    return { details: [], error: `详情响应不是合法 JSON：${error instanceof Error ? error.message : error}` };
  }
  if (parsed.code !== undefined && parsed.code !== 0 && parsed.code !== 1) {
    return { details: [], error: `接口返回 code=${parsed.code}` };
  }
  const details: CmsDetail[] = [];
  for (const entry of parsed.list ?? []) {
    const id = typeof entry.vod_id === "number" ? String(entry.vod_id) : entry.vod_id?.trim();
    const name = entry.vod_name?.trim();
    if (!id || !name) continue;
    const playGroups: CmsEpisode[][] = [];
    for (const group of (entry.vod_play_url ?? "").split("$$$")) {
      const episodes: CmsEpisode[] = [];
      for (const raw of group.split("#")) {
        const at = raw.indexOf("$");
        if (at <= 0) continue;
        const episodeName = raw.slice(0, at).trim();
        const url = raw.slice(at + 1).trim();
        if (!episodeName || !url) continue;
        episodes.push({ name: episodeName, url });
      }
      if (episodes.length) playGroups.push(episodes);
    }
    details.push({ id, name, playGroups });
  }
  return { details };
}

/** 组详情接口 URL：`…?ac=videolist&ids=<id>`（基址已含 ac=videolist 时复用 &）。 */
export function detailUrl(endpoint: string, id: string): string {
  const base = endpoint.replace(/[?&]+$/, "");
  const joiner = base.includes("?") ? "&" : "?";
  return `${base}${joiner}ac=videolist&ids=${encodeURIComponent(id)}`;
}
