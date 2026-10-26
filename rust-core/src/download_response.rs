//! Pure download response checks copied from the host's nativeDownload decisions.

use crate::CoreError;
use serde::{Deserialize, Serialize};

const MAX_MEDIA_BYTES: u64 = 200 * 1024 * 1024 * 1024;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const MAX_HEADER_UTF16_UNITS: usize = 16384;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    status: f64,
    offset: f64,
    prior_total: Option<f64>,
    prior_validator: Option<String>,
    content_length: String,
    content_encoding: String,
    etag: String,
    last_modified: String,
    content_range: String,
    expected_size: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DownloadResponse {
    pub offset: u64,
    pub total: u64,
    pub validator: String,
}

fn bad_request() -> CoreError {
    CoreError::new("BAD_REQUEST", "Download response input is invalid")
}

fn invalid_range() -> CoreError {
    CoreError::new(
        "INVALID_RANGE",
        "Download response does not match the requested range",
    )
}

fn too_large() -> CoreError {
    CoreError::new(
        "FILE_TOO_LARGE",
        "Download size is invalid or exceeds 200 GiB",
    )
}

fn safe_integer(value: f64) -> Option<u64> {
    (value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= MAX_SAFE_INTEGER)
        .then_some(value as u64)
}

fn js_whitespace(character: char) -> bool {
    matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn js_number(text: &str) -> Option<f64> {
    let text = text.trim_matches(js_whitespace);
    if text.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(digits) = text.strip_prefix(prefix) {
            if digits.is_empty() {
                return None;
            }
            let mut value = 0.0;
            for byte in digits.bytes() {
                value = value * f64::from(radix) + f64::from((byte as char).to_digit(radix)?);
            }
            return Some(value);
        }
    }
    if !text
        .bytes()
        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'.' | b'e' | b'E'))
    {
        return None;
    }
    text.parse().ok()
}

fn content_range(text: &str) -> Option<(f64, f64, f64)> {
    let (start, remainder) = text.strip_prefix("bytes ")?.split_once('-')?;
    let (end, total) = remainder.split_once('/')?;
    let number = |digits: &str| {
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        digits.parse::<f64>().ok()
    };
    Some((number(start)?, number(end)?, number(total)?))
}

pub fn inspect_response(payload: &str) -> Result<DownloadResponse, CoreError> {
    let input: Input = serde_json::from_str(payload).map_err(|_| bad_request())?;
    let status = safe_integer(input.status).ok_or_else(bad_request)?;
    if !(200..=299).contains(&status) {
        return Err(bad_request());
    }
    let mut offset = safe_integer(input.offset).ok_or_else(bad_request)?;
    let prior_total = input
        .prior_total
        .map(|value| safe_integer(value).ok_or_else(bad_request))
        .transpose()?;
    let expected_size = input
        .expected_size
        .map(|value| safe_integer(value).ok_or_else(bad_request))
        .transpose()?;
    for header in [
        input.content_length.as_str(),
        input.content_encoding.as_str(),
        input.etag.as_str(),
        input.last_modified.as_str(),
        input.content_range.as_str(),
        input.prior_validator.as_deref().unwrap_or(""),
    ] {
        if header.encode_utf16().count() > MAX_HEADER_UTF16_UNITS {
            return Err(bad_request());
        }
    }
    if input.content_encoding != "identity" {
        return Err(invalid_range());
    }
    let mut total = js_number(&input.content_length)
        .and_then(safe_integer)
        .filter(|value| *value <= MAX_MEDIA_BYTES)
        .ok_or_else(too_large)?;
    let validator = if !input.etag.is_empty() && !input.etag.starts_with("W/") {
        input.etag
    } else {
        input.last_modified
    };
    if status == 206 {
        let (start, end, range_total) =
            content_range(&input.content_range).ok_or_else(invalid_range)?;
        if start != offset as f64
            || end < offset as f64
            || range_total <= end
            || (offset > 0
                && (prior_total.map(|value| value as f64) != Some(range_total)
                    || input.prior_validator.as_deref() != Some(validator.as_str())))
        {
            return Err(invalid_range());
        }
        if total != 0 && total as f64 != end - offset as f64 + 1.0 {
            return Err(invalid_range());
        }
        total = safe_integer(range_total)
            .filter(|value| *value <= MAX_MEDIA_BYTES)
            .ok_or_else(too_large)?;
    } else {
        offset = 0;
    }
    if let Some(expected) = expected_size {
        if total != 0 && total != expected {
            return Err(CoreError::new(
                "SIZE_MISMATCH",
                "Download size does not match the expected size",
            ));
        }
        if expected > MAX_MEDIA_BYTES {
            return Err(too_large());
        }
        total = expected;
    }
    Ok(DownloadResponse {
        offset,
        total,
        validator,
    })
}
