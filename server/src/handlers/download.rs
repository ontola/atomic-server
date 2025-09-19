use crate::{appstate::AppState, errors::AtomicServerResult, helpers::get_client_agent};
use actix_files::NamedFile;
use actix_web::{web, HttpRequest, HttpResponse};
use atomic_lib::{urls, Resource, Storelike};

use serde::Deserialize;
use std::{collections::HashSet, path::{Path, PathBuf}};

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

    let for_agent = get_client_agent(headers, &appstate, subject.clone())?;
    tracing::info!("handle_download: {}", subject);

    let resource = store
        .get_resource_extended(&subject, false, &for_agent)?
        .to_single();

    download_file_handler_partial(&resource, &req, &params, &appstate)
}

pub fn download_file_handler_partial(
    resource: &Resource,
    req: &HttpRequest,
    params: &web::Query<DownloadParams>,
    appstate: &AppState,
) -> AtomicServerResult<HttpResponse> {
    let filename = resource
        .get(urls::INTERNAL_ID)
        .map_err(|e| format!("Internal ID of file could not be resolved. {}", e))?
        .to_string();
    
    // Validate filename to prevent path traversal attacks
    validate_filename(&filename)?;
    
    let mut file_path = appstate.config.uploads_path.clone();
    file_path.push(&filename);
    
    // Ensure the final path is still within the uploads directory
    validate_file_path(&file_path, &appstate.config.uploads_path)?;

    // No params were given, so we just return the file.
    if params.q.is_none() && params.w.is_none() && params.f.is_none() {
        let file = NamedFile::open(file_path)?;
        return Ok(file.into_response(req));
    }

    create_processed_folder_if_not_exists(&appstate.config.uploads_path)?;
    let processed_file_path =
        build_prossesed_file_path(&filename, params, appstate.config.uploads_path.clone())?;

    if processed_file_path.exists() {
        let file = NamedFile::open(processed_file_path)?;
        return Ok(file.into_response(req));
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
    Ok(file.into_response(req))
}

pub fn build_prossesed_file_path(
    filename: &str,
    params: &DownloadParams,
    base_path: PathBuf,
) -> AtomicServerResult<PathBuf> {
    // Validate filename first
    validate_filename(filename)?;
    
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

fn create_processed_folder_if_not_exists(base_path: &Path) -> AtomicServerResult<()> {
    let mut processed_folder = base_path.to_path_buf();
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

/// Validate filename to prevent path traversal attacks
fn validate_filename(filename: &str) -> AtomicServerResult<()> {
    // Check for empty filename
    if filename.is_empty() {
        return Err("Filename cannot be empty".into());
    }
    
    // Check for path traversal attempts
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err("Invalid filename: path traversal detected".into());
    }
    
    // Check for null bytes
    if filename.contains('\0') {
        return Err("Invalid filename: null byte detected".into());
    }
    
    // Check for control characters
    if filename.chars().any(|c| c.is_control()) {
        return Err("Invalid filename: control characters not allowed".into());
    }
    
    // Check length
    if filename.len() > 255 {
        return Err("Filename too long (max 255 characters)".into());
    }
    
    // Check for reserved names on Windows (even on Linux for consistency)
    let forbidden_names = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5",
        "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4",
        "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
    ];
    
    let name_without_ext = filename.split('.').next().unwrap_or(filename).to_uppercase();
    if forbidden_names.contains(&name_without_ext.as_str()) {
        return Err("Invalid filename: reserved name".into());
    }
    
    Ok(())
}

/// Validate that the file path is within the allowed directory
fn validate_file_path(file_path: &Path, base_path: &Path) -> AtomicServerResult<()> {
    // Canonicalize both paths to resolve any symlinks or relative components
    let canonical_file_path = file_path.canonicalize()
        .map_err(|_| "File path could not be resolved")?;
    
    let canonical_base_path = base_path.canonicalize()
        .map_err(|_| "Base path could not be resolved")?;
    
    // Check if the file path starts with the base path
    if !canonical_file_path.starts_with(&canonical_base_path) {
        return Err("Access denied: file is outside allowed directory".into());
    }
    
    Ok(())
}
