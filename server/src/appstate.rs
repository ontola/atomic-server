//! App state, which is accessible from handlers
use crate::{
    commit_monitor::CommitMonitor,
    config::Config,
    errors::AtomicServerResult,
    plugins,
    search::SearchState,
    y_sync_broadcaster::{self, YSyncBroadcaster},
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
    pub y_sync_broadcaster: actix::Addr<YSyncBroadcaster>,
    pub search_state: SearchState,
    pub dht: Option<crate::dht::DhtService>,
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

        let mut store = atomic_lib::Db::init(&config.store_path, Some(config.get_origin())).await?;

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

        let no_root_drive = store.get_resource(&"internal:/".into()).await.is_err();
        if no_root_drive {
            tracing::warn!("Root drive not found. Initializing a new database...");
        }
        let should_init = !&config.store_path.exists() || config.initialize || no_root_drive;
        if should_init {
            tracing::info!("Initialize: creating and populating new Database...");
            atomic_lib::populate::populate_default_store(&store)
                .await
                .map_err(|e| format!("Failed to populate default store. {}", e))?;
        }

        set_default_agent(&config, &store).await?;

        // Initialize search constructs
        let search_state = SearchState::new(&config)
            .map_err(|e| format!("Failed to start search service: {}", e))?;

        let dht = if config.opts.mainline_dht {
            tracing::info!("Starting Mainline DHT service");
            let dht_service = crate::dht::DhtService::new()?;
            Some(dht_service)
        } else {
            None
        };

        // Initialize commit monitor, which watches commits and sends these to the commit_monitor actor
        let commit_monitor =
            crate::commit_monitor::create_commit_monitor(store.clone(), search_state.clone());

        let commit_monitor_clone = commit_monitor.clone();

        let y_sync_broadcaster = y_sync_broadcaster::create_y_sync_broadcaster(store.clone());

        // This closure is called every time a Commit is created
        let send_commit = move |commit_response: &CommitResponse| {
            commit_monitor_clone.do_send(crate::actor_messages::CommitMessage {
                commit_response: commit_response.clone(),
            });
        };
        store.set_handle_commit(Box::new(send_commit));

        // If the user changes their server_url, the drive will not exist.
        // In this situation, we should re-build a new drive from scratch.
        if should_init {
            atomic_lib::populate::populate_all(&store).await?;
            // Building the index here is needed to perform Queries on imported resources
            let store_clone = store.clone();
            std::thread::spawn(move || {
                let res = store_clone.build_index(true);
                if let Err(e) = res {
                    tracing::error!("Failed to build index: {}", e);
                }
            });

            let invite_url = get_initial_invite_token(&store, &config.get_origin())
                .await
                .map_err(|e| format!("Error while setting up initial invite: {}", e))?;
            // This means that editing the .env does _not_ grant you the rights to edit the Drive.

            tracing::info!("Initial invite URL: \n\n {} \n\n", invite_url);
            tracing::info!("Adding all resources to search index");
            search_state.add_all_resources(&store).await?;
        }

        Ok(AppState {
            store,
            config,
            commit_monitor,
            y_sync_broadcaster,
            search_state,
            dht,
        })
    }

    /// Is called when AppState goes out of scope (e.g. when the application closes)
    /// Cleanup code, writing buffers, committing changes, etc.
    fn exit(&self) -> AtomicServerResult<()> {
        self.search_state.writer.write()?.commit()?;
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
                    },
                    client: agent_config.client,
                };
                cfg.save(&config.config_file_path)?;
                tracing::info!(
                    "Config file updated with migrated agent at {:?}",
                    config.config_file_path
                );
            }

            match store.get_resource(&agent.subject.clone().into()).await {
                Ok(_) => agent,
                Err(e) => {
                    let is_local = if let Some(base) = &config.base_domain {
                        agent.subject.as_str().contains(base)
                    } else {
                        agent.subject.as_str().starts_with("internal:")
                            || agent.subject.as_str().starts_with("did:")
                    };

                    if is_local {
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

/// Creates the first Invitation that is opened by the user on the Home page.
async fn get_initial_invite_token(
    store: &impl Storelike,
    base_url: &str,
) -> AtomicServerResult<String> {
    let agent = store
        .get_default_agent()
        .map_err(|e| format!("Could not get default agent: {}", e))?;
    let expiry = atomic_lib::utils::now() + 60 * 60 * 24 * 2; // 2 days
    let token = crate::invite_token::InviteToken::new(base_url.to_string(), true, expiry, &agent)
        .map_err(|e| format!("Could not create invite token: {}", e))?;

    let token_base64 = token
        .encode()
        .map_err(|e| format!("Could not encode invite token: {}", e))?;
    let token_encoded: String =
        url::form_urlencoded::byte_serialize(token_base64.as_bytes()).collect();
    let url = format!("{}/invites?token={}", base_url, token_encoded);

    Ok(url)
}
