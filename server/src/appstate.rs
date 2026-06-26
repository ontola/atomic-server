//! App state, which is accessible from handlers
use std::sync::Arc;

use crate::{
    commit_monitor::CommitMonitor,
    config::Config,
    errors::AtomicServerResult,
    handlers::web_sockets::IndexStatusBroadcast,
    loro_sync_broadcaster::{self, LoroSyncBroadcaster},
    plugins,
    search::SearchState,
};
use atomic_lib::{agents::Agent, commit::CommitResponse, config::SharedConfig, Storelike};

#[cfg(feature = "wasm-plugins")]
use crate::plugins::wasm;

/// The AppState contains all the relevant Context for the server.
/// This data object is available to all handlers and actors.
/// Contains the store, configuration and addresses for Actix Actors, such as for the [CommitMonitor].
/// It is generated using [init], which takes a [Config].
// This struct is cloned across all threads, so make sure the fields are thread safe.
// A good option here is to use Actors for things that can change (e.g. commit_monitor)
#[derive(Clone)]
pub struct AppState {
    /// Contains all the data
    pub store: atomic_lib::Db,
    /// App Configuration
    pub config: Config,
    /// The Actix Address of the CommitMonitor, which should receive updates when a commit is applied
    pub commit_monitor: actix::Addr<CommitMonitor>,
    pub loro_sync_broadcaster: actix::Addr<LoroSyncBroadcaster>,
    pub search_state: SearchState,
    pub vector_search_state: crate::vector_search::VectorSearchState,
    pub index_status_broadcast: Arc<IndexStatusBroadcast>,
    /// Whether this node is managed (reports to a control plane). Set at runtime
    /// by an embedder hook (see `serve_with_hook`); surfaced via the managed
    /// manifest endpoint. Always false on self-hosted nodes.
    pub managed: Arc<std::sync::atomic::AtomicBool>,
    /// User-facing portal URL for a managed node, populated at runtime by the
    /// embedder's policy poll (empty on self-hosted nodes). Read by the managed
    /// manifest endpoint so the welcome screen can route account creation to the
    /// dashboard.
    pub managed_dashboard_url: Arc<std::sync::RwLock<Option<String>>>,
}

impl AppState {
    /// Creates the AppState (the server's context available in Handlers).
    /// Initializes or opens a store on disk.
    /// Creates a new agent, if necessary.
    pub async fn init(config: Config) -> AtomicServerResult<AppState> {
        tracing::info!("Initializing AppState");

        // We warn over here because tracing needs to be initialized first.
        if config.opts.slow_mode {
            tracing::warn!("Slow mode is enabled. This will introduce random delays in the server, to simulate a slow connection.");
        }
        if config.opts.development {
            tracing::warn!("Development mode is enabled. This will use staging environments for services like LetsEncrypt.");
        }

        let mut store = atomic_lib::Db::init_redb_file(
            &config.store_path,
            Some(config.get_origin()),
            &config.uploads_path,
        )
        .await?;

        // Drop the persisted watched-query registry on startup. Every
        // entry was registered by a now-dead WS connection; live
        // subscribers re-register on reconnect. Without this, e2e
        // suites leak a unique filter per test (drives are unique)
        // and `check_if_atom_matches_watched_query_filters` walks a
        // growing pile of dead filters per commit, eventually pushing
        // rapid-save tests past their timeout. See
        // `Db::clear_watched_queries` for the full rationale.
        if let Err(e) = store.clear_watched_queries() {
            tracing::warn!("clear_watched_queries on startup failed: {e}");
        }

        // Register all built-in class extenders
        store.add_class_extender(plugins::chatroom::build_chatroom_extender())?;
        store.add_class_extender(plugins::chatroom::build_message_extender())?;
        store.add_endpoint(plugins::invite::invite_endpoint())?;
        store.add_class_extender(plugins::plugin::build_plugin_extender(
            config.plugin_path.clone(),
            config.plugin_cache_path.clone(),
            config.uploads_path.clone(),
        ))?;
        store.add_class_extender(plugins::files::build_file_extender(
            config.uploads_path.clone(),
        ))?;

        // Register all built-in endpoints
        store.add_endpoint(plugins::versioning::version_endpoint())?;
        store.add_endpoint(plugins::versioning::all_versions_endpoint())?;
        store.add_endpoint(plugins::did::did_endpoint())?;
        store.add_endpoint(plugins::setup::setup_endpoint())?;
        store.add_endpoint(plugins::bookmark::bookmark_endpoint())?;
        store.add_endpoint(plugins::files::upload_endpoint())?;
        store.add_endpoint(plugins::files::download_endpoint())?;
        store.add_endpoint(plugins::export::export_endpoint())?;
        store.add_endpoint(plugins::path::path_endpoint())?;
        store.add_endpoint(plugins::importer::import_endpoint())?;
        #[cfg(debug_assertions)]
        store.add_endpoint(plugins::prunetests::prune_tests_endpoint())?;
        store.add_endpoint(plugins::query::query_endpoint())?;
        store.add_endpoint(plugins::search::search_endpoint())?;
        #[cfg(feature = "vector-search")]
        store.add_endpoint(plugins::vector_search::vector_search_endpoint())?;

        // Get and register Wasm class extender plugins
        #[cfg(feature = "wasm-plugins")]
        {
            let extenders = wasm::load_wasm_class_extenders(
                &config.plugin_path,
                &config.plugin_cache_path,
                &store,
            )
            .await?;

            for extender in extenders {
                store.add_class_extender(extender)?;
            }
        }

        set_default_agent(&config, &store).await?;

        let should_init = !&config.store_path.exists() || config.initialize;
        // If the store is empty, populate the core models (classes, properties, etc.).
        // We don't create a Drive here anymore; that's handled in the data-browser (new identity flow).
        if should_init {
            tracing::info!("Initialize: bootstrapping core models...");
            atomic_lib::populate::bootstrap(&store)
                .await
                .map_err(|e| format!("Failed to bootstrap store. {}", e))?;
        } else if config.repopulate_defaults {
            // Re-import the built-in ontologies + default resources into an
            // already-seeded store (without an index rebuild). `import` upserts,
            // so this only adds new/changed default resources (e.g. a freshly
            // added Class) and leaves user data untouched. Triggered by
            // `ATOMIC_REPOPULATE_DEFAULTS=true`.
            tracing::info!("Repopulating built-in ontologies and default resources...");
            atomic_lib::populate::populate_default_store(&store)
                .await
                .map_err(|e| format!("Failed to repopulate defaults. {}", e))?;
        }

        // Initialize search constructs
        let search_state = SearchState::new(&config)
            .map_err(|e| format!("Failed to start search service: {}", e))?;

        if should_init {
            tracing::info!("Adding all resources to search index");
            search_state.add_all_resources(&store).await?;
        }

        let index_status_broadcast = Arc::new(IndexStatusBroadcast::new());
        let index_notifier: Arc<dyn Fn(&str, bool) + Send + Sync> = {
            let b = index_status_broadcast.clone();
            Arc::new(move |drive: &str, indexing: bool| {
                b.notify(drive, indexing);
            })
        };

        let vector_search_state =
            crate::vector_search::VectorSearchState::new(&config, Some(index_notifier))
                .await
                .map_err(|e| format!("Failed to start vector search service: {}", e))?;

        // Initialize commit monitor, which watches commits and sends these to the commit_monitor actor
        let commit_monitor = crate::commit_monitor::create_commit_monitor(
            store.clone(),
            search_state.clone(),
            vector_search_state.clone(),
        );

        let commit_monitor_clone = commit_monitor.clone();

        let loro_sync_broadcaster =
            loro_sync_broadcaster::create_loro_sync_broadcaster(store.clone());

        // This closure is called every time a Commit is created
        let send_commit = move |commit_response: &CommitResponse| {
            commit_monitor_clone.do_send(crate::actor_messages::CommitMessage {
                commit_response: commit_response.clone(),
            });
        };
        store.set_handle_commit(Box::new(send_commit));

        if should_init && vector_search_state.is_enabled() {
            tracing::info!("Adding all resources to vector search index");
            if let Err(e) = vector_search_state.add_all_resources(&store).await {
                tracing::error!("Failed to add all resources to vector search index: {}", e);
            }
        }
        Ok(AppState {
            store,
            config,
            commit_monitor,
            loro_sync_broadcaster,
            search_state,
            vector_search_state,
            index_status_broadcast,
            managed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            managed_dashboard_url: Arc::new(std::sync::RwLock::new(None)),
        })
    }

    /// Is called when AppState goes out of scope (e.g. when the application closes)
    /// Cleanup code, writing buffers, committing changes, etc.
    fn exit(&self) -> AtomicServerResult<()> {
        self.search_state.writer.write()?.commit()?;

        // `flush_pending` is async; sync teardown (`exit`) runs outside/normal teardown contexts where we cannot safely call `Handle::block_on()`
        // — nesting Tokio block-on triggers panic ("cannot block_on runtime inside runtime").
        let vs = self.vector_search_state.clone();
        match std::thread::spawn(move || -> AtomicServerResult<()> {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|e| {
                    format!(
                        "failed to build shutdown tokio runtime for vector flush: {}",
                        e
                    )
                })?;
            rt.block_on(vs.flush_pending())
        })
        .join()
        {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(e),
            Err(_panic) => Err("vector index flush thread panicked on shutdown".into()),
        }
    }
}

impl Drop for AppState {
    fn drop(&mut self) {
        if let Err(e) = self.exit() {
            tracing::error!("Error during AppState exit: {}", e);
        }
    }
}

/// Create a new agent if it does not yet exist.
async fn set_default_agent(config: &Config, store: &impl Storelike) -> AtomicServerResult<()> {
    tracing::info!("Setting default agent");

    let agent = match atomic_lib::config::read_config(Some(&config.config_file_path)) {
        Ok(agent_config) => {
            let mut agent = Agent::from_secret(&agent_config.shared.agent_secret)?;

            // Migrate old-format agent subjects (e.g. "https://atomicdata.dev/agents/...")
            // to the new "did:ad:" format. Old configs stored the agent subject as an
            // HTTP URL on atomicdata.dev, but the agent's keys are local. During invite token
            // verification the old URL would resolve to an external resource with a different
            // public key, causing "Invalid signature" errors.
            let needs_migration = agent
                .subject
                .as_str()
                .starts_with("https://atomicdata.dev/agents/")
                || agent
                    .subject
                    .as_str()
                    .starts_with("http://atomicdata.dev/agents/");
            if needs_migration {
                let private_key = agent
                    .private_key
                    .clone()
                    .ok_or("No private key found on agent to migrate")?;
                let migrated = Agent::new_from_private_key(Some("server"), &private_key)?;
                tracing::info!(
                    "Migrating agent subject from old format '{}' to new format '{}'",
                    agent.subject,
                    migrated.subject
                );
                agent = migrated;

                // Update the config file so the migration only happens once
                let cfg = atomic_lib::config::Config {
                    shared: SharedConfig {
                        agent_secret: agent.build_secret()?,
                        initial_drive: agent.initial_drive.clone().map(|s| s.to_string()),
                    },
                    client: agent_config.client,
                };
                cfg.save(&config.config_file_path)?;
                tracing::info!(
                    "Config file updated with migrated agent at {:?}",
                    config.config_file_path
                );
            }

            match store.get_resource(&agent.subject.clone()).await {
                Ok(_) => agent,
                Err(e) => {
                    if agent.subject.is_local() {
                        // If there is an agent in the config, but not in the store,
                        // That probably means that the DB has been erased and only the config file exists.
                        // This means that the Agent from the Config file should be recreated, using its private key.
                        tracing::info!("Agent not retrievable, but config was found. Recreating Agent in new store.");

                        let recreated_agent = Agent::new_from_private_key(
                            "server".into(),
                            &agent.private_key.ok_or("No private key found")?,
                        )?;
                        store.add_resource(&recreated_agent.to_resource()?).await?;

                        recreated_agent
                    } else {
                        return Err(format!(
                            "An agent is present in {:?}, but this agent cannot be retrieved. Either make sure the agent is retrievable, or remove it from your config. {}",
                            config.config_file_path, e,
                        ).into());
                    }
                }
            }
        }
        Err(_no_config) => {
            let agent = store.create_agent(Some("server")).await?;
            let cfg = atomic_lib::config::Config {
                shared: SharedConfig {
                    agent_secret: agent.build_secret()?,
                    initial_drive: agent.initial_drive.clone().map(|s| s.to_string()),
                },
                client: None,
            };

            cfg.save(&config.config_file_path)?;

            let config_string = cfg.to_string()?;
            tracing::warn!("No existing config found, created a new Config at {:?}. Copy this to your client machine (running atomic-cli or atomic-data-browser) to log in with these credentials. \n{}", &config.config_file_path, config_string);

            agent
        }
    };

    tracing::info!("Default Agent is set: {}", &agent.subject);
    store.set_default_agent(agent);
    Ok(())
}
