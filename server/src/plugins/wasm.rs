use std::future::Future;
use std::pin::Pin;

use futures::future::join_all;
use zip::ZipArchive;

use std::{
    collections::HashSet,
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::Arc,
};

use atomic_lib::{
    agents::ForAgent,
    class_extender::ClassExtender,
    errors::{AtomicError, AtomicResult},
    parse::{parse_json_ad_resource, ParseOpts, SaveOpts},
    storelike::{Query, ResourceResponse},
    urls, Db, Resource, Storelike,
};
use atomic_lib::{
    class_extender::{self, ClassExtenderScope},
    AtomicErrorType,
};
use base64::{engine::general_purpose, Engine as _};
use ring::digest::{digest, SHA256};
use tracing::{error, info, warn};
use wasmtime::{
    component::{Component, Linker, ResourceTable},
    Config, Engine, Store,
};
use wasmtime_wasi::{p2, DirPerms, FilePerms, WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpView};

mod bindings {
    wasmtime::component::bindgen!({
    path: "wit/class-extender.wit",
    world: "class-extender",
    imports: { default: async },
    exports: { default: async },
    });
}

use bindings::atomic::class_extender::types::{
    CommitContext as WasmCommitContext, GetContext as WasmGetContext,
    ResourceJson as WasmResourceJson, ResourceResponse as WasmResourceResponse,
};

const CLASS_EXTENDER_DIR_NAME: &str = "class-extenders"; // Relative to the store path.

#[derive(serde::Deserialize, serde::Serialize)]
struct PluginMetadata {
    name: String,
    namespace: String,
    author: String,
    description: String,
    version: String,
    #[serde(rename = "defaultConfig")]
    default_config: Option<serde_json::Value>,
    #[serde(rename = "configSchema")]
    config_schema: Option<serde_json::Value>,
    pub subject: Option<String>,
}

impl PluginMetadata {
    fn from_json(json: &str) -> AtomicResult<Self> {
        serde_json::from_str(json)
            .map_err(|e| AtomicError::from(format!("Failed to parse plugin metadata: {}", e)))
    }
}

// In your current crate (where AtomicError is defined or where you write the impl)
// The newtype is a local type now.
struct WasmtimeErrorWrapper(wasmtime::Error);

// Now you implement From for the local newtype, which is allowed.
impl From<wasmtime::Error> for WasmtimeErrorWrapper {
    fn from(error: wasmtime::Error) -> Self {
        WasmtimeErrorWrapper(error)
    }
}

// Now you can implement the conversion FROM your local newtype TO AtomicError
// This is also allowed because WasmtimeErrorWrapper is local.
impl From<WasmtimeErrorWrapper> for AtomicError {
    fn from(wrapper: WasmtimeErrorWrapper) -> Self {
        AtomicError {
            message: wrapper.0.to_string(),
            error_type: AtomicErrorType::OtherError,
            subject: None,
        }
    }
}

fn to_atomic_error(error: wasmtime::Error) -> AtomicError {
    WasmtimeErrorWrapper(error).into()
}

pub async fn load_wasm_class_extenders(
    plugin_path: &Path,
    plugin_cache_path: &Path,
    db: &Db,
) -> AtomicResult<Vec<ClassExtender>> {
    // Create the plugin directory if it doesn't exist
    let plugin_dir = plugin_path.join(CLASS_EXTENDER_DIR_NAME);
    let global_dir = plugin_dir.join("global");
    let scoped_dir = plugin_dir.join("scoped");

    if !plugin_dir.exists() {
        if let Err(err) = std::fs::create_dir_all(&plugin_dir) {
            warn!(
                error = %err,
                path = %plugin_dir.display(),
                "Failed to create Wasm extender directory"
            );
        } else {
            // Create global and scoped directories
            std::fs::create_dir_all(&global_dir).ok();
            std::fs::create_dir_all(&scoped_dir).ok();
            info!(
                path = %plugin_dir.display(),
                "Created empty Wasm extender directory (drop .wasm files in 'global' or 'scoped/<base64_drive_url>' folders)"
            );
        }
        return Ok(Vec::new());
    }

    // Ensure subdirectories exist
    if !global_dir.exists() {
        std::fs::create_dir_all(&global_dir).ok();
    }
    if !scoped_dir.exists() {
        std::fs::create_dir_all(&scoped_dir).ok();
    }

    // Setup cache directories
    if !plugin_cache_path.exists() {
        if let Err(err) = std::fs::create_dir_all(plugin_cache_path) {
            warn!(
                error = %err,
                path = %plugin_cache_path.display(),
                "Failed to create Wasm cache directory"
            );
        }
    }
    let global_cache = plugin_cache_path.join("global");
    if !global_cache.exists() {
        std::fs::create_dir_all(&global_cache).ok();
    }
    let scoped_cache = plugin_cache_path.join("scoped");
    if !scoped_cache.exists() {
        std::fs::create_dir_all(&scoped_cache).ok();
    }

    let engine = match build_engine() {
        Ok(engine) => Arc::new(engine),
        Err(err) => {
            error!(error = %err, "Failed to initialize Wasm engine. Skipping dynamic class extenders");
            return Ok(Vec::new());
        }
    };

    let mut extenders = Vec::new();
    let mut used_cwasm_files = HashSet::new();
    let mut cache_dirs = vec![global_cache.clone()];

    info!("Loading plugins...");

    let mut tasks = Vec::new();

    // Global Plugins
    let global_wasm_files = find_wasm_files(&global_dir);
    for path in global_wasm_files {
        tasks.push((
            path,
            global_dir.clone(),
            global_cache.clone(),
            ClassExtenderScope::Global,
        ));
    }

    // Scoped Plugins
    if let Ok(entries) = std::fs::read_dir(&scoped_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let dir_name = entry.file_name();
                let dir_name_str = dir_name.to_string_lossy();

                // Get the scope subject from the directory name
                let Ok(sope_subject) = decode_subject(&dir_name_str) else {
                    warn!(
                        "Skipping invalid base64 scoped plugin directory: {}",
                        dir_name_str
                    );
                    continue;
                };

                let scope = ClassExtenderScope::Drive(sope_subject);
                let drive_wasm_files = find_wasm_files(&path);
                let drive_cache = scoped_cache.join(&dir_name);
                if !drive_cache.exists() {
                    std::fs::create_dir_all(&drive_cache).ok();
                }
                cache_dirs.push(drive_cache.clone());

                for wasm_path in drive_wasm_files {
                    tasks.push((wasm_path, path.clone(), drive_cache.clone(), scope.clone()));
                }
            }
        }
    }

    let futures = tasks
        .into_iter()
        .map(|(path, plugin_dir, plugin_cache_path, scope)| {
            let engine = engine.clone();
            let db = db.clone();

            async move {
                load_plugin_from_disk(&path, &plugin_dir, &plugin_cache_path, scope, engine, &db)
                    .await
                    .unwrap_or((None, PathBuf::new()))
            }
        });

    let results = join_all(futures).await;

    for res in results {
        let (extender_opt, cwasm_path) = res;
        used_cwasm_files.insert(cwasm_path);
        if let Some(extender) = extender_opt {
            extenders.push(extender);
        }
    }

    for cache_dir in cache_dirs {
        cleanup_cache(&cache_dir, &used_cwasm_files);
    }

    Ok(extenders)
}

fn build_engine() -> AtomicResult<Engine> {
    let mut config = Config::new();
    config.wasm_component_model(true);
    config.async_support(true);
    Engine::new(&config).map_err(to_atomic_error)
}

#[derive(Clone)]
struct WasmPlugin {
    inner: Arc<WasmPluginInner>,
}

struct WasmPluginInner {
    engine: Arc<Engine>,
    component: Component,
    path: PathBuf,
    owned_folder_path: Option<PathBuf>,
    scope: ClassExtenderScope,
    class_url: Vec<String>,
    db: Arc<Db>,
    plugin_subject: Option<String>,
}

impl WasmPlugin {
    async fn load(
        engine: Arc<Engine>,
        wasm_bytes: &[u8],
        path: &Path,
        cwasm_path: &Path,
        owned_folder_path: Option<PathBuf>,
        db: &Db,
        scope: ClassExtenderScope,
        plugin_subject: Option<String>,
    ) -> AtomicResult<Self> {
        let db = Arc::new(db.clone());

        let component = if cwasm_path.exists() {
            match std::fs::read(cwasm_path) {
                Ok(bytes) => {
                    // Safety: We trust the pre-compiled component on disk as it is generated by us or the admin
                    match unsafe { Component::deserialize(&engine, &bytes) } {
                        Ok(c) => c,
                        Err(e) => {
                            warn!(
                                "Failed to deserialize cwasm at {}, recompiling. Error: {}",
                                cwasm_path.display(),
                                e
                            );
                            compile_and_save_component(&engine, wasm_bytes, path, cwasm_path)?
                        }
                    }
                }
                Err(e) => {
                    warn!("Failed to read cwasm file: {}", e);
                    compile_and_save_component(&engine, wasm_bytes, path, cwasm_path)?
                }
            }
        } else {
            compile_and_save_component(&engine, wasm_bytes, path, cwasm_path)?
        };

        let runtime = WasmPlugin {
            inner: Arc::new(WasmPluginInner {
                engine: engine.clone(),
                component,
                path: path.to_path_buf(),
                owned_folder_path,
                class_url: Vec::new(),
                scope: scope.clone(),
                db: Arc::clone(&db),
                plugin_subject: plugin_subject.clone(),
            }),
        };

        let class_url = runtime.call_class_url().await?;
        Ok(WasmPlugin {
            inner: Arc::new(WasmPluginInner {
                engine,
                component: runtime.inner.component.clone(),
                path: runtime.inner.path.clone(),
                owned_folder_path: runtime.inner.owned_folder_path.clone(),
                class_url,
                scope,
                db,
                plugin_subject,
            }),
        })
    }

    fn into_class_extender(self) -> ClassExtender {
        let get_plugin = self.clone();
        let before_plugin = self.clone();
        let after_plugin = self.clone();

        let id = if let ClassExtenderScope::Drive(drive) = &self.inner.scope {
            let filename = self
                .inner
                .path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            Some(format!("{}:{}", drive, filename))
        } else {
            let filename = self
                .inner
                .path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            Some(format!("global:{}", filename))
        };

        ClassExtender {
            id,
            classes: self.inner.class_url.clone(),
            on_resource_get: Some(ClassExtender::wrap_get_handler(move |context| {
                let get_plugin = get_plugin.clone();
                Box::pin(async move { get_plugin.call_on_resource_get(context).await })
            })),
            before_commit: Some(ClassExtender::wrap_commit_handler(move |context| {
                let before_plugin = before_plugin.clone();
                Box::pin(async move { before_plugin.call_before_commit(context).await })
            })),
            after_commit: Some(ClassExtender::wrap_commit_handler(move |context| {
                let after_plugin = after_plugin.clone();
                Box::pin(async move { after_plugin.call_after_commit(context).await })
            })),
            scope: self.inner.scope.clone(),
        }
    }

    async fn call_class_url(&self) -> AtomicResult<Vec<String>> {
        let (instance, mut store) = self.instantiate().await?;
        instance
            .call_class_url(&mut store)
            .await
            .map_err(to_atomic_error)
    }

    async fn call_on_resource_get<'a>(
        &'a self,
        context: class_extender::GetExtenderContext<'a>,
    ) -> AtomicResult<ResourceResponse> {
        let payload = self.build_get_context(&context)?;
        let (instance, mut store) = self.instantiate().await?;
        let response = instance
            .call_on_resource_get(&mut store, &payload)
            .await
            .map_err(to_atomic_error)??;

        let Some(payload) = response else {
            return Ok(ResourceResponse::Resource(context.db_resource.clone()));
        };

        self.inflate_resource_response(payload, context.store).await
    }

    async fn call_before_commit<'a>(
        &'a self,
        context: class_extender::CommitExtenderContext<'a>,
    ) -> AtomicResult<()> {
        let payload = self.build_commit_context(&context).await?;
        let (instance, mut store) = self.instantiate().await?;
        instance
            .call_before_commit(&mut store, &payload)
            .await
            .map_err(to_atomic_error)?
            .map_err(AtomicError::other_error)
    }

    async fn call_after_commit<'a>(
        &'a self,
        context: class_extender::CommitExtenderContext<'a>,
    ) -> AtomicResult<()> {
        let payload = self.build_commit_context(&context).await?;
        let (instance, mut store) = self.instantiate().await?;
        instance
            .call_after_commit(&mut store, &payload)
            .await
            .map_err(to_atomic_error)?
            .map_err(AtomicError::other_error)
    }

    async fn instantiate(&self) -> AtomicResult<(bindings::ClassExtender, Store<PluginHostState>)> {
        let mut store = Store::new(
            &self.inner.engine,
            PluginHostState::new(
                Arc::clone(&self.inner.db),
                &self.inner.owned_folder_path,
                self.inner.plugin_subject.clone(),
            )?,
        );
        let mut linker = Linker::new(&self.inner.engine);
        p2::add_to_linker_async(&mut linker).map_err(|err| AtomicError::from(err.to_string()))?;
        wasmtime_wasi_http::add_only_http_to_linker_async(&mut linker)
            .map_err(|err| AtomicError::from(err.to_string()))?;
        bindings::atomic::class_extender::host::add_to_linker::<
            PluginHostState,
            wasmtime::component::HasSelf<PluginHostState>,
        >(&mut linker, |state: &mut PluginHostState| state)
        .map_err(|err| AtomicError::from(err.to_string()))?;

        let instance =
            bindings::ClassExtender::instantiate_async(&mut store, &self.inner.component, &linker)
                .await
                .map_err(to_atomic_error)?;
        Ok((instance, store))
    }

    fn build_get_context(
        &self,
        context: &class_extender::GetExtenderContext,
    ) -> AtomicResult<WasmGetContext> {
        Ok(WasmGetContext {
            request_url: context.url.as_str().to_string(),
            requested_subject: context.db_resource.get_subject().to_string(),
            agent_subject: context.for_agent.to_string(),
            snapshot: self.encode_resource(context.db_resource)?,
        })
    }

    async fn build_commit_context<'a>(
        &self,
        context: &'a class_extender::CommitExtenderContext<'a>,
    ) -> AtomicResult<WasmCommitContext> {
        Ok(WasmCommitContext {
            subject: context.resource.get_subject().to_string(),
            commit_json: context
                .commit
                .serialize_deterministically_json_ad(context.store)
                .await?,
            snapshot: self.encode_resource(context.resource)?,
        })
    }

    fn encode_resource(&self, resource: &Resource) -> AtomicResult<WasmResourceJson> {
        Ok(WasmResourceJson {
            subject: resource.get_subject().to_string(),
            json_ad: resource.to_json_ad()?,
        })
    }

    fn inflate_resource_response<'a>(
        &self,
        payload: WasmResourceResponse,
        store: &'a atomic_lib::Db,
    ) -> Pin<Box<dyn Future<Output = AtomicResult<ResourceResponse>> + Send + 'a>> {
        Box::pin(async move {
            let mut parse_opts = ParseOpts::default();
            parse_opts.save = SaveOpts::DontSave;
            parse_opts.for_agent = ForAgent::Sudo;

            let mut base =
                parse_json_ad_resource(&payload.primary.json_ad, store, &parse_opts).await?;
            base.set_subject(payload.primary.subject);

            let mut referenced = Vec::new();
            for item in payload.referenced {
                let mut resource =
                    parse_json_ad_resource(&item.json_ad, store, &parse_opts).await?;
                resource.set_subject(item.subject);
                referenced.push(resource);
            }

            if referenced.is_empty() {
                Ok(ResourceResponse::Resource(base))
            } else {
                Ok(ResourceResponse::ResourceWithReferenced(base, referenced))
            }
        })
    }
}

struct PluginHostState {
    table: ResourceTable,
    ctx: WasiCtx,
    http: WasiHttpCtx,
    db: Arc<Db>,
    plugin_subject: Option<String>,
}

impl PluginHostState {
    fn new(
        db: Arc<Db>,
        owned_folder_path: &Option<PathBuf>,
        plugin_subject: Option<String>,
    ) -> AtomicResult<Self> {
        let mut builder = WasiCtxBuilder::new();
        builder
            .inherit_stdout()
            .inherit_stderr()
            .inherit_stdin()
            .inherit_network();

        if let Some(owned_folder_path) = owned_folder_path {
            builder
                .preopened_dir(
                    owned_folder_path.clone(),
                    "/",
                    DirPerms::READ | DirPerms::MUTATE,
                    FilePerms::WRITE | FilePerms::READ,
                )
                .map_err(|e| AtomicError::from(format!("Failed to preopen directory: {}", e)))?;
        }

        let ctx = builder.build();
        Ok(Self {
            table: ResourceTable::new(),
            ctx,
            http: WasiHttpCtx::new(),
            db,
            plugin_subject,
        })
    }
}

impl WasiView for PluginHostState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.ctx,
            table: &mut self.table,
        }
    }
}

impl WasiHttpView for PluginHostState {
    fn ctx(&mut self) -> &mut WasiHttpCtx {
        &mut self.http
    }

    fn table(&mut self) -> &mut ResourceTable {
        &mut self.table
    }
}

impl bindings::atomic::class_extender::host::Host for PluginHostState {
    async fn get_resource(
        &mut self,
        subject: String,
        agent: Option<String>,
    ) -> Result<WasmResourceJson, String> {
        let for_agent = agent.map(ForAgent::from).unwrap_or(ForAgent::Public);

        let resource = self
            .db
            .get_resource_extended(&subject, false, &for_agent)
            .await
            .map_err(|e| e.to_string())?
            .to_single();

        Ok(WasmResourceJson {
            subject: resource.get_subject().to_string(),
            json_ad: resource.to_json_ad().map_err(|e| e.to_string())?,
        })
    }

    async fn query(
        &mut self,
        property: String,
        value: String,
        agent: Option<String>,
    ) -> Result<Vec<WasmResourceJson>, String> {
        let for_agent = agent.map(ForAgent::from).unwrap_or(ForAgent::Public);

        let mut query = Query::new_prop_val(&property, &value);
        query.for_agent = for_agent;

        let result = self.db.query(&query).await.map_err(|e| e.to_string())?;

        let mut resources = Vec::new();

        for resource in result.resources {
            resources.push(WasmResourceJson {
                subject: resource.get_subject().to_string(),
                json_ad: resource.to_json_ad().map_err(|e| e.to_string())?,
            });
        }

        Ok(resources)
    }

    async fn get_plugin_agent(&mut self) -> String {
        String::new()
    }

    async fn get_config(&mut self) -> String {
        let Some(subject) = &self.plugin_subject else {
            return "{}".to_string();
        };

        let Ok(plugin_resource) = self.db.get_resource(subject).await else {
            return "{}".to_string();
        };

        let Ok(val) = plugin_resource.get(urls::CONFIG) else {
            return "{}".to_string();
        };

        match val {
            atomic_lib::Value::JSON(json_val) => json_val.to_string(),
            _ => "{}}".to_string(),
        }
    }
}

fn validate_plugin_zip(
    zip: &mut ZipArchive<std::io::Cursor<Vec<u8>>>,
) -> AtomicResult<(String, String)> {
    use std::io::Read;
    // Check for plugin.wasm
    if zip.by_name("plugin.wasm").is_err() {
        return Err(AtomicError::from("Missing plugin.wasm"));
    }

    // Check for plugin.json and read it
    let (namespace, name) = {
        let mut file = zip
            .by_name("plugin.json")
            .map_err(|_| AtomicError::from("Missing plugin.json"))?;
        let mut content = String::new();

        file.read_to_string(&mut content)
            .map_err(|e| AtomicError::from(format!("Failed to read plugin.json: {}", e)))?;
        let metadata: PluginMetadata = PluginMetadata::from_json(&content)?;
        (metadata.namespace, metadata.name)
    };

    for i in 0..zip.len() {
        let file = zip
            .by_index(i)
            .map_err(|e| AtomicError::from(e.to_string()))?;
        let name = file.name();
        if name == "plugin.wasm" || name == "plugin.json" || name.starts_with("assets/") {
            continue;
        }
        // If it's a directory "assets/", that's fine too.
        if name == "assets/" {
            continue;
        }
        return Err(AtomicError::from(format!(
            "Illegal file found in zip: {}. Only plugin.wasm, plugin.json and assets/ are allowed.",
            name
        )));
    }

    Ok((namespace, name))
}

fn extract_plugin_to_disk(
    zip: &mut ZipArchive<std::io::Cursor<Vec<u8>>>,
    plugins_dir: &Path,
    encoded_subject: &str,
    namespace: &str,
    name: &str,
) -> AtomicResult<PathBuf> {
    let target_dir = plugins_dir
        .join(CLASS_EXTENDER_DIR_NAME)
        .join("scoped")
        .join(encoded_subject);

    // We do not clear the directory, as multiple plugins might share this scope.
    // Existing files (wasm, json) will be overwritten by zip extraction.
    // The assets directory will be merged (existing files kept, new files written/overwritten).
    std::fs::create_dir_all(&target_dir)
        .map_err(|e| AtomicError::from(format!("Failed to create plugin directory: {}", e)))?;

    for i in 0..zip.len() {
        let mut file = zip
            .by_index(i)
            .map_err(|e| AtomicError::from(e.to_string()))?;
        let file_name = file.name().to_string();

        let target_path = if file_name == "plugin.wasm" {
            target_dir.join(format!("{}.{}.wasm", namespace, name))
        } else if file_name == "plugin.json" {
            target_dir.join(format!("{}.{}.json", namespace, name))
        } else if file_name.starts_with("assets/") {
            // Replace "assets/" with "{namespace}/"
            let stripped = file_name.strip_prefix("assets/").unwrap();
            if stripped.is_empty() {
                // It is the "assets/" directory itself
                target_dir.join(namespace)
            } else {
                target_dir.join(namespace).join(stripped)
            }
        } else {
            continue;
        };

        if file.is_dir() {
            std::fs::create_dir_all(&target_path).map_err(|e| {
                AtomicError::from(format!(
                    "Failed to create directory {}: {}",
                    target_path.display(),
                    e
                ))
            })?;
        } else {
            if let Some(parent) = target_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    AtomicError::from(format!(
                        "Failed to create directory {}: {}",
                        parent.display(),
                        e
                    ))
                })?;
            }
            let mut outfile = std::fs::File::create(&target_path).map_err(|e| {
                AtomicError::from(format!(
                    "Failed to create file {}: {}",
                    target_path.display(),
                    e
                ))
            })?;
            std::io::copy(&mut file, &mut outfile).map_err(|e| {
                AtomicError::from(format!(
                    "Failed to write file {}: {}",
                    target_path.display(),
                    e
                ))
            })?;
        }
    }

    Ok(target_dir)
}

fn find_wasm_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension() == Some(OsStr::new("wasm")) {
                files.push(path);
            }
        }
    }
    files
}

fn setup_plugin_data_dir(wasm_file_path: &Path, plugin_dir: &Path) -> Option<PathBuf> {
    let filename = wasm_file_path.file_name().and_then(|s| s.to_str())?;

    // Remove .wasm extension
    let stem = wasm_file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename);

    let stem_path = Path::new(stem);

    // If there is no second extension (e.g. just my-plugin.wasm), we don't grant access to a folder.
    // This is to prevent plugins from accessing arbitrary folders.
    // Only namespaced plugins (e.g. google.calendar.wasm or my-plugin.plugin.wasm) get a folder.
    if stem_path.extension().is_none() {
        return None;
    }

    // Remove the second extension (e.g. .plugin in my_script.plugin.wasm), if present.
    // This allows for any suffix without dots.
    let plugin_name = stem_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(stem);

    let data_dir = plugin_dir.join(plugin_name);

    if !data_dir.exists() {
        if let Err(err) = std::fs::create_dir_all(&data_dir) {
            warn!(
                error = %err,
                path = %data_dir.display(),
                "Failed to create data directory for plugin"
            );
            return None;
        }
    }

    if data_dir.exists() {
        Some(data_dir)
    } else {
        None
    }
}

pub async fn uninstall_plugin(
    name: &str,
    namespace: &str,
    drive_subject: &str,
    store: &Db,
    plugins_dir: &Path,
) -> AtomicResult<()> {
    let encoded_subject = general_purpose::URL_SAFE.encode(drive_subject);
    let target_dir = plugins_dir
        .join(CLASS_EXTENDER_DIR_NAME)
        .join("scoped")
        .join(&encoded_subject);

    if !target_dir.exists() {
        return Err(AtomicError::not_found(format!(
            "Plugin directory not found for drive: {}",
            drive_subject
        )));
    }

    let wasm_filename = format!("{}.{}.wasm", namespace, name);
    let wasm_path = target_dir.join(&wasm_filename);
    let json_path = target_dir.join(format!("{}.{}.json", namespace, name));

    if !wasm_path.exists() {
        return Err(AtomicError::not_found(format!(
            "Plugin {}.{} not found",
            namespace, name
        )));
    }

    // 1. Remove from DB
    let id = format!("{}:{}", drive_subject, wasm_filename);
    store.remove_class_extender(&id)?;

    // 2. Remove from disk
    std::fs::remove_file(&wasm_path).map_err(|e| {
        AtomicError::from(format!(
            "Failed to remove wasm file {}: {}",
            wasm_path.display(),
            e
        ))
    })?;

    if json_path.exists() {
        std::fs::remove_file(&json_path).map_err(|e| {
            AtomicError::from(format!(
                "Failed to remove json file {}: {}",
                json_path.display(),
                e
            ))
        })?;
    }

    // 3. Handle assets folder
    // Check if other plugins are using the same namespace in this drive
    let mut namespace_still_used = false;
    if let Ok(entries) = std::fs::read_dir(&target_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(file_name) = path.file_name().and_then(|s| s.to_str()) {
                    // Check for other plugins in the same namespace
                    if file_name.starts_with(&format!("{}.", namespace))
                        && (file_name.ends_with(".wasm") || file_name.ends_with(".json"))
                    {
                        namespace_still_used = true;
                        break;
                    }
                }
            }
        }
    }

    if !namespace_still_used {
        let assets_dir = target_dir.join(namespace);
        if assets_dir.exists() && assets_dir.is_dir() {
            info!("Removing unused assets directory: {}", assets_dir.display());
            std::fs::remove_dir_all(&assets_dir).map_err(|e| {
                AtomicError::from(format!(
                    "Failed to remove assets directory {}: {}",
                    assets_dir.display(),
                    e
                ))
            })?;
        }
    }

    info!("Uninstalled plugin {}.{}", namespace, name);

    Ok(())
}

pub async fn install_plugin(
    zip_file: &mut ZipArchive<std::io::Cursor<Vec<u8>>>,
    drive_subject: &str,
    plugin_subject: &str,
    store: &Db,
    plugins_dir: &Path,
    plugin_cache_dir: &Path,
) -> AtomicResult<()> {
    // 1. Validation
    let (namespace, name) = validate_plugin_zip(zip_file)?;
    let wasm_target_name = format!("{}.{}.wasm", namespace, name);

    // 2. Installation
    let encoded_subject = general_purpose::URL_SAFE.encode(drive_subject);
    let target_dir =
        extract_plugin_to_disk(zip_file, plugins_dir, &encoded_subject, &namespace, &name)?;

    // Update plugin.json with the plugin subject
    let json_path = target_dir.join(format!("{}.{}.json", namespace, name));
    if json_path.exists() {
        let json_content = std::fs::read_to_string(&json_path)
            .map_err(|e| AtomicError::from(format!("Failed to read plugin.json: {}", e)))?;
        let mut metadata: PluginMetadata = serde_json::from_str(&json_content)
            .map_err(|e| AtomicError::from(format!("Failed to parse plugin.json: {}", e)))?;
        metadata.subject = Some(plugin_subject.to_string());
        std::fs::write(&json_path, serde_json::to_string_pretty(&metadata).unwrap())
            .map_err(|e| AtomicError::from(format!("Failed to write plugin.json: {}", e)))?;
    }

    // 3. Load Plugin
    let engine = Arc::new(build_engine()?);
    let wasm_path = target_dir.join(&wasm_target_name);

    let scope = ClassExtenderScope::Drive(drive_subject.to_string());
    let scoped_cache = plugin_cache_dir.join("scoped").join(&encoded_subject);

    if !scoped_cache.exists() {
        std::fs::create_dir_all(&scoped_cache).ok();
    }

    let (plugin, _) =
        load_plugin_from_disk(&wasm_path, &target_dir, &scoped_cache, scope, engine, store).await?;

    if let Some(plugin) = plugin {
        store.add_class_extender(plugin)?;
    } else {
        return Err(AtomicError::from("Failed to load installed plugin"));
    }

    Ok(())
}

async fn load_plugin_from_disk(
    path: &Path,
    plugin_dir: &Path,
    plugin_cache_path: &Path,
    scope: ClassExtenderScope,
    engine: Arc<Engine>,
    db: &Db,
) -> AtomicResult<(Option<ClassExtender>, PathBuf)> {
    let owned_folder_path = setup_plugin_data_dir(path, plugin_dir);

    // Attempt to read plugin.json to find the subject
    let json_path = path.with_extension("json");
    let plugin_subject = if json_path.exists() {
        let content = std::fs::read_to_string(&json_path).ok();
        if let Some(content) = content {
            let meta: Result<PluginMetadata, _> = serde_json::from_str(&content);
            meta.ok().and_then(|m| m.subject)
        } else {
            None
        }
    } else {
        None
    };

    let wasm_bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) => {
            error!("Failed to read Wasm file at {}: {}", path.display(), e);
            return Ok((None, PathBuf::new())); // Or return Error? Original code returned None.
        }
    };

    let hash = digest(&SHA256, &wasm_bytes);
    let hash_hex = hex_encode(hash.as_ref());
    let cwasm_filename = format!("{}.cwasm", hash_hex);
    let cwasm_path = plugin_cache_path.join(cwasm_filename);
    let cwasm_path_ret = cwasm_path.clone();

    match WasmPlugin::load(
        engine.clone(),
        &wasm_bytes,
        path,
        &cwasm_path,
        owned_folder_path,
        db,
        scope,
        plugin_subject,
    )
    .await
    {
        Ok(plugin) => {
            info!(
                "Loaded {}",
                path.file_name().unwrap_or(OsStr::new("Unknown")).display()
            );
            Ok((Some(plugin.into_class_extender()), cwasm_path_ret))
        }
        Err(err) => {
            error!(
                error = %err,
                path = %path.display(),
                "Failed to load Wasm class extender"
            );
            Ok((None, cwasm_path_ret))
        }
    }
}

fn compile_and_save_component(
    engine: &Engine,
    wasm_bytes: &[u8],
    wasm_path: &Path,
    cwasm_path: &Path,
) -> AtomicResult<Component> {
    info!(
        "Pre-compiling {}",
        wasm_path
            .file_name()
            .unwrap_or(OsStr::new("Unknown"))
            .display()
    );

    let component_bytes = engine
        .precompile_component(wasm_bytes)
        .map_err(|e| AtomicError::from(format!("Failed to precompile component: {}", e)))?;

    if let Err(e) = std::fs::write(cwasm_path, &component_bytes) {
        warn!(
            "Failed to write cwasm file to {}: {}",
            cwasm_path.display(),
            e
        );
    } else {
        info!("Saved pre-compiled component to {}", cwasm_path.display());
    }

    unsafe { Component::deserialize(engine, &component_bytes) }
        .map_err(|e| AtomicError::from(format!("Failed to deserialize compiled component: {}", e)))
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn cleanup_cache(cache_dir: &Path, used_files: &HashSet<PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(cache_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension() == Some(OsStr::new("cwasm")) {
                if !used_files.contains(&path) {
                    if let Err(e) = std::fs::remove_file(&path) {
                        warn!(
                            "Failed to delete unused cwasm file {}: {}",
                            path.display(),
                            e
                        );
                    } else {
                        info!("Deleted unused cwasm file: {}", path.display());
                    }
                }
            }
        }
    }
}

fn decode_subject(b64_subject: &str) -> AtomicResult<String> {
    let subject = String::from_utf8(
        general_purpose::URL_SAFE
            .decode(b64_subject.as_bytes())
            .map_err(|e| AtomicError::from(format!("Failed to decode subject: {}", e)))?,
    )
    .map_err(|e| AtomicError::from(format!("Failed to decode subject: {}", e)))?;

    Ok(subject)
}
