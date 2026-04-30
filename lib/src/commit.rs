//! Describe changes / mutations to data

use crate::{
    agents::{decode_base64, encode_base64},
    datatype::DataType,
    errors::AtomicResult,
    urls,
    values::SubResource,
    Atom, Resource, Storelike, Subject, Value,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use urls::SIGNER;
/// The `resource_new`, `resource_old` and `commit_resource` fields are only created if the Commit is persisted.
/// When the Db is only notifying other of changes (e.g. if a new Message was added to a ChatRoom), these fields are not created.
/// When deleting a resource, the `resource_new` field is None.
#[derive(Clone, Debug)]
pub struct CommitResponse {
    pub commit: Commit,
    pub commit_resource: Resource,
    pub resource_new: Option<Resource>,
    pub resource_old: Option<Resource>,
    pub add_atoms: Vec<Atom>,
    pub remove_atoms: Vec<Atom>,
    /// The property URLs that were changed by this commit's Loro update.
    pub changed_props: HashSet<String>,
}

pub struct CommitApplied {
    /// The resource before the Commit was applied
    pub resource_old: Resource,
    /// The modified resources where the commit has been applied to
    pub resource_new: Resource,
    /// The atoms that should be added to the store (for updating indexes)
    pub add_atoms: Vec<Atom>,
    /// The atoms that should be removed from the store (for updating indexes)
    pub remove_atoms: Vec<Atom>,
    /// The property URLs that were changed by this commit's Loro update.
    pub changed_props: HashSet<String>,
}

#[derive(Clone, Debug)]
/// Describes options for applying a Commit.
/// Skip the checks you don't need to get better performance, or if you want to break the rules a little.
pub struct CommitOpts {
    /// Makes sure all `required` properties are present.
    pub validate_schema: bool,
    /// Checks the public key and the signature of the Commit.
    pub validate_signature: bool,
    /// Checks whether the Commit isn't too old, or has been created in the future.
    pub validate_timestamp: bool,
    /// Checks whether the creator of the Commit has the rights to edit the Resource.
    pub validate_rights: bool,
    /// Checks whether the previous Commit applied to the resource matches the one mentioned in the Commit/
    /// This makes sure that the Commit is not applied twice, or that the one creating it had a faulty state.
    pub validate_previous_commit: bool,
    /// Detects commits whose Loro update's writes silently lost LWW against
    /// the stored state — i.e. the client's Loro doc wasn't seeded from the
    /// server's current state, so its ops are concurrent with stored ops and
    /// get dropped by Loro's conflict resolution. When this happens, the
    /// commit would "succeed" but the server-visible state wouldn't reflect
    /// the client's intent. With this enabled, we reject such commits so the
    /// client can refetch and retry.
    ///
    /// Turn off for true multi-peer sync (mesh/Iroh) where concurrent writes
    /// are expected and LWW is the correct resolution.
    pub validate_loro_causality: bool,
    /// Updates the indexes in the Store. Is a bit more costly.
    pub update_index: bool,
    /// For who the right checks will be perormed. If empty, the signer of the Commit will be used.
    pub validate_for_agent: Option<String>,
}

impl CommitOpts {
    pub fn no_validations_no_index() -> Self {
        Self {
            validate_schema: false,
            validate_signature: false,
            validate_timestamp: false,
            validate_rights: false,
            validate_previous_commit: false,
            validate_loro_causality: false,
            update_index: false,
            validate_for_agent: None,
        }
    }
}

/// A Commit is a set of changes to a Resource.
/// Use CommitBuilder if you're programmatically constructing a Delta.
#[derive(Clone, Serialize)]
pub struct Commit {
    /// The subject URL that is to be modified by this Delta
    #[serde(rename = "https://atomicdata.dev/properties/subject")]
    pub subject: Subject,
    /// The date it was created, as a unix timestamp
    #[serde(rename = "https://atomicdata.dev/properties/createdAt")]
    pub created_at: i64,
    /// The URL of the one signing this Commit
    #[serde(rename = "https://atomicdata.dev/properties/signer")]
    pub signer: Subject,
    /// A Loro CRDT binary update for the entire resource document
    #[serde(rename = "https://atomicdata.dev/properties/loroUpdate")]
    pub loro_update: Option<Vec<u8>>,
    /// If set to true, deletes the entire resource
    #[serde(rename = "https://atomicdata.dev/properties/destroy")]
    pub destroy: Option<bool>,
    /// Base64 encoded signature of the JSON serialized Commit
    #[serde(rename = "https://atomicdata.dev/properties/signature")]
    pub signature: Option<String>,
    /// The previously applied commit to this Resource.
    #[serde(rename = "https://atomicdata.dev/properties/previousCommit")]
    pub previous_commit: Option<String>,
    /// Whether this is the first commit for a Resource.
    #[serde(rename = "https://atomicdata.dev/properties/isGenesis")]
    pub is_genesis: Option<bool>,
    /// The URL of the Commit
    pub url: Option<String>,
}

impl std::fmt::Debug for Commit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Commit")
            .field("subject", &self.subject)
            .field("created_at", &self.created_at)
            .field("signer", &self.signer)
            .field(
                "loro_update",
                &self.loro_update.as_ref().map(|v| format!("<{} bytes>", v.len())),
            )
            .field("destroy", &self.destroy)
            .field("signature", &self.signature)
            .field("previous_commit", &self.previous_commit)
            .field("is_genesis", &self.is_genesis)
            .field("url", &self.url)
            .finish()
    }
}

impl Commit {
    /// Throws an error if the parent is set to itself
    pub fn check_for_circular_parents(&self) -> AtomicResult<()> {
        // Check if the Loro update contains a parent property that matches the subject.
        if let Some(loro_bytes) = &self.loro_update {
            let doc = crate::loro::AtomicLoroDoc::from_snapshot(loro_bytes).or_else(|_| {
                let doc = crate::loro::AtomicLoroDoc::new();
                doc.import_update(loro_bytes)?;
                Ok::<_, crate::errors::AtomicError>(doc)
            })?;
            if let Some(parent) = doc.get_string_property(urls::PARENT) {
                if parent == self.subject {
                    return Err("Circular parent reference".into());
                }
            }
        }

        Ok(())
    }

    pub fn validate_previous_commit(
        &self,
        resource_old: &Resource,
        subject_url: &str,
    ) -> AtomicResult<()> {
        let commit = self;
        if let Ok(last_commit_val) = resource_old.get(urls::LAST_COMMIT) {
            let last_commit = last_commit_val.to_string();

            if let Some(prev_commit) = commit.previous_commit.clone() {
                // TODO: try auto merge
                if last_commit != prev_commit {
                    return Err(format!(
                        "previousCommit mismatch. Had lastCommit '{}' in Resource {}, but got in Commit '{}'. Perhaps you created the Commit based on an outdated version of the Resource.",
                        last_commit, subject_url, prev_commit,
                    )
                    .into());
                }
            } else {
                return Err(format!("Missing `previousCommit`. Resource {} already exists, and it has a `lastCommit` field, so a `previousCommit` field is required in your Commit.", commit.subject).into());
            }
        } else {
            // If there is no lastCommit in the Resource, we'll accept the Commit.
            tracing::warn!("No `lastCommit` in Resource. This can be a bug, or it could be that the resource was never properly updated.");
        }
        Ok(())
    }

    /// Creates a new Commit with a `did:ad` Subject.
    /// The ID of the Subject is the signature of the Commit.
    pub async fn create_did(
        mut commit_builder: CommitBuilder,
        agent: &crate::agents::Agent,
        store: &impl Storelike,
    ) -> AtomicResult<Commit> {
        let now = crate::utils::now();
        // Create a temporary commit with empty signature and subject
        // The subject is needed for serialization, but it will be removed for the signature check (and thus creation)
        let temp_subject = "did:ad:genesis".to_string();
        commit_builder.subject = temp_subject.clone().into();

        let loro_update = if let Some(update) = commit_builder.loro_update {
            Some(update)
        } else if !commit_builder.set.is_empty() || !commit_builder.remove.is_empty() {
            let doc = crate::loro::AtomicLoroDoc::new();
            for (prop, val) in &commit_builder.set {
                doc.set_property(prop, val)?;
            }
            for prop in &commit_builder.remove {
                doc.remove_property(prop)?;
            }
            Some(doc.export_snapshot())
        } else {
            None
        };

        let mut commit = Commit {
            subject: temp_subject.into(),
            signer: agent.subject.clone(),
            loro_update,
            destroy: Some(commit_builder.destroy),
            created_at: now,
            previous_commit: None,
            is_genesis: Some(true),
            signature: None,
            url: None,
        };

        // Serialize without subject
        let stringified = commit
            .serialize_deterministically_json_ad(store)
            .await
            .map_err(|e| format!("Failed serializing commit: {}", e))?;

        let private_key = agent.private_key.clone().ok_or("No private key in agent")?;
        let signature =
            sign_message(&stringified, &private_key, &agent.public_key).map_err(|e| {
                format!(
                    "Failed to sign message for new did:ad commit with agent {}: {}",
                    agent.subject, e
                )
            })?;

        commit.signature = Some(signature.clone());
        let did = format!("did:ad:{}", signature);
        commit.subject = did.into();

        Ok(commit)
    }

    /// Check if the Commit's signature matches the signer's public key.
    pub async fn validate_signature(&self, store: &impl Storelike) -> AtomicResult<()> {
        let commit = self;
        let signature = match commit.signature.as_ref() {
            Some(sig) => sig,
            None => return Err("No signature set".into()),
        };
        let signer_subject = store.normalize_subject(&commit.signer);
        // For agent DIDs, the public key IS the DID — extract directly.
        let pubkey_b64 = if commit.signer.is_agent_did() {
            commit
                .signer
                .as_str()
                .strip_prefix("did:ad:agent:")
                .ok_or("Invalid did:ad:agent signer")?
                .to_string()
        } else if let Ok(resource) = store.get_resource(&signer_subject).await {
            resource.get(urls::PUBLIC_KEY)?.to_string()
        } else if let crate::Subject::Internal { url, .. } = &signer_subject {
            // Legacy HTTP agents: extract key from URL path
            let path = url.path();
            if path.starts_with("/agents/") {
                path.strip_prefix("/agents/").unwrap().to_string()
            } else {
                return Err(format!("Signer {} not found in store", commit.signer).into());
            }
        } else {
            return Err(format!("Signer {} not found and cannot extract public key", commit.signer).into());
        };
        let agent_pubkey = decode_base64(&pubkey_b64)?;
        let stringified_commit = commit.serialize_deterministically_json_ad(store).await?;
        let pubkey_bytes: [u8; 32] = agent_pubkey
            .try_into()
            .map_err(|_| "Ed25519 public key must be 32 bytes")?;
        let verifying_key = ed25519_dalek::VerifyingKey::from_bytes(&pubkey_bytes)
            .map_err(|e| format!("Invalid public key: {}", e))?;
        let signature_bytes = decode_base64(signature)?;
        let sig_bytes: [u8; 64] = signature_bytes
            .try_into()
            .map_err(|_| "Ed25519 signature must be 64 bytes")?;
        let sig = ed25519_dalek::Signature::from_bytes(&sig_bytes);
        use ed25519_dalek::Verifier;
        verifying_key
            .verify(stringified_commit.as_bytes(), &sig)
            .map_err(|_e| {
                format!(
                    "Incorrect signature for Commit. This could be due to an error during signing or serialization of the commit. Compare this to the serialized commit in the server: {}",
                    stringified_commit,
                )
            })?;

        // For genesis resource commits (did:ad:{signature}), the subject must equal the signature.
        // Agent DIDs (did:ad:agent:{pubkey}) are identity-based and exempt from this check.
        if commit.subject.is_did()
            && !commit.subject.is_agent_did()
            && commit.previous_commit.is_none()
        {
            let subject_val = commit
                .subject
                .as_str()
                .strip_prefix("did:ad:")
                .ok_or("Invalid did:ad subject")?;
            if subject_val != signature {
                return Err(format!(
                    "Invalid did:ad subject. Expected 'did:ad:{}' but got '{}'",
                    signature, commit.subject
                )
                .into());
            }
        }
        Ok(())
    }

    /// Performs the checks specified in CommitOpts and constructs a new Resource.
    /// Warning: Does not save the new resource to the Store - doet not delete if it `destroy: true`.
    /// Use [Storelike::apply_commit] to save the resource to the Store.
    pub async fn validate_and_build_response(
        self,
        opts: &CommitOpts,
        store: &impl Storelike,
    ) -> AtomicResult<CommitResponse> {
        let commit = self;
        let subject = Subject::from(commit.subject.clone());

        if subject.is_did() && subject.as_str().starts_with("did:ad:") {
            let pure_id = subject.pure_id();
            let b64_part = if subject.is_agent_did() {
                pure_id.strip_prefix("did:ad:agent:")
            } else if subject.is_commit_did() {
                pure_id.strip_prefix("did:ad:commit:")
            } else {
                pure_id.strip_prefix("did:ad:")
            }
            .ok_or("Invalid DID format")?;

            let decoded = crate::agents::decode_base64(b64_part)
                .map_err(|_| "Invalid DID: not valid base64")?;

            let expected_len = if subject.is_agent_did() { 32 } else { 64 };
            if decoded.len() != expected_len {
                return Err(format!(
                    "Invalid DID: expected {} bytes, got {}. DID subjects cannot contain a path.",
                    expected_len,
                    decoded.len()
                )
                .into());
            }
        }

        let subject_url = match &subject {
            Subject::Internal { url, .. } => url.clone(),
            Subject::External(u) => u.clone(),
            Subject::Did { url, .. } => url.clone(),
        };

        if subject_url.query().is_some() {
            return Err("Subject URL cannot have query parameters".into());
        }

        if opts.validate_signature {
            commit.validate_signature(store).await?;
        }
        if opts.validate_timestamp {
            commit.validate_timestamp()?;
        }

        commit.check_for_circular_parents()?;

        // Create a new resource if it doesn't exist yet.
        // For agent DIDs, get_resource() returns a synthetic "just-in-time" agent
        // even when no data is stored. Detect this by checking for a lastCommit —
        // a real stored resource always has one after its genesis commit.
        let (resource_old, is_new) = match store.get_resource(&commit.subject.clone().into()).await
        {
            Ok(rs) => {
                let is_synthetic_agent = commit.subject.is_agent_did()
                    && rs.get(urls::LAST_COMMIT).is_err();
                if is_synthetic_agent {
                    // Treat synthetic fallback agents as non-existent so genesis
                    // commits work and the Loro doc is built from scratch.
                    (
                        Resource::new(
                            store
                                .normalize_subject(&commit.subject.clone().into())
                                .to_string(),
                        ),
                        true,
                    )
                } else {
                    (rs, false)
                }
            }
            Err(_) => (
                Resource::new(
                    store
                        .normalize_subject(&commit.subject.clone().into())
                        .to_string(),
                ),
                true,
            ),
        };

        if let Some(explicit_genesis) = commit.is_genesis {
            if explicit_genesis && !is_new {
                return Err(format!(
                    "Commit for {} has is_genesis: true, but the resource already exists.",
                    commit.subject
                )
                .into());
            }
            if !explicit_genesis && is_new {
                return Err(format!(
                    "Commit for {} has is_genesis: false, but the resource does not exist yet.",
                    commit.subject
                )
                .into());
            }
        }

        // Mandatory chaining for DID resources: if it exists, it must have a previousCommit.
        // Exception: Agents (did:ad:agent:...) don't have genesis commits in the same way,
        // so we allow updates without previousCommit for agents.
        let is_agent = commit.subject.is_agent_did();
        if !is_new && subject.is_did() && !is_agent && commit.previous_commit.is_none() {
            return Err(format!(
                "Resource {} already exists. Updates to DID resources must provide a `previousCommit` to prevent accidental forks.",
                commit.subject
            ).into());
        }

        // Make sure the one creating the commit had the same idea of what the current state is.
        if !is_new && opts.validate_previous_commit {
            commit.validate_previous_commit(&resource_old, subject_url.as_str())?;
        };

        // Reject commits that carry no Loro update and aren't a destroy.
        // Loro is the single source of truth for all user data; a commit
        // without it cannot change any searchable state. Previously, such
        // commits (typically legacy `set`/`push` bodies from old client code)
        // appeared to succeed but left the resource un-indexed — the search
        // index read from propvals, which only get materialized when Loro
        // imports fire. A destroy commit is the one exception.
        let is_destroy = commit.destroy.unwrap_or(false);
        if commit.loro_update.is_none() && !is_destroy {
            return Err(format!(
                "Commit for {} has no `loroUpdate` and is not a destroy. Loro \
                 is required for all state-changing commits — legacy `set` / \
                 `push` / `remove` maps are not applied. Please upgrade the \
                 client to send Loro updates.",
                commit.subject
            )
            .into());
        }

        let mut applied = commit
            .apply_changes(resource_old.clone())
            .await
            .map_err(|e| {
                format!(
                    "Error applying changes to Resource {}. {}",
                    commit.subject, e
                )
            })?;

        // Causality guard: a commit with a non-trivial loroUpdate that
        // produces ZERO net state change means the incoming ops lost LWW
        // against stored state — silent drop. Happens when the client's
        // Loro doc isn't seeded from the server's state (fresh peer ID,
        // concurrent writes). Reject so the silent data loss surfaces.
        //
        // Exemptions:
        // - destroy commits (no Loro merge to evaluate).
        // - tiny/empty loroUpdate (client didn't really try to write).
        // - genesis commits (is_new): there is no stored state to lose to,
        //   so an empty diff here just means the client's Loro ops didn't
        //   translate into materialized atoms (e.g. raw container init
        //   without value writes). Not the bug we're catching.
        if opts.validate_loro_causality
            && !is_new
            && !commit.destroy.unwrap_or(false)
            && commit.loro_update.as_ref().map(|b| b.len()).unwrap_or(0) > 16
            && applied.add_atoms.is_empty()
            && applied.remove_atoms.is_empty()
        {
            // Decode the incoming update in isolation to see what the client
            // INTENDED to write. Works cleanly when the client sends snapshots;
            // may be empty for pure deltas.
            let incoming_intent = commit
                .loro_update
                .as_ref()
                .map(|bytes| {
                    let doc = crate::loro::AtomicLoroDoc::new();
                    let _ = doc.import_update(bytes);
                    doc.get_all_properties()
                })
                .unwrap_or_default();
            let merged_doc = applied.resource_new.build_loro_doc_from_state()?;
            let merged_state = merged_doc.get_all_properties();

            // Idempotent replay check: if every property the client tried to
            // write already matches the merged state exactly, the commit is a
            // no-op, not a silent drop. Let it through — the client simply
            // re-sent state that was already correct (common pattern when an
            // UI flow calls `resource.set(x, v)` with the same v that's
            // already stored, then saves).
            let all_match = !incoming_intent.is_empty()
                && incoming_intent.iter().all(|(key, incoming_val)| {
                    merged_state.get(key).is_some_and(|mv| mv == incoming_val)
                });

            if all_match {
                tracing::debug!(
                    subject = %commit.subject,
                    keys = ?incoming_intent.keys().collect::<Vec<_>>(),
                    "[causality-guard] accepting idempotent no-op commit (values match stored state)"
                );
            } else {
                tracing::warn!(
                    subject = %commit.subject,
                    loro_bytes = commit.loro_update.as_ref().map(|b| b.len()).unwrap_or(0),
                    incoming_intent = ?incoming_intent,
                    merged_state = ?merged_state,
                    "[causality-guard] rejecting commit with non-trivial loroUpdate that produced no state changes (silent LWW loss)"
                );

                return Err(format!(
                    "Commit's Loro update produced no state changes — its writes were \
                     silently dropped by LWW against stored state. The client's Loro doc \
                     wasn't seeded from the server's current state. Refetch the resource \
                     and retry the commit. subject={} incoming_intent={:?} merged_state_keys={:?}",
                    commit.subject,
                    incoming_intent
                        .iter()
                        .map(|(k, v)| format!("{k} = {v:?}"))
                        .collect::<Vec<_>>(),
                    merged_state.keys().collect::<Vec<_>>(),
                )
                .into());
            }
        }

        if opts.validate_rights {
            let signer_str = commit.signer.to_string();
            let validate_for = opts.validate_for_agent.as_ref().unwrap_or(&signer_str);
            if is_new {
                crate::hierarchy::check_append(store, &applied.resource_new, &validate_for.into())
                    .await?;
                // For new DID resources, grant the signer explicit write access so future
                // commits don't need drive-level rights. Agents are excluded because they
                // already have self-write via their subject matching the agent check.
                if matches!(applied.resource_new.get_subject(), Subject::Did { .. }) {
                    let is_agent = applied
                        .resource_new
                        .get(urls::IS_A)
                        .ok()
                        .and_then(|v| v.to_subjects(None).ok())
                        .unwrap_or_default()
                        .iter()
                        .any(|c| c == urls::AGENT);
                    if !is_agent {
                        let mut writers: Vec<String> = applied
                            .resource_new
                            .get(urls::WRITE)
                            .ok()
                            .and_then(|v| v.to_subjects(None).ok())
                            .unwrap_or_default();
                        if !writers.contains(&signer_str) {
                            writers.push(signer_str.clone());
                            applied
                                .resource_new
                                .set_unsafe(urls::WRITE.into(), writers.into());
                        }
                    }
                }
            } else {
                // This should use the _old_ resource, not the new one, as the new one might maliciously give itself write rights.
                crate::hierarchy::check_write(store, &resource_old, &validate_for.into()).await?;
            }
        };
        // Check if all required props are there
        if opts.validate_schema {
            applied.resource_new.check_required_props(store).await?;
        }

        let commit_resource: Resource = commit.into_resource(store).await?;

        // Set the `lastCommit` to the newly created Commit
        applied
            .resource_new
            .set(
                urls::LAST_COMMIT.to_string(),
                Value::AtomicUrl(commit_resource.get_subject().clone()),
                store,
            )
            .await?;

        let destroyed = commit.destroy.unwrap_or(false);

        Ok(CommitResponse {
            commit,
            add_atoms: applied.add_atoms,
            remove_atoms: applied.remove_atoms,
            commit_resource,
            resource_new: if destroyed {
                None
            } else {
                Some(applied.resource_new)
            },
            resource_old: if is_new {
                None
            } else {
                Some(applied.resource_old)
            },
            changed_props: applied.changed_props,
        })
    }

    /// Checks if the Commit has been created in the future or if it is expired.
    #[tracing::instrument(skip_all)]
    pub fn validate_timestamp(&self) -> AtomicResult<()> {
        crate::utils::check_timestamp_in_past(self.created_at, ACCEPTABLE_TIME_DIFFERENCE)
    }

    /// Applies the Loro CRDT update and/or destroy to the Resource.
    /// Returns the diff as atoms for index updates, plus the set of changed property URLs.
    #[tracing::instrument(skip_all)]
    pub async fn apply_changes(&self, mut resource: Resource) -> AtomicResult<CommitApplied> {
        let resource_unedited = resource.clone();

        let mut remove_atoms: Vec<Atom> = Vec::new();
        let mut add_atoms: Vec<Atom> = Vec::new();
        let mut changed_props: HashSet<String> = HashSet::new();

        if let Some(loro_update_bytes) = &self.loro_update {
            // Seed from the current resource state when no snapshot exists yet so
            // older resources can still apply snapshot/delta updates correctly.
            let loro_doc = resource.build_loro_doc_from_state()?;

            // Import the update and compute the property-level diff for indexing
            let diff = loro_doc
                .import_update_with_diff(loro_update_bytes, &resource.get_subject().to_string())?;

            // Track which properties changed
            for atom in &diff.add_atoms {
                changed_props.insert(atom.property.clone());
            }
            for atom in &diff.remove_atoms {
                changed_props.insert(atom.property.clone());
            }

            add_atoms.extend(diff.add_atoms);
            remove_atoms.extend(diff.remove_atoms);

            // Rebuild the materialized resource state from the merged Loro doc so
            // deleted properties disappear from propvals as well.
            resource.replace_state_from_loro_doc(loro_doc)?;
        }

        // Remove all atoms from index if destroy
        if let Some(destroy) = self.destroy {
            if destroy {
                for atom in resource.to_atoms().into_iter() {
                    remove_atoms.push(atom);
                }
            }
        }

        Ok(CommitApplied {
            resource_old: resource_unedited,
            resource_new: resource,
            add_atoms,
            remove_atoms,
            changed_props,
        })
    }

    /// Converts a Resource of a Commit into a Commit
    pub fn from_resource(resource: Resource) -> AtomicResult<Commit> {
        let subject = resource.get(urls::SUBJECT)?.to_string();
        let created_at = resource.get(urls::CREATED_AT)?.to_int()?;
        let signer = resource.get(SIGNER)?.to_string();
        let loro_update = match resource.get(urls::LORO_UPDATE) {
            Ok(Value::LoroDoc(bin)) => Some(bin.clone()),
            _ => None,
        };
        let destroy = match resource.get(urls::DESTROY) {
            Ok(found) => Some(found.to_bool()?),
            Err(_) => None,
        };
        let previous_commit = match resource.get(urls::PREVIOUS_COMMIT) {
            Ok(found) => Some(found.to_string()),
            Err(_) => None,
        };
        let is_genesis = match resource.get(urls::IS_GENESIS) {
            Ok(found) => Some(found.to_bool()?),
            Err(_) => None,
        };
        let signature = resource.get(urls::SIGNATURE)?.to_string();
        let url = Some(resource.get_subject().to_string());

        Ok(Commit {
            subject: subject.into(),
            created_at,
            signer: signer.into(),
            loro_update,
            destroy,
            previous_commit,
            is_genesis,
            signature: Some(signature),
            url,
        })
    }

    /// Converts the Commit into a Resource with Atomic Values.
    /// Creates an identifier using the server_url
    /// Works for both Signed and Unsigned Commits
    #[tracing::instrument(skip_all)]
    pub async fn into_resource(&self, store: &impl Storelike) -> AtomicResult<Resource> {
        let commit_subject = match self.signature.as_ref() {
            Some(sig) => format!("did:ad:commit:{}", sig),
            None => {
                let now = crate::utils::now();
                format!("internal:/commitsUnsigned/{}", now)
            }
        };
        let mut resource = Resource::new_instance(urls::COMMIT, store).await?;
        resource.set_subject(commit_subject);
        resource.set_unsafe(
            urls::SUBJECT.into(),
            Value::new(self.subject.as_str(), &DataType::AtomicUrl)?,
        );
        let classes = vec![urls::COMMIT.to_string()];
        resource.set_unsafe(urls::IS_A.into(), classes.into());
        resource.set_unsafe(
            urls::CREATED_AT.into(),
            Value::new(&self.created_at.to_string(), &DataType::Timestamp)?,
        );
        resource.set_unsafe(
            SIGNER.into(),
            Value::new(self.signer.as_str(), &DataType::AtomicUrl)?,
        );
        if let Some(destroy) = self.destroy {
            if destroy {
                resource.set_unsafe(urls::DESTROY.into(), true.into());
            }
        }
        if let Some(previous_commit) = &self.previous_commit {
            resource.set_unsafe(
                urls::PREVIOUS_COMMIT.into(),
                Value::AtomicUrl(previous_commit.clone().into()),
            );
        }
        if let Some(is_genesis) = self.is_genesis {
            resource.set_unsafe(urls::IS_GENESIS.into(), is_genesis.into());
        }
        if let Some(loro_update) = &self.loro_update {
            if !loro_update.is_empty() {
                resource.set_unsafe(
                    urls::LORO_UPDATE.into(),
                    Value::LoroDoc(loro_update.clone()),
                );
            }
        }
        resource.set_unsafe(
            SIGNER.into(),
            Value::new(self.signer.as_str(), &DataType::AtomicUrl)?,
        );
        if let Some(signature) = &self.signature {
            resource.set_unsafe(urls::SIGNATURE.into(), signature.clone().into());
        }
        Ok(resource)
    }

    pub fn get_subject(&self) -> &Subject {
        &self.subject
    }

    /// Generates a deterministic serialized JSON-AD representation of the Commit.
    /// Removes the signature from the object before serializing, since this function is used to check if the signature is correct.
    #[tracing::instrument(skip_all)]
    pub async fn serialize_deterministically_json_ad(
        &self,
        store: &impl Storelike,
    ) -> AtomicResult<String> {
        let mut commit_resource = self.into_resource(store).await?;
        // A deterministic serialization should not contain the hash (signature), since that would influence the hash.
        commit_resource.remove_propval(urls::SIGNATURE);

        let is_did_non_agent = self.subject.is_did() && !self.subject.is_agent_did();
        let is_genesis_flag = self.is_genesis == Some(true);
        let has_previous = self.previous_commit.is_some();

        // Validate consistency between is_genesis flag and structural state.
        if is_genesis_flag && has_previous {
            return Err(format!(
                "Commit has is_genesis=true but also has a previous_commit ({}). A genesis commit cannot have a predecessor.",
                self.previous_commit.as_ref().unwrap()
            ).into());
        }
        if is_did_non_agent && !has_previous && !is_genesis_flag {
            return Err(format!(
                "Commit targets did:ad: subject '{}' with no previous_commit but is_genesis is not set. \
                 DID genesis commits must explicitly set is_genesis=true.",
                self.subject
            ).into());
        }

        // For genesis commits the subject is derived from the signature, so it
        // must not be part of the signed bytes (circular dependency).
        // is_genesis stays in the bytes so both sides sign/verify the same content.
        if is_genesis_flag {
            commit_resource.remove_propval(urls::SUBJECT);
        }
        let json_obj = crate::serialize::propvals_to_json_ad_map(
            commit_resource.get_propvals(),
            None,
            &store
                .get_base_domain()
                .unwrap_or_else(|| "internal".to_string()),
            false,
        )?;
        let json = serde_jcs::to_string(&json_obj)
            .map_err(|e| format!("Failed to serialize Commit: {}", e))?;
        Ok(json)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CommitBuilderJSON {
    pub subject: String,
    pub loro_update: Option<String>,
    pub destroy: bool,
    pub previous_commit: Option<String>,
}

/// Use this for creating Commits.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CommitBuilder {
    /// The subject URL that is to be modified by this Delta.
    pub subject: Subject,
    /// Property changes accumulated on the server side.
    /// These get converted to a Loro update at sign time.
    set: std::collections::HashMap<String, Value>,
    /// Properties to remove. Converted to Loro operations at sign time.
    remove: HashSet<String>,
    /// A Loro CRDT binary update (from client). Takes precedence over set/remove.
    loro_update: Option<Vec<u8>>,
    /// If set to true, deletes the entire resource
    destroy: bool,
    /// The previous Commit that was applied to the target resource (the subject) of this Commit.
    previous_commit: Option<String>,
    /// Whether this is a genesis commit (the first commit for a DID resource).
    pub is_genesis: bool,
}

impl CommitBuilder {
    /// Start constructing a Commit.
    pub fn new(subject: Subject) -> Self {
        CommitBuilder {
            subject,
            set: HashMap::new(),
            remove: HashSet::new(),
            loro_update: None,
            destroy: false,
            previous_commit: None,
            is_genesis: false,
        }
    }

    pub fn from_commit_builder_json(commit_builder_json: CommitBuilderJSON) -> AtomicResult<Self> {
        let mut commit_builder = CommitBuilder::new(commit_builder_json.subject.into());

        commit_builder.destroy(commit_builder_json.destroy);

        if let Some(loro_b64) = commit_builder_json.loro_update {
            let bin = crate::agents::decode_base64(&loro_b64)
                .map_err(|e| format!("Invalid base64 in loro_update: {e}"))?;
            commit_builder.set_loro_update(bin);
        }

        Ok(commit_builder)
    }

    /// Creates the Commit and signs it using a signature.
    /// Does not send it - see [atomic_lib::client::post_commit].
    /// Private key is the base64 encoded pkcs8 for the signer.
    /// Sets the `previousCommit` using the `lastCommit`.
    pub async fn sign(
        mut self,
        agent: &crate::agents::Agent,
        store: &impl Storelike,
        resource: &Resource,
    ) -> AtomicResult<Commit> {
        if let Ok(last) = resource.get(urls::LAST_COMMIT) {
            self.previous_commit = Some(last.to_string());
        }

        // If the resource has a live Loro doc but no snapshot was eagerly
        // exported to the commit builder, export it now (single export).
        if self.loro_update.is_none() {
            if let Some(snapshot) = resource.export_loro_snapshot() {
                self.loro_update = Some(snapshot);
            }
        }

        // Pass the resource's existing Loro snapshot so sign_at can build
        // incremental updates on top of it instead of creating a detached doc.
        //
        // We try three sources, in order:
        //   1. the resource's `loroUpdate` propval (preferred — already a snapshot),
        //   2. `resource.export_loro_snapshot()` if it has a live Loro doc,
        //   3. build a Loro doc from the resource's propvals and snapshot that.
        //
        // Without (3), resources whose state lives only in propvals (e.g.
        // legacy agent rows added via `set_unsafe`) would give `sign_at` no
        // base snapshot, so it would build the commit's Loro update on a
        // FRESH doc. That update then merges concurrently with the receiver's
        // seeded-from-propvals doc; LWW tie-breaks by peer-id and often
        // silently drops the incoming writes — the exact symptom seen in
        // `test_did_agent_edit` where an agent name edit didn't persist.
        let existing_snapshot: Option<Vec<u8>> =
            match resource.get(urls::LORO_UPDATE) {
                Ok(Value::LoroDoc(snapshot)) => Some(snapshot.clone()),
                _ => resource.export_loro_snapshot().or_else(|| {
                    // Fall back to seeding a doc from propvals.
                    resource
                        .build_loro_doc_from_state()
                        .ok()
                        .map(|doc| doc.export_snapshot())
                }),
            };

        let now = crate::utils::now();
        sign_at(self, agent, now, store, existing_snapshot.as_deref()).await
    }

    /// Set a property value. On sign, this gets converted to a Loro update.
    pub fn set(&mut self, prop: String, val: Value) {
        self.set.insert(prop, val);
    }

    /// Mark a property for removal. On sign, this gets converted to a Loro update.
    pub fn remove(&mut self, prop: String) {
        self.remove.insert(prop);
    }

    /// Appends a URL or nested Resource to a ResourceArray.
    pub fn push_propval(&mut self, property: &str, value: SubResource) -> AtomicResult<()> {
        let mut vec = match self.set.get(property) {
            Some(Value::ResourceArray(resources)) => resources.to_owned(),
            _ => Vec::new(),
        };
        vec.push(value);
        self.set.insert(property.into(), Value::ResourceArray(vec));
        Ok(())
    }

    /// Set a new subject for this Commit
    pub fn set_subject(&mut self, subject: Subject) {
        self.subject = subject;
    }

    /// Set a Loro CRDT binary update for this commit.
    pub fn set_loro_update(&mut self, update: Vec<u8>) {
        self.loro_update = Some(update);
    }

    /// Whether the resource needs to be removed fully
    pub fn destroy(&mut self, destroy: bool) {
        self.destroy = destroy
    }
}

/// Signs a CommitBuilder at a specific unix timestamp.
/// `existing_loro_snapshot` is the resource's current Loro state, if any.
/// When provided, the set/remove operations are applied on top of it and
/// an incremental update is exported. Without it, a full snapshot is created
/// (appropriate for genesis commits or when no prior state exists).
#[tracing::instrument(skip_all)]
async fn sign_at(
    commitbuilder: CommitBuilder,
    agent: &crate::agents::Agent,
    sign_date: i64,
    store: &impl Storelike,
    existing_loro_snapshot: Option<&[u8]>,
) -> AtomicResult<Commit> {
    // If no Loro update was provided (i.e. server-side commit), convert
    // the accumulated set/remove operations into a Loro update.
    let loro_update = if let Some(update) = commitbuilder.loro_update {
        Some(update)
    } else if !commitbuilder.set.is_empty() || !commitbuilder.remove.is_empty() {
        // Build on top of existing state if available, so the Loro CRDT
        // correctly tracks causality and the update merges deterministically.
        let doc = if let Some(snapshot) = existing_loro_snapshot {
            crate::loro::AtomicLoroDoc::from_snapshot(snapshot)?
        } else {
            crate::loro::AtomicLoroDoc::new()
        };
        for (prop, val) in &commitbuilder.set {
            doc.set_property(prop, val)?;
        }
        for prop in &commitbuilder.remove {
            doc.remove_property(prop)?;
        }
        // Always export a full snapshot — the receiver's apply_changes will
        // import it into its own doc and compute the diff.
        Some(doc.export_snapshot())
    } else {
        None
    };

    let mut commit = Commit {
        subject: commitbuilder.subject,
        signer: agent.subject.clone(),
        loro_update,
        destroy: Some(commitbuilder.destroy),
        created_at: sign_date,
        previous_commit: commitbuilder.previous_commit,
        is_genesis: if commitbuilder.is_genesis {
            Some(true)
        } else {
            None
        },
        signature: None,
        url: None,
    };
    let stringified = commit
        .serialize_deterministically_json_ad(store)
        .await
        .map_err(|e| format!("Failed serializing commit: {}", e))?;
    let private_key = agent.private_key.clone().ok_or("No private key in agent")?;
    let signature = sign_message(&stringified, &private_key, &agent.public_key).map_err(|e| {
        format!(
            "Failed to sign message for resource {} with agent {}: {}",
            commit.subject, agent.subject, e
        )
    })?;
    commit.signature = Some(signature);
    Ok(commit)
}

/// Signs a string using a base64 encoded ed25519 private key. Outputs a base64 encoded ed25519 signature.
#[tracing::instrument(skip_all)]
pub fn sign_message(message: &str, private_key: &str, public_key: &str) -> AtomicResult<String> {
    let private_key_bytes = decode_base64(private_key)
        .map_err(|e| format!("Failed decoding private key {}: {}", private_key, e))?;
    let public_key_bytes = decode_base64(public_key)
        .map_err(|e| format!("Failed decoding public key {}: {}", public_key, e))?;
    let seed: [u8; 32] = private_key_bytes
        .try_into()
        .map_err(|_| "Ed25519 private key must be 32 bytes")?;
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&seed);
    // Verify the public key matches
    let derived_public = signing_key.verifying_key();
    if derived_public.as_bytes() != public_key_bytes.as_slice() {
        return Err("Public key does not match private key".into());
    }
    use ed25519_dalek::Signer;
    let message_bytes = message.as_bytes();
    let signature = signing_key.sign(message_bytes);
    Ok(encode_base64(&signature.to_bytes()))
}

/// The amount of milliseconds that a Commit signature is valid for.
const ACCEPTABLE_TIME_DIFFERENCE: i64 = 10000;

#[cfg(test)]
mod test {
    lazy_static::lazy_static! {
        pub static ref OPTS: CommitOpts = CommitOpts {
            validate_schema: true,
            validate_signature: true,
            validate_timestamp: true,
            validate_previous_commit: true,
            validate_loro_causality: true,
            validate_rights: false,
            validate_for_agent: None,
            update_index: true,
        };
    }

    use super::*;
    use crate::{agents::Agent, Store, Storelike};

    #[tokio::test]
    async fn agent_and_commit() {
        let store = Store::init().await.unwrap();
        store.set_base_url("http://localhost:9883");
        store.populate().await.unwrap();
        let agent = store.create_agent(Some("test_actor")).await.unwrap();
        let subject = "https://localhost/new_thing";
        let resource = Resource::new(subject.into());
        let mut commitbuiler = crate::commit::CommitBuilder::new(subject.into());
        let property1 = crate::urls::DESCRIPTION;
        let value1 = Value::new("Some value", &DataType::Markdown).unwrap();
        commitbuiler.set(property1.into(), value1.clone());
        let property2 = crate::urls::SHORTNAME;
        let value2 = Value::new("someval", &DataType::Slug).unwrap();
        commitbuiler.set(property2.into(), value2);
        let commit = commitbuiler.sign(&agent, &store, &resource).await.unwrap();
        let commit_subject = commit.get_subject().to_string();
        let _created_resource = store.apply_commit(commit, &OPTS).await.unwrap();

        let resource = store.get_resource(&subject.into()).await.unwrap();
        assert!(resource.get(property1).unwrap().to_string() == value1.to_string());
        let found_commit = store
            .get_resource(&commit_subject.as_str().into())
            .await
            .unwrap();
        println!("Found commit subject: {}", found_commit.get_subject());
        println!("Found commit props: {:?}", found_commit.get_propvals());

        assert!(
            found_commit
                .get_shortname("description", &store)
                .await
                .unwrap()
                .to_string()
                == value1.to_string()
        );
    }

    #[tokio::test]
    async fn serialize_commit() {
        let store = Store::init().await.unwrap();
        store.set_base_url("http://localhost:9883");
        store.populate().await.unwrap();
        // Build a Loro update with some properties
        let doc = crate::loro::AtomicLoroDoc::new();
        doc.set_property(urls::SHORTNAME, &Value::String("shortname".into()))
            .unwrap();
        doc.set_property(urls::DESCRIPTION, &Value::String("Some description".into()))
            .unwrap();
        let loro_update = doc.export_snapshot();

        let commit = Commit {
            subject: "https://localhost/test".into(),
            created_at: 1603638837,
            signer: "https://localhost/author".into(),
            loro_update: Some(loro_update),
            previous_commit: None,
            is_genesis: None,
            destroy: None,
            signature: None,
            url: None,
        };
        let serialized = commit
            .serialize_deterministically_json_ad(&store)
            .await
            .unwrap();
        // Verify deterministic: serialize twice, must match
        let serialized2 = commit
            .serialize_deterministically_json_ad(&store)
            .await
            .unwrap();
        assert_eq!(serialized, serialized2);
        // Must contain loroUpdate and core fields
        assert!(serialized.contains("loroUpdate"));
        assert!(serialized.contains("https://atomicdata.dev/properties/signer"));
    }

    #[tokio::test]
    async fn signature_matches() {
        let store = Store::init().await.unwrap();
        store.set_base_url("http://localhost:9883");
        let private_key = "CapMWIhFUT+w7ANv9oCPqrHrwZpkP2JhzF9JnyT6WcI=";
        let agent = Agent::new_from_private_key(None, private_key).unwrap();
        assert_eq!(
            agent.subject,
            "did:ad:agent:7LsjMW5gOfDdJzK/atgjQ1t20J/rw8MjVg6xwqm+h8U="
        );
        store
            .add_resource(&agent.to_resource().unwrap())
            .await
            .unwrap();
        let subject = "https://localhost/new_thing";
        let mut commitbuilder = crate::commit::CommitBuilder::new(subject.into());
        let property1 = crate::urls::DESCRIPTION;
        let value1 = Value::new("Some value", &DataType::String).unwrap();
        commitbuilder.set(property1.into(), value1);
        let property2 = crate::urls::SHORTNAME;
        let value2 = Value::new("someval", &DataType::String).unwrap();
        commitbuilder.set(property2.into(), value2);
        let commit = sign_at(commitbuilder, &agent, 0, &store, None)
            .await
            .unwrap();
        let serialized = commit
            .serialize_deterministically_json_ad(&store)
            .await
            .unwrap();

        // Commits now use loroUpdate instead of set
        assert!(
            serialized.contains("loroUpdate"),
            "Commit should contain loroUpdate, got: {}",
            serialized
        );
        assert!(
            !serialized.contains("\"set\""),
            "Commit should not contain legacy set field"
        );
        // Verify signature is valid
        commit.validate_signature(&store).await.unwrap();
    }

    #[test]
    fn signature_basics() {
        let private_key = "CapMWIhFUT+w7ANv9oCPqrHrwZpkP2JhzF9JnyT6WcI=";
        let public_key = "7LsjMW5gOfDdJzK/atgjQ1t20J/rw8MjVg6xwqm+h8U=";
        let signature_expected = "YtDR/xo0272LHNBQtDer4LekzdkfUANFTI0eHxZhITXnbC3j0LCqDWhr6itNvo4tFnep6DCbev5OKAHH89+TDA==";
        let message = "val";
        let signature = sign_message(message, private_key, public_key).unwrap();
        assert_eq!(signature, signature_expected);
    }

    #[tokio::test]
    async fn invalid_subjects() {
        let store = Store::init().await.unwrap();
        store.set_base_url("http://localhost:9883");
        store.populate().await.unwrap();
        let agent = store.create_agent(Some("test_actor")).await.unwrap();
        let resource = Resource::new("https://localhost/test_resource".into());

        // Helper — commits now must carry a loro_update (enforced by
        // validate_and_build_response). Attach an empty-but-present Loro doc
        // so the test exercises subject validation, not Loro absence.
        let minimal_loro = || {
            let doc = crate::loro::AtomicLoroDoc::new();
            doc.export_snapshot()
        };

        // Note: "invalid URL" now parses as Subject::Internal, which is valid
        // in the in-memory Store. Subject validation is handled by the Subject type itself.
        {
            let subject = "https://localhost/?q=invalid";
            let mut commitbuilder = crate::commit::CommitBuilder::new(subject.into());
            commitbuilder.set_loro_update(minimal_loro());
            let commit = commitbuilder.sign(&agent, &store, &resource).await.unwrap();
            store.apply_commit(commit, &OPTS).await.unwrap_err();
        }
        {
            let subject = "https://localhost/valid";
            let mut commitbuilder = crate::commit::CommitBuilder::new(subject.into());
            commitbuilder.set_loro_update(minimal_loro());
            let commit = commitbuilder.sign(&agent, &store, &resource).await.unwrap();
            store.apply_commit(commit, &OPTS).await.unwrap();
        }
        {
            // A did:ad: subject with a subpath is structurally invalid.
            // sign() now enforces that did:ad: commits without a previous_commit
            // must have is_genesis=true, so we set that here. apply_commit then
            // rejects the subpath as "Invalid DID".
            let subject = "did:ad:cbXxQGm7UBBS5JPvl/NR/p9RJNbSMUjvA7lRYQt9lZvKZrU1FBo6Icl5uctr7i1AMZ/mElWZ3X1dApo5ifzmBg==/subpath";
            let mut commitbuilder = crate::commit::CommitBuilder::new(subject.into());
            commitbuilder.is_genesis = true;
            commitbuilder.set_loro_update(minimal_loro());
            let commit = commitbuilder.sign(&agent, &store, &resource).await.unwrap();
            let err = store.apply_commit(commit, &OPTS).await.unwrap_err();
            assert!(
                err.to_string().contains("Invalid DID"),
                "Expected Invalid DID error, got: {}",
                err
            );
        }
    }

    // ── DID commit tests ────────────────────────────────────────────────────

    /// Helper: build a store with a known agent whose private key we control.
    async fn store_with_known_agent() -> (crate::Store, Agent) {
        let store = Store::init().await.unwrap();
        store.set_base_url("http://localhost:9883");
        store.populate().await.unwrap();
        let private_key = "CapMWIhFUT+w7ANv9oCPqrHrwZpkP2JhzF9JnyT6WcI=";
        let agent = Agent::new_from_private_key(None, private_key).unwrap();
        store
            .add_resource(&agent.to_resource().unwrap())
            .await
            .unwrap();
        (store, agent)
    }

    /// Creating a new `did:ad:` resource via genesis commit should succeed and
    /// the resulting resource subject must start with `did:ad:`.
    #[tokio::test]
    async fn did_genesis_commit_creates_resource() {
        let (store, agent) = store_with_known_agent().await;
        let mut builder = CommitBuilder::new("placeholder".into());
        builder.set(
            crate::urls::DESCRIPTION.into(),
            Value::new("hello", &DataType::Markdown).unwrap(),
        );
        let commit = Commit::create_did(builder, &agent, &store).await.unwrap();
        assert!(
            commit.subject.is_did(),
            "genesis subject should be a DID, got {}",
            commit.subject
        );
        assert!(!commit.subject.is_agent_did());
        let opts = CommitOpts {
            validate_signature: true,
            validate_timestamp: false,
            validate_previous_commit: false,
            validate_rights: false,
            ..CommitOpts::no_validations_no_index()
        };
        let result = store.apply_commit(commit, &opts).await.unwrap();
        let new_subject = result
            .resource_new
            .as_ref()
            .map(|r| r.get_subject().to_string())
            .unwrap_or_default();
        assert!(
            new_subject.starts_with("did:ad:"),
            "created resource subject should be a did:ad: DID, got: {}",
            new_subject
        );

        // Verify the resource is actually retrievable from the store
        let stored = store
            .get_resource(&new_subject.as_str().into())
            .await
            .expect("DID resource should be retrievable after genesis commit");
        assert_eq!(
            stored.get(crate::urls::DESCRIPTION).unwrap().to_string(),
            "hello",
            "Stored resource should have the description from the commit"
        );
    }

    /// Loro-only genesis commit (empty set map, only loroUpdate) — mimics browser behavior.
    /// The resource should be stored and retrievable with materialized properties.
    #[tokio::test]
    async fn did_loro_only_genesis_commit_stores_resource() {
        let (store, agent) = store_with_known_agent().await;

        // Build a Loro doc with properties (mimics browser-side Loro)
        let loro_doc = crate::loro::AtomicLoroDoc::new();
        loro_doc
            .set_property(crate::urls::NAME, &Value::String("My Table".into()))
            .unwrap();
        loro_doc
            .set_property(
                crate::urls::DESCRIPTION,
                &Value::String("A test table".into()),
            )
            .unwrap();
        loro_doc
            .set_property(
                crate::urls::PUBLIC_KEY,
                &Value::String(agent.public_key.clone()),
            )
            .unwrap();

        // Export as snapshot (this is what the browser sends for genesis)
        let snapshot = loro_doc.export_snapshot();

        // Create a CommitBuilder with ONLY loroUpdate (no set map)
        let mut builder = CommitBuilder::new("placeholder".into());
        builder.set_loro_update(snapshot);

        let commit = Commit::create_did(builder, &agent, &store).await.unwrap();
        let did_subject = commit.subject.clone();

        assert!(
            commit.loro_update.is_some(),
            "commit should have loroUpdate"
        );

        let opts = CommitOpts {
            validate_signature: true,
            validate_timestamp: false,
            validate_previous_commit: false,
            validate_rights: false,
            update_index: true,
            ..CommitOpts::no_validations_no_index()
        };

        let result = store.apply_commit(commit, &opts).await.unwrap();
        assert!(result.resource_new.is_some(), "should have resource_new");

        // THE KEY TEST: verify the resource is retrievable from the store
        let stored = store
            .get_resource(&did_subject.as_str().into())
            .await
            .expect("Loro-only DID resource should be retrievable after commit");

        assert_eq!(
            stored.get(crate::urls::NAME).unwrap().to_string(),
            "My Table",
            "Name should be materialized from Loro"
        );
        assert_eq!(
            stored.get(crate::urls::DESCRIPTION).unwrap().to_string(),
            "A test table",
            "Description should be materialized from Loro"
        );
    }

    /// A follow-up commit to a `did:ad:` resource (after genesis) should
    /// succeed when signed by the same agent.
    #[tokio::test]
    async fn did_followup_commit_succeeds() {
        let (store, agent) = store_with_known_agent().await;
        let mut builder = CommitBuilder::new("placeholder".into());
        builder.set(
            crate::urls::DESCRIPTION.into(),
            Value::new("v1", &DataType::Markdown).unwrap(),
        );
        let genesis = Commit::create_did(builder, &agent, &store).await.unwrap();
        let did_subject = genesis.subject.clone();
        let _genesis_url = genesis.url.clone();
        let opts_no_rights = CommitOpts {
            validate_signature: true,
            validate_timestamp: false,
            validate_previous_commit: false,
            validate_rights: false,
            ..CommitOpts::no_validations_no_index()
        };
        store.apply_commit(genesis, &opts_no_rights).await.unwrap();

        // Load the existing resource and edit on top of its Loro state
        let mut resource = store
            .get_resource(&did_subject.as_str().into())
            .await
            .unwrap();
        resource.set_unsafe(
            crate::urls::DESCRIPTION.into(),
            Value::new("v2", &DataType::Markdown).unwrap(),
        );
        let update = resource
            .get_commit_builder()
            .clone()
            .sign(&agent, &store, &resource)
            .await
            .unwrap();
        store.apply_commit(update, &opts_no_rights).await.unwrap();

        let updated = store
            .get_resource(&did_subject.as_str().into())
            .await
            .unwrap();
        assert_eq!(
            updated.get(crate::urls::DESCRIPTION).unwrap().to_string(),
            "v2"
        );
    }

    /// Agent DID genesis commit should succeed even though get_resource()
    /// returns a synthetic "just-in-time" agent. The Loro snapshot must be
    /// persisted so follow-up commits can merge deltas correctly.
    #[tokio::test]
    async fn agent_did_genesis_and_followup_persists_loro() {
        let (store, agent) = store_with_known_agent().await;

        let agent_subject: Subject = format!("did:ad:agent:{}", agent.public_key).into();

        // Build a genesis Loro doc (mimics browser's handleNew)
        let loro_doc = crate::loro::AtomicLoroDoc::new();
        loro_doc
            .set_property(urls::PUBLIC_KEY, &Value::String(agent.public_key.clone()))
            .unwrap();
        loro_doc
            .set_property(
                urls::IS_A,
                &Value::ResourceArray(vec![urls::AGENT.into()]),
            )
            .unwrap();
        let genesis_snapshot = loro_doc.export_snapshot();
        let genesis_version = loro_doc.oplog_vv();

        // Create the genesis commit via CommitBuilder (agent DIDs have a known subject)
        let mut builder = CommitBuilder::new(agent_subject.clone());
        builder.set_loro_update(genesis_snapshot);
        builder.is_genesis = true;
        let empty_resource = Resource::new(agent_subject.to_string());
        let genesis = builder.sign(&agent, &store, &empty_resource).await.unwrap();

        let opts = CommitOpts {
            validate_signature: true,
            validate_timestamp: false,
            validate_previous_commit: false,
            validate_rights: false,
            update_index: true,
            ..CommitOpts::no_validations_no_index()
        };

        let result = store.apply_commit(genesis, &opts).await.unwrap();
        let genesis_commit_url = result.commit_resource.get_subject().to_string();
        assert!(result.resource_new.is_some(), "genesis should produce resource_new");

        // Verify the stored resource has a loroUpdate
        let stored = store.get_resource(&agent_subject).await.unwrap();
        assert!(
            stored.get(urls::LORO_UPDATE).is_ok(),
            "Agent resource should have loroUpdate after genesis"
        );
        assert_eq!(
            stored.get(urls::PUBLIC_KEY).unwrap().to_string(),
            agent.public_key,
        );

        // Now create a follow-up commit that adds properties (mimics persistAgentAfterInvite)
        let loro_doc2 = crate::loro::AtomicLoroDoc::new();
        loro_doc2.import_update(&loro_doc.export_snapshot()).unwrap();
        loro_doc2
            .set_property(urls::NAME, &Value::String("Test Agent".into()))
            .unwrap();
        loro_doc2
            .set_property(
                urls::DESCRIPTION,
                &Value::String("My personal drive".into()),
            )
            .unwrap();
        let delta = loro_doc2.export_updates_since(&genesis_version);

        let mut builder2 = CommitBuilder::new(agent_subject.clone());
        builder2.set_loro_update(delta);
        builder2.previous_commit = Some(genesis_commit_url);
        let followup = builder2.sign(&agent, &store, &stored).await.unwrap();

        let result2 = store.apply_commit(followup, &opts).await.unwrap();
        assert!(result2.resource_new.is_some());

        // THE KEY ASSERTION: the follow-up properties must be materialized
        let stored2 = store.get_resource(&agent_subject).await.unwrap();
        assert_eq!(
            stored2.get(urls::NAME).unwrap().to_string(),
            "Test Agent",
            "Name from follow-up commit should be persisted"
        );
        assert_eq!(
            stored2.get(urls::DESCRIPTION).unwrap().to_string(),
            "My personal drive",
            "Description from follow-up commit should be persisted"
        );
        assert_eq!(
            stored2.get(urls::PUBLIC_KEY).unwrap().to_string(),
            agent.public_key,
            "publicKey from genesis should still be present"
        );
    }

    #[tokio::test]
    async fn loro_update_without_stored_snapshot_seeds_from_propvals_and_removes_deleted_props() {
        let (store, agent) = store_with_known_agent().await;
        let subject = "https://localhost/loro_seeded_resource";

        let mut existing = Resource::new(subject.into());
        existing.set_unsafe(
            crate::urls::NAME.into(),
            Value::String("Before delete".into()),
        );
        existing.set_unsafe(
            crate::urls::DESCRIPTION.into(),
            Value::String("Delete me".into()),
        );

        let base_doc = crate::loro::AtomicLoroDoc::new();
        base_doc
            .set_property(crate::urls::NAME, &Value::String("Before delete".into()))
            .unwrap();
        base_doc
            .set_property(crate::urls::DESCRIPTION, &Value::String("Delete me".into()))
            .unwrap();

        let client_doc =
            crate::loro::AtomicLoroDoc::from_snapshot(&base_doc.export_snapshot()).unwrap();
        client_doc.remove_property(crate::urls::DESCRIPTION).unwrap();
        client_doc
            .set_property(crate::urls::NAME, &Value::String("After delete".into()))
            .unwrap();

        let mut builder = CommitBuilder::new(subject.into());
        builder.set_loro_update(client_doc.export_snapshot());
        let commit = builder.sign(&agent, &store, &existing).await.unwrap();

        let applied = commit.apply_changes(existing).await.unwrap();
        let updated = applied.resource_new;

        assert_eq!(updated.get(crate::urls::NAME).unwrap().to_string(), "After delete");
        assert!(
            updated.get(crate::urls::DESCRIPTION).is_err(),
            "deleted properties should be removed from materialized propvals"
        );
        assert!(
            matches!(
                updated.get(crate::urls::LORO_UPDATE),
                Ok(Value::LoroDoc(snapshot)) if !snapshot.is_empty()
            ),
            "updated resource should keep a persisted Loro snapshot"
        );
    }

    #[tokio::test]
    async fn did_child_keeps_parent_and_can_be_edited_with_inherited_write_rights() {
        let (store, agent) = store_with_known_agent().await;

        let drive_subject = "did:ad:test-drive";
        let mut drive = Resource::new(drive_subject.into());
        drive.set_unsafe(
            crate::urls::IS_A.into(),
            Value::ResourceArray(vec![crate::urls::DRIVE.to_string().into()]),
        );
        drive.set_unsafe(
            crate::urls::WRITE.into(),
            Value::ResourceArray(vec![agent.subject.to_string().into()]),
        );
        store.add_resource(&drive).await.unwrap();

        let mut builder = CommitBuilder::new("placeholder".into());
        builder.set(
            crate::urls::PARENT.into(),
            Value::AtomicUrl(drive_subject.into()),
        );
        builder.set(
            crate::urls::NAME.into(),
            Value::String("First version".into()),
        );

        let genesis = Commit::create_did(builder, &agent, &store).await.unwrap();
        let did_subject = genesis.subject.clone();

        let opts_with_rights = CommitOpts {
            validate_signature: true,
            validate_timestamp: false,
            validate_previous_commit: true,
            validate_rights: true,
            validate_for_agent: Some(agent.subject.to_string()),
            update_index: true,
            ..CommitOpts::no_validations_no_index()
        };

        store
            .apply_commit(genesis, &opts_with_rights)
            .await
            .unwrap();

        let created = store.get_resource(&did_subject).await.unwrap();
        assert_eq!(
            created.get(crate::urls::PARENT).unwrap().to_string(),
            drive_subject
        );

        let mut updated_resource = created.clone();
        updated_resource.set_unsafe(
            crate::urls::DESCRIPTION.into(),
            Value::String("Second version".into()),
        );
        let update = updated_resource
            .get_commit_builder()
            .clone()
            .sign(&agent, &store, &updated_resource)
            .await
            .unwrap();

        store
            .apply_commit(update, &opts_with_rights)
            .await
            .unwrap();

        let updated = store.get_resource(&did_subject).await.unwrap();
        assert_eq!(updated.get(crate::urls::PARENT).unwrap().to_string(), drive_subject);
        assert_eq!(
            updated.get(crate::urls::DESCRIPTION).unwrap().to_string(),
            "Second version"
        );
    }

    /// Tampering with the signature of an otherwise valid commit must be
    /// rejected when signature validation is enabled.
    #[tokio::test]
    async fn tampered_signature_is_rejected() {
        let (store, agent) = store_with_known_agent().await;
        let subject = "https://localhost/tamper_target";
        let resource = Resource::new(subject.into());
        let mut builder = CommitBuilder::new(subject.into());
        builder.set(
            crate::urls::DESCRIPTION.into(),
            Value::new("legit", &DataType::Markdown).unwrap(),
        );
        let mut commit = builder.sign(&agent, &store, &resource).await.unwrap();
        // Flip the first character of the signature to invalidate it.
        commit.signature = Some(format!("XXXX{}", &commit.signature.unwrap()[4..]));

        let opts = CommitOpts {
            validate_signature: true,
            validate_timestamp: false,
            validate_previous_commit: false,
            validate_rights: false,
            ..CommitOpts::no_validations_no_index()
        };
        let err = store.apply_commit(commit, &opts).await.unwrap_err();
        assert!(
            err.to_string().to_lowercase().contains("signature"),
            "expected a signature error, got: {}",
            err
        );
    }

    /// Signing a commit with agent B but writing to a resource that agent A
    /// created (and owns) must fail signature validation.
    #[tokio::test]
    async fn wrong_agent_signature_is_rejected() {
        let (store, agent_a) = store_with_known_agent().await;
        let agent_b = store.create_agent(Some("agent_b")).await.unwrap();

        let subject = "https://localhost/agent_a_resource";
        let resource = Resource::new(subject.into());
        let mut builder = CommitBuilder::new(subject.into());
        builder.set(
            crate::urls::DESCRIPTION.into(),
            Value::new("by agent_a", &DataType::Markdown).unwrap(),
        );
        // Sign with agent_b but claim agent_a signed it by manually overriding the signer.
        let mut commit = builder.sign(&agent_b, &store, &resource).await.unwrap();
        commit.signer = agent_a.subject.clone();

        let opts = CommitOpts {
            validate_signature: true,
            validate_timestamp: false,
            validate_previous_commit: false,
            validate_rights: false,
            ..CommitOpts::no_validations_no_index()
        };
        let err = store.apply_commit(commit, &opts).await.unwrap_err();
        assert!(
            err.to_string().to_lowercase().contains("signature"),
            "expected a signature error, got: {}",
            err
        );
    }

    /// A genesis commit's deterministic serialization must NOT include `@id`,
    /// so that the subject (= the signature) is not part of the signed bytes.
    #[tokio::test]
    async fn genesis_deterministic_serialization_excludes_id() {
        let (store, agent) = store_with_known_agent().await;
        let mut builder = CommitBuilder::new("placeholder".into());
        builder.set(
            crate::urls::DESCRIPTION.into(),
            Value::new("test", &DataType::Markdown).unwrap(),
        );
        let commit = Commit::create_did(builder, &agent, &store).await.unwrap();
        let serialized = commit
            .serialize_deterministically_json_ad(&store)
            .await
            .unwrap();
        assert!(
            !serialized.contains("@id"),
            "deterministic serialization must not contain @id, got: {}",
            serialized
        );
    }

    /// Regression: renaming a resource with two sequential commits should
    /// persist the SECOND name. Previously observed symptom: the client types
    /// "New Drive" one character at a time, each keystroke sends a commit,
    /// but only the first one sticks — the stored name remains "N".
    ///
    /// This exercises the real `store.apply_commit` path (not just
    /// `apply_changes`) so persistence + rehydration are part of the test.
    #[tokio::test]
    async fn two_sequential_commits_both_land() {
        let (store, agent) = store_with_known_agent().await;
        let subject = "https://localhost/rename_target";

        // Commit 1: create resource with name="N"
        let client_doc = crate::loro::AtomicLoroDoc::new();
        client_doc
            .set_property(crate::urls::NAME, &Value::String("N".into()))
            .unwrap();
        client_doc
            .set_property(
                crate::urls::IS_A,
                &Value::ResourceArray(vec![crate::urls::CLASS.to_string().into()]),
            )
            .unwrap();
        client_doc
            .set_property(
                crate::urls::SHORTNAME,
                &Value::String("n".into()),
            )
            .unwrap();
        client_doc
            .set_property(
                crate::urls::DESCRIPTION,
                &Value::String("desc".into()),
            )
            .unwrap();

        let empty = Resource::new(subject.into());
        let mut builder = CommitBuilder::new(subject.into());
        builder.set_loro_update(client_doc.export_snapshot());
        let commit1 = builder.sign(&agent, &store, &empty).await.unwrap();
        store.apply_commit(commit1, &OPTS).await.unwrap();

        let after_first = store.get_resource(&subject.into()).await.unwrap();
        assert_eq!(
            after_first.get(crate::urls::NAME).unwrap().to_string(),
            "N",
            "commit 1 should set name to N"
        );

        // Commit 2: rename to "Ne" — same Loro doc (incremental), so the
        // exported snapshot represents one op of the same peer ID.
        client_doc
            .set_property(crate::urls::NAME, &Value::String("Ne".into()))
            .unwrap();
        let mut builder2 = CommitBuilder::new(subject.into());
        builder2.set_loro_update(client_doc.export_snapshot());
        // `sign()` auto-fills previous_commit from the resource's lastCommit.
        let commit2 = builder2.sign(&agent, &store, &after_first).await.unwrap();
        store.apply_commit(commit2, &OPTS).await.unwrap();

        let after_second = store.get_resource(&subject.into()).await.unwrap();
        assert_eq!(
            after_second.get(crate::urls::NAME).unwrap().to_string(),
            "Ne",
            "commit 2 should rename name to Ne — if this fails, sequential commits aren't merging properly"
        );
    }

    /// Same as above but each commit comes from a FRESH Loro doc seeded from
    /// the server's previous snapshot — simulates a client that rebuilds its
    /// Loro state between commits (or a peer that joins mid-session).
    #[tokio::test]
    async fn two_commits_with_fresh_doc_per_commit_both_land() {
        let (store, agent) = store_with_known_agent().await;
        let subject = "https://localhost/rename_fresh_doc";

        // Commit 1: name="N" from a fresh doc.
        let doc1 = crate::loro::AtomicLoroDoc::new();
        doc1.set_property(crate::urls::NAME, &Value::String("N".into()))
            .unwrap();
        doc1.set_property(
            crate::urls::IS_A,
            &Value::ResourceArray(vec![crate::urls::CLASS.to_string().into()]),
        )
        .unwrap();
        doc1.set_property(
            crate::urls::SHORTNAME,
            &Value::String("n".into()),
        )
        .unwrap();
        doc1.set_property(
            crate::urls::DESCRIPTION,
            &Value::String("desc".into()),
        )
        .unwrap();

        let empty = Resource::new(subject.into());
        let mut builder = CommitBuilder::new(subject.into());
        builder.set_loro_update(doc1.export_snapshot());
        let commit1 = builder.sign(&agent, &store, &empty).await.unwrap();
        store.apply_commit(commit1, &OPTS).await.unwrap();

        let after_first = store.get_resource(&subject.into()).await.unwrap();
        assert_eq!(
            after_first.get(crate::urls::NAME).unwrap().to_string(),
            "N"
        );

        // Commit 2: client rebuilds Loro doc from the server's stored state,
        // then mutates. This models "fresh doc per commit" client behaviour.
        let stored_snapshot = match after_first.get(crate::urls::LORO_UPDATE).unwrap() {
            Value::LoroDoc(b) => b.clone(),
            other => panic!("expected LoroDoc, got {:?}", other),
        };
        let doc2 = crate::loro::AtomicLoroDoc::from_snapshot(&stored_snapshot).unwrap();
        doc2.set_property(crate::urls::NAME, &Value::String("Ne".into()))
            .unwrap();

        let mut builder2 = CommitBuilder::new(subject.into());
        builder2.set_loro_update(doc2.export_snapshot());
        let commit2 = builder2.sign(&agent, &store, &after_first).await.unwrap();
        store.apply_commit(commit2, &OPTS).await.unwrap();

        let after_second = store.get_resource(&subject.into()).await.unwrap();
        assert_eq!(
            after_second.get(crate::urls::NAME).unwrap().to_string(),
            "Ne",
            "fresh-doc-per-commit should still land the second rename"
        );
    }

    /// Two commits where each commit comes from a FRESH Loro doc with a
    /// different peer ID, NOT seeded from the server's state. Writes to the
    /// same key are concurrent — Loro's LWW tiebreak by peer ID decides which
    /// one wins. We pin the peer IDs so docA always wins LWW: docB's writes
    /// are guaranteed to be silently dropped against the merged state, which
    /// is exactly the case the causality guard exists to catch.
    #[tokio::test]
    async fn two_commits_with_independent_docs_both_peers_same_key() {
        let (store, agent) = store_with_known_agent().await;
        let subject = "https://localhost/concurrent_peers";

        // Commit 1: docA → name="A". Pin peer ID high so this peer wins LWW
        // tiebreaks against docB.
        let doc_a = crate::loro::AtomicLoroDoc::new();
        doc_a.set_peer_id(u64::MAX - 1).unwrap();
        doc_a
            .set_property(crate::urls::NAME, &Value::String("A".into()))
            .unwrap();
        doc_a
            .set_property(
                crate::urls::IS_A,
                &Value::ResourceArray(vec![crate::urls::CLASS.to_string().into()]),
            )
            .unwrap();
        doc_a
            .set_property(
                crate::urls::SHORTNAME,
                &Value::String("a".into()),
            )
            .unwrap();
        doc_a
            .set_property(
                crate::urls::DESCRIPTION,
                &Value::String("desc".into()),
            )
            .unwrap();

        let empty = Resource::new(subject.into());
        let mut builder = CommitBuilder::new(subject.into());
        builder.set_loro_update(doc_a.export_snapshot());
        let commit1 = builder.sign(&agent, &store, &empty).await.unwrap();
        store.apply_commit(commit1, &OPTS).await.unwrap();

        // Commit 2: docB = FRESH, NOT seeded from server. Pin peer ID low so
        // this peer always loses LWW tiebreaks against docA.
        let doc_b = crate::loro::AtomicLoroDoc::new();
        doc_b.set_peer_id(1).unwrap();
        doc_b
            .set_property(crate::urls::NAME, &Value::String("B".into()))
            .unwrap();
        doc_b
            .set_property(
                crate::urls::IS_A,
                &Value::ResourceArray(vec![crate::urls::CLASS.to_string().into()]),
            )
            .unwrap();
        doc_b
            .set_property(
                crate::urls::SHORTNAME,
                &Value::String("b".into()),
            )
            .unwrap();
        doc_b
            .set_property(
                crate::urls::DESCRIPTION,
                &Value::String("desc".into()),
            )
            .unwrap();

        let after_first = store.get_resource(&subject.into()).await.unwrap();
        let mut builder2 = CommitBuilder::new(subject.into());
        builder2.set_loro_update(doc_b.export_snapshot());
        let commit2 = builder2.sign(&agent, &store, &after_first).await.unwrap();
        let err = store.apply_commit(commit2, &OPTS).await.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("silently dropped"),
            "expected silent-drop error from causality guard, got: {msg}"
        );

        // Stored state is unchanged; commit 2 was rejected.
        let after_second = store.get_resource(&subject.into()).await.unwrap();
        assert_eq!(
            after_second.get(crate::urls::NAME).unwrap().to_string(),
            "A",
            "stored name should still be `A` since commit 2 was rejected"
        );
    }

    #[tokio::test]
    async fn deserialize_from_json() {
        let json = r#"
        {
            "subject": "https://localhost/test",
            "loro_update": "bG9ybw==",
            "destroy": false
        }
        "#;

        let commit_builder_json: CommitBuilderJSON = serde_json::from_str(json).unwrap();
        let commit_builder = CommitBuilder::from_commit_builder_json(commit_builder_json).unwrap();

        assert_eq!(commit_builder.subject, "https://localhost/test");
        assert!(commit_builder.loro_update.is_some());
        assert!(!commit_builder.destroy);
    }
}
