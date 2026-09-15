//! Portable static deployment contract. No graph traversal, authoring config or credentials.
use crate::errors::AtomicResult;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_BYTES: usize = 5_000_000;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WebsitePackage {
    pub version: u32,
    pub files: BTreeMap<String, String>,
}
impl WebsitePackage {
    pub fn validate(&self) -> AtomicResult<()> {
        if self.version != 1 || !self.files.contains_key("index.html") || self.files.len() > 100 {
            return Err(
                "Unsupported website package or missing index.html (maximum 100 files)".into(),
            );
        }
        if self.files.iter().any(|(path, _)| !valid_path(path)) {
            return Err("Invalid website file path or unsupported file type".into());
        }
        if serde_json::to_vec(self)?.len() > MAX_BYTES {
            return Err("Website package exceeds the 5 MB pilot limit".into());
        }
        Ok(())
    }
    pub fn id(&self) -> AtomicResult<String> {
        self.validate()?;
        Ok(blake3::hash(&serde_json::to_vec(self)?)
            .to_hex()
            .to_string())
    }
}
pub fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 240
        && path.split('/').all(|part| {
            !part.is_empty()
                && !part.starts_with('.')
                && part
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"-_.".contains(&c))
        })
        && [".html", ".css", ".js"]
            .iter()
            .any(|ext| path.ends_with(ext))
}
pub fn project_id(subject: &str) -> String {
    // 160 bits fits in a DNS label. The bound full subject is checked on writes.
    blake3::hash(subject.as_bytes()).to_hex()[..40].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packages_are_bounded_and_content_addressed() {
        let mut p = WebsitePackage {
            version: 1,
            files: BTreeMap::from([("index.html".into(), "Hello".into())]),
        };
        let id = p.id().unwrap();
        p.files.insert("index.html".into(), "Changed".into());
        assert_ne!(id, p.id().unwrap());
        for path in [
            "../index.html",
            "/index.html",
            "a//index.html",
            "a/../../x.js",
            "a\\x.js",
            "%2e.js",
            ".env",
            "x.svg",
        ] {
            assert!(!valid_path(path), "{path}");
        }
        p.files.insert("index.html".into(), "x".repeat(MAX_BYTES));
        assert!(p.validate().is_err());
    }
}
