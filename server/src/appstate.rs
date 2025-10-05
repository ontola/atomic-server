//! App state, which is accessible from handlers
use crate::{
    commit_monitor::CommitMonitor, config::Config, db_writer::DbWriter, errors::AtomicServerResult,
    search::SearchState,
};
use atomic_lib::{
    agents::Agent,
    config::{ClientConfig, SharedConfig},
    Storelike,
};

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
    /// The Actix Address of the DbWriter, which handles all database write operations sequentially
    pub db_writer: actix::Addr<DbWriter>,
    pub search_state: SearchState,
}

impl AppState {
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

        let store = atomic_lib::Db::init(&config.store_path, config.server_url.clone())?;
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
        let search_state = SearchState::new(&config)
            .map_err(|e| format!("Failed to start search service: {}", e))?;

        // Initialize commit monitor, which watches commits and sends these to the commit_monitor actor
        let commit_monitor =
            crate::commit_monitor::create_commit_monitor(store.clone(), search_state.clone());

        // Initialize db writer actor for single-threaded writes, passing commit_monitor for notifications
        let db_writer = crate::db_writer::create_db_writer(store.clone(), commit_monitor.clone());

        // Note: Commit notifications are now handled directly by the DbWriter actor
        // The DbWriter sends CommitMessage to the commit_monitor after successful commits

        // If the user changes their server_url, the drive will not exist.
        // In this situation, we should re-build a new drive from scratch.
        if should_init {
            atomic_lib::populate::populate_all(&store)?;
            // Building the index here is needed to perform Queries on imported resources
            let store_clone = store.clone();
            std::thread::spawn(move || {
                let res = store_clone.build_index(true);
                if let Err(e) = res {
                    tracing::error!("Failed to build index: {}", e);
                }
            });

            set_up_initial_invite(&store)
                .map_err(|e| format!("Error while setting up initial invite: {}", e))?;
            // This means that editing the .env does _not_ grant you the rights to edit the Drive.

            tracing::info!("Adding all resources to search index");
            search_state.add_all_resources(&store)?;
        }

        Ok(AppState {
            store,
            config,
            commit_monitor,
            db_writer,
            search_state,
        })
    }

    /// Is called when AppState goes out of scope (e.g. when the application closes)
    /// Cleanup code, writing buffers, committing changes, etc.
    fn exit(&self) -> AtomicServerResult<()> {
        // Cleanup can be added here if needed in the future
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
