use mnemo_core::{MAX_PAYLOAD_BYTES, MAX_REQUEST_BYTES, MAX_RESULTS};
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

fn call_bytes(input: &[u8]) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_mnemo-core"))
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
    serde_json::from_slice(&output.stdout).expect("exactly one JSON response")
}

fn call(op: &str, payload: &str) -> Value {
    call_bytes(&serde_json::to_vec(&json!({"version":1,"op":op,"payload":payload})).unwrap())
}

fn error_code(response: &Value) -> &str {
    assert_eq!(response["ok"], false);
    response["error"]["code"].as_str().unwrap()
}

#[test]
fn cms_list_and_detail_are_serialized_for_the_typescript_host() {
    let payload = r#"{"code":1,"list":[{"vod_id":7,"vod_name":"三体","vod_remarks":"全30集","vod_play_url":"01$https://cdn.example/a.mp4#02$https://cdn.example/b.mp4$$$备用$https://cdn.example/c.mp4"}]}"#;
    let list = call("cms_list", payload);
    assert_eq!(list["ok"], true);
    assert_eq!(
        list["result"]["items"][0],
        json!({"id":"7","name":"三体","remarks":"全30集"})
    );
    let detail = call("cms_detail", payload);
    assert_eq!(detail["ok"], true);
    assert_eq!(
        detail["result"]["details"][0]["playGroups"][0][0],
        json!({"name":"01","url":"https://cdn.example/a.mp4"})
    );
    assert!(detail["result"]["details"][0].get("play_groups").is_none());
}

#[test]
fn rss_and_atom_have_the_same_feed_result_shape() {
    for (payload, kind) in [
        (
            r#"<rss><channel><title>订阅</title><link>https://example.org</link><item><title>one</title><guid>id1</guid><pubDate>today</pubDate><description>description</description><enclosure url="https://cdn.example/one.mp4" length="42"/></item><item></item></channel></rss>"#,
            "rss",
        ),
        (
            r#"<feed xmlns="http://www.w3.org/2005/Atom"><title>订阅</title><link href="https://example.org"/><entry><title>one</title><id>id1</id><published>today</published><summary>description</summary><link rel="enclosure" href="https://cdn.example/one.mp4"/></entry><entry></entry></feed>"#,
            "atom",
        ),
    ] {
        let response = call("feed", payload);
        assert_eq!(response["ok"], true, "{response}");
        let feed = &response["result"];
        assert_eq!(feed["kind"], kind);
        assert_eq!(feed["title"], "订阅");
        assert_eq!(feed["link"], "https://example.org");
        assert_eq!(feed["skipped"], 1);
        assert_eq!(feed["items"][0]["title"], "one");
        assert_eq!(feed["items"][0]["url"], "https://cdn.example/one.mp4");
        assert_eq!(feed["items"][0]["guid"], "id1");
        assert_eq!(feed["items"][0]["published"], "today");
        assert_eq!(feed["items"][0]["description"], "description");
        assert_eq!(
            feed["items"][0]["size_bytes"],
            if kind == "rss" {
                json!(42)
            } else {
                Value::Null
            }
        );
    }
}

#[test]
fn bad_envelope_fields_and_operations_are_distinguishable() {
    assert_eq!(error_code(&call_bytes(b"not json")), "BAD_JSON");
    assert_eq!(
        error_code(&call_bytes(br#"{"version":1,"op":"feed","payload":3}"#)),
        "BAD_REQUEST"
    );
    assert_eq!(
        error_code(&call_bytes(
            br#"{"version":2,"op":"feed","payload":"<feed/>"}"#
        )),
        "BAD_VERSION"
    );
    assert_eq!(error_code(&call("missing", "secret")), "BAD_OP");
    assert_eq!(
        error_code(&call_bytes(
            br#"{"version":1,"op":"feed","payload":"<feed/>"}{}"#
        )),
        "BAD_JSON"
    );
    assert_eq!(error_code(&call("cms_list", "not json")), "CMS_PARSE");
    assert_eq!(
        error_code(&call("cms_list", r#"{"code":500,"list":[]}"#)),
        "CMS_CODE"
    );
}

#[test]
fn malformed_xml_and_non_feed_documents_are_distinguishable() {
    for payload in [
        "<rss><channel><item><title>unfinished",
        "<rss><channel></rss>",
        "<feed><entry><title>x</bad></entry></feed>",
        "<feed/><feed/>",
        "<feed><title>&unknown;</title></feed>",
        "<feed><link href=\"unterminated></feed>",
    ] {
        assert_eq!(error_code(&call("feed", payload)), "FEED_XML", "{payload}");
    }
    for payload in ["plain body", "<html><rss/></html>", "", "<!-- no root -->"] {
        assert_eq!(
            error_code(&call("feed", payload)),
            "FEED_FORMAT",
            "{payload}"
        );
    }
    for payload in ["<rss/>", "<feed/>"] {
        assert_eq!(call("feed", payload)["ok"], true);
    }
}

#[test]
fn errors_never_echo_payload_or_untrusted_field_values() {
    let secret = "private-token-do-not-echo";
    for response in [
        call_bytes(format!("{{\"version\":1,\"op\":\"{secret}\",\"payload\":false}}").as_bytes()),
        call(secret, secret),
        call("cms_list", &format!("{{\"code\":\"{secret}\"}}")),
        call(
            "cms_detail",
            &format!("{{\"list\":[{{\"vod_name\":{secret}}}]}}"),
        ),
        call("feed", &format!("<rss><channel><{secret}></wrong>")),
    ] {
        assert_eq!(response["ok"], false);
        assert!(!response.to_string().contains(secret));
    }
}

#[test]
fn payload_and_complete_request_bounds_are_checked_without_truncation() {
    let prefix = r#"{"code":1,"list":[],"padding":""#;
    let suffix = "\"}";
    let payload = format!(
        "{prefix}{}{suffix}",
        "a".repeat(MAX_PAYLOAD_BYTES - prefix.len() - suffix.len())
    );
    assert_eq!(payload.len(), MAX_PAYLOAD_BYTES);
    assert_eq!(call("cms_list", &payload)["ok"], true);
    assert_eq!(error_code(&call("cms_list", &(payload + " "))), "LIMIT");
    let valid = br#"{"version":1,"op":"cms_list","payload":"{\"list\":[]}"}"#;
    let mut input = vec![b' '; MAX_REQUEST_BYTES - valid.len()];
    input.extend_from_slice(valid);
    assert_eq!(call_bytes(&input)["ok"], true);
    input.push(b' ');
    assert_eq!(error_code(&call_bytes(&input)), "LIMIT");
    let unicode = "é".repeat(MAX_PAYLOAD_BYTES / 2 + 1);
    assert_eq!(error_code(&call("cms_list", &unicode)), "LIMIT");
}

#[test]
fn result_limits_cover_lists_details_and_all_episode_groups() {
    let entries = vec![json!({"vod_id":1,"vod_name":"one"}); MAX_RESULTS];
    let payload = json!({"code":1,"list":entries}).to_string();
    assert_eq!(
        call("cms_list", &payload)["result"]["items"]
            .as_array()
            .unwrap()
            .len(),
        MAX_RESULTS
    );
    assert_eq!(
        call("cms_detail", &payload)["result"]["details"]
            .as_array()
            .unwrap()
            .len(),
        MAX_RESULTS
    );
    let payload =
        json!({"list":vec![json!({"vod_id":1,"vod_name":"one"}); MAX_RESULTS + 1]}).to_string();
    for op in ["cms_list", "cms_detail"] {
        assert_eq!(error_code(&call(op, &payload)), "LIMIT");
    }
    for count in [MAX_RESULTS, MAX_RESULTS + 1] {
        let group = std::iter::repeat_n("episode$https://cdn.example/a.mp4", count / 2)
            .collect::<Vec<_>>()
            .join("#");
        let other_group =
            std::iter::repeat_n("episode$https://cdn.example/a.mp4", count - count / 2)
                .collect::<Vec<_>>()
                .join("#");
        let payload = json!({"list":[{"vod_id":1,"vod_name":"one","vod_play_url":group},{"vod_id":2,"vod_name":"two","vod_play_url":other_group}]}).to_string();
        let response = call("cms_detail", &payload);
        if count == MAX_RESULTS {
            assert_eq!(response["ok"], true);
        } else {
            assert_eq!(error_code(&response), "LIMIT");
        }
    }
    let groups = std::iter::repeat_n("episode$https://cdn.example/a.mp4", MAX_RESULTS + 1)
        .collect::<Vec<_>>()
        .join("$$$");
    assert_eq!(
        error_code(&call(
            "cms_detail",
            &json!({"list":[{"vod_id":1,"vod_name":"one","vod_play_url":groups}]}).to_string()
        )),
        "LIMIT"
    );
}

#[test]
fn feed_result_limits_apply_to_rss_and_atom() {
    for (root, entry) in [
        ("rss", "<item><title>one</title></item>"),
        ("feed", "<entry><title>one</title></entry>"),
    ] {
        for count in [MAX_RESULTS, MAX_RESULTS + 1] {
            let payload = format!("<{root}>{}</{root}>", entry.repeat(count));
            let response = call("feed", &payload);
            if count == MAX_RESULTS {
                assert_eq!(
                    response["result"]["items"].as_array().unwrap().len(),
                    MAX_RESULTS
                );
            } else {
                assert_eq!(error_code(&response), "LIMIT");
            }
        }
    }
}

#[test]
fn feed_regression_cdata_fields_preserve_literal_entities() {
    for (kind, payload) in [
        (
            "rss",
            r#"<rss><channel><item><title><![CDATA[三体 &amp; 第二集]]></title><link><![CDATA[https://cdn.example/a.mp4?a=1&b=2]]></link><guid><![CDATA[id&amp;1]]></guid><pubDate><![CDATA[today &amp; later]]></pubDate><description><![CDATA[<b>one &amp; two</b>]]></description></item></channel></rss>"#,
        ),
        (
            "atom",
            r#"<feed xmlns="http://www.w3.org/2005/Atom"><entry><title><![CDATA[三体 &amp; 第二集]]></title><link rel="enclosure" href="https://cdn.example/a.mp4?a=1&amp;b=2"/><id><![CDATA[id&amp;1]]></id><published><![CDATA[today &amp; later]]></published><summary><![CDATA[<b>one &amp; two</b>]]></summary></entry></feed>"#,
        ),
    ] {
        let response = call("feed", payload);
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["result"]["kind"], kind);
        assert_eq!(response["result"]["items"].as_array().unwrap().len(), 1);
        assert_eq!(
            response["result"]["items"][0],
            json!({
                "title":"三体 &amp; 第二集",
                "url":"https://cdn.example/a.mp4?a=1&b=2",
                "guid":"id&amp;1",
                "published":"today &amp; later",
                "description":"<b>one &amp; two</b>",
                "size_bytes":null
            })
        );
    }
}

#[test]
fn feed_regression_atom_links_use_default_alternate_and_prefer_enclosures() {
    for alternate in [
        r#"<link href="https://example.org/entry"/>"#,
        r#"<link href="https://example.org/entry"></link>"#,
        r#"<link rel="alternate" href="https://example.org/entry"/>"#,
        r#"<link rel="alternate" href="https://example.org/entry"></link>"#,
    ] {
        let payload = format!("<feed><entry><title>one</title>{alternate}</entry></feed>");
        let response = call("feed", &payload);
        assert_eq!(
            response["result"]["items"][0]["url"],
            "https://example.org/entry"
        );
        for enclosure in [
            r#"<link rel="enclosure" href="https://cdn.example/one.mp4"/>"#,
            r#"<link rel="enclosure" href="https://cdn.example/one.mp4"></link>"#,
        ] {
            for links in [
                format!("{alternate}{enclosure}"),
                format!("{enclosure}{alternate}"),
            ] {
                let payload = format!("<feed><entry><title>one</title>{links}</entry></feed>");
                let response = call("feed", &payload);
                assert_eq!(
                    response["result"]["items"][0]["url"],
                    "https://cdn.example/one.mp4"
                );
            }
        }
    }
}

#[test]
fn password_and_download_operations_follow_the_shared_stdio_protocol() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/password-vectors.json")).unwrap();
    let vector = &fixture["vectors"][0];
    let mut password = json!({"passwordHex":vector["passwordHex"],"stored":vector["stored"]});
    assert_eq!(
        call("password_verify", &password.to_string()),
        json!({"ok":true,"result":{"matches":true}})
    );
    password["passwordHex"] = json!("00");
    assert_eq!(
        call("password_verify", &password.to_string()),
        json!({"ok":true,"result":{"matches":false}})
    );
    let invalid = call(
        "password_verify",
        r#"{"passwordHex":"00","stored":"private-record-do-not-echo"}"#,
    );
    assert_eq!(error_code(&invalid), "PASSWORD_RECORD");
    assert!(!invalid.to_string().contains("private-record-do-not-echo"));
    let invalid = call(
        "password_verify",
        r#"{"passwordHex":"private-password-do-not-echo","stored":"private-record-do-not-echo"}"#,
    );
    assert_eq!(error_code(&invalid), "BAD_REQUEST");
    assert!(!invalid.to_string().contains("private-"));
    let download = json!({"status":200,"offset":5,"contentLength":"10","contentEncoding":"identity","etag":"\"v1\"","lastModified":"","contentRange":""});
    assert_eq!(
        call("download_response", &download.to_string()),
        json!({"ok":true,"result":{"offset":0,"total":10,"validator":"\"v1\""}})
    );
}

#[test]
fn cli_version_and_usage_are_stable() {
    let binary = env!("CARGO_BIN_EXE_mnemo-core");
    let version = Command::new(binary).arg("--version").output().unwrap();
    assert!(version.status.success());
    assert_eq!(version.stdout, b"mnemo-core 0.1.1 protocol=1\n");
    for args in [vec![], vec!["--unknown"], vec!["--stdio", "--version"]] {
        let output = Command::new(binary).args(args).output().unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert_eq!(output.stderr, b"usage: mnemo-core --stdio | --version\n");
    }
}
