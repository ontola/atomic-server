use actix_web::{web, HttpResponse};

use crate::{appstate::AppState, errors::AtomicServerResult};

/// Content type for materializable JSON-AD frozen bodies.
const AD_JSON: &str = "application/ad+json";

fn validate_hash_hex(hash_hex: &str) -> AtomicServerResult<()> {
    if hash_hex.len() != 64 || !hash_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Frozen hash must be 64 hex chars (BLAKE3)".into());
    }
    Ok(())
}

/// HTTP fallback for pushing a `did:ad:frozen` body to the server. Unlike a blob
/// (opaque bytes hashed directly), a frozen body is JSON-AD and its id is
/// `blake3(JCS(body))` — so we parse, canonicalize, and check the content hash
/// matches the URL hash. A mismatch is rejected.
///
/// Public on purpose: the hash is the capability, and storage is content-
/// addressed and immutable — re-posting the same hash is a no-op. We store the
/// canonical JCS bytes so reads round-trip and re-verify.
#[tracing::instrument(skip(appstate, body))]
pub async fn put_frozen(
    path: web::Path<String>,
    appstate: web::Data<AppState>,
    body: web::Bytes,
) -> AtomicServerResult<HttpResponse> {
    let hash_hex = path.into_inner();
    validate_hash_hex(&hash_hex)?;

    let parsed: serde_json::Value =
        serde_json::from_slice(&body).map_err(|e| format!("Frozen body must be JSON: {e}"))?;

    let id = atomic_lib::frozen::frozen_id(&parsed)?;
    let expected = format!("{}{}", atomic_lib::subject::DID_AD_FROZEN_PREFIX, hash_hex);
    if id != expected {
        return Err(format!("Frozen body hashes to {id}, does not match URL hash {hash_hex}").into());
    }

    let canonical = serde_jcs::to_string(&parsed).map_err(|e| e.to_string())?;
    appstate.store.kv.insert(
        atomic_lib::db::trees::Tree::Frozen,
        hash_hex.as_bytes(),
        canonical.as_bytes(),
    )?;

    Ok(HttpResponse::NoContent().finish())
}

/// Serves the raw JSON-AD bytes of a frozen resource by hash. Content-addressed,
/// so the client re-verifies by re-hashing; the server is just a cache.
#[tracing::instrument(skip(appstate))]
pub async fn get_frozen(
    path: web::Path<String>,
    appstate: web::Data<AppState>,
) -> AtomicServerResult<HttpResponse> {
    let hash_hex = path.into_inner();
    validate_hash_hex(&hash_hex)?;

    match appstate
        .store
        .kv
        .get(atomic_lib::db::trees::Tree::Frozen, hash_hex.as_bytes())?
    {
        Some(bytes) => Ok(HttpResponse::Ok().content_type(AD_JSON).body(bytes)),
        None => Ok(HttpResponse::NotFound().finish()),
    }
}
