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
            update_index: false,
            validate_for_agent: None,
        }
    }
}

/// A Commit is a set of changes to a Resource.
/// Use CommitBuilder if you're programmatically constructing a Delta.
#[derive(Clone, Debug, Serialize)]
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

impl Commit {
    /// Throws an error if the parent is set to itself
    pub fn check_for_circular_parents(&self) -> AtomicResult<()> {
        // Check if the Loro update contains a parent property that matches the subject.
        if let Some(loro_bytes) = &self.loro_update {
            let doc = crate::loro::AtomicLoroDoc::from_snapshot(loro_bytes)
                .or_else(|_| {
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
        // We first try to get the public key from the store.
        // If the signer is found in the store, we use that key.
        // This handles updates to existing agents by themselves.
        let pubkey_b64 = match store.get_resource(&signer_subject).await {
            Ok(resource) => resource.get(urls::PUBLIC_KEY)?.to_string(),
            Err(e) => {
                // If the signer is not found in the store, we might be able to extract the public key from the URL.
                if let crate::Subject::Internal { url, .. } = &signer_subject {
                    let path = url.path();
                    if path.starts_with("/agents/") {
                        path.strip_prefix("/agents/").unwrap().to_string()
                    } else {
                        return Err(format!("Signer {} not found in store, and path does not start with /agents/. Error: {}", commit.signer, e).into());
                    }
                } else if commit.signer.as_str().starts_with("did:key:") {
                    // Extract from did:key (placeholder for future implementation)
                    return Err(format!(
                        "did:key not yet fully supported for signature verification: {}",
                        commit.signer
                    )
                    .into());
                } else if commit.signer.is_agent_did() {
                    commit
                        .signer
                        .as_str()
                        .strip_prefix("did:ad:agent:")
                        .ok_or("Invalid did:ad:agent signer")?
                        .to_string()
                } else if commit.signer == commit.subject && commit.previous_commit.is_none() {
                    // If the signer is not found in the store AND signer == subject,
                    // it's likely a self-signed genesis commit (e.g. creating a new DID/agent).
                    if commit.destroy.unwrap_or(false) {
                        return Err("Cannot verify signature for self-signed destroy commit".into());
                    }
                    // Extract public key from the Loro update
                    if let Some(loro_bytes) = &commit.loro_update {
                        let doc = crate::loro::AtomicLoroDoc::from_snapshot(loro_bytes)
                            .or_else(|_| {
                                let doc = crate::loro::AtomicLoroDoc::new();
                                doc.import_update(loro_bytes)?;
                                Ok::<_, crate::errors::AtomicError>(doc)
                            })?;
                        if let Some(pk) = doc.get_string_property(urls::PUBLIC_KEY) {
                            pk
                        } else {
                            return Err("Self-signed genesis commit must contain public key in Loro update".into());
                        }
                    } else {
                        return Err("Self-signed genesis commit must contain a Loro update".into());
                    }
                } else {
                    return Err(format!("Signer {} not found in store, and this is not a self-signed genesis commit or extractable URL. Error: {}", commit.signer, e).into());
                }
            }
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

        // Create a new resource if it doesn't exist yet
        let (resource_old, is_new) = match store.get_resource(&commit.subject.clone().into()).await
        {
            Ok(rs) => (rs, false),
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

        let mut applied = commit
            .apply_changes(resource_old.clone())
            .await
            .map_err(|e| {
                format!(
                    "Error applying changes to Resource {}. {}",
                    commit.subject, e
                )
            })?;

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
    #[tracing::instrument]
    pub async fn apply_changes(
        &self,
        mut resource: Resource,
    ) -> AtomicResult<CommitApplied> {
        let resource_unedited = resource.clone();

        let mut remove_atoms: Vec<Atom> = Vec::new();
        let mut add_atoms: Vec<Atom> = Vec::new();
        let mut changed_props: HashSet<String> = HashSet::new();

        if let Some(loro_update_bytes) = &self.loro_update {
            // Load existing Loro snapshot from the resource, or create a new doc
            let loro_doc = match resource.get(urls::LORO_UPDATE) {
                Ok(Value::LoroDoc(existing_snapshot)) => {
                    crate::loro::AtomicLoroDoc::from_snapshot(existing_snapshot)?
                }
                _ => crate::loro::AtomicLoroDoc::new(),
            };

            // Import the update and compute the property-level diff for indexing
            let diff = loro_doc.import_update_with_diff(
                loro_update_bytes,
                &resource.get_subject().to_string(),
            )?;

            // Track which properties changed
            for atom in &diff.add_atoms {
                changed_props.insert(atom.property.clone());
            }
            for atom in &diff.remove_atoms {
                changed_props.insert(atom.property.clone());
            }

            add_atoms.extend(diff.add_atoms);
            remove_atoms.extend(diff.remove_atoms);

            // Materialize changed Loro properties into the Resource's propvals
            let properties = loro_doc.get_all_properties();
            for (prop, loro_val) in &properties {
                if let Some(atomic_val) = crate::loro::loro_value_to_atomic_value(loro_val) {
                    resource.set_unsafe(prop.into(), atomic_val);
                }
            }

            // Store the updated Loro snapshot on the resource for future merges
            let snapshot = loro_doc.export_snapshot();
            resource.set_unsafe(urls::LORO_UPDATE.into(), Value::LoroDoc(snapshot));
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
    #[tracing::instrument(skip(store))]
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
    #[tracing::instrument(skip(store))]
    pub async fn serialize_deterministically_json_ad(
        &self,
        store: &impl Storelike,
    ) -> AtomicResult<String> {
        let mut commit_resource = self.into_resource(store).await?;
        // A deterministic serialization should not contain the hash (signature), since that would influence the hash.
        commit_resource.remove_propval(urls::SIGNATURE);

        let is_did_non_agent = self.subject.is_did()
            && !self.subject.is_agent_did();
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

    pub fn from_commit_builder_json(
        commit_builder_json: CommitBuilderJSON,
    ) -> AtomicResult<Self> {
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

        // Pass the resource's existing Loro snapshot so sign_at can build
        // incremental updates on top of it instead of creating a detached doc.
        let existing_snapshot = match resource.get(urls::LORO_UPDATE) {
            Ok(Value::LoroDoc(snapshot)) => Some(snapshot.clone()),
            _ => None,
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
#[tracing::instrument(skip(store, existing_loro_snapshot))]
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
        is_genesis: if commitbuilder.is_genesis { Some(true) } else { None },
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
#[tracing::instrument]
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
        let commit = sign_at(commitbuilder, &agent, 0, &store, None).await.unwrap();
        let serialized = commit
            .serialize_deterministically_json_ad(&store)
            .await
            .unwrap();

        // Commits now use loroUpdate instead of set
        assert!(serialized.contains("loroUpdate"), "Commit should contain loroUpdate, got: {}", serialized);
        assert!(!serialized.contains("\"set\""), "Commit should not contain legacy set field");
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

        // Note: "invalid URL" now parses as Subject::Internal, which is valid
        // in the in-memory Store. Subject validation is handled by the Subject type itself.
        {
            let subject = "https://localhost/?q=invalid";
            let commitbuiler = crate::commit::CommitBuilder::new(subject.into());
            let commit = commitbuiler.sign(&agent, &store, &resource).await.unwrap();
            store.apply_commit(commit, &OPTS).await.unwrap_err();
        }
        {
            let subject = "https://localhost/valid";
            let commitbuiler = crate::commit::CommitBuilder::new(subject.into());
            let commit = commitbuiler.sign(&agent, &store, &resource).await.unwrap();
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
        let new_subject = result.resource_new
            .as_ref()
            .map(|r| r.get_subject().to_string())
            .unwrap_or_default();
        assert!(
            new_subject.starts_with("did:ad:"),
            "created resource subject should be a did:ad: DID, got: {}",
            new_subject
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
        let genesis_url = genesis.url.clone();
        let opts_no_rights = CommitOpts {
            validate_signature: true,
            validate_timestamp: false,
            validate_previous_commit: false,
            validate_rights: false,
            ..CommitOpts::no_validations_no_index()
        };
        store.apply_commit(genesis, &opts_no_rights).await.unwrap();

        // Load the existing resource and edit on top of its Loro state
        let mut resource = store.get_resource(&did_subject.as_str().into()).await.unwrap();
        resource.set_unsafe(
            crate::urls::DESCRIPTION.into(),
            Value::new("v2", &DataType::Markdown).unwrap(),
        );
        let update = resource.get_commit_builder().clone()
            .sign(&agent, &store, &resource).await.unwrap();
        store.apply_commit(update, &opts_no_rights).await.unwrap();

        let updated = store.get_resource(&did_subject.as_str().into()).await.unwrap();
        assert_eq!(
            updated.get(crate::urls::DESCRIPTION).unwrap().to_string(),
            "v2"
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
        let commit_builder = CommitBuilder::from_commit_builder_json(commit_builder_json)
            .unwrap();

        assert_eq!(commit_builder.subject, "https://localhost/test");
        assert!(commit_builder.loro_update.is_some());
        assert!(!commit_builder.destroy);
    }
}
