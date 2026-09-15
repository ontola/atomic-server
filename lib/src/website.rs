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
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub assets: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
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
        if self.assets.len() + self.files.len() > 100
            || self.assets.iter().any(|(path, hash)| {
                !valid_asset(path) || !path.starts_with(&format!("assets/{hash}."))
            })
        {
            return Err("Invalid website image asset manifest".into());
        }
        if serde_json::to_vec(self)?.len() > MAX_BYTES {
            return Err("Website package exceeds the 5 MB pilot limit".into());
        }
        Ok(())
    }
    pub fn id(&self) -> AtomicResult<String> {
        self.validate()?;
        Ok(blake3::hash(&serde_json::to_vec(&self.manifest())?)
            .to_hex()
            .to_string())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WebsiteManifest {
    pub version: u32,
    pub files: BTreeMap<String, String>,
    pub assets: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}
impl WebsitePackage {
    pub fn manifest(&self) -> WebsiteManifest {
        WebsiteManifest {
            version: 2,
            files: self
                .files
                .iter()
                .map(|(path, bytes)| {
                    (
                        path.clone(),
                        blake3::hash(bytes.as_bytes()).to_hex().to_string(),
                    )
                })
                .collect(),
            assets: self.assets.clone(),
            metadata: self.metadata.clone(),
        }
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
pub fn valid_asset(path: &str) -> bool {
    let Some(name) = path.strip_prefix("assets/") else {
        return false;
    };
    let Some((hash, ext)) = name.split_once('.') else {
        return false;
    };
    hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        && matches!(ext, "png" | "jpeg" | "webp" | "gif")
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
            assets: BTreeMap::new(),
            metadata: None,
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
