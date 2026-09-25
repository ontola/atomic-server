//! Resolve existing resources into an installation without moving or cloning them.
//!
//! An identity belongs to its existing resource subject. Entry points inherit the
//! nearest identity, but only after their owning drive has been verified. Legacy
//! resources without an identity remain explicit; revoked identities never become
//! legacy or inherit a more powerful ancestor's signer.

use atomic_lib::{
    db::app_agent::{AppAgentKey, AppAgentState},
    urls, Db, Resource, Storelike, Subject, Value,
};

pub struct Installation {
    pub signing_as: Option<AppAgentKey>,
}

/// Whether this resource is an Installation that is not running.
///
/// Read from the resource rather than from any cached state, so pausing takes
/// effect on the next run with no registry to keep in step. `revoked` needs no
/// case here: revoking retires the identity, which the walk below already
/// refuses. Anything that is not an Installation (a legacy `Plugin`, an entry
/// point, a drive) is not suspendable and reads as running.
pub fn suspended_status(resource: &Resource) -> Option<String> {
    let is_installation = resource
        .get(urls::IS_A)
        .ok()
        .map(|is_a| is_a.to_reference_index_strings().unwrap_or_default())
        .is_some_and(|classes| classes.iter().any(|c| c == urls::INSTALLATION));
    if !is_installation {
        return None;
    }
    // Anything but `active` is suspended, including a status that is missing or
    // in an encoding this does not recognise. A plugin that stopped when it
    // should not have is visible and harmless; one that kept running through a
    // pause is the bug this guards. `revoked` lands here too, ahead of the
    // identity tombstone below, which is best-effort.
    let status = match resource.get(urls::INSTALLATION_STATUS) {
        Ok(Value::String(status)) => status.clone(),
        Ok(other) => other.to_string(),
        Err(_) => "a draft".to_string(),
    };
    (status != "active").then_some(status)
}

/// Whether this resource is an Installation that is not running.
pub fn is_suspended(resource: &Resource) -> bool {
    suspended_status(resource).is_some()
}

pub async fn resolve(db: &Db, drive: &str, entrypoint: &str) -> Result<Installation, String> {
    let expected = Subject::from(drive).pure_id();
    let mut current = db
        .get_resource(&entrypoint.into())
        .await
        .map_err(|e| e.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut signing_as = None;
    let mut identities = None;
    loop {
        if seen.len() >= 64 {
            return Err("plugin parent hierarchy is too deep".into());
        }
        if !seen.insert(current.get_subject().pure_id()) {
            return Err("plugin parent hierarchy contains a cycle".into());
        }
        if let Some(status) = suspended_status(&current) {
            return Err(format!(
                "this installation is {status}, not active, so it does not run"
            ));
        }
        if signing_as.is_none() {
            let key = AppAgentKey::new(drive, &current.get_subject().to_string());
            match db.get_app_agent_state(&key).map_err(|e| e.to_string())? {
                AppAgentState::Revoked => {
                    return Err(
                        "installation identity was revoked; reconnect before running".into(),
                    )
                }
                AppAgentState::Active(_) => signing_as = Some(key),
                AppAgentState::Legacy => {
                    if let Some(refusal) =
                        identity_without_key(db, drive, &current, &mut identities).await
                    {
                        return Err(refusal);
                    }
                }
            }
        }
        if let Some(owner) = current.get_drive() {
            if owner.pure_id() != expected {
                return Err("the plugin does not belong to this drive".into());
            }
        }
        if current.get_subject().pure_id() == expected {
            return Ok(Installation { signing_as });
        }
        current = current
            .get_parent(db)
            .await
            .map_err(|_| "the plugin has no owning drive".to_string())?;
    }
}

/// Why this resource may not run here, when it was issued an identity this
/// node cannot sign for. Called only once the key lookup came back `Legacy`,
/// so falling through means running as the server's own agent.
///
/// Two kinds of identity are seen (#1644, and #1700 answer 8):
/// - installation identities: an Installation's keyless app id and the agents
///   nodes minted for it and published (see
///   `installation_identity::installation_of_identity`). What an Installation
///   runs as is this node's own agent for it, so an identity of Installation
///   `I` is fine when this node holds an agent for `I`, and refused when it
///   does not: `I` was not activated here. An Installation that carries such
///   an identity and has no agent here is refused itself, for the same reason.
/// - `createApp` app agents, which are one key on one node: see
///   [app_identity_without_key].
async fn identity_without_key(
    db: &Db,
    drive: &str,
    resource: &Resource,
    identities: &mut Option<Option<String>>,
) -> Option<String> {
    let subject = resource.get_subject().to_string();
    if resource.has_class(urls::INSTALLATION)
        && super::installation_identity::carries_identity(db, resource).await
    {
        return Some(format!("The {}", not_activated_here(&subject)));
    }
    let mut writers = Vec::new();
    for writer in agent_writers(resource) {
        match super::installation_identity::installation_of_identity(db, &writer).await {
            Some(installation) => {
                let key = AppAgentKey::new(drive, &installation);
                if !matches!(db.get_app_agent_state(&key), Ok(AppAgentState::Active(_))) {
                    return Some(format!(
                        "{subject} names {writer}, an identity of an installation this node \
                         has not activated: the {}",
                        not_activated_here(&installation)
                    ));
                }
            }
            None => writers.push(writer),
        }
    }
    let agent = app_identity_without_key(db, drive, &writers, identities).await?;
    Some(format!(
        "{subject} writes as its own agent {agent}, but this node holds no key for it; \
         connect the app's identity on this node before running it here"
    ))
}

fn not_activated_here(installation: &str) -> String {
    format!(
        "installation {installation} runs as the agent each node mints when it activates \
         it, and it has no agent on this node; activate it on this node before running it \
         here"
    )
}

/// The agent ids in this resource's `write` list.
fn agent_writers(resource: &Resource) -> Vec<String> {
    resource
        .get(urls::WRITE)
        .ok()
        .and_then(|value| value.to_subjects(None).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|writer| Subject::from(writer.as_str()).is_agent_did())
        .collect()
}

/// The app agent among `writers`, when this node cannot sign as it.
///
/// Called only once the key lookup came back `Legacy`. An app's agent
/// resource syncs with the drive. Its key, posted once to `POST /app-agent`,
/// stays on the node it was posted to. On any other node the missing key
/// reads as `Legacy`, and without this check a run falls back to the server's
/// own agent. The app's writes are then attributed to the server, and the
/// app's own rights no longer bound them (ontola/atomic-plugins#41).
///
/// "Issued an app agent" is read from synced data only: an agent DID in the
/// resource's `write` list whose agent resource sits in the drive's
/// app-identities folder, which is where `createApp` puts every app agent.
/// `identities` caches that folder's subject across one resolve walk.
async fn app_identity_without_key(
    db: &Db,
    drive: &str,
    writers: &[String],
    identities: &mut Option<Option<String>>,
) -> Option<String> {
    if writers.is_empty() {
        return None;
    }
    if identities.is_none() {
        *identities = Some(app_identities_folder(db, drive).await);
    }
    let folder = identities.as_ref()?.as_ref()?;
    for writer in writers {
        let Ok(agent) = db.get_resource(&writer.as_str().into()).await else {
            continue;
        };
        let parent = agent.get(urls::PARENT).ok().map(|p| p.to_string());
        if parent.as_deref() == Some(folder.as_str()) {
            return Some(writer.clone());
        }
    }
    None
}

/// The drive's app-identities folder, found through the drive-schema property
/// `createApp` points at it with.
async fn app_identities_folder(db: &Db, drive: &str) -> Option<String> {
    let property = super::scheduler::drive_terms(db, drive)
        .await?
        .properties
        .remove("app-identities")?;
    let drive_resource = db.get_resource(&drive.into()).await.ok()?;
    drive_resource.get(&property).ok().map(|v| v.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use atomic_lib::{agents::Agent, db::app_agent::AppAgent, urls, Value};

    /// An active JS Installation committed on this node, so activation mints
    /// this node's agent for it, carrying the keyless app id `app`.
    async fn installed_here(f: &crate::plugins::test_fixture::Fixture, app: &str) -> String {
        let db = &f.appstate.store;
        let release = db
            .publish_plugin_release(&atomic_lib::db::plugin_release::PluginRelease::js(
                "export function run() { return { intents: [] }; }".into(),
                serde_json::json!({"schemaVersion":2}),
                Default::default(),
            ))
            .unwrap();
        crate::plugins::test_fixture::genesis(
            db,
            vec![
                (
                    urls::IS_A,
                    Value::ResourceArray(vec![urls::INSTALLATION.into()]),
                ),
                (urls::PARENT, Value::AtomicUrl(f.drive.as_str().into())),
                (urls::NAME, Value::String("importer".into())),
                (urls::NAMESPACE, Value::String("acme".into())),
                (urls::RELEASE_PROP, Value::String(release.clone())),
                (urls::RELEASE_ID, Value::String(release)),
                (urls::INSTALLATION_STATUS, Value::String("active".into())),
                (urls::GRANTS, Value::Json(serde_json::json!([]))),
                (urls::INTEGRATION_APP_AGENT, Value::AtomicUrl(app.into())),
            ],
        )
        .await
    }

    /// The same Installation as another node sees it after a sync: the data
    /// arrived, activation did not run here, so this node holds no agent for
    /// it. Saved without the class hooks, as synced data is.
    async fn installed_elsewhere(
        f: &crate::plugins::test_fixture::Fixture,
        app: &str,
        other_node: &str,
    ) -> String {
        let db = &f.appstate.store;
        let subject = crate::plugins::test_fixture::genesis(
            db,
            vec![
                (urls::PARENT, Value::AtomicUrl(f.drive.as_str().into())),
                (urls::NAME, Value::String("importer".into())),
            ],
        )
        .await;
        let mut installation = db.get_resource(&subject.as_str().into()).await.unwrap();
        for (property, value) in [
            (
                urls::IS_A,
                Value::ResourceArray(vec![urls::INSTALLATION.into()]),
            ),
            (urls::NAMESPACE, Value::String("acme".into())),
            (urls::RELEASE_PROP, Value::String("blake3:elsewhere".into())),
            (urls::RELEASE_ID, Value::String("blake3:elsewhere".into())),
            (urls::GRANTS, Value::Json(serde_json::json!([]))),
            (urls::INSTALLATION_STATUS, Value::String("active".into())),
            (urls::INTEGRATION_APP_AGENT, Value::AtomicUrl(app.into())),
        ] {
            installation.set_unsafe(property.into(), value).unwrap();
        }
        db.add_resource_opts(&installation, false, true, true)
            .await
            .unwrap();
        // The node that did activate it published its agent.
        runtime_child(f, &subject, other_node).await;
        subject
    }

    /// What `publish_runtime` writes on the node that owns `agent`.
    async fn runtime_child(
        f: &crate::plugins::test_fixture::Fixture,
        installation: &str,
        agent: &str,
    ) {
        crate::plugins::test_fixture::genesis(
            &f.appstate.store,
            vec![
                (
                    urls::IS_A,
                    Value::ResourceArray(vec![urls::INSTALLATION_RUNTIME.into()]),
                ),
                (urls::PARENT, Value::AtomicUrl(installation.into())),
                (
                    urls::INTEGRATION_RUNTIME_AGENT,
                    Value::AtomicUrl(agent.into()),
                ),
                (urls::NAME, Value::String("the other node".into())),
            ],
        )
        .await;
    }

    /// An entry point under `parent` whose write list names `writers`, the
    /// way a plugin's own resources name the identities that may write them.
    async fn entrypoint(
        f: &crate::plugins::test_fixture::Fixture,
        parent: &str,
        writers: &[&str],
    ) -> String {
        crate::plugins::test_fixture::genesis(
            &f.appstate.store,
            vec![
                (urls::PARENT, Value::AtomicUrl(parent.into())),
                (
                    urls::WRITE,
                    Value::ResourceArray(writers.iter().map(|w| (*w).into()).collect()),
                ),
            ],
        )
        .await
    }

    /// Piece 8 of #1700: installation identities (the keyless app id, and the
    /// agents other nodes minted and published) are identities the check
    /// sees, and an Installation this node activated is not refused for them.
    #[actix_rt::test]
    async fn an_installed_plugin_runs_as_this_nodes_agent_whatever_identities_it_names() {
        let f = crate::plugins::test_fixture::fixture("installation_identities_here").await;
        let db = &f.appstate.store;
        let app = Agent::new(None).unwrap().subject.to_string();
        let installation = installed_here(&f, &app).await;
        let key = AppAgentKey::new(&f.drive, &installation);
        assert!(matches!(
            db.get_app_agent_state(&key).unwrap(),
            AppAgentState::Active(_)
        ));
        let other_node = Agent::new(None).unwrap().subject.to_string();
        runtime_child(&f, &installation, &other_node).await;
        let here = db.get_app_agent_info(&key).unwrap().unwrap().agent;

        let child = entrypoint(&f, &installation, &[&app, &other_node, &here]).await;
        assert_eq!(
            resolve(db, &f.drive, &child).await.unwrap().signing_as,
            Some(key.clone())
        );
        assert_eq!(
            resolve(db, &f.drive, &installation)
                .await
                .unwrap()
                .signing_as,
            Some(key)
        );
    }

    /// The same Installation on a node that has its data but never activated
    /// it: it carries installation identities, this node holds no agent for
    /// it, so it does not fall back to running as the server.
    #[actix_rt::test]
    async fn an_installation_not_activated_on_this_node_does_not_run_as_the_server() {
        let f = crate::plugins::test_fixture::fixture("installation_identities_elsewhere").await;
        let db = &f.appstate.store;
        let app = Agent::new(None).unwrap().subject.to_string();
        let other_node = Agent::new(None).unwrap().subject.to_string();
        let installation = installed_elsewhere(&f, &app, &other_node).await;

        let err = resolve(db, &f.drive, &installation)
            .await
            .map(|i| i.signing_as)
            .unwrap_err();
        assert!(err.contains("no agent on this node"), "{err}");

        // An entry point naming its identities is refused for the same reason,
        // before the walk reaches the Installation.
        let child = entrypoint(&f, &installation, &[&app, &other_node]).await;
        let err = resolve(db, &f.drive, &child)
            .await
            .map(|i| i.signing_as)
            .unwrap_err();
        assert!(err.contains("no agent on this node"), "{err}");
        assert!(err.contains(&installation), "{err}");
    }

    /// Recognising installation identities does not let an unknown key
    /// through: an app agent from `createApp` whose key is not here is still
    /// refused (#1644), even under an Installation this node activated.
    #[actix_rt::test]
    async fn an_app_key_that_is_not_on_this_node_is_still_refused() {
        let f = crate::plugins::test_fixture::fixture("installation_unknown_key").await;
        let db = &f.appstate.store;
        let app = Agent::new(None).unwrap().subject.to_string();
        let installation = installed_here(&f, &app).await;

        // What `createApp` does: the app's agent in the drive's app-identities
        // folder. Its key stays on the node that created it.
        let folder = crate::plugins::test_fixture::genesis(
            db,
            vec![
                (urls::PARENT, Value::AtomicUrl(f.drive.as_str().into())),
                (urls::NAME, Value::String("App identities".into())),
            ],
        )
        .await;
        let mut drive = db.get_resource(&f.drive.as_str().into()).await.unwrap();
        drive
            .set_unsafe(
                f.terms.property("app-identities").unwrap().into(),
                Value::AtomicUrl(folder.as_str().into()),
            )
            .unwrap();
        drive.save(db).await.unwrap();
        let unknown = Agent::new(Some("an app")).unwrap();
        let mut agent_resource = unknown.to_resource().unwrap();
        agent_resource
            .set_unsafe(
                urls::PARENT.into(),
                Value::AtomicUrl(folder.as_str().into()),
            )
            .unwrap();
        agent_resource.save_locally(db).await.unwrap();

        let unknown = unknown.subject.to_string();
        let child = entrypoint(&f, &installation, &[&app, &unknown]).await;
        let err = resolve(db, &f.drive, &child)
            .await
            .map(|i| i.signing_as)
            .unwrap_err();
        assert!(err.contains("holds no key"), "{err}");
        assert!(err.contains(&unknown), "{err}");
    }

    #[actix_rt::test]
    async fn resolves_existing_subjects_without_migrating_data_and_refuses_foreign_drives() {
        let mut f = crate::plugins::test_fixture::fixture("installation_binding").await;
        crate::plugins::test_fixture::write_plugin(&mut f, "binding test").await;
        let db = &f.appstate.store;
        assert!(resolve(db, &f.drive, &f.plugin)
            .await
            .unwrap()
            .signing_as
            .is_none());
        let child = crate::plugins::test_fixture::genesis(
            db,
            vec![(urls::PARENT, Value::AtomicUrl(f.plugin.as_str().into()))],
        )
        .await;
        let key = AppAgentKey::new(&f.drive, &f.plugin);
        let agent = Agent::new(None).unwrap();
        db.set_app_agent(
            &key,
            &AppAgent::new(agent.subject.to_string(), agent.build_secret().unwrap(), 0),
        )
        .unwrap();
        assert_eq!(
            resolve(db, &f.drive, &child).await.unwrap().signing_as,
            Some(key.clone())
        );
        // A key stored under a forged drive claim must not bypass ownership.
        db.set_app_agent(
            &AppAgentKey::new("did:ad:wrong", &child),
            &AppAgent::new(agent.subject.to_string(), agent.build_secret().unwrap(), 0),
        )
        .unwrap();
        assert!(resolve(db, "did:ad:wrong", &child).await.is_err());
        db.delete_app_agent(&key).unwrap();
        assert!(resolve(db, &f.drive, &child).await.is_err());
        assert_eq!(
            db.get_resource(&child.as_str().into())
                .await
                .unwrap()
                .get(urls::PARENT)
                .unwrap()
                .to_string(),
            f.plugin
        );
        db.set_app_agent(
            &key,
            &AppAgent::new(agent.subject.to_string(), agent.build_secret().unwrap(), 0),
        )
        .unwrap();
        assert_eq!(
            resolve(db, &f.drive, &child).await.unwrap().signing_as,
            Some(key)
        );
    }
}
