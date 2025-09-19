use std::{ffi::OsStr, io::Write, path::Path};

use actix_multipart::{Field, Multipart};
use actix_web::{web, HttpResponse};
use atomic_lib::{hierarchy::check_write, urls, utils::now, Resource, Storelike, Value};
use futures::{StreamExt, TryStreamExt};
use image::GenericImageView;
use serde::Deserialize;

use crate::{appstate::AppState, errors::AtomicServerResult, helpers::get_client_agent};

#[derive(Deserialize, Debug)]
pub struct UploadQuery {
    parent: String,
}

/// Allows the user to upload files tot the `/upload` endpoint.
/// A parent Query parameter is required for checking rights and for placing the file in a Hierarchy.
/// Creates new File resources for every submitted file.
/// Submission is done using multipart/form-data.
/// The file is stored in the `/uploads` directory.
#[tracing::instrument(skip(appstate, req, body))]
pub async fn upload_handler(
    mut body: Multipart,
    appstate: web::Data<AppState>,
    query: web::Query<UploadQuery>,
    req: actix_web::HttpRequest,
) -> AtomicServerResult<HttpResponse> {
    let store = &appstate.store;
    let parent = store.get_resource(&query.parent)?;
    let subject = format!(
        "{}{}",
        store.get_server_url()?,
        req.head()
            .uri
            .path_and_query()
            .ok_or("Path must be given")?
    );
    let agent = get_client_agent(req.headers(), &appstate, subject)?;
    check_write(store, &parent, &agent)?;

    let mut created_resources: Vec<Resource> = Vec::new();

    while let Ok(Some(field)) = body.try_next().await {
        let mut resource = save_file_and_create_resource(field, &appstate, &query.parent).await?;
        resource.save(store)?;
        created_resources.push(resource);
    }

    let mut builder = HttpResponse::Ok();

    Ok(builder.body(atomic_lib::serialize::resources_to_json_ad(
        &created_resources,
    )?))
}

async fn save_file_and_create_resource(
    mut field: Field,
    appstate: &web::Data<AppState>,
    parent: &str,
) -> AtomicServerResult<Resource> {
    let store = &appstate.store;
    let content_type = field.content_disposition().clone();
    let filename = content_type.get_filename().ok_or("Filename is missing")?;
    
    // Validate filename and content type
    validate_upload_security(filename, &field)?;

    std::fs::create_dir_all(&appstate.config.uploads_path)?;

    let file_id = format!(
        "{}-{}",
        now(),
        sanitize_filename::sanitize(filename)
            // Spacebars lead to very annoying bugs in browsers
            .replace(' ', "-")
    );

    let mut file_path = appstate.config.uploads_path.clone();
    file_path.push(&file_id);

    let mut file = std::fs::File::create(&file_path)?;
    let mut total_size = 0u64;
    const MAX_FILE_SIZE: u64 = 100 * 1024 * 1024; // 100MB limit
    
    // Field in turn is stream of *Bytes* object
    while let Some(chunk) = field.next().await {
        let data = chunk.map_err(|e| format!("Error while reading multipart data. {}", e))?;
        
        // Check file size limits
        total_size += data.len() as u64;
        if total_size > MAX_FILE_SIZE {
            // Clean up partial file
            std::fs::remove_file(&file_path).ok();
            return Err("File too large (max 100MB)".into());
        }
        
        // TODO: Update a SHA256 hash here for checksum
        file.write_all(&data)?;
    }

    let byte_count: i64 = file
        .metadata()?
        .len()
        .try_into()
        .map_err(|_e| "Too large")?;

    // Additional security validation after file is written
    validate_uploaded_file(&file_path, filename)?;
    
    let mimetype = guess_mime_for_filename(filename);
    let subject_path = format!("files/{}", urlencoding::encode(&file_id));
    let new_subject = format!("{}/{}", store.get_server_url()?, subject_path);
    let download_url = format!("{}/download/{}", store.get_server_url()?, subject_path);

    let mut resource = atomic_lib::Resource::new_instance(urls::FILE, store)?;
    resource
        .set_subject(new_subject)
        .set_string(urls::PARENT.into(), parent, store)?
        .set_string(urls::INTERNAL_ID.into(), &file_id, store)?
        .set(urls::FILESIZE.into(), Value::Integer(byte_count), store)?
        .set_string(urls::MIMETYPE.into(), &mimetype, store)?
        .set_string(urls::FILENAME.into(), filename, store)?
        .set_string(urls::DOWNLOAD_URL.into(), &download_url, store)?;

    if mimetype.starts_with("image/") {
        if let Ok(img) = image::ImageReader::open(&file_path)?.decode() {
            let (width, height) = img.dimensions();
            resource
                .set(
                    urls::IMAGE_WIDTH.into(),
                    Value::Integer(width as i64),
                    store,
                )?
                .set(
                    urls::IMAGE_HEIGHT.into(),
                    Value::Integer(height as i64),
                    store,
                )?;
        }
    }

    Ok(resource)
}

fn guess_mime_for_filename(filename: &str) -> String {
    if let Some(ext) = get_extension_from_filename(filename) {
        actix_files::file_extension_to_mime(ext).to_string()
    } else {
        "application/octet-stream".to_string()
    }
}

fn get_extension_from_filename(filename: &str) -> Option<&str> {
    Path::new(filename).extension().and_then(OsStr::to_str)
}

/// Validate upload security before processing
fn validate_upload_security(filename: &str, field: &Field) -> AtomicServerResult<()> {
    // Validate filename
    validate_filename_upload(filename)?;
    
    // Validate content type
    if let Some(content_type) = field.content_type() {
        validate_content_type(content_type.as_ref())?;
    }
    
    Ok(())
}

/// Validate filename for uploads
fn validate_filename_upload(filename: &str) -> AtomicServerResult<()> {
    // Check for empty filename
    if filename.is_empty() {
        return Err("Filename cannot be empty".into());
    }
    
    // Check length
    if filename.len() > 255 {
        return Err("Filename too long (max 255 characters)".into());
    }
    
    // Check for path traversal attempts
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err("Invalid filename: path separators not allowed".into());
    }
    
    // Check for null bytes and control characters
    if filename.contains('\0') || filename.chars().any(|c| c.is_control()) {
        return Err("Invalid filename: control characters not allowed".into());
    }
    
    // Check for dangerous extensions
    let dangerous_extensions = [
        "exe", "bat", "cmd", "com", "pif", "scr", "vbs", "js", "jar", "ps1",
        "sh", "php", "asp", "aspx", "jsp", "py", "rb", "pl"
    ];
    
    if let Some(ext) = get_extension_from_filename(filename) {
        if dangerous_extensions.contains(&ext.to_lowercase().as_str()) {
            return Err("File type not allowed for security reasons".into());
        }
    }
    
    // Check for reserved Windows names
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

/// Validate content type
fn validate_content_type(content_type: &str) -> AtomicServerResult<()> {
    // Allow common safe content types
    let allowed_types = [
        "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
        "text/plain", "text/csv", "text/markdown",
        "application/pdf", "application/json", "application/xml",
        "application/zip", "application/gzip",
        "audio/mpeg", "audio/wav", "audio/ogg",
        "video/mp4", "video/webm", "video/ogg"
    ];
    
    // Check for exact matches or wildcard patterns
    let is_allowed = allowed_types.iter().any(|&allowed| {
        content_type == allowed || 
        (allowed.ends_with("/*") && content_type.starts_with(&allowed[..allowed.len()-1]))
    });
    
    if !is_allowed {
        return Err(format!("Content type not allowed: {}", content_type).into());
    }
    
    Ok(())
}

/// Validate uploaded file after writing
fn validate_uploaded_file(file_path: &Path, filename: &str) -> AtomicServerResult<()> {
    // Check file exists and is readable
    if !file_path.exists() {
        return Err("Uploaded file does not exist".into());
    }
    
    // Check file is not empty (unless it's supposed to be)
    let metadata = std::fs::metadata(file_path)
        .map_err(|_| "Cannot read file metadata")?;
    
    if metadata.len() == 0 {
        return Err("Uploaded file is empty".into());
    }
    
    // Additional validation for image files
    if let Some(ext) = get_extension_from_filename(filename) {
        if matches!(ext.to_lowercase().as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp") {
            validate_image_file(file_path)?;
        }
    }
    
    Ok(())
}

/// Validate image file format
fn validate_image_file(file_path: &Path) -> AtomicServerResult<()> {
    // Try to read as image to ensure it's valid
    match image::ImageReader::open(file_path) {
        Ok(reader) => {
            if reader.decode().is_err() {
                return Err("Invalid image file format".into());
            }
        }
        Err(_) => {
            return Err("Cannot read image file".into());
        }
    }
    
    Ok(())
}
