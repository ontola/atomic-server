use crate::{appstate::AppState, errors::AtomicServerResult, helpers::get_client_agent};
use actix_files::NamedFile;
use actix_web::http::header::{
    ContentDisposition, DispositionParam, DispositionType, HeaderName, HeaderValue,
};
use actix_web::{web, HttpRequest, HttpResponse};
use atomic_lib::{urls, Resource, Storelike};

use serde::Deserialize;
use std::{collections::HashSet, path::PathBuf};

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
    let server_url = &appstate.config.server_url;
    let store = &appstate.store;

    // We replace `/download` with `/` to get the subject of the Resource.
    let subject = if let Some(pth) = path {
        let subject = format!("{}/{}", server_url, pth);
        subject
    } else {
        // There is no end string, so It's the root of the URL, the base URL!
        return Err("Put `/download` in front of an File URL to download it.".into());
    };

    let for_agent = get_client_agent(headers, &appstate, subject.clone()).await?;
    tracing::info!("handle_download: {}", subject);

    let resource = store
        .get_resource_extended(&subject, false, &for_agent)
        .await?
        .to_single();

    download_file_handler_partial(&resource, &req, &params, &appstate)
}

pub fn download_file_handler_partial(
    resource: &Resource,
    req: &HttpRequest,
    params: &web::Query<DownloadParams>,
    appstate: &AppState,
) -> AtomicServerResult<HttpResponse> {
    if !resource
        .get(urls::IS_A)
        .and_then(|v| v.to_subjects(None))
        .map(|classes| classes.iter().any(|c| c == urls::FILE))
        .unwrap_or(false)
    {
        return Err("Resource is not a File".into());
    }

    // `internalId` reaching here unsanitized would let a crafted value walk the
    // path out of `uploads_path` (see the server-managed-property denylist in
    // commit.rs for where this is actually blocked from being set). Sanitizing here
    // too means this handler is safe on its own, independent of that denylist.
    let raw_filename = resource
        .get(urls::INTERNAL_ID)
        .map_err(|e| format!("Internal ID of file could not be resolved. {}", e))?
        .to_string();
    let filename = sanitize_filename::sanitize(&raw_filename);
    let download_name = resource.get(urls::FILENAME).ok().map(|v| v.to_string());

    let file_path = safe_join_uploads_path(&appstate.config.uploads_path, &filename)?;

    // No params were given, so we just return the file.
    if params.q.is_none() && params.w.is_none() && params.f.is_none() {
        let file = NamedFile::open(&file_path)?;
        return Ok(force_attachment(file, req, download_name));
    }

    create_processed_folder_if_not_exists(&appstate.config.uploads_path)?;
    let processed_file_path =
        build_prossesed_file_path(&filename, params, appstate.config.uploads_path.clone())?;

    if processed_file_path.exists() {
        let file = NamedFile::open(processed_file_path)?;
        return Ok(force_attachment(file, req, download_name));
    }

    // only if image feature flag is on
    #[cfg(feature = "image")]
    {
        use crate::handlers::image::{is_image, process_image};
        if !is_image(&file_path) {
            return Err("Quality or with parameter are not supported for non image files".into());
        }
        let format = get_format(params)?;
        process_image(&file_path, &processed_file_path, params, &format)?;
    }

    let file = NamedFile::open(processed_file_path)?;
    Ok(force_attachment(file, req, download_name))
}

/// Joins `filename` onto `base`, refusing to serve anything outside `base`.
/// `filename` is expected to already be a bare, sanitized path component; this
/// additionally verifies containment via canonicalization so a traversal or absolute
/// path smuggled into `internalId` can never escape the uploads directory, even if it
/// somehow bypassed sanitization upstream.
fn safe_join_uploads_path(base: &PathBuf, filename: &str) -> AtomicServerResult<PathBuf> {
    let candidate = base.join(filename);

    let canonical_base = base
        .canonicalize()
        .map_err(|_| "Upload storage is unavailable")?;
    let canonical_candidate = candidate.canonicalize().map_err(|_| "File not found")?;

    if !canonical_candidate.starts_with(&canonical_base) {
        return Err("File not found".into());
    }

    Ok(candidate)
}

/// Serves user-uploaded content as a forced download rather than rendering it inline.
/// Uploaded HTML/SVG would otherwise be rendered by the browser in the app's own
/// origin (actix-files defaults those mimetypes to `inline`), letting a stored script
/// read the same-origin session cookie and the Agent's private key out of IndexedDB.
fn force_attachment(file: NamedFile, req: &HttpRequest, filename: Option<String>) -> HttpResponse {
    let parameters = match filename {
        Some(name) => vec![DispositionParam::Filename(name)],
        None => vec![],
    };
    let file = file.set_content_disposition(ContentDisposition {
        disposition: DispositionType::Attachment,
        parameters,
    });
    let mut response = file.into_response(req);
    response.headers_mut().insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    response
}

pub fn build_prossesed_file_path(
    filename: &str,
    params: &DownloadParams,
    base_path: PathBuf,
) -> AtomicServerResult<PathBuf> {
    let format = get_format(params)?;

    let Some((timestamp, rest)) = filename.split_once('-') else {
        return Err("Filename does not contain a timestamp.".into());
    };

    let mut new_filename = String::new();

    new_filename.push_str(timestamp);

    if let Some(quality) = &params.q {
        new_filename.push_str(&format!("-q{}", quality));
    }
    if let Some(width) = &params.w {
        new_filename.push_str(&format!("-w{}", width));
    }

    new_filename.push_str(&format!("-{}", rest));
    let mut processed_file_path = base_path.join("processed").join(new_filename);
    processed_file_path.set_extension(format);

    Ok(processed_file_path)
}

fn create_processed_folder_if_not_exists(base_path: &PathBuf) -> AtomicServerResult<()> {
    let mut processed_folder = base_path.clone();
    processed_folder.push("processed");
    std::fs::create_dir_all(processed_folder)?;
    Ok(())
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
