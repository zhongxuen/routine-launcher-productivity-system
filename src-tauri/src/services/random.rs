//! Random tokens from the operating system's generator.
//!
//! Two callers: the sync folder's device id (`services::sync`) and the phone
//! companion's pairing token (`services::companion`). The second is a secret,
//! which is why neither is made from the clock or a counter.

use super::error::{ServiceError, ServiceResult};

/// `bytes` random bytes as lowercase hex (twice as many characters).
pub fn hex_token(bytes: usize) -> ServiceResult<String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::getrandom(&mut buffer).map_err(|error| {
        ServiceError::validation(format!("Windows could not provide random numbers: {error}"))
    })?;
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_hex_of_the_right_length_and_differ() {
        let a = hex_token(32).unwrap();
        let b = hex_token(32).unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b);
    }
}
