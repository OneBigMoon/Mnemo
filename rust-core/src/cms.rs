//! Pure CMS V10 parsing copied from output/zcode-work/rust-core/src/cms.rs.
//! Transport, health tracking and download services remain outside this crate.

use crate::{CoreError, MAX_RESULTS};
use serde::Deserialize;

// ---------------------------------------------------------------------------
// CMS V10 解析（纯函数）
// ---------------------------------------------------------------------------

pub type CmsError = CoreError;

/// 搜索结果条目（列表页）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CmsSummary {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remarks: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
}

/// 详情页条目：播放组与单集地址。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmsDetail {
    pub id: String,
    pub name: String,
    /// 播放组：每组是一串 `名称$url`（`#` 分隔）；V10 用 `$$$` 分隔多组。
    pub play_groups: Vec<Vec<Episode>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Episode {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
struct VodListPayload {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    list: Vec<VodEntry>,
}

#[derive(Debug, Deserialize)]
struct VodEntry {
    #[serde(default)]
    vod_id: serde_json::Value,
    #[serde(default)]
    vod_name: Option<String>,
    #[serde(default)]
    vod_remarks: Option<String>,
    #[serde(default)]
    vod_time: Option<String>,
    #[serde(default)]
    vod_play_url: Option<String>,
}

use serde::Serialize;

fn entry_id(entry: &VodEntry) -> Option<String> {
    match &entry.vod_id {
        serde_json::Value::Number(number) => Some(number.to_string()),
        serde_json::Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        _ => None,
    }
}

/// 解析列表接口（`?ac=videolist&wd=...`）。
pub fn parse_vod_list(payload: &str) -> Result<Vec<CmsSummary>, CmsError> {
    let parsed: VodListPayload = serde_json::from_str(payload).map_err(|_| {
        CoreError::new(
            "CMS_PARSE",
            "CMS list response is invalid JSON or has an invalid schema",
        )
    })?;
    if parsed.code != 0 && parsed.code != 1 {
        return Err(CoreError::new(
            "CMS_CODE",
            "CMS list source returned a failure code",
        ));
    }
    let mut items = Vec::new();
    for entry in &parsed.list {
        let Some(id) = entry_id(entry) else { continue };
        let name = entry.vod_name.as_deref().unwrap_or("").trim().to_string();
        if name.is_empty() {
            continue;
        }
        if items.len() == MAX_RESULTS {
            return Err(CoreError::new(
                "LIMIT",
                "CMS list exceeds 1000 result items",
            ));
        }
        items.push(CmsSummary {
            id,
            name,
            remarks: entry
                .vod_remarks
                .clone()
                .filter(|value| !value.trim().is_empty()),
            updated: entry
                .vod_time
                .clone()
                .filter(|value| !value.trim().is_empty()),
        });
    }
    Ok(items)
}

/// 解析详情接口（`?ac=videolist&ids=...`）的播放组与单集。
pub fn parse_vod_detail(payload: &str) -> Result<Vec<CmsDetail>, CmsError> {
    let mut episode_count = 0;
    let parsed: VodListPayload = serde_json::from_str(payload).map_err(|_| {
        CoreError::new(
            "CMS_PARSE",
            "CMS detail response is invalid JSON or has an invalid schema",
        )
    })?;
    if parsed.code != 0 && parsed.code != 1 {
        return Err(CoreError::new(
            "CMS_CODE",
            "CMS detail source returned a failure code",
        ));
    }
    let mut items = Vec::new();
    for entry in &parsed.list {
        let Some(id) = entry_id(entry) else { continue };
        let name = entry.vod_name.as_deref().unwrap_or("").trim().to_string();
        if name.is_empty() {
            continue;
        }
        let mut play_groups = Vec::new();
        if let Some(play_url) = &entry.vod_play_url {
            for group in play_url.split("$$$") {
                let episodes: Vec<Episode> = group
                    .split('#')
                    .filter_map(|episode| {
                        let (name, url) = episode.split_once('$')?;
                        let name = name.trim().to_string();
                        let url = url.trim().to_string();
                        if name.is_empty() || url.is_empty() {
                            None
                        } else {
                            Some(Episode { name, url })
                        }
                    })
                    .take(MAX_RESULTS + 1)
                    .collect();
                episode_count += episodes.len();
                if episode_count > MAX_RESULTS {
                    return Err(CoreError::new(
                        "LIMIT",
                        "CMS detail exceeds 1000 total episodes",
                    ));
                }
                if !episodes.is_empty() {
                    play_groups.push(episodes);
                }
            }
        }
        if items.len() == MAX_RESULTS {
            return Err(CoreError::new(
                "LIMIT",
                "CMS detail exceeds 1000 result items",
            ));
        }
        items.push(CmsDetail {
            id,
            name,
            play_groups,
        });
    }
    Ok(items)
}
