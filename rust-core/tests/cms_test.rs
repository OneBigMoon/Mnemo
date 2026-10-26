//! Pure parser tests copied from output/zcode-work/rust-core/tests/cms_test.rs.
use mnemo_core::cms::{parse_vod_detail, parse_vod_list};

const LIST_PAYLOAD: &str = r#"{
  "code": 1,
  "list": [
    { "vod_id": 101, "vod_name": "三体", "vod_remarks": "全30集", "vod_time": "2026-10-24" },
    { "vod_id": "102", "vod_name": "漫长的季节" },
    { "vod_id": "", "vod_name": "缺 id 的条目" },
    { "vod_name": "又一个缺 id" }
  ]
}"#;

const DETAIL_PAYLOAD: &str = r#"{
  "code": 1,
  "list": [
    {
      "vod_id": 101,
      "vod_name": "三体",
      "vod_play_url": "第01集$https://cdn.example.org/e01.m3u8#第02集$https://cdn.example.org/e02.m3u8$$$备用线路$https://backup.example.org/e01.m3u8"
    }
  ]
}"#;

#[test]
fn vod_list_parses_summaries_and_skips_idless_entries() {
    let items = parse_vod_list(LIST_PAYLOAD).unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].id, "101");
    assert_eq!(items[0].name, "三体");
    assert_eq!(items[0].remarks.as_deref(), Some("全30集"));
    assert_eq!(items[1].id, "102");
}

#[test]
fn vod_detail_splits_play_groups_and_episodes() {
    let details = parse_vod_detail(DETAIL_PAYLOAD).unwrap();
    assert_eq!(details.len(), 1);
    let groups = &details[0].play_groups;
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0].len(), 2);
    assert_eq!(groups[0][0].name, "第01集");
    assert_eq!(groups[0][0].url, "https://cdn.example.org/e01.m3u8");
    assert_eq!(groups[1][0].name, "备用线路");
}

#[test]
fn nullable_names_skip_invalid_rows_while_preserving_valid_rows() {
    let payload = r#"{"code":1,"list":[{"vod_id":1,"vod_name":null},{"vod_id":2,"vod_name":"Test","vod_remarks":null,"vod_play_url":null}]}"#;
    let items = parse_vod_list(payload).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].id, "2");
    assert_eq!(items[0].name, "Test");
    assert_eq!(
        serde_json::to_value(&items[0]).unwrap(),
        serde_json::json!({"id":"2","name":"Test"})
    );
    let details = parse_vod_detail(payload).unwrap();
    assert_eq!(details.len(), 1);
    assert_eq!(details[0].id, "2");
    assert_eq!(details[0].name, "Test");
    assert!(details[0].play_groups.is_empty());
}

#[test]
fn nullable_fields_still_reject_values_of_other_types() {
    for field in ["vod_name", "vod_remarks", "vod_play_url"] {
        let mut entry = serde_json::json!({"vod_id":2,"vod_name":"Test"});
        entry[field] = serde_json::json!(42);
        let payload = serde_json::json!({"list":[entry]}).to_string();
        assert_eq!(parse_vod_list(&payload).unwrap_err().code, "CMS_PARSE");
        assert_eq!(parse_vod_detail(&payload).unwrap_err().code, "CMS_PARSE");
    }
}
