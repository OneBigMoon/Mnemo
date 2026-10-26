use mnemo_core::download_response::{inspect_response, DownloadResponse};
use mnemo_core::CoreError;
use serde_json::{json, Value};

fn input(overrides: Value) -> Value {
    let mut input = json!({
        "status":200,"offset":0,"contentLength":"10","contentEncoding":"identity",
        "etag":"\"version-1\"","lastModified":"Tue, 01 Jan 2030 00:00:00 GMT","contentRange":""
    });
    for (key, value) in overrides.as_object().unwrap() {
        input[key] = value.clone();
    }
    input
}

fn inspect(overrides: Value) -> Result<DownloadResponse, CoreError> {
    inspect_response(&input(overrides).to_string())
}

#[test]
fn successful_full_responses_restart_offsets_and_select_the_existing_validator_rule() {
    for status in [200, 201, 204, 299] {
        let result =
            inspect(json!({"status":status,"offset":5,"priorTotal":20,"priorValidator":"old"}))
                .unwrap();
        assert_eq!(result.offset, 0);
        assert_eq!(result.total, 10);
        assert_eq!(result.validator, "\"version-1\"");
    }
    for etag in ["", "W/\"weak\""] {
        assert_eq!(
            inspect(json!({"etag":etag})).unwrap().validator,
            "Tue, 01 Jan 2030 00:00:00 GMT"
        );
    }
    assert_eq!(
        inspect(json!({"etag":"w/lowercase"})).unwrap().validator,
        "w/lowercase"
    );
    assert_eq!(
        inspect(json!({"etag":"","lastModified":""}))
            .unwrap()
            .validator,
        ""
    );
}

#[test]
fn content_length_uses_javascript_number_rules_and_the_200_gib_bound() {
    for (header, wanted) in [
        ("", 0),
        (" \t\r\n", 0),
        ("\u{feff}10\u{a0}", 10),
        ("10", 10),
        ("+10", 10),
        ("10.0", 10),
        ("1e1", 10),
        (".0", 0),
        ("-0", 0),
        ("0xA", 10),
        ("0XA", 10),
        ("0b1010", 10),
        ("0B1010", 10),
        ("0o12", 10),
        ("0O12", 10),
        ("214748364800", 214748364800),
    ] {
        assert_eq!(
            inspect(json!({"contentLength":header})).unwrap().total,
            wanted,
            "header {header:?}"
        );
    }
    for header in [
        "NaN",
        "Infinity",
        "-Infinity",
        "inf",
        "0x",
        "-0x1",
        "+0b1",
        "0b2",
        "1_0",
        "10px",
        "1 0",
        "1,0",
        "0.5",
        "-1",
        "214748364801",
        "9007199254740992",
        "1e1000",
        "\u{85}10",
    ] {
        assert_eq!(
            inspect(json!({"contentLength":header})).unwrap_err().code,
            "FILE_TOO_LARGE",
            "header {header:?}"
        );
    }
}

#[test]
fn partial_responses_use_complete_totals_and_require_matching_resume_metadata() {
    let complete = json!({"status":206,"offset":4,"priorTotal":10,"priorValidator":"\"version-1\"","contentLength":"6","contentRange":"bytes 4-9/10"});
    let result = inspect(complete.clone()).unwrap();
    assert_eq!(
        result,
        DownloadResponse {
            offset: 4,
            total: 10,
            validator: "\"version-1\"".to_string()
        }
    );
    let mut unknown_length = complete.clone();
    unknown_length["contentLength"] = json!("");
    assert_eq!(inspect(unknown_length).unwrap().total, 10);
    let mut weak = complete.clone();
    weak["etag"] = json!("W/\"weak\"");
    weak["priorValidator"] = json!("Tue, 01 Jan 2030 00:00:00 GMT");
    assert_eq!(inspect(weak).unwrap().total, 10);
    for (field, value) in [
        ("priorTotal", json!(11)),
        ("priorTotal", Value::Null),
        ("priorValidator", json!("changed")),
        ("priorValidator", Value::Null),
        ("contentLength", json!("5")),
        ("contentRange", json!("bytes 3-9/10")),
        ("contentRange", json!("bytes 4-3/10")),
        ("contentRange", json!("bytes 4-9/9")),
    ] {
        let mut changed = complete.clone();
        changed[field] = value;
        assert_eq!(
            inspect(changed).unwrap_err().code,
            "INVALID_RANGE",
            "field {field}"
        );
    }
    assert_eq!(
        inspect(json!({"status":206,"offset":0,"contentLength":"5","contentRange":"bytes 0-4/10"}))
            .unwrap()
            .total,
        10
    );
}

#[test]
fn malformed_ranges_compression_and_oversized_totals_fail_before_body_writes() {
    for range in [
        "",
        "Bytes 0-9/10",
        "bytes 0-9/*",
        "bytes 0-9/10 ",
        " bytes 0-9/10",
        "bytes +0-9/10",
        "bytes 0-9/10/1",
        "bytes 0-10/10",
        "bytes 1-9/10",
    ] {
        assert_eq!(
            inspect(json!({"status":206,"contentRange":range}))
                .unwrap_err()
                .code,
            "INVALID_RANGE",
            "range {range}"
        );
    }
    assert_eq!(
        inspect(json!({"status":206,"contentRange":"bytes 0-9/214748364801"}))
            .unwrap_err()
            .code,
        "FILE_TOO_LARGE"
    );
    assert_eq!(
        inspect(json!({"status":206,"contentRange":"bytes 0-9/9007199254740992"}))
            .unwrap_err()
            .code,
        "FILE_TOO_LARGE"
    );
    assert_eq!(
        inspect(json!({"status":206,"contentRange":"bytes 00-09/010"}))
            .unwrap()
            .total,
        10
    );
    for encoding in ["gzip", "br", "Identity", "", "identity "] {
        assert_eq!(
            inspect(json!({"contentEncoding":encoding}))
                .unwrap_err()
                .code,
            "INVALID_RANGE"
        );
    }
}

#[test]
fn expected_sizes_match_known_totals_and_supply_unknown_totals() {
    assert_eq!(inspect(json!({"expectedSize":10})).unwrap().total, 10);
    assert_eq!(inspect(json!({"expectedSize":null})).unwrap().total, 10);
    assert_eq!(
        inspect(json!({"contentLength":"0","expectedSize":20}))
            .unwrap()
            .total,
        20
    );
    assert_eq!(
        inspect(json!({"contentLength":"0","expectedSize":214748364800u64}))
            .unwrap()
            .total,
        214748364800
    );
    assert_eq!(
        inspect(json!({"expectedSize":20})).unwrap_err().code,
        "SIZE_MISMATCH"
    );
    assert_eq!(
        inspect(
            json!({"status":206,"contentLength":"5","contentRange":"bytes 0-4/10","expectedSize":5})
        )
        .unwrap_err()
        .code,
        "SIZE_MISMATCH"
    );
    assert_eq!(
        inspect(json!({"contentLength":"0","expectedSize":214748364801u64}))
            .unwrap_err()
            .code,
        "FILE_TOO_LARGE"
    );
}

#[test]
fn new_full_responses_accept_long_ascii_and_latin1_validators() {
    for character in ["a", "é"] {
        let validator = format!("\"{}\"", character.repeat(9000));
        let result = inspect(json!({"status":200,"offset":5,"etag":validator})).unwrap();
        assert_eq!(result.offset, 0);
        assert_eq!(result.total, 10);
        assert_eq!(result.validator, validator);
    }
}

#[test]
fn numeric_and_header_inputs_are_bounded_and_errors_do_not_echo_headers() {
    for (field, value) in [
        ("status", json!(199)),
        ("status", json!(300)),
        ("status", json!(200.5)),
        ("offset", json!(-1)),
        ("offset", json!(0.5)),
        ("offset", json!(9007199254740992u64)),
        ("priorTotal", json!(-1)),
        ("priorTotal", json!(9007199254740992u64)),
        ("expectedSize", json!(0.5)),
        ("expectedSize", json!(9007199254740992u64)),
        ("contentLength", json!(10)),
    ] {
        let mut invalid = input(json!({}));
        invalid[field] = value;
        assert_eq!(
            inspect_response(&invalid.to_string()).unwrap_err().code,
            "BAD_REQUEST",
            "field {field}"
        );
    }
    for field in [
        "contentLength",
        "contentEncoding",
        "etag",
        "lastModified",
        "contentRange",
        "priorValidator",
    ] {
        let mut oversized = input(json!({}));
        oversized[field] = json!("private-header".repeat(1200));
        let error = inspect_response(&oversized.to_string()).unwrap_err();
        assert_eq!(error.code, "BAD_REQUEST");
        assert!(!error.message.contains("private-header"));
    }
    assert_eq!(
        inspect(json!({"etag":"é".repeat(16384)}))
            .unwrap()
            .validator
            .encode_utf16()
            .count(),
        16384
    );
    assert_eq!(
        inspect(json!({"etag":"é".repeat(16385)})).unwrap_err().code,
        "BAD_REQUEST"
    );
    assert_eq!(
        inspect(json!({"priorValidator":"é".repeat(16385)}))
            .unwrap_err()
            .code,
        "BAD_REQUEST"
    );
    for payload in ["not json", "null", "[]", "{\"status\":1e999}"] {
        assert_eq!(inspect_response(payload).unwrap_err().code, "BAD_REQUEST");
    }
}
