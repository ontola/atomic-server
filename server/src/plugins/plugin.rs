#[cfg(feature = "wasm-plugins")]
use std::path::Path;
use std::path::PathBuf;

#[cfg(feature = "wasm-plugins")]
use atomic_lib::urls::{DOWNLOAD_URL, MIMETYPE};
use atomic_lib::{
    agents::{Agent, ForAgent},
    class_extender::{BoxFuture, ClassExtender, CommitExtenderContext, GetExtenderContext},
    db::plugin_meta::{validate_plugin_identifier, validate_plugin_identifiers, PluginMetaKey},
    errors::AtomicResult,
    storelike::ResourceResponse,
    urls::{self},
    AtomicError, Db, Resource, Storelike, Value,
};
#[cfg(feature = "wasm-plugins")]
use tracing::{error, info};
#[cfg(feature = "wasm-plugins")]
use zip::ZipArchive;

#[cfg(feature = "wasm-plugins")]
use crate::plugins::wasm::{install_or_update_plugin, uninstall_plugin};

/// Largest plugin zip we are willing to download from a `downloadURL`.
#[cfg(feature = "wasm-plugins")]
const PLUGIN_DOWNLOAD_MAX_BYTES: usize = 50 * 1024 * 1024;

async fn get_parent_drive(resource: &Resource, store: &Db) -> AtomicResult<String> {
    // Loro materialization decodes scalar string values as `Value::String`,
    // not `Value::AtomicUrl` — there's no type marker in the stored string.
    // Accept either so genesis commits (where the only source of state is
    // the loroUpdate) don't fail their before-commit hook.
    let parent_subject = match resource.get(urls::PARENT) {
        Ok(Value::AtomicUrl(s)) => s.to_string(),
        Ok(Value::String(s)) => s.clone(),
        _ => {
            return Err(AtomicError::from(format!(
                "Plugin {} has no parent",
                resource.get_subject()
            )));
        }
    };

    let parent_resource = store
        .get_resource_extended(&parent_subject.clone().into(), true, &ForAgent::Sudo)
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

    Ok(parent_subject)
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

    // These values are user-controlled and end up in filesystem paths.
    validate_plugin_identifiers(namespace, name)?;

    Ok((namespace.to_string(), name.to_string()))
}

#[cfg(feature = "wasm-plugins")]
async fn do_uninstall_plugin(
    resource: &Resource,
    parent_subject: &str,
    store: &Db,
    plugins_dir: &Path,
) -> AtomicResult<()> {
    tracing::info!("destroying plugin {}", resource.get_subject());

    // Validates namespace/name so path traversal payloads never reach the filesystem.
    let (namespace, name) = get_namespace_and_name(resource)?;

    tracing::info!(
        "uninstalling plugin {} in namespace {} for drive {}",
        name,
        namespace,
        parent_subject
    );

    // Even if the uninstall fails we still want to continue the commit
    // If we don't do this the resource will not be able to be deleted.
    if let Err(e) = uninstall_plugin(&name, &namespace, parent_subject, store, plugins_dir).await {
        tracing::warn!(
            "Failed to uninstall plugin {}.{} for drive {}: {}",
            namespace,
            name,
            parent_subject,
            e
        );
    }

    Ok(())
}

#[cfg(feature = "wasm-plugins")]
async fn do_install_plugin(
    resource: &Resource,
    parent_subject: &str,
    store: &Db,
    plugins_dir: &Path,
    plugin_cache_dir: &Path,
    uploads_dir: &Path,
    signer: &str,
) -> AtomicResult<()> {
    let plugin_file_subject: String = match resource.get(urls::PLUGIN_FILE)? {
        Value::AtomicUrl(s) => s.to_string(),
        Value::String(s) => s.clone(),
        _ => return Err("Plugin file not found".into()),
    };

    let plugin_file = match store
        .get_resource_extended(
            &plugin_file_subject.clone().into(),
            false,
            &ForAgent::AgentSubject(signer.to_string().into()),
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

    let internal_id_value = plugin_file.get(urls::INTERNAL_ID).ok();
    let internal_id_str: Option<String> = match internal_id_value {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::AtomicUrl(s)) => Some(s.to_string()),
        _ => None,
    };

    let bytes = if let Some(internal_id) = internal_id_str {
        // Files are stored content-addressed in the configured blob backend,
        // keyed by the blake3 hash hex digest. The legacy `uploads_dir/<id>`
        // filesystem path was retired with the content-addressed migration —
        // see server/src/handlers/upload.rs which writes to that backend.
        let hash_bytes = match hex::decode(&internal_id) {
            Ok(b) if b.len() == 32 => b,
            _ => {
                error!(
                    "Plugin file {} has internalId that is not a valid blake3 hex hash: {}",
                    plugin_file_subject, internal_id
                );
                // Fall back to the legacy uploads_dir path for any remaining
                // pre-content-addressed file resources.
                let file_path = uploads_dir.join(&internal_id);
                info!("Reading plugin from local file (legacy): {:?}", file_path);
                return Err(AtomicError::from(format!(
                    "Failed to read plugin file locally: {}",
                    std::fs::read(&file_path)
                        .err()
                        .map(|e| e.to_string())
                        .unwrap_or_default()
                )));
            }
        };

        match store.get_blob(&hash_bytes).await {
            Ok(Some(bytes)) => {
                info!("Reading plugin from blob backend ({} bytes)", bytes.len());
                bytes
            }
            Ok(None) => {
                error!(
                    "Plugin file {} blob not found in blob backend for hash {}",
                    plugin_file_subject, internal_id
                );
                return Err(AtomicError::from(format!(
                    "Plugin file blob not found in blob backend: {}",
                    internal_id
                )));
            }
            Err(e) => {
                return Err(AtomicError::from(format!(
                    "Failed to read plugin blob: {}",
                    e
                )));
            }
        }
    } else {
        let Value::String(download_url) = plugin_file.get(DOWNLOAD_URL)? else {
            error!(
                "Plugin file {} has no internalId and no downloadURL",
                plugin_file_subject
            );
            return Err("Download URL invalid type".into());
        };

        info!("Downloading plugin from: {}", download_url);

        // The URL comes from whoever wrote the plugin-file resource, so this
        // goes through the SSRF guard (no loopback / private / metadata
        // addresses — `ATOMIC_ALLOW_PRIVATE_FETCH=1` lifts that for local
        // plugin development) and the body is capped.
        atomic_lib::client::helpers::fetch_bytes_untrusted(
            download_url.as_str(),
            PLUGIN_DOWNLOAD_MAX_BYTES,
        )
        .await
        .map_err(|e| {
            error!("Failed to download plugin file: {}", e);
            AtomicError::from(format!("Failed to download plugin file: {}", e))
        })?
    };

    info!("Plugin file size: {} bytes", bytes.len());
    if bytes.len() >= 4 {
        info!("First 4 bytes: {:02X?}", &bytes[0..4]);
    } else {
        error!("Downloaded file is too small to be a zip file");
    }

    let mut zip_file = ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| AtomicError::from(format!("Failed to create zip archive: {}", e)))?;

    install_or_update_plugin(
        &mut zip_file,
        parent_subject,
        resource.get_subject().as_str(),
        store,
        plugins_dir,
        plugin_cache_dir,
    )
    .await?;

    Ok(())
}

#[allow(unused_variables)]
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
            is_new,
            changed_props,
        } = context;

        // Gets the parent drive and returns an error if the parent is not a drive.
        let parent_subject = get_parent_drive(resource, store).await?;

        // If the plugin is being deleted, uninstall it.
        if commit.destroy == Some(true) {
            #[cfg(feature = "wasm-plugins")]
            do_uninstall_plugin(resource, &parent_subject, store, &plugins_dir).await?;
            return Ok(());
        }

        if !changed_props.is_empty() {
            // If the plugin is not new, we don't allow updating values that identify the plugin as that could lead to corrupted state.
            if !is_new {
                if changed_props.contains(urls::NAME) || changed_props.contains(urls::NAMESPACE) {
                    return Err(AtomicError::from(
                        "Cannot update plugin namespace/name after it has been created",
                    ));
                }

                if changed_props.contains(urls::PARENT) {
                    return Err(AtomicError::from(
                        "Cannot update plugin parent after it has been created",
                    ));
                }
            } else {
                // Reject unsafe identifiers at creation time, so a traversal payload can never be
                // stored and later reach the uninstall path.
                for (field, prop) in [("name", urls::NAME), ("namespace", urls::NAMESPACE)] {
                    if let Ok(Value::String(value)) = resource.get(prop) {
                        validate_plugin_identifier(field, value)?;
                    }
                }

                // For new plugins, check if name/namespace are already used on this drive.
                if let Ok((namespace, name)) = get_namespace_and_name(resource) {
                    let key = PluginMetaKey::new(&parent_subject, &namespace, &name);
                    if let Some(meta) = store.get_plugin_meta(&key)? {
                        if meta.subject.as_str() != resource.get_subject().as_str() {
                            return Err(AtomicError::from(format!(
                                "A plugin with the name '{}' and namespace '{}' is already installed on this drive.",
                                name, namespace
                            )));
                        }
                    }
                }
            }

            // The plugin file has been set or updated, so we need to (re)install the plugin.
            #[cfg(feature = "wasm-plugins")]
            if changed_props.contains(urls::PLUGIN_FILE) {
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
                    commit.signer.as_str(),
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

        // A resource with missing or invalid identifiers has no meta to enrich it with.
        // Return it untouched so it can still be viewed and deleted.
        let Ok((namespace, name)) = get_namespace_and_name(db_resource) else {
            return Ok(db_resource.clone().into());
        };

        let Some(meta) = store.get_plugin_meta(&PluginMetaKey::new(&drive, &namespace, &name))?
        else {
            return Ok(db_resource.clone().into());
        };

        let agent = Agent::from_secret(&meta.agent_secret)?;

        // Populate the resource with the data from the plugin manifest.
        db_resource.set_unsafe(
            urls::PLUGIN_AGENT.to_string(),
            Value::AtomicUrl(agent.subject.clone()),
        )?;

        db_resource
            .set(
                urls::VERSION.to_string(),
                Value::String(meta.manifest.version.clone()),
                store,
            )
            .await?;

        if let Some(description) = meta.manifest.description {
            db_resource
                .set(
                    urls::DESCRIPTION.to_string(),
                    Value::Markdown(description),
                    store,
                )
                .await?;
        }

        if let Some(author) = meta.manifest.author {
            db_resource
                .set(
                    urls::PLUGIN_AUTHOR.to_string(),
                    Value::String(author),
                    store,
                )
                .await?;
        }

        if let Some(permissions) = meta.manifest.permissions {
            db_resource
                .set(
                    urls::PLUGIN_PERMISSIONS.to_string(),
                    Value::Json(serde_json::to_value(permissions)?),
                    store,
                )
                .await?;
        }

        if let Some(json_schema) = meta.manifest.config_schema {
            db_resource
                .set(
                    urls::JSON_SCHEMA.to_string(),
                    Value::Json(serde_json::to_value(json_schema)?),
                    store,
                )
                .await?;
        }

        Ok(db_resource.clone().into())
    })
}

// ---------------------------------------------------------------------------
// Installation: one install path for both runtimes.
//
// Committing an `Installation` with `installationStatus: active` resolves the
// pinned Release, verifies its id, refuses the server-extension world, checks
// the grants and then materializes by runtime: a wasip2 package goes through
// the same `install_or_update_plugin` a zip upload uses; a JS release only
// needs its installation identity. `revoked` or destroy undoes both.
// ---------------------------------------------------------------------------

#[cfg(feature = "wasm-plugins")]
mod installation_hook {
    use super::*;
    use crate::plugins::release;
    use atomic_lib::db::{
        app_agent::{AppAgent, AppAgentKey, AppAgentState},
        plugin_meta::{PluginManifest, PluginMeta},
        plugin_release::{PluginRelease, WORLD_SERVER_EXTENSION},
    };

    pub const STATUS_DRAFT: &str = "draft";
    pub const STATUS_ACTIVE: &str = "active";
    pub const STATUS_PAUSED: &str = "paused";
    pub const STATUS_REVOKED: &str = "revoked";

    fn string_value(resource: &Resource, prop: &str) -> Option<String> {
        match resource.get(prop) {
            Ok(Value::AtomicUrl(s)) => Some(s.to_string()),
            Ok(Value::String(s)) => Some(s.clone()),
            Ok(other) => Some(other.to_string()),
            Err(_) => None,
        }
    }

    fn json_value(resource: &Resource, prop: &str) -> AtomicResult<serde_json::Value> {
        match resource.get(prop) {
            Ok(Value::Json(v)) => Ok(v.clone()),
            Ok(Value::String(s)) => Ok(serde_json::from_str(s)?),
            Ok(other) => Ok(serde_json::from_str(&other.to_string())?),
            Err(_) => Ok(serde_json::Value::Null),
        }
    }

    /// Namespace and name identify the installation on the drive. They come
    /// from the resource, or from the manifest when the resource has none.
    fn identifiers(
        resource: &Resource,
        manifest: &serde_json::Value,
    ) -> AtomicResult<(String, String)> {
        let pick = |prop: &str, key: &str| -> Option<String> {
            string_value(resource, prop).or_else(|| {
                manifest
                    .get(key)
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
        };
        let namespace = pick(urls::NAMESPACE, "namespace")
            .ok_or("an Installation needs a namespace, on the resource or in the manifest")?;
        let name = pick(urls::NAME, "name")
            .ok_or("an Installation needs a name, on the resource or in the manifest")?;
        validate_plugin_identifiers(&namespace, &name)?;
        Ok((namespace, name))
    }

    pub async fn activate(
        resource: &Resource,
        drive: &str,
        store: &Db,
        signer: &str,
        plugins_dir: &Path,
        plugin_cache_dir: &Path,
    ) -> AtomicResult<()> {
        let subject = resource.get_subject().to_string();
        let reference = string_value(resource, urls::RELEASE_PROP)
            .ok_or("an active Installation needs a release")?;
        let pinned = string_value(resource, urls::RELEASE_ID)
            .ok_or("an active Installation needs a releaseId")?;

        // 1. Resolve and verify. The pinned id is what the installer reviewed;
        //    whatever the reference resolves to must hash to exactly that.
        let for_agent = ForAgent::AgentSubject(signer.to_string().into());
        let release = release::resolve(store, &reference, &for_agent).await?;
        let actual = release.id()?;
        if actual != pinned {
            return Err(AtomicError::from(format!(
                "Installation {subject} pins release {pinned} but {reference} resolves to {actual}; refusing to install"
            )));
        }
        // A wasip2 server-extension is a class extender; an Installation
        // materializes it drive-scoped (`scoped/<drive>/`), exactly as the
        // legacy zip upload does, so its hooks only see this drive. A JS
        // server-extension has no runtime that serves its hooks yet, and a
        // server-scoped extension is configured by the operator on disk,
        // never through a commit.
        if release.world == WORLD_SERVER_EXTENSION && !release.is_wasip2() {
            return Err(AtomicError::from(
                "a server-extension release cannot be installed through an Installation; operators configure it on the server",
            ));
        }

        // 2. Grants against what the manifest declares. The grants on the
        //    Installation are the approved set the host reads back.
        release::check_grants(&release.manifest, &json_value(resource, urls::GRANTS)?)?;

        let (namespace, name) = identifiers(resource, &release.manifest)?;
        let key = PluginMetaKey::new(drive, &namespace, &name);
        if let Some(meta) = store.get_plugin_meta(&key)? {
            if meta.subject != subject {
                return Err(AtomicError::from(format!(
                    "'{namespace}/{name}' is already installed on this drive by {}",
                    meta.subject
                )));
            }
        }

        // 3. Materialize by runtime.
        if release.is_wasip2() {
            let package = release
                .package
                .as_deref()
                .ok_or("a wasip2 release without a package")?;
            let bytes = release::package_bytes(store, package).await?;
            let mut zip = ZipArchive::new(std::io::Cursor::new(bytes))
                .map_err(|e| AtomicError::from(format!("package is not a zip archive: {e}")))?;
            install_or_update_plugin(
                &mut zip,
                drive,
                &subject,
                store,
                plugins_dir,
                plugin_cache_dir,
            )
            .await?;
            // The loader reads the legacy `plugin.json` from disk; the v2
            // manifest the installer reviewed is kept beside it.
            if let Some(mut meta) = store.get_plugin_meta(&key)? {
                meta.manifest_v2 = Some(release.manifest.clone());
                store.set_plugin_meta(&key, &meta)?;
            }
        } else {
            ensure_js_identity(store, drive, &subject, &namespace, &name, &release).await?;
        }
        info!(
            "activated installation {subject} ({namespace}/{name}, {})",
            release.runtime
        );
        Ok(())
    }

    /// A JS installation writes nothing to disk. Its identity is the app
    /// agent `installation::resolve` looks up, mirrored into `PluginMeta` so
    /// both runtimes are listed in one place.
    async fn ensure_js_identity(
        store: &Db,
        drive: &str,
        subject: &str,
        namespace: &str,
        name: &str,
        release: &PluginRelease,
    ) -> AtomicResult<()> {
        let app_key = AppAgentKey::new(drive, subject);
        let secret = match store.get_app_agent_state(&app_key)? {
            AppAgentState::Revoked => {
                return Err(AtomicError::from(
                    "this installation's identity was revoked; create a new Installation",
                ))
            }
            AppAgentState::Active(_) => store
                .with_app_agent(&app_key, |agent| agent.build_secret())?
                .ok_or("installation identity vanished")??,
            AppAgentState::Legacy => {
                let agent = Agent::new(Some(name))?;
                let mut agent_resource = agent.to_resource()?;
                agent_resource
                    .set(
                        urls::NAME.into(),
                        Value::String(format!("{namespace}/{name}")),
                        store,
                    )
                    .await?;
                agent_resource.save_locally(store).await?;
                let secret = agent.build_secret()?;
                store.set_app_agent(
                    &app_key,
                    &AppAgent::new(
                        agent.subject.to_string(),
                        secret.clone(),
                        atomic_lib::utils::now(),
                    ),
                )?;
                secret
            }
        };
        let version = release
            .version
            .clone()
            .or_else(|| {
                release
                    .manifest
                    .get("version")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "0".into());
        let manifest = PluginManifest {
            name: name.to_string(),
            namespace: namespace.to_string(),
            version,
            description: release
                .manifest
                .get("description")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            author: None,
            permissions: None,
            default_config: None,
            config_schema: None,
            network: None,
        };
        store.set_plugin_meta(
            &PluginMetaKey::new(drive, namespace, name),
            &PluginMeta {
                subject: subject.to_string(),
                agent_secret: secret,
                manifest,
                manifest_v2: Some(release.manifest.clone()),
            },
        )?;
        Ok(())
    }

    /// Undo an activation. Best effort on every step, so a half-installed
    /// plugin can still be revoked or destroyed.
    pub async fn deactivate(
        resource: &Resource,
        drive: &str,
        store: &Db,
        plugins_dir: &Path,
    ) -> AtomicResult<()> {
        let subject = resource.get_subject().to_string();
        // Identifiers live on the resource, or in the manifest of the pinned
        // release, which is in this node's cache once it was ever activated.
        let identifiers = match get_namespace_and_name(resource) {
            Ok(found) => Some(found),
            Err(_) => match string_value(resource, urls::RELEASE_ID) {
                Some(id) => store
                    .get_plugin_release(&id)
                    .ok()
                    .and_then(|release| identifiers(resource, &release.manifest).ok()),
                None => None,
            },
        };
        if let Some((namespace, name)) = identifiers {
            let key = PluginMetaKey::new(drive, &namespace, &name);
            if let Some(meta) = store.get_plugin_meta(&key)? {
                if meta.subject == subject {
                    // The wasm path removes the files and the meta; a JS
                    // installation has no files, so only the meta is left.
                    if let Err(e) =
                        uninstall_plugin(&name, &namespace, drive, store, plugins_dir).await
                    {
                        tracing::debug!("no wasm files to remove for {subject}: {e}");
                    }
                    store.delete_plugin_meta(&key)?;
                }
            }
        }
        let app_key = AppAgentKey::new(drive, &subject);
        if let AppAgentState::Active(_) = store.get_app_agent_state(&app_key)? {
            // Leaves the revocation tombstone `installation::resolve` honours.
            store.delete_app_agent(&app_key)?;
        }
        info!("deactivated installation {subject}");
        Ok(())
    }

    pub fn status(resource: &Resource) -> String {
        string_value(resource, urls::INSTALLATION_STATUS).unwrap_or_else(|| STATUS_DRAFT.into())
    }
}

#[allow(unused_variables)]
fn on_installation_before_commit(
    context: CommitExtenderContext,
    plugins_dir: PathBuf,
    plugin_cache_dir: PathBuf,
) -> BoxFuture<AtomicResult<()>> {
    Box::pin(async move {
        let CommitExtenderContext {
            store,
            commit,
            resource,
            is_new,
            changed_props,
        } = context;

        let drive = get_parent_drive(resource, store).await?;

        if commit.destroy == Some(true) {
            #[cfg(feature = "wasm-plugins")]
            installation_hook::deactivate(resource, &drive, store, &plugins_dir).await?;
            return Ok(());
        }

        if !is_new {
            for prop in [urls::NAME, urls::NAMESPACE, urls::PARENT] {
                if changed_props.contains(prop) {
                    return Err(AtomicError::from(
                        "Cannot change an Installation's name, namespace or parent after it was created",
                    ));
                }
            }
        }

        #[cfg(feature = "wasm-plugins")]
        {
            use installation_hook::*;
            let status = status(resource);
            let activation_changed = is_new
                || [
                    urls::INSTALLATION_STATUS,
                    urls::RELEASE_PROP,
                    urls::RELEASE_ID,
                    urls::GRANTS,
                    urls::CONFIG,
                ]
                .iter()
                .any(|prop| changed_props.contains(*prop));
            match status.as_str() {
                STATUS_ACTIVE if activation_changed => {
                    activate(
                        resource,
                        &drive,
                        store,
                        commit.signer.as_str(),
                        &plugins_dir,
                        &plugin_cache_dir,
                    )
                    .await?
                }
                STATUS_ACTIVE => {}
                STATUS_REVOKED if changed_props.contains(urls::INSTALLATION_STATUS) => {
                    deactivate(resource, &drive, store, &plugins_dir).await?
                }
                STATUS_REVOKED | STATUS_DRAFT | STATUS_PAUSED => {}
                other => {
                    return Err(AtomicError::from(format!(
                        "unknown installationStatus '{other}'; expected draft, active, paused or revoked"
                    )))
                }
            }
        }

        Ok(())
    })
}

pub fn build_installation_extender(
    plugins_dir: PathBuf,
    plugin_cache_dir: PathBuf,
) -> ClassExtender {
    ClassExtender::builder()
        .id("installation".to_string())
        .classes(vec![urls::INSTALLATION.to_string()])
        .on_resource_get(ClassExtender::wrap_get_handler(move |context| {
            on_resource_get(context)
        }))
        .before_commit(ClassExtender::wrap_commit_handler(move |context| {
            on_installation_before_commit(context, plugins_dir.clone(), plugin_cache_dir.clone())
        }))
        .build()
}

pub fn build_plugin_extender(
    plugins_dir: PathBuf,
    plugin_cache_dir: PathBuf,
    uploads_dir: PathBuf,
) -> ClassExtender {
    ClassExtender::builder()
        .id("plugin".to_string())
        .classes(vec![urls::PLUGIN.to_string()])
        .on_resource_get(ClassExtender::wrap_get_handler(move |context| {
            on_resource_get(context)
        }))
        .before_commit(ClassExtender::wrap_commit_handler(move |context| {
            on_before_commit(
                context,
                plugins_dir.clone(),
                plugin_cache_dir.clone(),
                uploads_dir.clone(),
            )
        }))
        .build()
}

#[cfg(all(test, feature = "wasm-plugins"))]
mod installation_tests {
    use super::*;
    use crate::plugins::{
        installation, release,
        test_fixture::{fixture, genesis},
    };
    use atomic_lib::db::{
        app_agent::AppAgentKey,
        plugin_release::{PluginRelease, RUNTIME_WASIP2, WORLD_EXTENSION, WORLD_SERVER_EXTENSION},
    };
    use serde_json::json;

    const TEST_PLUGIN_ZIP: &[u8] =
        include_bytes!("../../../browser/e2e/tests/fixtures/test-plugin.zip");

    fn js_release(world: &str) -> PluginRelease {
        let mut release = PluginRelease::js(
            "export function run() { return { intents: [] }; }".into(),
            json!({"schemaVersion":2,"capabilities":[{"name":"storage","reason":"keeps a cursor"}]}),
            Default::default(),
        );
        release.world = world.into();
        release
    }

    fn installation_props<'a>(
        drive: &'a str,
        namespace: &'a str,
        name: &'a str,
        release: &'a str,
        pinned: &'a str,
        status: &'a str,
    ) -> Vec<(&'a str, Value)> {
        vec![
            (
                urls::IS_A,
                Value::ResourceArray(vec![urls::INSTALLATION.into()]),
            ),
            (urls::PARENT, Value::AtomicUrl(drive.into())),
            (urls::NAME, Value::String(name.into())),
            (urls::NAMESPACE, Value::String(namespace.into())),
            (urls::RELEASE_PROP, Value::String(release.into())),
            (urls::RELEASE_ID, Value::String(pinned.into())),
            (urls::INSTALLATION_STATUS, Value::String(status.into())),
            (urls::GRANTS, Value::Json(json!(["storage"]))),
        ]
    }

    /// Like `genesis`, but returns the commit error instead of panicking.
    async fn try_genesis(store: &Db, propvals: Vec<(&str, Value)>) -> AtomicResult<String> {
        let mut resource = Resource::new("did:ad:placeholder".into());
        for (property, value) in propvals {
            resource.set_unsafe(property.into(), value)?;
        }
        resource.save_as_genesis(store).await?;
        Ok(resource.get_subject().to_string())
    }

    #[actix_rt::test]
    async fn an_active_js_installation_mints_its_identity_and_revocation_tombstones_it() {
        let f = fixture("installation_js").await;
        let db = &f.appstate.store;
        let id = db
            .publish_plugin_release(&js_release(WORLD_EXTENSION))
            .unwrap();
        let installation = genesis(
            db,
            installation_props(&f.drive, "acme", "importer", &id, &id, "active"),
        )
        .await;

        let key = PluginMetaKey::new(&f.drive, "acme", "importer");
        let meta = db
            .get_plugin_meta(&key)
            .unwrap()
            .expect("a PluginMeta record");
        assert_eq!(meta.subject, installation);
        assert_eq!(meta.manifest.namespace, "acme");
        assert_eq!(meta.manifest_v2, Some(js_release(WORLD_EXTENSION).manifest));
        let app_key = AppAgentKey::new(&f.drive, &installation);
        assert_eq!(
            installation::resolve(db, &f.drive, &installation)
                .await
                .unwrap()
                .signing_as,
            Some(app_key.clone())
        );
        let agent = db.get_app_agent_info(&app_key).unwrap().unwrap().agent;
        assert_eq!(
            Agent::from_secret(&meta.agent_secret)
                .unwrap()
                .subject
                .to_string(),
            agent
        );

        // The same identifiers cannot be claimed by a second installation.
        let clash = try_genesis(
            db,
            installation_props(&f.drive, "acme", "importer", &id, &id, "active"),
        )
        .await
        .unwrap_err();
        assert!(clash.to_string().contains("already installed"), "{clash}");

        let mut r = db
            .get_resource(&installation.as_str().into())
            .await
            .unwrap();
        r.set_unsafe(
            urls::INSTALLATION_STATUS.into(),
            Value::String("revoked".into()),
        )
        .unwrap();
        r.save(db).await.unwrap();
        assert!(db.get_plugin_meta(&key).unwrap().is_none());
        let err = installation::resolve(db, &f.drive, &installation)
            .await
            .err()
            .expect("a revoked identity no longer resolves");
        assert!(err.contains("revoked"), "{err}");
        assert!(db.app_agent_was_revoked(&app_key).unwrap());
    }

    #[actix_rt::test]
    async fn a_tampered_or_server_extension_release_is_refused() {
        let f = fixture("installation_refused").await;
        let db = &f.appstate.store;
        let id = db
            .publish_plugin_release(&js_release(WORLD_EXTENSION))
            .unwrap();

        let forged = format!("blake3:{}", "0".repeat(64));
        let err = try_genesis(
            db,
            installation_props(&f.drive, "acme", "forged", &id, &forged, "active"),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("refusing to install"), "{err}");
        assert!(db
            .get_plugin_meta(&PluginMetaKey::new(&f.drive, "acme", "forged"))
            .unwrap()
            .is_none());

        let server_only = db
            .publish_plugin_release(&js_release(WORLD_SERVER_EXTENSION))
            .unwrap();
        let err = try_genesis(
            db,
            installation_props(
                &f.drive,
                "acme",
                "hooks",
                &server_only,
                &server_only,
                "active",
            ),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("server-extension"), "{err}");

        let err = try_genesis(
            db,
            vec![
                (
                    urls::IS_A,
                    Value::ResourceArray(vec![urls::INSTALLATION.into()]),
                ),
                (urls::PARENT, Value::AtomicUrl(f.drive.as_str().into())),
                (urls::NAME, Value::String("greedy".into())),
                (urls::NAMESPACE, Value::String("acme".into())),
                (urls::RELEASE_PROP, Value::String(id.clone())),
                (urls::RELEASE_ID, Value::String(id.clone())),
                (urls::INSTALLATION_STATUS, Value::String("active".into())),
                (urls::GRANTS, Value::Json(json!(["full-drive-access"]))),
            ],
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("not declared"), "{err}");

        // Granting less than the manifest declares is refused too, naming the
        // capability and its reason.
        let err = try_genesis(
            db,
            vec![
                (
                    urls::IS_A,
                    Value::ResourceArray(vec![urls::INSTALLATION.into()]),
                ),
                (urls::PARENT, Value::AtomicUrl(f.drive.as_str().into())),
                (urls::NAME, Value::String("stingy".into())),
                (urls::NAMESPACE, Value::String("acme".into())),
                (urls::RELEASE_PROP, Value::String(id.clone())),
                (urls::RELEASE_ID, Value::String(id.clone())),
                (urls::INSTALLATION_STATUS, Value::String("active".into())),
                (urls::GRANTS, Value::Json(json!([]))),
            ],
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().contains("storage (keeps a cursor)"),
            "{err}"
        );

        // A draft does nothing, and can be created for any release.
        let draft = genesis(
            db,
            installation_props(&f.drive, "acme", "later", &id, &forged, "draft"),
        )
        .await;
        assert!(db.get_resource(&draft.as_str().into()).await.is_ok());
    }

    /// The capabilities `test-plugin.zip` declares in its `plugin.json`.
    const TEST_PLUGIN_GRANTS: [&str; 3] = ["storage", "custom-view", "full-drive-access"];

    #[actix_rt::test]
    async fn a_wasip2_release_carries_a_v2_manifest_read_from_the_component() {
        let f = fixture("wasm_release_manifest").await;
        let db = &f.appstate.store;
        let (id, release, manifest) = release::publish_package(db, TEST_PLUGIN_ZIP).await.unwrap();
        assert_eq!(release.runtime, RUNTIME_WASIP2);
        assert_eq!(release.package.as_deref().map(str::len), Some(64));
        assert_eq!(release.version.as_deref(), Some("1.0.0"));
        // The component extends Folder (and a test class), so the package is
        // a server-extension with those classes as its entrypoints.
        assert_eq!(release.world, WORLD_SERVER_EXTENSION);
        let classes = manifest.entrypoints.class_urls();
        assert_eq!(classes.len(), 2, "{classes:?}");
        assert!(
            classes.contains(&"https://atomicdata.dev/classes/Folder".to_string()),
            "{classes:?}"
        );
        assert!(!manifest.entrypoints.run);
        assert_eq!(release.manifest["schemaVersion"], 2);
        assert_eq!(release.manifest["runtime"], "wasip2/1");
        assert_eq!(release.manifest["world"], "server-extension");
        assert_eq!(release.manifest["namespace"], "ontola");
        assert_eq!(release.manifest["name"], "test-plugin");
        let declared: Vec<&str> = manifest
            .capabilities
            .iter()
            .map(|c| c.name.as_str())
            .collect();
        assert_eq!(declared, TEST_PLUGIN_GRANTS);
        assert!(manifest.capabilities.iter().all(|c| c.reason.is_some()));
        // The stored manifest parses back as the same version-two manifest.
        crate::plugins::manifest::Manifest::parse(release.manifest.clone())
            .unwrap()
            .unwrap();
        // Content-addressed: the same bytes publish to the same id.
        let (again, _, _) = release::publish_package(db, TEST_PLUGIN_ZIP).await.unwrap();
        assert_eq!(again, id);
        assert_eq!(db.get_plugin_release(&id).unwrap(), release);
    }

    #[actix_rt::test]
    async fn a_wasip2_installation_goes_through_the_zip_install_path() {
        let f = fixture("installation_wasm").await;
        let db = &f.appstate.store;
        let (id, release, _) = release::publish_package(db, TEST_PLUGIN_ZIP).await.unwrap();

        // Grants must cover every capability the package declares.
        let mut props = installation_props(&f.drive, "ontola", "test-plugin", &id, &id, "active");
        props.retain(|(prop, _)| *prop != urls::GRANTS);
        props.push((urls::GRANTS, Value::Json(json!(["storage", "custom-view"]))));
        let err = try_genesis(db, props).await.unwrap_err();
        assert!(err.to_string().contains("full-drive-access ("), "{err}");
        let key = PluginMetaKey::new(&f.drive, "ontola", "test-plugin");
        assert!(db.get_plugin_meta(&key).unwrap().is_none());

        // The zip path checks the manifest against the stored resource, so the
        // installation is created as a draft and activated in a second commit.
        let mut props = installation_props(&f.drive, "ontola", "test-plugin", &id, &id, "draft");
        props.retain(|(prop, _)| *prop != urls::GRANTS);
        props.push((urls::GRANTS, Value::Json(json!(TEST_PLUGIN_GRANTS))));
        let installation = genesis(db, props).await;
        assert!(db.get_plugin_meta(&key).unwrap().is_none());
        assert!(db.get_class_extenders_on_drive(&f.drive).is_empty());

        let mut r = db
            .get_resource(&installation.as_str().into())
            .await
            .unwrap();
        r.set_unsafe(
            urls::INSTALLATION_STATUS.into(),
            Value::String("active".into()),
        )
        .unwrap();
        r.save(db).await.unwrap();

        let meta = db.get_plugin_meta(&key).unwrap().expect("installed");
        assert_eq!(meta.subject, installation);
        assert_eq!(meta.manifest.version, "1.0.0");
        assert_eq!(meta.manifest_v2, Some(release.manifest.clone()));
        // Drive-scoped: the class extender is registered on this drive only
        // (`get_class_extenders_on_drive` filters on `ClassExtenderScope::Drive`).
        assert_eq!(db.get_class_extenders_on_drive(&f.drive).len(), 1);
        // The dynamic properties a Plugin gets are served for an Installation too.
        let shown = db
            .get_resource_extended(&installation.as_str().into(), false, &ForAgent::Sudo)
            .await
            .unwrap()
            .to_single();
        assert!(shown.get(urls::PLUGIN_AGENT).is_ok());

        let mut r = db
            .get_resource(&installation.as_str().into())
            .await
            .unwrap();
        r.destroy(db).await.unwrap();
        assert!(db.get_plugin_meta(&key).unwrap().is_none());
    }

    #[actix_rt::test]
    async fn a_package_that_is_not_on_this_node_cannot_be_installed() {
        let f = fixture("installation_missing_package").await;
        let db = &f.appstate.store;
        let id = db
            .publish_plugin_release(&PluginRelease {
                source: None,
                package: Some("ab".repeat(32)),
                manifest: json!({"name":"ghost","namespace":"acme","version":"0.1.0"}),
                runtime: RUNTIME_WASIP2.into(),
                world: WORLD_EXTENSION.into(),
                schemas: Default::default(),
                version: None,
                previous_release: None,
            })
            .unwrap();
        // A legacy plugin.json manifest without permissions declares nothing.
        let mut props = installation_props(&f.drive, "acme", "ghost", &id, &id, "active");
        props.retain(|(prop, _)| *prop != urls::GRANTS);
        let err = try_genesis(db, props).await.unwrap_err();
        assert!(err.to_string().contains("not on this node"), "{err}");
    }
}
