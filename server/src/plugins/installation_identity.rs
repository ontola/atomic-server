//! What an Installation tells the integration proxy about itself
//! (ontola/atomic-plugins#54, phase 2; #1700 answers 1–3).
//!
//! - **The app id** (`integrationAppAgent`): a keyless `atomic:agent:<pubkey>`
//!   the installing page minted and recorded in a commit signed by the user.
//!   Delegations and frame capabilities name it; nobody signs as it. It cannot
//!   change once set, because the proxy's delegations and runtimes point at it.
//! - **The node's agent** (`InstallationRuntime`): each node that activates an
//!   Installation mints its own agent for it (`ensure_js_identity`) and
//!   publishes that agent's id on a child of the Installation, signed by that
//!   agent, which may write it. The page reads it and registers it with the
//!   proxy as a runtime of the app (`POST /runtimes {app, agent, label}`).
//! - **The delegated connections** (`integrationConnections`):
//!   `{platform: connection_id}`, written by the page when it delegates. The
//!   host hands it to the plugin as `ctx.connections`, next to `ctx.config`.
//!
//! These answers are provisional, so everything that reads or writes them is
//! here rather than spread over the install hook and the runtime.

use atomic_lib::{
    agents::ForAgent,
    db::app_agent::{AppAgentKey, AppAgentState},
    errors::AtomicResult,
    storelike::Query,
    urls, AtomicError, Db, Resource, Storelike, Value,
};

fn string_of(value: &Value) -> Option<String> {
    match value {
        Value::AtomicUrl(s) => Some(s.to_string()),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// The installation's recorded app id, if it has one.
pub fn app_agent_of(resource: &Resource) -> Option<String> {
    resource
        .get(urls::INTEGRATION_APP_AGENT)
        .ok()
        .and_then(string_of)
}

/// An app id is an agent identifier whose body is a valid Ed25519 public key,
/// and nothing else: no URL, no drive hint, no path.
pub fn validate_app_agent(raw: &str) -> AtomicResult<()> {
    let key = atomic_lib::identifiers::agent_public_key(raw).ok_or_else(|| {
        AtomicError::from(format!(
            "integrationAppAgent must be an `atomic:agent:<public key>`, not '{raw}'"
        ))
    })?;
    atomic_lib::agents::verify_public_key(key)
        .map_err(|e| AtomicError::from(format!("integrationAppAgent: {e}")))
}

/// The delegated connections, `{platform: connection_id}`. `Ok(None)` when
/// the Installation has none; an error when it has something else.
pub fn connections_of(
    resource: &Resource,
) -> AtomicResult<Option<serde_json::Map<String, serde_json::Value>>> {
    let parsed = match resource.get(urls::INTEGRATION_CONNECTIONS) {
        Err(_) => return Ok(None),
        Ok(Value::Json(v)) => v.clone(),
        // A client that pinned no datatype writes the JSON as a string.
        Ok(Value::String(s)) => serde_json::from_str(s)
            .map_err(|e| format!("integrationConnections is not JSON: {e}"))?,
        Ok(other) => serde_json::from_str(&other.to_string())
            .map_err(|e| format!("integrationConnections is not JSON: {e}"))?,
    };
    let serde_json::Value::Object(map) = parsed else {
        return Err(
            "integrationConnections must be a JSON object of {platform: connection_id}".into(),
        );
    };
    for (platform, id) in &map {
        let valid_id = id.as_str().is_some_and(|id| !id.trim().is_empty());
        if platform.trim().is_empty() || !valid_id {
            return Err(format!(
                "integrationConnections maps each platform to a connection id string; '{platform}' does not"
            )
            .into());
        }
    }
    Ok(Some(map))
}

/// The connection delegated to `installation` for `platform`, if any. Refuses
/// an id that could not be one path segment of a proxy URL, since it is put
/// into one verbatim.
pub async fn delegated_connection(
    db: &Db,
    installation: &str,
    platform: &str,
) -> Result<Option<String>, String> {
    let resource = db
        .get_resource(&installation.into())
        .await
        .map_err(|e| e.to_string())?;
    let Some(connections) = connections_of(&resource).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let Some(id) = connections.get(platform).and_then(|id| id.as_str()) else {
        return Ok(None);
    };
    if !id
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(format!(
            "the connection delegated for {platform} is not a connection id"
        ));
    }
    Ok(Some(id.to_string()))
}

/// What an Installation commit may not do to these properties. Called from
/// the Installation's before-commit hook, before the store has the new state.
pub async fn check_commit(
    store: &Db,
    resource: &Resource,
    is_new: bool,
    changed_props: &std::collections::HashSet<String>,
) -> AtomicResult<()> {
    if changed_props.contains(urls::INTEGRATION_APP_AGENT) {
        let new = app_agent_of(resource);
        if let Some(new) = &new {
            validate_app_agent(new)?;
        }
        if !is_new {
            let old = store
                .get_resource(resource.get_subject())
                .await
                .ok()
                .as_ref()
                .and_then(app_agent_of);
            if old.is_some() && old != new {
                return Err(AtomicError::from(
                    "an Installation's integrationAppAgent cannot change once set: the proxy's delegations and runtimes name it",
                ));
            }
        }
    }
    if changed_props.contains(urls::INTEGRATION_CONNECTIONS) {
        connections_of(resource)?;
    }
    Ok(())
}

/// What the host adds to a run's input next to `config`: `app`, the
/// installation's app id (or `null`), and `connections`, its delegated
/// connections (`{}` when none). Empty for a run that has no Installation.
pub async fn run_context(
    db: &Db,
    drive: &str,
    plugin: &str,
) -> serde_json::Map<String, serde_json::Value> {
    let mut context = serde_json::Map::new();
    let Ok(installation) = super::installation::resolve(db, drive, plugin).await else {
        return context;
    };
    let Some(key) = installation.signing_as else {
        return context;
    };
    let Ok(resource) = db.get_resource(&key.app.as_str().into()).await else {
        return context;
    };
    if !resource.has_class(urls::INSTALLATION) {
        return context;
    }
    context.insert(
        "app".into(),
        app_agent_of(&resource).map_or(serde_json::Value::Null, serde_json::Value::String),
    );
    let connections = connections_of(&resource).unwrap_or_else(|e| {
        tracing::warn!("installation {} has unreadable connections: {e}", key.app);
        None
    });
    context.insert(
        "connections".into(),
        serde_json::Value::Object(connections.unwrap_or_default()),
    );
    context
}

/// The `InstallationRuntime` on which `agent` is published under
/// `installation`, if there is one.
pub async fn runtime_of(
    store: &Db,
    installation: &str,
    agent: &str,
) -> AtomicResult<Option<Resource>> {
    let found = store
        .query(&Query {
            property: Some(urls::INTEGRATION_RUNTIME_AGENT.into()),
            value: Some(Value::AtomicUrl(agent.into())),
            include_nested: true,
            for_agent: ForAgent::Sudo,
            ..Default::default()
        })
        .await?;
    Ok(found.resources.into_iter().find(|r| {
        r.has_class(urls::INSTALLATION_RUNTIME)
            && r.get(urls::PARENT)
                .ok()
                .and_then(string_of)
                .is_some_and(|parent| parent == installation)
    }))
}

/// Resources whose `property` names `agent`, in either spelling of an agent
/// id (`atomic:agent:` or `did:ad:agent:`) and either stored datatype.
async fn naming_agent(db: &Db, property: &str, agent: &str) -> Vec<Resource> {
    let Some(key) = atomic_lib::identifiers::agent_public_key(agent) else {
        return Vec::new();
    };
    let mut spellings = vec![
        agent.to_string(),
        format!("{}{key}", atomic_lib::identifiers::ATOMIC_AGENT_PREFIX),
        format!("did:ad:agent:{key}"),
    ];
    spellings.dedup();
    let mut found: Vec<Resource> = Vec::new();
    for spelling in spellings {
        for value in [
            Value::AtomicUrl(spelling.as_str().into()),
            Value::String(spelling.clone()),
        ] {
            let Ok(result) = db
                .query(&Query {
                    property: Some(property.into()),
                    value: Some(value),
                    include_nested: true,
                    for_agent: ForAgent::Sudo,
                    ..Default::default()
                })
                .await
            else {
                continue;
            };
            for resource in result.resources {
                if !found
                    .iter()
                    .any(|r| r.get_subject() == resource.get_subject())
                {
                    found.push(resource);
                }
            }
        }
    }
    found
}

/// The Installation `agent` is an identity of, if it is one: the keyless app
/// id an Installation records (`integrationAppAgent`), or the agent a node
/// minted for it and published on an `InstallationRuntime` child. Read from
/// synced data only, so every node answers the same.
///
/// These identities are what #1644's fail-closed check sees for
/// installations (#1700, answer 8). Unlike a `createApp` agent they are not a
/// key this node must hold: an Installation runs as the agent this node
/// minted for it, whichever identities its resources name.
pub async fn installation_of_identity(db: &Db, agent: &str) -> Option<String> {
    for resource in naming_agent(db, urls::INTEGRATION_APP_AGENT, agent).await {
        if resource.has_class(urls::INSTALLATION) {
            return Some(resource.get_subject().to_string());
        }
    }
    for resource in naming_agent(db, urls::INTEGRATION_RUNTIME_AGENT, agent).await {
        if resource.has_class(urls::INSTALLATION_RUNTIME) {
            if let Some(parent) = resource.get(urls::PARENT).ok().and_then(string_of) {
                return Some(parent);
            }
        }
    }
    None
}

/// Whether this Installation carries an installation identity: an app id, or
/// an agent some node published for it after activating it. Such an
/// Installation runs as a node's own agent, never as the server's.
pub async fn carries_identity(db: &Db, installation: &Resource) -> bool {
    if app_agent_of(installation).is_some() {
        return true;
    }
    let subject = installation.get_subject().to_string();
    db.query(&Query {
        property: Some(urls::PARENT.into()),
        value: Some(Value::AtomicUrl(subject.as_str().into())),
        include_nested: true,
        for_agent: ForAgent::Sudo,
        ..Default::default()
    })
    .await
    .is_ok_and(|found| {
        found
            .resources
            .iter()
            .any(|r| r.has_class(urls::INSTALLATION_RUNTIME))
    })
}

/// Publishes this node's agent for an active Installation on a child the
/// agent may write, once. Returns that child's subject, or `None` when this
/// node has no agent for the Installation (not activated here, a wasip2
/// installation, or revoked).
///
/// The genesis is signed by the node's agent itself, so a reader can check
/// that the agent published on it is the one that wrote it.
pub async fn publish_runtime(
    store: &Db,
    drive: &str,
    installation: &str,
) -> AtomicResult<Option<String>> {
    let key = AppAgentKey::new(drive, installation);
    let AppAgentState::Active(info) = store.get_app_agent_state(&key)? else {
        return Ok(None);
    };
    if let Some(existing) = runtime_of(store, installation, &info.agent).await? {
        return Ok(Some(existing.get_subject().to_string()));
    }
    let Some(agent) = store.with_app_agent(&key, |agent| agent.clone())? else {
        return Ok(None);
    };

    let mut runtime = Resource::new("did:ad:placeholder".into());
    runtime.set_unsafe(
        urls::IS_A.into(),
        Value::ResourceArray(vec![urls::INSTALLATION_RUNTIME.into()]),
    )?;
    runtime.set_unsafe(urls::PARENT.into(), Value::AtomicUrl(installation.into()))?;
    runtime.set_unsafe(
        urls::INTEGRATION_RUNTIME_AGENT.into(),
        Value::AtomicUrl(info.agent.as_str().into()),
    )?;
    runtime.set_unsafe(
        urls::NAME.into(),
        Value::String(atomic_lib::sync::peer::effective_device_name(store)),
    )?;
    runtime.set_unsafe(
        urls::WRITE.into(),
        Value::ResourceArray(vec![info.agent.as_str().into()]),
    )?;
    runtime.save_as_genesis_signed_by(&agent, store).await?;
    let subject = runtime.get_subject().to_string();
    tracing::info!(
        "published this node's agent {} for installation {installation} on {subject}",
        info.agent
    );
    Ok(Some(subject))
}

#[cfg(all(test, feature = "wasm-plugins"))]
mod tests {
    use super::*;
    use crate::plugins::test_fixture::{fixture, Fixture};
    use atomic_lib::{agents::Agent, db::plugin_release::PluginRelease};

    const SOURCE: &str = "export function run(ctx) { return { intents: [], probe: { app: ctx.app, connections: ctx.connections, config: ctx.config } }; }";

    /// A keyless app id, the way the page mints one.
    fn app_id() -> String {
        Agent::new(None).unwrap().subject.to_string()
    }

    fn release(db: &Db) -> String {
        db.publish_plugin_release(&PluginRelease::js(
            SOURCE.into(),
            serde_json::json!({"schemaVersion":2}),
            Default::default(),
        ))
        .unwrap()
    }

    /// Commits an active JS Installation with `extra` on it.
    async fn install(f: &Fixture, extra: Vec<(&str, Value)>) -> AtomicResult<String> {
        let db = &f.appstate.store;
        let id = release(db);
        let mut resource = Resource::new("did:ad:placeholder".into());
        for (property, value) in [
            (
                urls::IS_A,
                Value::ResourceArray(vec![urls::INSTALLATION.into()]),
            ),
            (urls::PARENT, Value::AtomicUrl(f.drive.as_str().into())),
            (urls::NAME, Value::String("importer".into())),
            (urls::NAMESPACE, Value::String("acme".into())),
            (urls::RELEASE_PROP, Value::String(id.clone())),
            (urls::RELEASE_ID, Value::String(id)),
            (urls::INSTALLATION_STATUS, Value::String("active".into())),
            (urls::GRANTS, Value::Json(serde_json::json!([]))),
        ]
        .into_iter()
        .chain(extra)
        {
            resource.set_unsafe(property.into(), value)?;
        }
        resource.save_as_genesis(db).await?;
        Ok(resource.get_subject().to_string())
    }

    async fn update(f: &Fixture, subject: &str, property: &str, value: Value) -> AtomicResult<()> {
        let db = &f.appstate.store;
        let mut resource = db.get_resource(&subject.into()).await?;
        resource.set(property.into(), value, db).await?;
        resource.save(db).await.map(|_| ())
    }

    #[actix_rt::test]
    async fn an_installation_records_a_keyless_app_id() {
        let f = fixture("identity_app_id").await;
        let app = app_id();
        let subject = install(
            &f,
            vec![(
                urls::INTEGRATION_APP_AGENT,
                Value::AtomicUrl(app.as_str().into()),
            )],
        )
        .await
        .unwrap();
        let stored = f
            .appstate
            .store
            .get_resource(&subject.as_str().into())
            .await
            .unwrap();
        assert_eq!(app_agent_of(&stored).as_deref(), Some(app.as_str()));
        // Keyless: it is not this node's agent for the installation.
        let node = f
            .appstate
            .store
            .get_app_agent_info(&AppAgentKey::new(&f.drive, &subject))
            .unwrap()
            .unwrap()
            .agent;
        assert_ne!(node, app);
    }

    #[actix_rt::test]
    async fn an_app_id_that_is_not_an_agent_is_refused() {
        let f = fixture("identity_app_id_bad").await;
        for bad in [
            "https://example.com/agents/me",
            "atomic:agent:",
            "atomic:agent:tooshort",
            "atomic:commit:RqPwpgHv+PK7Pnz/dVab8hmHjYnvTL1YrlVa6L9G9Zg=",
        ] {
            let err = install(
                &f,
                vec![(urls::INTEGRATION_APP_AGENT, Value::String(bad.into()))],
            )
            .await
            .unwrap_err();
            assert!(
                err.to_string().contains("integrationAppAgent"),
                "{bad}: {err}"
            );
        }
        // The legacy spelling names the same kind of agent.
        let key = Agent::new(None).unwrap().public_key;
        install(
            &f,
            vec![(
                urls::INTEGRATION_APP_AGENT,
                Value::String(format!("did:ad:agent:{key}")),
            )],
        )
        .await
        .unwrap();
    }

    #[actix_rt::test]
    async fn an_app_id_can_be_added_but_never_changed() {
        let f = fixture("identity_app_id_fixed").await;
        let subject = install(&f, vec![]).await.unwrap();
        let first = app_id();
        // An Installation from before app ids gets one later.
        update(
            &f,
            &subject,
            urls::INTEGRATION_APP_AGENT,
            Value::AtomicUrl(first.as_str().into()),
        )
        .await
        .unwrap();
        let err = update(
            &f,
            &subject,
            urls::INTEGRATION_APP_AGENT,
            Value::AtomicUrl(app_id().as_str().into()),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("cannot change"), "{err}");
        let stored = f
            .appstate
            .store
            .get_resource(&subject.as_str().into())
            .await
            .unwrap();
        assert_eq!(app_agent_of(&stored), Some(first));
    }

    #[actix_rt::test]
    async fn activation_publishes_the_nodes_agent_on_a_child_that_agent_may_write() {
        let f = fixture("identity_runtime").await;
        let db = &f.appstate.store;
        let subject = install(&f, vec![]).await.unwrap();
        let node = db
            .get_app_agent_info(&AppAgentKey::new(&f.drive, &subject))
            .unwrap()
            .expect("activation minted an agent")
            .agent;

        let runtime = runtime_of(db, &subject, &node)
            .await
            .unwrap()
            .expect("activation published the node's agent");
        assert!(runtime.has_class(urls::INSTALLATION_RUNTIME));
        assert_eq!(
            runtime.get(urls::WRITE).unwrap().to_subjects(None).unwrap(),
            vec![node.clone()]
        );
        assert!(!runtime.get(urls::NAME).unwrap().to_string().is_empty());
        // Written by the agent it publishes, so a reader can check it holds the key.
        let rights = atomic_lib::hierarchy::check_write(
            db,
            &runtime,
            &ForAgent::AgentSubject(node.as_str().into()),
        )
        .await;
        assert!(rights.is_ok(), "{rights:?}");
        let genesis = runtime.get(urls::LAST_COMMIT).unwrap().to_string();
        let genesis = db.get_resource(&genesis.as_str().into()).await.unwrap();
        assert_eq!(genesis.get(urls::SIGNER).unwrap().to_string(), node);

        // Once: later commits to the Installation publish nothing new.
        update(
            &f,
            &subject,
            urls::CONFIG,
            Value::Json(serde_json::json!({"changed": true})),
        )
        .await
        .unwrap();
        assert_eq!(
            publish_runtime(db, &f.drive, &subject).await.unwrap(),
            Some(runtime.get_subject().to_string())
        );
        let all = db
            .query(&Query {
                property: Some(urls::PARENT.into()),
                value: Some(Value::AtomicUrl(subject.as_str().into())),
                include_nested: true,
                for_agent: ForAgent::Sudo,
                ..Default::default()
            })
            .await
            .unwrap()
            .resources
            .into_iter()
            .filter(|r| r.has_class(urls::INSTALLATION_RUNTIME))
            .count();
        assert_eq!(all, 1);
    }

    #[actix_rt::test]
    async fn a_node_without_an_agent_publishes_nothing() {
        let f = fixture("identity_runtime_none").await;
        assert_eq!(
            publish_runtime(&f.appstate.store, &f.drive, &f.plugin)
                .await
                .unwrap(),
            None
        );
    }

    #[actix_rt::test]
    async fn connections_must_map_platforms_to_ids() {
        let f = fixture("identity_connections_bad").await;
        for bad in [
            serde_json::json!(["conn-1"]),
            serde_json::json!({"clockify": 7}),
            serde_json::json!({"clockify": ""}),
            serde_json::json!({"": "conn-1"}),
        ] {
            let err = install(
                &f,
                vec![(urls::INTEGRATION_CONNECTIONS, Value::Json(bad.clone()))],
            )
            .await
            .unwrap_err();
            assert!(
                err.to_string().contains("integrationConnections"),
                "{bad}: {err}"
            );
        }
    }

    /// Runs `SOURCE` under the Installation the way `/plugin-run` does, with
    /// `input` from the caller.
    async fn run(f: &Fixture, installation: &str, input: serde_json::Value) -> serde_json::Value {
        let db = std::sync::Arc::new(f.appstate.store.clone());
        let host = crate::plugins::js_runtime::StoreHost {
            db: db.clone(),
            plugin: installation.to_string(),
            drive: f.drive.clone(),
            for_agent: ForAgent::AgentSubject(db.get_default_agent().unwrap().subject),
            manifest: None,
        };
        host.validate_binding().await.unwrap();
        let verdict = crate::plugins::js_runtime::embedded_runtime()
            .unwrap()
            .run(SOURCE, &input.to_string(), host)
            .await
            .unwrap()
            .unwrap();
        serde_json::from_str::<serde_json::Value>(&verdict).unwrap()["probe"].clone()
    }

    #[actix_rt::test]
    async fn the_plugin_gets_its_app_and_connections_next_to_config() {
        let f = fixture("identity_ctx").await;
        let app = app_id();
        let subject = install(
            &f,
            vec![
                (
                    urls::INTEGRATION_APP_AGENT,
                    Value::AtomicUrl(app.as_str().into()),
                ),
                (
                    urls::INTEGRATION_CONNECTIONS,
                    Value::Json(serde_json::json!({"clockify": "conn-1"})),
                ),
            ],
        )
        .await
        .unwrap();

        let probe = run(
            &f,
            &subject,
            serde_json::json!({
                "trigger": {"kind": "manual", "at": 0},
                "config": {"workspace": "w"},
                // What the caller sends is not what the plugin gets: the
                // Installation is the only source.
                "connections": {"clockify": "forged"},
                "app": "atomic:agent:forged",
            }),
        )
        .await;
        assert_eq!(
            probe["connections"],
            serde_json::json!({"clockify": "conn-1"})
        );
        assert_eq!(probe["app"], serde_json::json!(app));
        assert_eq!(probe["config"], serde_json::json!({"workspace": "w"}));

        // Delegating later reaches the next run.
        update(
            &f,
            &subject,
            urls::INTEGRATION_CONNECTIONS,
            Value::Json(serde_json::json!({"clockify": "conn-1", "github": "conn-2"})),
        )
        .await
        .unwrap();
        let probe = run(
            &f,
            &subject,
            serde_json::json!({"trigger": {"kind": "manual", "at": 0}}),
        )
        .await;
        assert_eq!(
            probe["connections"],
            serde_json::json!({"clockify": "conn-1", "github": "conn-2"})
        );
    }

    #[actix_rt::test]
    async fn an_installation_without_them_gets_empty_connections_and_no_app() {
        let f = fixture("identity_ctx_empty").await;
        let subject = install(&f, vec![]).await.unwrap();
        let probe = run(
            &f,
            &subject,
            serde_json::json!({"trigger": {"kind": "manual", "at": 0}}),
        )
        .await;
        assert_eq!(probe["connections"], serde_json::json!({}));
        assert_eq!(probe["app"], serde_json::Value::Null);
    }
}
