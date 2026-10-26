//! One-request, bounded JSON protocol for the portable parsing core.

pub mod cms;
pub mod download_response;
pub mod feed;
pub mod password;

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

pub const PROTOCOL_VERSION: u32 = 1;
pub const VERSION_BANNER: &str = concat!("mnemo-core ", env!("CARGO_PKG_VERSION"), " protocol=1");
pub const MAX_REQUEST_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RESULTS: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CoreError {
    pub code: &'static str,
    pub message: &'static str,
}

impl CoreError {
    pub const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CoreError {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u32,
    op: String,
    payload: String,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Parsed {
    CmsList { items: Vec<cms::CmsSummary> },
    CmsDetail { details: Vec<cms::CmsDetail> },
    Feed(feed::Feed),
    Password(password::Verification),
    DownloadResponse(download_response::DownloadResponse),
}

#[derive(Serialize)]
#[serde(untagged)]
enum Response {
    Success { ok: bool, result: Parsed },
    Failure { ok: bool, error: CoreError },
}

fn parse_request(bytes: &[u8]) -> Result<Parsed, CoreError> {
    let request: Request = serde_json::from_slice(bytes).map_err(|error| {
        if error.is_data() {
            CoreError::new(
                "BAD_REQUEST",
                "Request must contain version, op and string payload",
            )
        } else {
            CoreError::new("BAD_JSON", "Request is not valid JSON")
        }
    })?;
    if request.payload.len() > MAX_PAYLOAD_BYTES {
        return Err(CoreError::new("LIMIT", "Payload exceeds 4 MiB UTF-8 limit"));
    }
    if request.version != PROTOCOL_VERSION {
        return Err(CoreError::new(
            "BAD_VERSION",
            "Unsupported protocol version",
        ));
    }
    match request.op.as_str() {
        "cms_list" => cms::parse_vod_list(&request.payload).map(|items| Parsed::CmsList { items }),
        "cms_detail" => {
            cms::parse_vod_detail(&request.payload).map(|details| Parsed::CmsDetail { details })
        }
        "feed" => feed::parse_feed(&request.payload).map(Parsed::Feed),
        "password_verify" => password::verify_password(&request.payload).map(Parsed::Password),
        "download_response" => {
            download_response::inspect_response(&request.payload).map(Parsed::DownloadResponse)
        }
        _ => Err(CoreError::new("BAD_OP", "Unsupported core operation")),
    }
}

struct BoundedOutput(Vec<u8>);

impl Write for BoundedOutput {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_OUTPUT_BYTES - self.0.len() {
            return Err(std::io::Error::other("output limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn encode_response(result: Result<Parsed, CoreError>) -> Vec<u8> {
    let response = match result {
        Ok(result) => Response::Success { ok: true, result },
        Err(error) => Response::Failure { ok: false, error },
    };
    let mut output = BoundedOutput(Vec::new());
    if serde_json::to_writer(&mut output, &response).is_err() {
        return serde_json::to_vec(&Response::Failure {
            ok: false,
            error: CoreError::new("LIMIT", "Response exceeds 8 MiB output limit"),
        })
        .expect("static error response is serializable");
    }
    output.0
}

/// Read no more than the request limit plus one byte, then return one JSON document.
pub fn handle_stdio_request(input: impl Read) -> Vec<u8> {
    let mut bytes = Vec::new();
    let result = match input
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
    {
        Err(_) => Err(CoreError::new("IO_ERROR", "Failed to read request")),
        Ok(_) if bytes.len() > MAX_REQUEST_BYTES => Err(CoreError::new(
            "LIMIT",
            "Request exceeds 25 MiB input limit",
        )),
        Ok(_) => parse_request(&bytes),
    };
    encode_response(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_limit_returns_one_small_error_instead_of_partial_json() {
        let result = Parsed::Feed(feed::Feed {
            title: Some("x".repeat(MAX_OUTPUT_BYTES)),
            ..feed::Feed::default()
        });
        let output = encode_response(Ok(result));
        assert!(output.len() < 256);
        let response: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "LIMIT");
    }

    #[test]
    fn input_reader_stops_at_limit_plus_one_byte() {
        let input = std::io::repeat(b' ');
        let output = handle_stdio_request(input);
        let response: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(response["error"]["code"], "LIMIT");
    }

    #[test]
    fn input_failure_is_an_observable_domain_error() {
        struct BrokenInput;
        impl Read for BrokenInput {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("private reader error"))
            }
        }
        let output = handle_stdio_request(BrokenInput);
        let response: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(response["error"]["code"], "IO_ERROR");
        assert!(!String::from_utf8(output)
            .unwrap()
            .contains("private reader error"));
    }
}
