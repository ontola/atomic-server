//! Immutable, locally registered schema definitions. Hashes cover JSON-AD bodies,
//! without @id or mutable CRDT/commit metadata. No HTTP origin participates.
use crate::{errors::AtomicResult, Resource, Subject};
use serde_json::Value;

pub const PREFIX: &str = "atomic:frozen:";
pub const MAX_BYTES: usize = 256 * 1024;

pub fn is_frozen(subject: &Subject) -> bool {
    crate::identifiers::identifier_body(subject.as_str()).is_some_and(|s| s.starts_with("frozen:"))
}

pub fn id(body: &Value) -> AtomicResult<String> {
    let object = body
        .as_object()
        .ok_or("Frozen definition must be an object")?;
    for key in ["@id", crate::urls::LORO_UPDATE, crate::urls::LAST_COMMIT] {
        if object.contains_key(key) {
            return Err(format!("Frozen definition cannot contain {key}").into());
        }
    }
    fn check_depth(value: &Value, depth: usize) -> AtomicResult<()> {
        if depth > 64 {
            return Err("Definition nesting exceeds 64 levels".into());
        }
        match value {
            Value::Array(items) => {
                for item in items {
                    check_depth(item, depth + 1)?;
                }
            }
            Value::Object(map) => {
                for item in map.values() {
                    check_depth(item, depth + 1)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    check_depth(body, 0)?;
    let bytes = serde_jcs::to_vec(body)?;
    if bytes.len() > MAX_BYTES {
        return Err("Frozen definition exceeds 256 KiB".into());
    }
    Ok(format!("{PREFIX}{}", blake3::hash(&bytes).to_hex()))
}

pub fn body(resource: &Resource) -> AtomicResult<Value> {
    crate::serialize::propvals_to_json_ad_map(
        resource.get_propvals(),
        None,
        "http://localhost",
        true,
    )
}

pub fn freeze(resource: &Resource) -> AtomicResult<Resource> {
    let subject = id(&body(resource)?)?;
    Ok(Resource::from_propvals(
        resource.get_propvals().clone(),
        subject.into(),
    ))
}

pub fn verify(resource: &Resource) -> AtomicResult<()> {
    if !is_frozen(resource.get_subject()) {
        return Ok(());
    }
    let expected = id(&body(resource)?)?;
    if resource.get_subject().pure_id() != expected {
        return Err("Frozen definition does not match its content hash".into());
    }
    Ok(())
}
