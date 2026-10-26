use mnemo_core::password::verify_password;
use serde_json::{json, Value};

fn vectors() -> Value {
    serde_json::from_str(include_str!("fixtures/password-vectors.json")).unwrap()
}

#[test]
fn existing_node_openssl_scrypt_records_match_all_synthetic_vectors() {
    let fixture = vectors();
    assert_eq!(
        fixture["parameters"],
        json!({"N":16384,"r":8,"p":1,"keylen":32})
    );
    for vector in fixture["vectors"].as_array().unwrap() {
        let input = json!({"passwordHex":vector["passwordHex"],"stored":vector["stored"]});
        assert!(
            verify_password(&input.to_string()).unwrap().matches,
            "vector {}",
            vector["label"]
        );
    }
    assert_eq!(
        fixture["vectors"][2]["passwordHex"],
        "efbfbd6d6964646c65efbfbd"
    );
}

#[test]
fn wrong_password_is_a_normal_false_result_and_uppercase_hex_is_valid() {
    let fixture = vectors();
    let vector = &fixture["vectors"][0];
    let wrong = json!({"passwordHex":"00","stored":vector["stored"]});
    assert!(!verify_password(&wrong.to_string()).unwrap().matches);
    let uppercase = json!({
        "passwordHex":vector["passwordHex"].as_str().unwrap().to_ascii_uppercase(),
        "stored":vector["stored"].as_str().unwrap().to_ascii_uppercase()
    });
    assert!(verify_password(&uppercase.to_string()).unwrap().matches);
}

#[test]
fn malformed_records_and_password_input_have_distinct_static_errors() {
    let fixture = vectors();
    let valid = fixture["vectors"][0]["stored"].as_str().unwrap();
    for record in [
        "".to_string(),
        "ab:cd".to_string(),
        "0".repeat(97),
        format!("{}:{}", "g".repeat(32), "0".repeat(64)),
        format!("{}:{}", "0".repeat(32), "z".repeat(64)),
        format!("{}:{}", "0".repeat(31), "0".repeat(65)),
    ] {
        let input = json!({"passwordHex":"00","stored":record});
        assert_eq!(
            verify_password(&input.to_string()).unwrap_err().code,
            "PASSWORD_RECORD"
        );
    }
    for password_hex in [
        "f".to_string(),
        "gg".to_string(),
        "é".to_string(),
        "00".repeat(1025),
    ] {
        let input = json!({"passwordHex":password_hex,"stored":valid});
        assert_eq!(
            verify_password(&input.to_string()).unwrap_err().code,
            "BAD_REQUEST"
        );
    }
    for input in [
        "not json",
        "null",
        "[]",
        r#"{"passwordHex":null,"stored":"private-record"}"#,
    ] {
        let error = verify_password(input).unwrap_err();
        assert_eq!(error.code, "BAD_REQUEST");
        assert!(!error.message.contains("private-record"));
    }
}
