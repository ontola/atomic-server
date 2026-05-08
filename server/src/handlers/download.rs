use crate::{
    appstate::AppState, context::RequestContext, errors::AtomicServerResult,
    helpers::get_client_agent,
};
use actix_web::{web, HttpRequest, HttpResponse};
use atomic_lib::{urls, Resource, Storelike};

use serde::Deserialize;
use std::collections::HashSet;

#[serde_with::serde_as]
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Debug)]
pub struct DownloadParams {
    pub q: Option<f32>,
    pub w: Option<u32>,
    pub f: Option<String>,
}

/// Downloads the File of the Resource that matches the same URL minus the `/download` path.
#[tracing::instrument(skip(appstate, req))]
pub async fn handle_download(
    path: Option<web::Path<String>>,
    appstate: web::Data<AppState>,
    params: web::Query<DownloadParams>,
    req: actix_web::HttpRequest,
) -> AtomicServerResult<HttpResponse> {
    let headers = req.headers();
    let origin = RequestContext::new(&req, &appstate).origin;
    let store = &appstate.store;

    let subject_path = if let Some(pth) = path {
        format!("/{}", pth)
    } else {
        // There is no end string, so It's the root of the URL, the base URL!
        return Err("Put `/download` in front of an File URL to download it.".into());
    };

    // Content-addressed shortcut: `/download/files/<64-hex>` serves the blob
    // directly from Tree::Blobs without requiring a resource to live at
    // `<origin>/files/<hash>`. Only fires for raw fetches — image-processing
    // params still go through the File-resource path so we can read mimetype.
    if params.q.is_none() && params.w.is_none() && params.f.is_none() {
        if let Some(hash_hex) = subject_path.strip_prefix("/files/") {
            if let Some(bytes) = blob_by_hash_hex(hash_hex, &appstate)? {
                return Ok(HttpResponse::Ok()
                    .content_type("application/octet-stream")
                    .body(bytes));
            }
        }
    }

    let subject = atomic_lib::Subject::from_raw(&subject_path, None);

    // Support did:ad:blob: subjects directly in /download
    if subject.is_blob_did() {
        if let Some(hash_hex) = subject.blob_hash_hex() {
            if let Some(bytes) = blob_by_hash_hex(hash_hex, &appstate)? {
                return Ok(HttpResponse::Ok()
                    .content_type("application/octet-stream")
                    .body(bytes));
            }
        }
    }

    let resolved_subject = subject.resolve(&origin);

    let for_agent = get_client_agent(headers, &appstate, &resolved_subject).await?;
    tracing::info!("handle_download: {}", resolved_subject);

    let resource = store
        .get_resource_extended(&resolved_subject.into(), false, &for_agent)
        .await?
        .to_single();

    download_file_handler_partial(&resource, &req, &params, &appstate)
}

/// Look up a blob by its hex-encoded BLAKE3 hash. Returns `None` if the input
/// is not a 64-char hex string or no blob is stored under that hash.
fn blob_by_hash_hex(hash_hex: &str, appstate: &AppState) -> AtomicServerResult<Option<Vec<u8>>> {
    if hash_hex.len() != 64 {
        return Ok(None);
    }
    let Ok(hash_bytes) = hex::decode(hash_hex) else {
        return Ok(None);
    };
    Ok(appstate
        .store
        .kv
        .get(atomic_lib::db::trees::Tree::Blobs, &hash_bytes)
        .ok()
        .flatten())
}

pub fn download_file_handler_partial(
    resource: &Resource,
    _req: &HttpRequest,
    params: &web::Query<DownloadParams>,
    appstate: &AppState,
) -> AtomicServerResult<HttpResponse> {
    let internal_id = resource
        .get(urls::INTERNAL_ID)
        .map_err(|e| format!("Internal ID of file could not be resolved. {}", e))?
        .to_string();

    let hash_bytes = hex::decode(&internal_id)
        .map_err(|_| format!("File internalId is not hex: {}", internal_id))?;
    if hash_bytes.len() != 32 {
        return Err(format!(
            "File internalId is not a 32-byte BLAKE3 hash: {}",
            internal_id
        )
        .into());
    }

    let bytes = appstate
        .store
        .kv
        .get(atomic_lib::db::trees::Tree::Blobs, &hash_bytes)?
        .ok_or_else(|| format!("Blob not found: {}", internal_id))?;

    let mimetype = resource
        .get(urls::MIMETYPE)
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "application/octet-stream".to_string());

    // No params: serve the original bytes verbatim.
    if params.q.is_none() && params.w.is_none() && params.f.is_none() {
        return Ok(HttpResponse::Ok().content_type(mimetype).body(bytes));
    }

    // With image params: serve a processed rendition. Cache it in Tree::Blobs
    // under a deterministic synthetic hash so future requests with the same
    // params hit the cache and any peer that has produced the same rendition
    // can serve it content-addressably.
    serve_processed_image(&bytes, &hash_bytes, params, appstate)
}

#[cfg(feature = "img")]
fn serve_processed_image(
    source_bytes: &[u8],
    source_hash: &[u8],
    params: &web::Query<DownloadParams>,
    appstate: &AppState,
) -> AtomicServerResult<HttpResponse> {
    use crate::handlers::image::{is_image_bytes, process_image_bytes};

    let format = get_format(params)?;
    let cache_key = processed_cache_key(source_hash, &format, params);

    if let Some(cached) = appstate
        .store
        .kv
        .get(atomic_lib::db::trees::Tree::Blobs, &cache_key)?
    {
        return Ok(HttpResponse::Ok()
            .content_type(mimetype_for(&format))
            .body(cached));
    }

    if !is_image_bytes(source_bytes) {
        return Err("Quality or width parameters are only supported for image files".into());
    }

    let encoded = process_image_bytes(source_bytes, params, &format)?;
    appstate
        .store
        .kv
        .insert(atomic_lib::db::trees::Tree::Blobs, &cache_key, &encoded)?;

    Ok(HttpResponse::Ok()
        .content_type(mimetype_for(&format))
        .body(encoded))
}

#[cfg(not(feature = "img"))]
fn serve_processed_image(
    _source_bytes: &[u8],
    _source_hash: &[u8],
    _params: &web::Query<DownloadParams>,
    _appstate: &AppState,
) -> AtomicServerResult<HttpResponse> {
    Err("Image processing is not enabled in this build (compile with the `img` feature)".into())
}

/// Deterministic 32-byte cache key for a processed rendition. Same source
/// hash + same params => same key on every server, so the rendition is
/// content-addressable across the mesh.
fn processed_cache_key(source_hash: &[u8], format: &str, params: &DownloadParams) -> [u8; 32] {
    let canonical = format!(
        "processed|hash={}|f={}|q={}|w={}",
        hex::encode(source_hash),
        format,
        params.q.map(|q| q.to_string()).unwrap_or_default(),
        params.w.map(|w| w.to_string()).unwrap_or_default(),
    );
    *blake3::hash(canonical.as_bytes()).as_bytes()
}

fn mimetype_for(format: &str) -> &'static str {
    match format {
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn get_format(params: &DownloadParams) -> AtomicServerResult<String> {
    let supported_compression_formats: HashSet<String> =
        HashSet::from_iter(vec!["webp".to_string(), "avif".to_string()]);

    let format = params.f.clone().unwrap_or("webp".to_string());
    if !supported_compression_formats.contains(&format) {
        return Err("Unsupported format".into());
    }

    Ok(format)
}
