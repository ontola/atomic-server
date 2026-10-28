//! Writing as an app, on this device: the phone's equivalent of the server's
//! `/app-write` (`server/src/handlers/app_write.rs`, over `StoreApplyHost`).
//!
//! An app's view runs in the page, and a commit the page has signed is
//! authored by the person. So the page does not sign an app's write: it asks
//! the host (`appWrite`), which signs with the app's own key. That key was
//! handed over once (`setAppAgent`) and lives in the store, wrapped like every
//! secret; it never goes back to the page. The page-facing rule that `sign`
//! only signs the device agent's own commits stays as it is.
//!
//! A write needs two rights, and they are different questions:
//!
//! - the person (this device's agent) must be able to write the app: read to
//!   open an app, write to use it to change things;
//! - the app's own agent must be able to write each subject it touches, so a
//!   person who may write the whole drive still cannot make an app escape its
//!   own subtree.
//!
//! Both are checked per subject (the parent for a create). The server also
//! bounds an Installation by its `writeScope`; an app made on this device has
//! none, so only the two rights apply here.
//!
//! Only DID resources are written: an app on the phone lives in a DID drive,
//! and saving a URL subject would post the commit to the server it names.

use crate::{
    agents::{Agent, ForAgent},
    commit::CommitResponse,
    db::app_agent::AppAgentKey,
    hierarchy::check_write,
    identifiers::is_atomic_identifier,
    urls, Db, Resource, Storelike, Subject, Value,
};
use serde_json::Value as Json;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// What an app's write did, for the caller to queue and push.
pub struct AppWriteOutcome {
    /// The subject that exists now. Differs from what was asked for on a
    /// create, because a DID is minted from the signature.
    pub subject: String,
    /// The app's agent, who signed `commit`. Its outbox is the one to queue in.
    pub signer: Agent,
    /// What applying the write returned. Unsigned when nothing changed.
    pub commit: CommitResponse,
}

struct Request<'a> {
    op: &'a str,
    subject: Option<&'a str>,
    parent: Option<&'a str>,
    is_a: Vec<String>,
    prop_vals: Vec<(String, Json)>,
    properties: Vec<String>,
}

impl<'a> Request<'a> {
    fn parse(request: &'a Json) -> Result<Self, String> {
        let text = |key: &str| request.get(key).and_then(Json::as_str);
        let strings = |key: &str| -> Vec<String> {
            request
                .get(key)
                .and_then(Json::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        };
        Ok(Self {
            op: text("op").ok_or("An app write needs an op")?,
            subject: text("subject"),
            parent: text("parent"),
            is_a: strings("isA"),
            prop_vals: request
                .get("propVals")
                .and_then(Json::as_object)
                .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default(),
            properties: strings("properties"),
        })
    }

    fn subject(&self) -> Result<&'a str, String> {
        self.subject
            .ok_or_else(|| "That needs a subject".to_string())
    }
}

struct Writer<'a> {
    store: &'a Db,
    /// The person using the app: this device's agent.
    person: ForAgent,
    app: Agent,
}

impl Writer<'_> {
    /// Refuses unless the person and the app's agent may both write `subject`.
    async fn may_write(&self, subject: &str) -> Result<(), String> {
        let resource = self
            .store
            .get_resource(&subject.into())
            .await
            .map_err(|e| format!("{subject} could not be read: {e}"))?;

        check_write(self.store, &resource, &self.person)
            .await
            .map_err(err)?;
        check_write(
            self.store,
            &resource,
            &ForAgent::AgentSubject(self.app.subject.clone()),
        )
        .await
        .map_err(|e| format!("the app has no right to write {subject}: {e}"))?;
        Ok(())
    }

    async fn value_for(&self, property: &str, value: Json) -> Result<Value, String> {
        let full = self
            .store
            .get_property(property)
            .await
            .map_err(|e| format!("{property} is not a property: {e}"))?;

        crate::values::json_to_value(value, &full.data_type)
            .map_err(|e| format!("{}: {e}", full.shortname))
    }

    async fn load(&self, subject: &str) -> Result<Resource, String> {
        refuse_url_subject(subject)?;
        self.store
            .get_resource(&subject.into())
            .await
            .map_err(|e| format!("{subject} could not be read: {e}"))
    }

    async fn create(&self, request: &Request<'_>, parent: &str) -> Result<CommitResponse, String> {
        refuse_url_subject(parent)?;
        self.may_write(parent).await?;

        let mut resource = Resource::new(format!(
            "_new:{}",
            ulid::Ulid::new().to_string().to_lowercase()
        ));
        resource
            .set_unsafe(
                urls::PARENT.into(),
                Value::AtomicUrl(Subject::from_raw(parent, None)),
            )
            .map_err(err)?;

        if !request.is_a.is_empty() {
            resource
                .set_unsafe(
                    urls::IS_A.into(),
                    Value::ResourceArray(
                        request
                            .is_a
                            .iter()
                            .map(|class| {
                                crate::values::SubResource::Subject(Subject::from_raw(class, None))
                            })
                            .collect(),
                    ),
                )
                .map_err(err)?;
        }

        for (property, value) in &request.prop_vals {
            let value = self
                .value_for(property, stamp_import_approval(property, value.clone()))
                .await?;
            resource.set_unsafe(property.clone(), value).map_err(err)?;
        }

        // Signed by the app: under a DID parent the signature is the subject.
        resource
            .save_as_genesis_signed_by(&self.app, self.store)
            .await
            .map_err(|e| format!("could not create a resource under {parent}: {e}"))
    }

    async fn save(&self, request: &Request<'_>, subject: &str) -> Result<CommitResponse, String> {
        let mut resource = self.load(subject).await?;
        self.may_write(subject).await?;

        for (property, value) in &request.prop_vals {
            let value = self
                .value_for(property, stamp_import_approval(property, value.clone()))
                .await?;
            resource.set_unsafe(property.clone(), value).map_err(err)?;
        }

        resource
            .save_as(&self.app, self.store)
            .await
            .map_err(|e| format!("could not write {subject}: {e}"))
    }

    async fn remove(&self, request: &Request<'_>, subject: &str) -> Result<CommitResponse, String> {
        let mut resource = self.load(subject).await?;
        self.may_write(subject).await?;

        for property in &request.properties {
            resource.remove_propval(property).map_err(err)?;
        }

        resource
            .save_as(&self.app, self.store)
            .await
            .map_err(|e| format!("could not write {subject}: {e}"))
    }

    async fn destroy(&self, subject: &str) -> Result<CommitResponse, String> {
        let mut resource = self.load(subject).await?;
        self.may_write(subject).await?;

        resource
            .destroy_as(&self.app, self.store)
            .await
            .map_err(|e| format!("could not destroy {subject}: {e}"))
    }
}

/// A resource saved under a URL is posted to the server it names, which this
/// device must never do for an app; DIDs are applied locally.
fn refuse_url_subject(subject: &str) -> Result<(), String> {
    if is_atomic_identifier(subject) {
        Ok(())
    } else {
        Err(format!(
            "An app on this device writes DID resources only; {subject} is not one"
        ))
    }
}

/// Mark each approved import write, even when two previews have identical data.
/// The same stamp as the server's apply host puts on it.
fn stamp_import_approval(property: &str, mut value: Json) -> Json {
    if property == urls::IMPORT_BASELINE {
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "approval".into(),
                Json::String(crate::utils::random_string(32)),
            );
        }
    }
    value
}

/// Performs one write of the app `app` on `drive`, signed by the app's own
/// agent. `request` is what the page sends: `{ op, subject?, parent?, isA?,
/// propVals?, properties? }` with `op` one of `create`, `save`, `remove`,
/// `destroy`.
///
/// Applies the commit locally. Queueing it in the app agent's outbox and
/// pushing it on is the caller's job (`EmbedHost` does).
pub async fn app_write(
    store: &Db,
    drive: &str,
    app: &str,
    request: &Json,
) -> Result<AppWriteOutcome, String> {
    let request = Request::parse(request)?;
    let person = store.get_default_agent().map_err(err)?;

    // Write rights on the app, which is what sharing one already means.
    let app_resource = store
        .get_resource(&app.into())
        .await
        .map_err(|e| format!("{app} could not be read: {e}"))?;
    check_write(
        store,
        &app_resource,
        &ForAgent::AgentSubject(person.subject.clone()),
    )
    .await
    .map_err(err)?;

    let signer = store
        .with_app_agent(&AppAgentKey::new(drive, app), |agent| agent.clone())
        .map_err(|e| format!("could not read the key of {app}: {e}"))?
        .ok_or("This app has no key on this device")?;

    let writer = Writer {
        store,
        person: ForAgent::AgentSubject(person.subject),
        app: signer.clone(),
    };

    let (subject, commit) = match request.op {
        "create" => {
            // Defaults to the app: the one place it may always write.
            let parent = request.parent.unwrap_or(app);
            let commit = writer.create(&request, parent).await?;
            (commit.commit.subject.to_string(), commit)
        }
        "save" => {
            let subject = request.subject()?;
            (subject.to_string(), writer.save(&request, subject).await?)
        }
        "remove" => {
            let subject = request.subject()?;
            (subject.to_string(), writer.remove(&request, subject).await?)
        }
        "destroy" => {
            let subject = request.subject()?;
            (subject.to_string(), writer.destroy(subject).await?)
        }
        other => return Err(format!("An app cannot {other}")),
    };

    Ok(AppWriteOutcome {
        subject,
        signer,
        commit,
    })
}
