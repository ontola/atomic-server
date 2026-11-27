//! Priming the local store with an ontology bundle.
//!
//! An app ships a JSON-AD file with an ordinary Ontology and its Class and
//! Property resources at fixed `https://` subjects. The address is a name, not
//! a place: a node that misses a term fetches it once from its address and
//! keeps it (`Storelike::get_resource` on an External subject). An app that
//! carries its bundle should not have to wait for that, or need the network at
//! all. [`install_ontology_bundle`] stores the bundle's resources under exactly
//! those subjects, the way a fetched External resource is cached: no commits,
//! no signing, no `parent` changes, no outbox, no sync, no network request.

use crate::{
    agents::ForAgent,
    errors::AtomicResult,
    parse::{parse_json_ad_string, ParseOpts, SaveOpts},
    urls, AtomicError, Resource, Storelike, Subject, Value,
};
use std::collections::BTreeSet;

/// What [`install_ontology_bundle`] did.
#[derive(Debug, Default)]
pub struct InstallReport {
    /// Subjects written for the first time.
    pub created: Vec<String>,
    /// Subjects whose label (`name`, `description`) or ontology member lists changed.
    pub updated: Vec<String>,
    /// Subjects already installed as in the bundle: nothing was written.
    pub unchanged: Vec<String>,
}

/// Fields that may change between versions of a bundle without changing what a
/// term means.
const LABELS: &[&str] = &[urls::NAME, urls::DESCRIPTION];

/// The Ontology's member lists only grow: a newer bundle adds terms.
const ONTOLOGY_LISTS: &[&str] = &[urls::CLASSES, urls::PROPERTIES];

/// A comparable form of a value: arrays are sets of subjects (their order is
/// not part of the meaning), everything else its string form.
fn canonical(value: &Value) -> String {
    match value {
        Value::ResourceArray(_) => {
            let mut subjects = value.to_subjects(None).unwrap_or_default();
            subjects.sort();
            subjects.join("\n")
        }
        other => other.to_string(),
    }
}

fn is_a(resource: &Resource) -> Vec<String> {
    resource
        .get(urls::IS_A)
        .ok()
        .and_then(|v| v.to_subjects(None).ok())
        .unwrap_or_default()
}

fn kind_order(resource: &Resource) -> u8 {
    let classes = is_a(resource);
    if classes.iter().any(|c| c == urls::ONTOLOGY) {
        0
    } else if classes.iter().any(|c| c == urls::PROPERTY) {
        1
    } else {
        2
    }
}

/// Store the ontology bundle `bundle` (a JSON-AD array) in `store` under the
/// subjects it names, without any network access and without commits.
///
/// - Idempotent: a bundle that is already stored writes nothing.
/// - Refuses, writing nothing, when a term is stored with a different meaning:
///   any field other than `name`, `description` (and the ontology's member
///   lists, which may grow) must match what is stored.
/// - The bundle may only hold an Ontology of class [`urls::ONTOLOGY`], Classes
///   and Properties, each at an absolute `https://` subject. Exactly one
///   Ontology. Subjects in the reserved shared-vocabulary namespaces
///   ([`Subject::is_canonical_vocabulary`]) are refused.
/// - A store that serves a subject's address itself (its own base domain) is
///   refused: publish the bundle there by importing it, see
///   `docs/src/schema/classes.md`.
pub async fn install_ontology_bundle(
    store: &impl Storelike,
    bundle: &str,
) -> AtomicResult<InstallReport> {
    let opts = ParseOpts {
        for_agent: ForAgent::Sudo,
        save: SaveOpts::DontSave,
        // Skipped properties would be dropped silently; a bundle is exact.
        skip_unknown_props: false,
        ..ParseOpts::default()
    };
    let mut wanted = parse_json_ad_string(bundle, store, &opts).await?;
    wanted.sort_by_key(kind_order);

    let ontologies: Vec<&Resource> = wanted.iter().filter(|r| kind_order(r) == 0).collect();
    if ontologies.len() != 1 {
        return Err("An ontology bundle holds exactly one Ontology".into());
    }

    for resource in &wanted {
        let subject = resource.get_subject();
        let url = match subject {
            Subject::External(url) if url.scheme() == "https" && url.query().is_none() => url,
            _ => {
                return Err(format!(
                    "{subject} is not an absolute https:// subject without a query,"
                )
                .into())
            }
        };
        let authority = match url.port() {
            Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
            None => url.host_str().unwrap_or_default().to_string(),
        };
        let own = store.get_base_domain().is_some_and(|base| {
            let base = base
                .trim_start_matches("https://")
                .trim_start_matches("http://");
            let base = base.trim_end_matches('/');
            authority == base || authority.ends_with(&format!(".{base}"))
        });
        if own {
            return Err(format!(
                "{subject} is served by this store itself; publish the bundle here by importing it"
            )
            .into());
        }
        if Subject::is_canonical_vocabulary(url.as_str()) {
            return Err(format!("{subject} belongs to the shared vocabulary").into());
        }
        let classes = is_a(resource);
        let allowed = [urls::ONTOLOGY, urls::CLASS, urls::PROPERTY];
        if classes.len() != 1 || !allowed.contains(&classes[0].as_str()) {
            return Err(format!(
                "{subject} is not an Ontology ({}), Class or Property; found {:?}",
                urls::ONTOLOGY,
                classes
            )
            .into());
        }
    }

    // Plan everything before writing anything: a refusal leaves no half install.
    let mut plan: Vec<(Resource, bool)> = Vec::new();
    let mut report = InstallReport::default();
    for wanted_resource in &wanted {
        let subject = wanted_resource.get_subject().clone();
        let is_ontology = kind_order(wanted_resource) == 0;

        // Stored-only read: `get_resource` would fetch a missing https subject.
        if !store.has_stored_resource(&subject) {
            plan.push((wanted_resource.clone(), false));
            continue;
        }
        let stored = store.get_resource(&subject).await?;
        let mut target = Resource::new(subject.to_string());
        for (property, value) in stored.get_propvals() {
            if property != urls::LORO_UPDATE && property != urls::LAST_COMMIT {
                target.set_unsafe(property.clone(), value.clone())?;
            }
        }
        let mut changed = false;

        for (property, value) in wanted_resource.get_propvals() {
            let property = property.as_str();
            if property == urls::PARENT {
                continue;
            }
            let current = stored.get(property).ok();
            if current.is_some_and(|c| canonical(c) == canonical(value)) {
                continue;
            }
            let growable = is_ontology && ONTOLOGY_LISTS.contains(&property);
            if !LABELS.contains(&property) && !growable {
                return Err(AtomicError::from(format!(
                    "{subject} is already stored with a different `{property}`: refusing to change what the term means"
                )));
            }
            if growable {
                let mut merged: BTreeSet<String> = current
                    .and_then(|c| c.to_subjects(None).ok())
                    .unwrap_or_default()
                    .into_iter()
                    .collect();
                merged.extend(value.to_subjects(None)?);
                let merged = Value::from(merged.into_iter().collect::<Vec<String>>());
                if current.is_some_and(|c| canonical(c) == canonical(&merged)) {
                    continue;
                }
                target.set_unsafe(property.into(), merged)?;
            } else {
                target.set_unsafe(property.into(), value.clone())?;
            }
            changed = true;
        }

        if changed {
            plan.push((target, true));
        } else {
            report.unchanged.push(subject.to_string());
        }
    }

    for (resource, existed) in plan {
        let subject = resource.get_subject().to_string();
        // The same write `get_resource` does with a fetched External resource.
        store
            .add_resource_opts(&resource, false, false, true)
            .await?;
        if existed {
            report.updated.push(subject);
        } else {
            report.created.push(subject);
        }
    }

    Ok(report)
}
