use std::path::{Path, PathBuf};

use atomic_lib::{
    agents::{Agent, ForAgent},
    class_extender::{
        BoxFuture, ClassExtender, ClassExtenderScope, CommitExtenderContext, GetExtenderContext,
    },
    db::plugin_meta::PluginMetaKey,
    errors::AtomicResult,
    storelike::ResourceResponse,
    urls::{self, DOWNLOAD_URL, MIMETYPE},
    AtomicError, Db, Resource, Storelike, Value,
};
use tracing::{error, info};
use zip::ZipArchive;

use crate::plugins::wasm::{install_plugin, uninstall_plugin};

async fn get_parent_drive(resource: &Resource, store: &Db) -> AtomicResult<String> {
    let Ok(Value::AtomicUrl(parent_subject)) = resource.get(urls::PARENT) else {
        return Err(AtomicError::from(format!(
            "Plugin {} has no parent",
            resource.get_subject()
        )));
    };

    let parent_resource = store
        .get_resource_extended(parent_subject, true, &ForAgent::Sudo)
        .await?
        .to_single();

    if !parent_resource
        .get(urls::IS_A)?
        .to_subjects(None)?
        .contains(&urls::DRIVE.to_string())
    {
        return Err(AtomicError::from(format!(
            "Parent resource for plugin {} is not a drive",
            resource.get_subject()
        )));
    };

    Ok(parent_subject.to_string())
}

fn get_namespace_and_name(resource: &Resource) -> AtomicResult<(String, String)> {
    let Ok(Value::String(name)) = resource.get(urls::NAME) else {
        return Err(AtomicError::from(format!(
            "Plugin {} has no name",
            resource.get_subject()
        )));
    };

    let Ok(Value::String(namespace)) = resource.get(urls::NAMESPACE) else {
        return Err(AtomicError::from(format!(
            "Plugin {} has no namespace",
            resource.get_subject()
        )));
    };

    Ok((namespace.to_string(), name.to_string()))
}

async fn do_uninstall_plugin(
    resource: &Resource,
    parent_subject: &str,
    store: &Db,
    plugins_dir: &Path,
) -> AtomicResult<()> {
    tracing::info!("destroying plugin {}", resource.get_subject());

    let Ok(Value::String(name)) = resource.get(urls::NAME) else {
        return Err(AtomicError::from(format!(
            "Plugin {} has no name",
            resource.get_subject()
        )));
    };

    let Ok(Value::String(namespace)) = resource.get(urls::NAMESPACE) else {
        return Err(AtomicError::from(format!(
            "Plugin {} has no namespace",
            resource.get_subject()
        )));
    };

    tracing::info!(
        "uninstalling plugin {} in namespace {} for drive {}",
        name,
        namespace,
        parent_subject
    );

    // Even if the uninstall fails we still want to continue the commit
    // If we don't do this the resource will not be able to be deleted.
    let _ = uninstall_plugin(name, namespace, &parent_subject, store, &plugins_dir).await;

    Ok(())
}

async fn do_install_plugin(
    resource: &Resource,
    parent_subject: &str,
    store: &Db,
    plugins_dir: &Path,
    plugin_cache_dir: &Path,
    uploads_dir: &Path,
    signer: &str,
) -> AtomicResult<()> {
    let Value::AtomicUrl(plugin_file_subject) = resource.get(urls::PLUGIN_FILE)? else {
        return Err("Plugin file not found".into());
    };

    let plugin_file = match store
        .get_resource_extended(
            plugin_file_subject,
            false,
            &ForAgent::AgentSubject(signer.to_string()),
        )
        .await
    {
        Ok(res) => res.to_single(),
        Err(e) => {
            error!(
                "Failed to get plugin file resource {}: {}",
                plugin_file_subject, e
            );
            return Err(e);
        }
    };

    let Value::String(mime_type) = plugin_file.get(MIMETYPE)? else {
        error!(
            "MIME type invalid type for plugin file {}",
            plugin_file_subject
        );
        return Err("MIME type invalid type".into());
    };

    if mime_type != "application/zip" {
        error!(
            "Plugin file {} must be a zip file, got {}",
            plugin_file_subject, mime_type
        );
        return Err("Plugin file must be a zip file".into());
    };

    let bytes = if let Ok(Value::String(internal_id)) = plugin_file.get(urls::INTERNAL_ID) {
        let file_path = uploads_dir.join(internal_id);
        info!("Reading plugin from local file: {:?}", file_path);
        std::fs::read(&file_path).map_err(|e| {
            error!(
                "Failed to read plugin file locally at {:?}: {}",
                file_path, e
            );
            AtomicError::from(format!("Failed to read plugin file locally: {}", e))
        })?
    } else {
        let Value::String(download_url) = plugin_file.get(DOWNLOAD_URL)? else {
            error!(
                "Plugin file {} has no internalId and no downloadURL",
                plugin_file_subject
            );
            return Err("Download URL invalid type".into());
        };

        info!("Downloading plugin from: {}", download_url);

        // download the zip file from the download URL
        let response = reqwest::get(download_url.as_str())
            .await
            .map_err(|e| AtomicError::from(format!("Failed to download plugin file: {}", e)))?;

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
            .map_err(|e| AtomicError::from(format!("Failed to download plugin file: {}", e)))?
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
        &parent_subject,
        resource.get_subject(),
        store,
        &plugins_dir,
        &plugin_cache_dir,
    )
    .await?;

    Ok(())
}

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

        // Gets the parent drive and returns an error if the parent is not a drive.
        let parent_subject = get_parent_drive(resource, store).await?;

        // If the plugin is being deleted, uninstall it.
        if commit.destroy == Some(true) {
            do_uninstall_plugin(resource, &parent_subject, store, &plugins_dir).await?;
            return Ok(());
        }

        if let Some(set) = &commit.set {
            // The plugin file has been set or updated, so we need to (re)install the plugin.
            if set.contains_key(urls::PLUGIN_FILE) {
                tracing::info!(
                    "New plugin file found for plugin {}, installing...",
                    resource.get_subject()
                );
                do_install_plugin(
                    resource,
                    &parent_subject,
                    store,
                    &plugins_dir,
                    &plugin_cache_dir,
                    &uploads_dir,
                    &commit.signer,
                )
                .await?;
            }
        }

        Ok(())
    })
}

fn on_resource_get(context: GetExtenderContext) -> BoxFuture<AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        let GetExtenderContext {
            store, db_resource, ..
        } = context;

        let drive = get_parent_drive(db_resource, store).await?;

        let (namespace, name) = get_namespace_and_name(db_resource)?;

        let Some(meta) = store.get_plugin_meta(&PluginMetaKey::new(&drive, &namespace, &name))?
        else {
            return Ok(db_resource.clone().into());
        };

        let agent = Agent::from_secret(&meta.agent_secret)?;

        db_resource
            .set(
                urls::PLUGIN_AGENT.to_string(),
                Value::AtomicUrl(agent.subject.clone()),
                store,
            )
            .await?;

        Ok(db_resource.clone().into())
    })
}

pub fn build_plugin_extender(
    plugins_dir: PathBuf,
    plugin_cache_dir: PathBuf,
    uploads_dir: PathBuf,
) -> ClassExtender {
    ClassExtender {
        id: Some("plugin".to_string()),
        classes: vec![urls::PLUGIN.to_string()],
        on_resource_get: Some(ClassExtender::wrap_get_handler(move |context| {
            on_resource_get(context)
        })),
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
