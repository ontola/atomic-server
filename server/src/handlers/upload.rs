use std::{ffi::OsStr, io::Write, path::Path};

use actix_multipart::{Field, Multipart};
use actix_web::{web, HttpResponse};
use atomic_lib::{hierarchy::check_write, urls, utils::now, Db, Resource, Storelike, Value};
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
    let server_url = appstate.config.get_server_url_for_request(&req);
    let store = appstate.store.clone_with_url(server_url);

    let parent = store.get_resource(&query.parent).await?;
    let subject = format!(
        "{}{}",
        store.get_server_url()?,
        req.head()
            .uri
            .path_and_query()
            .ok_or("Path must be given")?
    );
    let agent = get_client_agent(req.headers(), &appstate, subject).await?;
    check_write(&store, &parent, &agent).await?;

    let mut created_resources: Vec<Resource> = Vec::new();

    while let Ok(Some(field)) = body.try_next().await {
        let mut resource =
            save_file_and_create_resource(field, &appstate, &query.parent, &store).await?;
        resource.save(&store).await?;
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
    store: &Db,
) -> AtomicServerResult<Resource> {
    let content_type = field.content_disposition().clone();
    let filename = content_type.get_filename().ok_or("Filename is missing")?;

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

    // Field in turn is stream of *Bytes* object
    while let Some(chunk) = field.next().await {
        let data = chunk.map_err(|e| format!("Error while reading multipart data. {}", e))?;
        // TODO: Update a SHA256 hash here for checksum
        file.write_all(&data)?;
    }

    let byte_count: i64 = file
        .metadata()?
        .len()
        .try_into()
        .map_err(|_e| "Too large")?;

    let mimetype = guess_mime_for_filename(filename);
    let subject_path = format!("files/{}", urlencoding::encode(&file_id));
    let new_subject = format!("{}/{}", store.get_server_url()?, subject_path);
    let download_url = format!("{}/download/{}", store.get_server_url()?, subject_path);

    let mut resource = atomic_lib::Resource::new_instance(urls::FILE, store).await?;
    resource
        .set_subject(new_subject)
        .set_string(urls::PARENT.into(), parent, store)
        .await?
        .set_string(urls::INTERNAL_ID.into(), &file_id, store)
        .await?
        .set(urls::FILESIZE.into(), Value::Integer(byte_count), store)
        .await?
        .set_string(urls::MIMETYPE.into(), &mimetype, store)
        .await?
        .set_string(urls::FILENAME.into(), filename, store)
        .await?
        .set_string(urls::DOWNLOAD_URL.into(), &download_url, store)
        .await?;

    if mimetype.starts_with("image/") {
        if let Ok(img) = image::ImageReader::open(&file_path)?.decode() {
            let (width, height) = img.dimensions();
            resource
                .set(
                    urls::IMAGE_WIDTH.into(),
                    Value::Integer(width as i64),
                    store,
                )
                .await?
                .set(
                    urls::IMAGE_HEIGHT.into(),
                    Value::Integer(height as i64),
                    store,
                )
                .await?;
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
