//! Verification of existing Node scrypt records; record creation stays in the host.

use crate::CoreError;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

const MAX_PASSWORD_BYTES: usize = 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    password_hex: String,
    stored: String,
}

#[derive(Debug, Serialize)]
pub struct Verification {
    pub matches: bool,
}

fn bad_request() -> CoreError {
    CoreError::new("BAD_REQUEST", "Password verification input is invalid")
}

fn bad_record() -> CoreError {
    CoreError::new("PASSWORD_RECORD", "Stored password record is invalid")
}

fn kdf_error() -> CoreError {
    CoreError::new("PASSWORD_KDF", "Password verification is unavailable")
}

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    text.as_bytes()
        .chunks(2)
        .map(|pair| {
            let [high, low] = pair else { return None };
            let high = (*high as char).to_digit(16)?;
            let low = (*low as char).to_digit(16)?;
            Some((high * 16 + low) as u8)
        })
        .collect()
}

pub fn verify_password(payload: &str) -> Result<Verification, CoreError> {
    let input: Input = serde_json::from_str(payload).map_err(|_| bad_request())?;
    if input.password_hex.len() > MAX_PASSWORD_BYTES * 2 {
        return Err(bad_request());
    }
    let password = decode_hex(&input.password_hex).ok_or_else(bad_request)?;
    if input.stored.len() != 97 {
        return Err(bad_record());
    }
    let (salt_hex, hash_hex) = input.stored.split_once(':').ok_or_else(bad_record)?;
    if salt_hex.len() != 32 || hash_hex.len() != 64 {
        return Err(bad_record());
    }
    let salt = decode_hex(salt_hex).ok_or_else(bad_record)?;
    let expected = decode_hex(hash_hex).ok_or_else(bad_record)?;
    let mut actual = [0u8; 32];
    // Node scryptSync defaults: N=16384, r=8, p=1; existing records use 32-byte keys.
    let params = scrypt::Params::new(14, 8, 1, actual.len()).map_err(|_| kdf_error())?;
    scrypt::scrypt(&password, &salt, &params, &mut actual).map_err(|_| kdf_error())?;
    Ok(Verification {
        matches: bool::from(actual.as_slice().ct_eq(expected.as_slice())),
    })
}
