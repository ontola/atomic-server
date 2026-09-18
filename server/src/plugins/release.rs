//! Resolving the Release an Installation pins, wherever it was published.
//!
//! A Release is content-addressed, so where it comes from does not matter for
//! integrity: the caller recomputes the id and compares it with the pinned one.
//! It can be a release id already in this node's KV cache, a `Release` resource
//! on this node, or a `Release` resource on another server, fetched through the
//! same SSRF-guarded client as a plugin's `downloadURL`. A remote release is
//! cached in the KV store under its id once fetched, so later runs pinned to
//! the id find it locally.

use atomic_lib::{
    agents::ForAgent,
    client::helpers::{fetch_body_untrusted, fetch_bytes_untrusted},
    db::plugin_release::PluginRelease,
    errors::AtomicResult,
    parse::{parse_json_ad_resource, ParseOpts, SaveOpts},
    urls, AtomicError, Db, Resource, Storelike, Subject, Value,
};

/// Largest package (zip) fetched from another server.
pub const PACKAGE_MAX_BYTES: usize = 50 * 1024 * 1024;

pub const JSON_AD: &str = "application/ad+json";

/// `reference` is a release id (`blake3:…`) or the URL of a `Release` resource.
///
/// The returned release is validated for shape but not yet compared with any
/// pinned id; that is the caller's decision.
pub async fn resolve(
    db: &Db,
    reference: &str,
    for_agent: &ForAgent,
) -> AtomicResult<PluginRelease> {
    if reference.starts_with("blake3:") {
        return db.get_plugin_release(reference);
    }
    let subject = Subject::from_raw(reference, db.get_base_domain().as_deref());
    let release = if subject.is_local() {
        let resource = db
            .get_resource_extended(&subject, false, for_agent)
            .await?
            .to_single();
        let package = local_package(db, &resource, for_agent).await?;
        PluginRelease::from_resource(&resource, package)?
    } else {
        let resource = fetch_remote_resource(reference, db).await?;
        let package = remote_package(db, &resource).await?;
        PluginRelease::from_resource(&resource, package)?
    };
    // Cache under its own id; publishing is idempotent for identical content.
    db.publish_plugin_release(&release)?;
    Ok(release)
}

/// Bytes of a wasip2 package, from this node's blob store.
pub async fn package_bytes(db: &Db, package: &str) -> AtomicResult<Vec<u8>> {
    let hash = package_hash(package)?;
    db.get_blob(&hash)
        .await?
        .ok_or_else(|| AtomicError::from(format!("package blob {package} is not on this node")))
}

fn package_hash(package: &str) -> AtomicResult<Vec<u8>> {
    match hex::decode(package) {
        Ok(hash) if hash.len() == 32 => Ok(hash),
        _ => Err(AtomicError::from(format!(
            "package {package} is not a blake3 hex hash"
        ))),
    }
}

/// Stores zip bytes content-addressed and returns their blake3 hex.
pub async fn store_package(db: &Db, bytes: &[u8]) -> AtomicResult<String> {
    let hash = blake3::hash(bytes);
    if !db.has_blob(hash.as_bytes()).await? {
        db.put_blob(hash.as_bytes(), bytes).await?;
    }
    Ok(hash.to_hex().to_string())
}

fn string_value(resource: &Resource, prop: &str) -> Option<String> {
    match resource.get(prop) {
        Ok(Value::AtomicUrl(s)) => Some(s.to_string()),
        Ok(Value::String(s)) => Some(s.clone()),
        Ok(other) => Some(other.to_string()),
        Err(_) => None,
    }
}

/// The package hash of a local `Release`, read from the File it points at.
async fn local_package(
    db: &Db,
    release: &Resource,
    for_agent: &ForAgent,
) -> AtomicResult<Option<String>> {
    let Some(file) = string_value(release, urls::PACKAGE) else {
        return Ok(None);
    };
    let file = db
        .get_resource_extended(&file.as_str().into(), false, for_agent)
        .await?
        .to_single();
    let internal_id = string_value(&file, urls::INTERNAL_ID)
        .ok_or("the Release's package File has no internalId")?;
    let hash = package_hash(&internal_id)?;
    if !db.has_blob(&hash).await? {
        return Err(AtomicError::from(format!(
            "package blob {internal_id} is not on this node"
        )));
    }
    Ok(Some(internal_id))
}

async fn fetch_remote_resource(url: &str, db: &Db) -> AtomicResult<Resource> {
    let body = fetch_body_untrusted(url, JSON_AD).await?;
    parse_json_ad_resource(
        &body,
        db,
        &ParseOpts {
            save: SaveOpts::DontSave,
            for_agent: ForAgent::Public,
            skip_unknown_props: true,
            ..Default::default()
        },
    )
    .await
}

/// The package of a remote `Release`: fetch its File, download the bytes,
/// verify them against the File's blake3 id and keep them locally.
async fn remote_package(db: &Db, release: &Resource) -> AtomicResult<Option<String>> {
    let Some(file_url) = string_value(release, urls::PACKAGE) else {
        return Ok(None);
    };
    let file = fetch_remote_resource(&file_url, db).await?;
    let internal_id = string_value(&file, urls::INTERNAL_ID)
        .ok_or("the remote package File has no internalId")?;
    let expected = package_hash(&internal_id)?;
    if db.has_blob(&expected).await? {
        return Ok(Some(internal_id));
    }
    let download_url = string_value(&file, urls::DOWNLOAD_URL)
        .ok_or("the remote package File has no downloadURL")?;
    let bytes = fetch_bytes_untrusted(&download_url, PACKAGE_MAX_BYTES).await?;
    if blake3::hash(&bytes).as_bytes() != expected.as_slice() {
        return Err(AtomicError::from(format!(
            "downloaded package does not match the File's hash {internal_id}"
        )));
    }
    db.put_blob(&expected, &bytes).await?;
    Ok(Some(internal_id))
}

/// TODO(manifest v2): validate `grants` against the unified manifest's
/// capability list with its reasons, once `manifest.rs` carries it. Until then
/// this only rejects a grant the manifest never asked for, and accepts
/// anything when the manifest declares no `permissions` or `capabilities`.
pub fn check_grants(manifest: &serde_json::Value, grants: &serde_json::Value) -> AtomicResult<()> {
    let mut declared: Vec<String> = Vec::new();
    if let Some(permissions) = manifest.get("permissions").and_then(|p| p.as_array()) {
        for entry in permissions {
            match entry {
                serde_json::Value::String(s) => declared.push(s.clone()),
                serde_json::Value::Object(o) => {
                    if let Some(s) = o.get("permission").and_then(|p| p.as_str()) {
                        declared.push(s.to_string());
                    }
                }
                _ => {}
            }
        }
    }
    if let Some(capabilities) = manifest.get("capabilities").and_then(|c| c.as_array()) {
        declared.extend(
            capabilities
                .iter()
                .filter_map(|c| c.as_str().map(String::from)),
        );
    }
    let has_declaration =
        manifest.get("permissions").is_some() || manifest.get("capabilities").is_some();
    let granted: Vec<String> = match grants {
        serde_json::Value::Null => Vec::new(),
        serde_json::Value::Array(items) => items
            .iter()
            .map(|item| match item {
                serde_json::Value::String(s) => Ok(s.clone()),
                other => Err(AtomicError::from(format!(
                    "grant {other} is not a capability name"
                ))),
            })
            .collect::<AtomicResult<_>>()?,
        serde_json::Value::Object(map) => map.keys().cloned().collect(),
        other => {
            return Err(AtomicError::from(format!(
                "grants must be a JSON array or object, got {other}"
            )))
        }
    };
    if !has_declaration {
        return Ok(());
    }
    for grant in granted {
        if !declared.contains(&grant) {
            return Err(AtomicError::from(format!(
                "grant '{grant}' is not declared by the plugin manifest"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn grants_must_be_declared_when_the_manifest_declares_anything() {
        let manifest = json!({"permissions":[{"permission":"storage","reason":"r"}],"capabilities":["network"]});
        check_grants(&manifest, &json!(["storage", "network"])).unwrap();
        check_grants(&manifest, &json!({"storage": true})).unwrap();
        check_grants(&manifest, &json!(null)).unwrap();
        assert!(check_grants(&manifest, &json!(["full-drive-access"])).is_err());
        assert!(check_grants(&manifest, &json!("storage")).is_err());
        // No declaration at all: nothing to check against yet.
        check_grants(&json!({"schemaVersion":1}), &json!(["anything"])).unwrap();
    }

    #[test]
    fn package_hashes_are_blake3_hex() {
        assert!(package_hash(&"ab".repeat(32)).is_ok());
        assert!(package_hash("ab").is_err());
        assert!(package_hash(&"zz".repeat(32)).is_err());
    }
}
