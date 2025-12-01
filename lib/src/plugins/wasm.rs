use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::Arc,
};

use tracing::{error, info, warn};
use wasmtime::{
    component::{Component, Linker, ResourceTable},
    Config, Engine, Store,
};
use wasmtime_wasi::{p2, WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

use crate::{
    agents::ForAgent,
    class_extender::ClassExtender,
    errors::{AtomicError, AtomicResult},
    parse::{parse_json_ad_resource, ParseOpts, SaveOpts},
    storelike::ResourceResponse,
    Resource,
};

mod bindings {
    wasmtime::component::bindgen!({
        path: "wit/class-extender.wit",
        world: "class-extender",
    });
}

use bindings::atomic::class_extender::types::{
    CommitContext as WasmCommitContext, GetContext as WasmGetContext,
    ResourceJson as WasmResourceJson, ResourceResponse as WasmResourceResponse,
};

const WASM_EXTENDER_DIR: &str = "../plugins/class-extenders";

pub fn load_wasm_class_extenders(store_path: &Path) -> Vec<ClassExtender> {
    let plugins_dir = store_path.join(WASM_EXTENDER_DIR);
    // Create the plugin directory if it doesn't exist
    if !plugins_dir.exists() {
        if let Err(err) = std::fs::create_dir_all(&plugins_dir) {
            warn!(
                error = %err,
                path = %plugins_dir.display(),
                "Failed to create Wasm extender directory"
            );
        } else {
            info!(
                path = %plugins_dir.display(),
                "Created empty Wasm extender directory (drop .wasm files here to enable runtime plugins)"
            );
        }
        return Vec::new();
    }

    let engine = match build_engine() {
        Ok(engine) => Arc::new(engine),
        Err(err) => {
            error!(error = %err, "Failed to initialize Wasm engine. Skipping dynamic class extenders");
            return Vec::new();
        }
    };

    let entries = match std::fs::read_dir(&plugins_dir) {
        Ok(entries) => entries,
        Err(err) => {
            error!(
                error = %err,
                path = %plugins_dir.display(),
                "Failed to read Wasm extender directory"
            );
            return Vec::new();
        }
    };

    let mut extenders = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension() != Some(OsStr::new("wasm")) {
            continue;
        }

        match WasmPlugin::load(engine.clone(), &path) {
            Ok(plugin) => {
                info!(
                    path = %path.display(),
                    class = %plugin.class_url(),
                    "Loaded Wasm class extender"
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

    extenders
}

fn build_engine() -> AtomicResult<Engine> {
    let mut config = Config::new();
    config.wasm_component_model(true);
    Engine::new(&config).map_err(AtomicError::from)
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
}

impl WasmPlugin {
    fn load(engine: Arc<Engine>, path: &Path) -> AtomicResult<Self> {
        let component = Component::from_file(&engine, path).map_err(AtomicError::from)?;
        let runtime = WasmPlugin {
            inner: Arc::new(WasmPluginInner {
                engine: engine.clone(),
                component,
                path: path.to_path_buf(),
                class_url: String::new(),
            }),
        };

        let class_url = runtime.call_class_url()?;
        Ok(WasmPlugin {
            inner: Arc::new(WasmPluginInner {
                engine,
                component: runtime.inner.component.clone(),
                path: runtime.inner.path.clone(),
                class_url,
            }),
        })
    }

    fn class_url(&self) -> &str {
        &self.inner.class_url
    }

    fn into_class_extender(self) -> ClassExtender {
        let get_plugin = self.clone();
        let before_plugin = self.clone();
        let after_plugin = self.clone();

        ClassExtender {
            class: self.inner.class_url.clone(),
            on_resource_get: Some(ClassExtender::wrap_get_handler(move |context| {
                get_plugin.call_on_resource_get(context)
            })),
            before_commit: Some(ClassExtender::wrap_commit_handler(move |context| {
                before_plugin.call_before_commit(context)
            })),
            after_commit: Some(ClassExtender::wrap_commit_handler(move |context| {
                after_plugin.call_after_commit(context)
            })),
        }
    }

    fn call_class_url(&self) -> AtomicResult<String> {
        let (instance, mut store) = self.instantiate()?;
        instance
            .call_class_url(&mut store)
            .map_err(AtomicError::from)
    }

    fn call_on_resource_get(
        &self,
        context: crate::class_extender::GetExtenderContext,
    ) -> AtomicResult<ResourceResponse> {
        let payload = self.build_get_context(&context)?;
        let (instance, mut store) = self.instantiate()?;
        let response = instance
            .call_on_resource_get(&mut store, &payload)
            .map_err(AtomicError::from)?
            .map_err(AtomicError::other_error)?;

        if let Some(payload) = response {
            self.inflate_resource_response(payload, context.store)
        } else {
            Ok(ResourceResponse::Resource(context.db_resource.clone()))
        }
    }

    fn call_before_commit(
        &self,
        context: crate::class_extender::CommitExtenderContext,
    ) -> AtomicResult<()> {
        let payload = self.build_commit_context(&context)?;
        let (instance, mut store) = self.instantiate()?;
        instance
            .call_before_commit(&mut store, &payload)
            .map_err(AtomicError::from)?
            .map_err(AtomicError::other_error)
    }

    fn call_after_commit(
        &self,
        context: crate::class_extender::CommitExtenderContext,
    ) -> AtomicResult<()> {
        let payload = self.build_commit_context(&context)?;
        let (instance, mut store) = self.instantiate()?;
        instance
            .call_after_commit(&mut store, &payload)
            .map_err(AtomicError::from)?
            .map_err(AtomicError::other_error)
    }

    fn instantiate(&self) -> AtomicResult<(bindings::ClassExtender, Store<PluginHostState>)> {
        let mut store = Store::new(&self.inner.engine, PluginHostState::new()?);
        let mut linker = Linker::new(&self.inner.engine);
        p2::add_to_linker_sync(&mut linker).map_err(|err| AtomicError::from(err.to_string()))?;
        let instance =
            bindings::ClassExtender::instantiate(&mut store, &self.inner.component, &linker)
                .map_err(AtomicError::from)?;
        Ok((instance, store))
    }

    fn build_get_context(
        &self,
        context: &crate::class_extender::GetExtenderContext,
    ) -> AtomicResult<WasmGetContext> {
        Ok(WasmGetContext {
            request_url: context.url.as_str().to_string(),
            requested_subject: context.db_resource.get_subject().to_string(),
            agent_subject: context.for_agent.to_string(),
            snapshot: self.encode_resource(context.db_resource)?,
        })
    }

    fn build_commit_context(
        &self,
        context: &crate::class_extender::CommitExtenderContext,
    ) -> AtomicResult<WasmCommitContext> {
        Ok(WasmCommitContext {
            subject: context.resource.get_subject().to_string(),
            commit_json: context
                .commit
                .serialize_deterministically_json_ad(context.store)?,
            snapshot: Some(self.encode_resource(context.resource)?),
        })
    }

    fn encode_resource(&self, resource: &Resource) -> AtomicResult<WasmResourceJson> {
        Ok(WasmResourceJson {
            subject: resource.get_subject().to_string(),
            json_ad: resource.to_json_ad()?,
        })
    }

    fn inflate_resource_response(
        &self,
        payload: WasmResourceResponse,
        store: &crate::Db,
    ) -> AtomicResult<ResourceResponse> {
        let mut parse_opts = ParseOpts::default();
        parse_opts.save = SaveOpts::DontSave;
        parse_opts.for_agent = ForAgent::Sudo;

        let mut base = parse_json_ad_resource(&payload.primary.json_ad, store, &parse_opts)?;
        base.set_subject(payload.primary.subject);

        let mut referenced = Vec::new();
        for item in payload.referenced {
            let mut resource = parse_json_ad_resource(&item.json_ad, store, &parse_opts)?;
            resource.set_subject(item.subject);
            referenced.push(resource);
        }

        if referenced.is_empty() {
            Ok(ResourceResponse::Resource(base))
        } else {
            Ok(ResourceResponse::ResourceWithReferenced(base, referenced))
        }
    }
}

struct PluginHostState {
    table: ResourceTable,
    ctx: WasiCtx,
}

impl PluginHostState {
    fn new() -> AtomicResult<Self> {
        let mut builder = WasiCtxBuilder::new();
        builder.inherit_stdout().inherit_stderr().inherit_stdin();
        let ctx = builder.build();
        Ok(Self {
            table: ResourceTable::new(),
            ctx,
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
