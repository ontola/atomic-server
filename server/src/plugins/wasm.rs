use std::future::Future;
use std::pin::Pin;

use std::{
    collections::HashSet,
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::Arc,
};

use atomic_lib::{class_extender, AtomicErrorType};
use ring::digest::{digest, SHA256};

use atomic_lib::{
    agents::ForAgent,
    class_extender::ClassExtender,
    errors::{AtomicError, AtomicResult},
    parse::{parse_json_ad_resource, ParseOpts, SaveOpts},
    storelike::{Query, ResourceResponse},
    Db, Resource, Storelike,
};
use tracing::{error, info, warn};
use wasmtime::{
    component::{Component, Linker, ResourceTable},
    Config, Engine, Store,
};
use wasmtime_wasi::{p2, WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
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
) -> Vec<ClassExtender> {
    // Create the plugin directory if it doesn't exist
    let plugin_dir = plugin_path.join(CLASS_EXTENDER_DIR_NAME);

    if !plugin_dir.exists() {
        if let Err(err) = std::fs::create_dir_all(&plugin_dir) {
            warn!(
                error = %err,
                path = %plugin_dir.display(),
                "Failed to create Wasm extender directory"
            );
        } else {
            info!(
                path = %plugin_dir.display(),
                "Created empty Wasm extender directory (drop .wasm files here to enable runtime plugins)"
            );
        }
        return Vec::new();
    }

    if !plugin_cache_path.exists() {
        if let Err(err) = std::fs::create_dir_all(&plugin_cache_path) {
            warn!(
                error = %err,
                path = %plugin_cache_path.display(),
                "Failed to create Wasm cache directory"
            );
        }
    }

    let engine = match build_engine() {
        Ok(engine) => Arc::new(engine),
        Err(err) => {
            error!(error = %err, "Failed to initialize Wasm engine. Skipping dynamic class extenders");
            return Vec::new();
        }
    };

    let mut extenders = Vec::new();
    let mut used_cwasm_files = HashSet::new();

    info!("Loading plugins...");

    let wasm_files = find_wasm_files(&plugin_dir);

    for path in wasm_files {
        let wasm_bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) => {
                error!("Failed to read Wasm file at {}: {}", path.display(), e);
                continue;
            }
        };

        let hash = digest(&SHA256, &wasm_bytes);
        let hash_hex = hex_encode(hash.as_ref());
        let cwasm_filename = format!("{}.cwasm", hash_hex);
        let cwasm_path = plugin_cache_path.join(cwasm_filename);

        used_cwasm_files.insert(cwasm_path.clone());

        match WasmPlugin::load(engine.clone(), &wasm_bytes, &path, &cwasm_path, db).await {
            Ok(plugin) => {
                info!(
                    "Loaded {}",
                    path.file_name().unwrap_or(OsStr::new("Unknown")).display()
                );
                extenders.push(plugin.into_class_extender());
            }
            Err(err) => {
                error!(
                    error = %err,
                    path = %path.display(),
                    "Failed to load Wasm class extender"
                );
            }
        }
    }

    cleanup_cache(&plugin_cache_path, &used_cwasm_files);

    extenders
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
    class_url: String,
    db: Arc<Db>,
}

impl WasmPlugin {
    async fn load(
        engine: Arc<Engine>,
        wasm_bytes: &[u8],
        path: &Path,
        cwasm_path: &Path,
        db: &Db,
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
                class_url: String::new(),
                db: Arc::clone(&db),
            }),
        };

        let class_url = runtime.call_class_url().await?;
        Ok(WasmPlugin {
            inner: Arc::new(WasmPluginInner {
                engine,
                component: runtime.inner.component.clone(),
                path: runtime.inner.path.clone(),
                class_url,
                db,
            }),
        })
    }

    fn into_class_extender(self) -> ClassExtender {
        let get_plugin = self.clone();
        let before_plugin = self.clone();
        let after_plugin = self.clone();

        ClassExtender {
            class: self.inner.class_url.clone(),
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
        }
    }

    async fn call_class_url(&self) -> AtomicResult<String> {
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
            PluginHostState::new(Arc::clone(&self.inner.db))?,
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
            snapshot: Some(self.encode_resource(context.resource)?),
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
}

impl PluginHostState {
    fn new(db: Arc<Db>) -> AtomicResult<Self> {
        let mut builder = WasiCtxBuilder::new();
        builder
            .inherit_stdout()
            .inherit_stderr()
            .inherit_stdin()
            .inherit_network();
        let ctx = builder.build();
        Ok(Self {
            table: ResourceTable::new(),
            ctx,
            http: WasiHttpCtx::new(),
            db,
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
}

fn find_wasm_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Ok(sub_entries) = std::fs::read_dir(&path) {
                    for sub_entry in sub_entries.flatten() {
                        let sub_path = sub_entry.path();
                        if sub_path.extension() == Some(OsStr::new("wasm")) {
                            files.push(sub_path);
                        }
                    }
                }
            } else if path.extension() == Some(OsStr::new("wasm")) {
                files.push(path);
            }
        }
    }
    files
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
