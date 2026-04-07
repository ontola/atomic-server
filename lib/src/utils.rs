//! Helper functions for dealing with URLs

use crate::errors::AtomicResult;
use url::Url;

/// Removes the path and query from a String, returns the base server URL
pub fn server_url(url: &str) -> AtomicResult<String> {
    let mut parsed: Url = Url::parse(url)?;

    match parsed.path_segments_mut() {
        Ok(mut path) => {
            path.clear();
        }
        Err(_) => return Err(format!("Url {} is not valid.", url).into()),
    }

    parsed.set_query(None);

    Ok(parsed.to_string())
}

/// Throws an error if the URL is not a valid URL
pub fn check_valid_url(url: &str) -> AtomicResult<()> {
    if url.starts_with("http") || url.starts_with("did:") || url.starts_with('/') {
        return Ok(());
    }
    if url.starts_with("internal:") {
        // internal:/ is always valid
        if url == "internal:/" {
            return Ok(());
        }
        // internal:/path is also valid
        if url.starts_with("internal:/") {
            return Ok(());
        }
    }
    Err(format!("Url does not start with http, did: or internal:/: {}", url).into())
}

pub fn check_valid_uri(uri: &str) -> AtomicResult<()> {
    url::Url::parse(uri).map_err(|e| format!("Invalid URI: {}. {}", uri, e))?;
    Ok(())
}

pub fn check_valid_json(json: &str) -> AtomicResult<()> {
    let _: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Invalid JSON: {}. {}", json, e))?;

    Ok(())
}

/// Returns the current timestamp in milliseconds since UNIX epoch
#[cfg(not(target_arch = "wasm32"))]
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("You're a time traveler")
        .as_millis() as i64
}

/// Returns the current timestamp in milliseconds since UNIX epoch (WASM version)
#[cfg(target_arch = "wasm32")]
pub fn now() -> i64 {
    js_sys::Date::now() as i64
}

/// Generates a relatively short random string of n length
pub fn random_string(n: usize) -> String {
    use rand::Rng;
    let random_string: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(n)
        .map(char::from)
        .collect();
    random_string.to_lowercase()
}

pub fn check_timestamp_in_past(timestamp: i64, difference: i64) -> AtomicResult<()> {
    let now = crate::utils::now();
    if timestamp > now + difference {
        return Err(format!(
                "Commit CreatedAt timestamp must lie in the past. Check your clock. Timestamp now: {} CreatedAt is: {}",
                now, timestamp
            )
            .into());
    }
    Ok(())
}

pub fn truncate_string(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        return s.to_string();
    }

    let mut end = max_len;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[0..end].to_string()
}
