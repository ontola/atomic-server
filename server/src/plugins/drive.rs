use std::path::PathBuf;

use atomic_lib::{
    agents::ForAgent,
    class_extender::{BoxFuture, ClassExtender, ClassExtenderScope, CommitExtenderContext},
    errors::AtomicResult,
    urls::{self, DOWNLOAD_URL, MIMETYPE, PLUGINS, PLUGIN_FILE},
    values::SubResource,
    AtomicError, Storelike, Value,
};
use tracing::{error, info};
use zip::ZipArchive;

use crate::plugins::wasm::install_plugin;

fn on_before_commit(
    context: CommitExtenderContext,
    plugins_dir: PathBuf,
    plugin_cache_dir: PathBuf,
    uploads_dir: PathBuf,
) -> BoxFuture<AtomicResult<()>> {
    Box::pin(async move {
        let CommitExtenderContext {
            store,
            commit,
            resource,
        } = context;

        let Some(push) = &commit.push else {
            return Ok(());
        };

        let Some(Value::ResourceArray(plugins)) = push.get(PLUGINS) else {
            return Ok(());
        };

        for plugin_subject in plugins {
            let SubResource::Subject(plugin_subject) = plugin_subject else {
                return Err("Cannot install nested resource as plugin".into());
            };

            let plugin = store
                .get_resource_extended(
                    &plugin_subject,
                    false,
                    &ForAgent::AgentSubject(commit.signer.clone()),
                )
                .await?
                .to_single();

            let Value::AtomicUrl(plugin_file_subject) = plugin.get(PLUGIN_FILE)? else {
                return Err("Plugin file not found".into());
            };

            let plugin_file = store
                .get_resource_extended(
                    plugin_file_subject,
                    false,
                    &ForAgent::AgentSubject(commit.signer.clone()),
                )
                .await?
                .to_single();

            let Value::String(mime_type) = plugin_file.get(MIMETYPE)? else {
                return Err("MIME type invalid type".into());
            };

            if mime_type != "application/zip" {
                return Err("Plugin file must be a zip file".into());
            };

            let bytes = if let Ok(Value::String(internal_id)) = plugin_file.get(urls::INTERNAL_ID) {
                let file_path = uploads_dir.join(internal_id);
                info!("Reading plugin from local file: {:?}", file_path);
                std::fs::read(&file_path).map_err(|e| {
                    AtomicError::from(format!("Failed to read plugin file locally: {}", e))
                })?
            } else {
                let Value::String(download_url) = plugin_file.get(DOWNLOAD_URL)? else {
                    return Err("Download URL invalid type".into());
                };

                info!("Downloading plugin from: {}", download_url);

                // download the zip file from the download URL
                let response = reqwest::get(download_url.as_str()).await.map_err(|e| {
                    AtomicError::from(format!("Failed to download plugin file: {}", e))
                })?;

                if !response.status().is_success() {
                    let status = response.status();
                    let body = response.text().await.unwrap_or_default();
                    error!(
                        "Failed to download plugin file. Status: {}. Body: {}",
                        status, body
                    );
                    return Err(AtomicError::from(format!(
                        "Failed to download plugin file: Status {}",
                        status
                    )));
                }

                response
                    .bytes()
                    .await
                    .map_err(|e| {
                        AtomicError::from(format!("Failed to download plugin file: {}", e))
                    })?
                    .to_vec()
            };

            info!("Plugin file size: {} bytes", bytes.len());
            if bytes.len() >= 4 {
                info!("First 4 bytes: {:02X?}", &bytes[0..4]);
            } else {
                error!("Downloaded file is too small to be a zip file");
            }

            let mut zip_file = ZipArchive::new(std::io::Cursor::new(bytes))
                .map_err(|e| AtomicError::from(format!("Failed to create zip archive: {}", e)))?;

            install_plugin(
                &mut zip_file,
                resource.get_subject(),
                plugin.get_subject(),
                store,
                &plugins_dir,
                &plugin_cache_dir,
            )
            .await?;
        }
        Ok(())
    })
}

pub fn build_drive_extender(
    plugins_dir: PathBuf,
    plugin_cache_dir: PathBuf,
    uploads_dir: PathBuf,
) -> ClassExtender {
    ClassExtender {
        id: Some("drive".to_string()),
        classes: vec![urls::DRIVE.to_string()],
        on_resource_get: None,
        before_commit: Some(ClassExtender::wrap_commit_handler(move |context| {
            on_before_commit(
                context,
                plugins_dir.clone(),
                plugin_cache_dir.clone(),
                uploads_dir.clone(),
            )
        })),
        after_commit: None,
        scope: ClassExtenderScope::Global,
    }
}
