//! App state, which is accessible from handlers
use crate::{
    commit_monitor::CommitMonitor, config::Config, errors::AtomicServerResult, search::SearchState,
};
use atomic_lib::{
    agents::Agent,
    config::{ClientConfig, SharedConfig},
    errors::{AtomicError, AtomicResult},
    Storelike,
};

#[cfg(feature = "turso")]
use atomic_lib::TursoStore;

/// Enum to support different store backends
#[derive(Clone)]
pub enum StoreWrapper {
    /// Default SQLite/Sled database
    Db(atomic_lib::Db),
    /// Turso (libSQL) database backend
    #[cfg(feature = "turso")]
    Turso(TursoStore),
}

impl StoreWrapper {
    /// Build index for search functionality (Db-specific)
    pub fn build_index(&self, include_external: bool) -> AtomicResult<()> {
        match self {
            StoreWrapper::Db(db) => db.build_index(include_external),
            #[cfg(feature = "turso")]
            StoreWrapper::Turso(_) => {
                // Turso uses built-in FTS, no separate indexing needed
                Ok(())
            }
        }
    }

    /// Clear search index (Db-specific)
    pub fn clear_index(&self) -> AtomicResult<()> {
        match self {
            StoreWrapper::Db(db) => db.clear_index(),
            #[cfg(feature = "turso")]
            StoreWrapper::Turso(_) => {
                // Turso uses built-in FTS, no separate indexing needed
                Ok(())
            }
        }
    }

}

// Implement Storelike for StoreWrapper by delegating to the underlying store
impl Storelike for StoreWrapper {
    fn add_atoms(&self, _atoms: Vec<atomic_lib::Atom>) -> AtomicResult<()> {
        Err(AtomicError::not_found(
            "add_atoms is deprecated. Use add_resource_opts instead.".to_string()
        ))
    }

    fn add_resource_opts(
        &self,
        resource: &atomic_lib::Resource,
        check_required_props: bool,
        update_index: bool,
        overwrite_existing: bool,
    ) -> AtomicResult<()> {
        match self {
            StoreWrapper::Db(db) => db.add_resource_opts(resource, check_required_props, update_index, overwrite_existing),
            #[cfg(feature = "turso")]
            StoreWrapper::Turso(turso) => turso.add_resource_opts(resource, check_required_props, update_index, overwrite_existing),
        }
    }

    fn all_resources(&self, include_external: bool) -> Box<dyn Iterator<Item = atomic_lib::Resource>> {
        match self {
            StoreWrapper::Db(db) => db.all_resources(include_external),
            #[cfg(feature = "turso")]
            StoreWrapper::Turso(turso) => turso.all_resources(include_external),
        }
    }

    fn get_resource(&self, subject: &str) -> AtomicResult<atomic_lib::Resource> {
        match self {
            StoreWrapper::Db(db) => db.get_resource(subject),
            #[cfg(feature = "turso")]
            StoreWrapper::Turso(turso) => turso.get_resource(subject),
        }
    }

    fn remove_resource(&self, subject: &str) -> AtomicResult<()> {
        match self {
            StoreWrapper::Db(db) => db.remove_resource(subject),
            #[cfg(feature = "turso")]
            StoreWrapper::Turso(turso) => turso.remove_resource(subject),
        }
    }

    fn query(&self, q: &atomic_lib::storelike::Query) -> AtomicResult<atomic_lib::storelike::QueryResult> {
        match self {
            StoreWrapper::Db(db) => db.query(q),
            #[cfg(feature = "turso")]
            StoreWrapper::Turso(turso) => turso.query(q),
        }
    }

    fn get_server_url(&self) -> AtomicResult<String> {
        match self {
            StoreWrapper::Db(db) => db.get_server_url(),
            #[cfg(feature = "turso")]
            StoreWrapper::Turso(turso) => turso.get_server_url(),
        }
    }

    fn get_self_url(&self) -> Option<String> {
        match self {
            StoreWrapper::Db(db) => db.get_self_url(),
            #[cfg(feature = "turso")]
            StoreWrapper::Turso(turso) => turso.get_self_url(),
        }
    }

    fn get_default_agent(&self) -> AtomicResult<Agent> {
        match self {
            StoreWrapper::Db(db) => db.get_default_agent(),
            #[cfg(feature = "turso")]
            StoreWrapper::Turso(turso) => turso.get_default_agent(),
        }
    }

    fn set_default_agent(&self, agent: Agent) {
        match self {
            StoreWrapper::Db(db) => db.set_default_agent(agent),
            #[cfg(feature = "turso")]
            StoreWrapper::Turso(turso) => turso.set_default_agent(agent),
        }
    }
}

/// The AppState contains all the relevant Context for the server.
/// This data object is available to all handlers and actors.
/// Contains the store, configuration and addresses for Actix Actors, such as for the [CommitMonitor].
/// It is generated using [init], which takes a [Config].
// This struct is cloned across all threads, so make sure the fields are thread safe.
// A good option here is to use Actors for things that can change (e.g. commit_monitor)
#[derive(Clone)]
pub struct AppState {
    /// Contains all the data
    pub store: StoreWrapper,
    /// App Configuration
    pub config: Config,
    /// The Actix Address of the CommitMonitor, which should receive updates when a commit is applied
    pub commit_monitor: actix::Addr<CommitMonitor>,
    pub search_state: SearchState,
}

/// Minimal AppState for CLI operations that don't need search or commit monitoring
impl AppState {
    /// Creates a new AppState with the given components (primarily for testing)
    #[allow(dead_code)]
    pub async fn new(config: Config, store: StoreWrapper, search_state: SearchState) -> AtomicServerResult<AppState> {
        let commit_monitor = crate::commit_monitor::create_commit_monitor(store.clone(), search_state.clone());
        
        Ok(AppState {
            store,
            config,
            commit_monitor,
            search_state,
        })
    }

    /// Creates the AppState (the server's context available in Handlers).
    /// Initializes or opens a store on disk.
    /// Creates a new agent, if necessary.
    pub fn init(config: Config) -> AtomicServerResult<AppState> {
        tracing::info!("Initializing AppState");

        // We warn over here because tracing needs to be initialized first.
        if config.opts.slow_mode {
            tracing::warn!("Slow mode is enabled. This will introduce random delays in the server, to simulate a slow connection.");
        }
        if config.opts.development {
            tracing::warn!("Development mode is enabled. This will use staging environments for services like LetsEncrypt.");
        }

        // Initialize the appropriate store backend
        let store = Self::init_store(&config)?;
        let no_server_resource = store.get_resource(&config.server_url).is_err();
        if no_server_resource {
            tracing::warn!("Server URL resource not found. This is likely because the server URL has changed. Initializing a new database...");
        }
        let should_init = !&config.store_path.exists() || config.initialize || no_server_resource;
        if should_init {
            tracing::info!("Initialize: creating and populating new Database...");
            atomic_lib::populate::populate_default_store(&store)
                .map_err(|e| format!("Failed to populate default store. {}", e))?;
        }

        set_default_agent(&config, &store)?;

        // Initialize search constructs
        let search_state = match &store {
            StoreWrapper::Db(_db) => {
                // Use the existing SearchState::new for Db backend
                let temp_config = config.clone();
                SearchState::new(&temp_config)
                    .map_err(|e| format!("Failed to start search service: {}", e))?
            }
            #[cfg(feature = "turso")]
            StoreWrapper::Turso(_) => {
                // For Turso, create a minimal search state since Turso has built-in FTS
                SearchState::new(&config)
                    .map_err(|e| format!("Failed to start search service: {}", e))?
            }
        };

        // Initialize commit monitor, which watches commits and sends these to the commit_monitor actor
        let commit_monitor =
            crate::commit_monitor::create_commit_monitor(store.clone(), search_state.clone());

        // Note: set_handle_commit is only available on Db backend, not on StoreWrapper
        // We need to do this differently since we can't get mutable access through the wrapper
        // For now, we'll skip this for Turso and implement hooks differently later

        // If the user changes their server_url, the drive will not exist.
        // In this situation, we should re-build a new drive from scratch.
        if should_init {
            // populate_all currently requires Db specifically
            match &store {
                StoreWrapper::Db(db) => {
                    atomic_lib::populate::populate_all(db)?;
                }
                #[cfg(feature = "turso")]
                StoreWrapper::Turso(_) => {
                    // For Turso, we can use the generic populate methods
                    store.populate()?;
                }
            }
            // Building the index here is needed to perform Queries on imported resources
            // Note: Only Db backend supports build_index, so we need to handle this differently for Turso
            match &store {
                StoreWrapper::Db(db) => {
                    let store_clone = db.clone();
                    std::thread::spawn(move || {
                        let res = store_clone.build_index(true);
                        if let Err(e) = res {
                            tracing::error!("Failed to build index: {}", e);
                        }
                    });
                }
                #[cfg(feature = "turso")]
                StoreWrapper::Turso(_) => {
                    // Turso uses SQLite FTS which doesn't require separate indexing
                    tracing::info!("Turso backend uses built-in FTS, skipping separate index building");
                }
            }

            set_up_initial_invite(&store)
                .map_err(|e| format!("Error while setting up initial invite: {}", e))?;
            // This means that editing the .env does _not_ grant you the rights to edit the Drive.

            tracing::info!("Adding all resources to search index");
            // add_all_resources currently requires Db specifically
            match &store {
                StoreWrapper::Db(db) => {
                    search_state.add_all_resources(db)?;
                }
                #[cfg(feature = "turso")]
                StoreWrapper::Turso(_) => {
                    // For Turso, search indexing is handled by built-in FTS
                    tracing::info!("Turso uses built-in FTS, skipping separate search indexing");
                }
            }
        }

        Ok(AppState {
            store,
            config,
            commit_monitor,
            search_state,
        })
    }

    /// Initialize the appropriate store backend based on configuration
    fn init_store(config: &Config) -> AtomicServerResult<StoreWrapper> {
        #[cfg(feature = "turso")]
        if let Some(turso_config) = &config.turso_config {
            tracing::info!("Initializing Turso store backend");
            
            // Use tokio runtime to handle async initialization
            let runtime = tokio::runtime::Handle::current();
            let store = runtime.block_on(async {
                if turso_config.embedded_replica_path.is_some() {
                    TursoStore::new_embedded_replica(turso_config.clone()).await
                } else {
                    TursoStore::new_remote(turso_config.clone()).await
                }
            })?;

            store.set_server_url(&config.server_url);
            return Ok(StoreWrapper::Turso(store));
        }

        // Default to regular Db backend
        tracing::info!("Initializing default Db store backend");
        let db = atomic_lib::Db::init(&config.store_path, config.server_url.clone())?;
        Ok(StoreWrapper::Db(db))
    }

    /// Is called when AppState goes out of scope (e.g. when the application closes)
    /// Cleanup code, writing buffers, committing changes, etc.
    fn exit(&self) -> AtomicServerResult<()> {
        // SQLite handles commits automatically, no explicit cleanup needed for search
        // Any SQLite connections will be closed when the database goes out of scope
        Ok(())
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
fn set_default_agent(config: &Config, store: &impl Storelike) -> AtomicServerResult<()> {
    tracing::info!("Setting default agent");

    let agent = match atomic_lib::config::read_config(Some(&config.config_file_path)) {
        Ok(agent_config) => {
            let agent = Agent::from_secret(&agent_config.shared.agent_secret)?;
            match store.get_resource(&agent.subject) {
                Ok(_) => agent,
                Err(e) => {
                    if agent.subject.contains(&config.server_url) {
                        // If there is an agent in the config, but not in the store,
                        // That probably means that the DB has been erased and only the config file exists.
                        // This means that the Agent from the Config file should be recreated, using its private key.
                        tracing::info!("Agent not retrievable, but config was found. Recreating Agent in new store.");

                        let recreated_agent = Agent::new_from_private_key(
                            "server".into(),
                            store,
                            &agent.private_key.ok_or("No private key found")?,
                        )?;
                        store.add_resource(&recreated_agent.to_resource()?)?;

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
            let agent = store.create_agent(Some("server"))?;
            let cfg = atomic_lib::config::Config {
                shared: SharedConfig {
                    agent_secret: agent.build_secret()?,
                },
                client: Some(ClientConfig {
                    server_url: config.server_url.clone(),
                }),
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

/// Creates the first Invitation that is opened by the user on the Home page.
fn set_up_initial_invite(store: &impl Storelike) -> AtomicServerResult<()> {
    let subject = format!("{}/setup", store.get_server_url()?);
    tracing::info!("Creating initial Invite at {}", subject);
    let mut invite = store.get_resource_new(&subject);
    invite.set_class(atomic_lib::urls::INVITE);
    invite.set_subject(subject);
    // This invite can be used only once
    invite.set(
        atomic_lib::urls::USAGES_LEFT.into(),
        atomic_lib::Value::Integer(1),
        store,
    )?;
    invite.set(
        atomic_lib::urls::WRITE_BOOL.into(),
        atomic_lib::Value::Boolean(true),
        store,
    )?;
    invite.set(
        atomic_lib::urls::TARGET.into(),
        atomic_lib::Value::AtomicUrl(store.get_server_url()?),
        store,
    )?;
    invite.set(
        atomic_lib::urls::PARENT.into(),
        atomic_lib::Value::AtomicUrl(store.get_server_url()?),
        store,
    )?;
    invite.set(
        atomic_lib::urls::NAME.into(),
        atomic_lib::Value::String("Setup".into()),
        store,
    )?;
    invite.set_string(
        atomic_lib::urls::DESCRIPTION.into(),
        "Use this Invite to create an Agent, or use an existing one. Accepting will grant your Agent the necessary rights to edit the data in your Atomic Server. This can only be used once. If you, for whatever reason, need a new `/setup` invite, you can pass the `--initialize` flag to `atomic-server`.",
        store,
    )?;
    invite.save_locally(store)?;
    Ok(())
}
