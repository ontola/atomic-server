use actix_web::{web, HttpResponse};

use crate::{appstate::AppState, errors::AtomicServerResult};

/// HTTP fallback for pushing blob bytes to the server. Used by clients when
/// the WebSocket BLOB_RESPONSE path isn't available (WS not open, restricted
/// network, etc.). The hash is verified server-side: a body whose BLAKE3
/// digest doesn't match the URL hash is rejected.
///
/// Public on purpose: the hash is the capability. Anyone who knows the hash
/// can read or write its bytes. Storage is content-addressed and immutable —
/// re-posting the same hash is a no-op.
#[tracing::instrument(skip(appstate, body))]
pub async fn put_blob(
    path: web::Path<String>,
    appstate: web::Data<AppState>,
    body: web::Bytes,
) -> AtomicServerResult<HttpResponse> {
    let hash_hex = path.into_inner();
    if hash_hex.len() != 64 {
        return Err("Hash must be 64 hex chars (BLAKE3)".into());
    }
    let hash_bytes =
        hex::decode(&hash_hex).map_err(|_| "Hash must be valid hex".to_string())?;

    let computed = blake3::hash(&body);
    if computed.as_bytes() != hash_bytes.as_slice() {
        return Err(format!(
            "Body hash {} does not match URL hash {}",
            computed.to_hex(),
            hash_hex
        )
        .into());
    }

    appstate
        .store
        .kv
        .insert(atomic_lib::db::trees::Tree::Blobs, &hash_bytes, &body)?;

    Ok(HttpResponse::NoContent().finish())
}
