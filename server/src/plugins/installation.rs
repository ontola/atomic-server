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
                AppAgentState::Legacy => {}
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

#[cfg(test)]
mod tests {
    use super::*;
    use atomic_lib::{agents::Agent, db::app_agent::AppAgent, urls, Value};

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
