//! Describe changes / mutations to data

use crate::{
    agents::{decode_base64, encode_base64},
    datatype::DataType,
    errors::AtomicResult,
    parse::{ParseOpts, SaveOpts},
    resources::PropVals,
    urls,
    values::SubResource,
    Atom, Resource, Storelike, Subject, Value,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use urls::{SET, SIGNER};
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
    pub subject: String,
    /// The date it was created, as a unix timestamp
    #[serde(rename = "https://atomicdata.dev/properties/createdAt")]
    pub created_at: i64,
    /// The URL of the one signing this Commit
    #[serde(rename = "https://atomicdata.dev/properties/signer")]
    pub signer: String,
    /// The set of PropVals that need to be added.
    /// Overwrites existing values
    #[serde(rename = "https://atomicdata.dev/properties/set")]
    pub set: Option<std::collections::HashMap<String, Value>>,
    /// A map of properties and the Yjs updates to be applied to them (must be Value::YDoc)
    #[serde(rename = "https://atomicdata.dev/properties/yUpdate")]
    pub y_update: Option<std::collections::HashMap<String, Value>>,
    #[serde(rename = "https://atomicdata.dev/properties/remove")]
    /// The set of property URLs that need to be removed
    pub remove: Option<Vec<String>>,
    /// If set to true, deletes the entire resource
    #[serde(rename = "https://atomicdata.dev/properties/destroy")]
    pub destroy: Option<bool>,
    /// Base64 encoded signature of the JSON serialized Commit
    #[serde(rename = "https://atomicdata.dev/properties/signature")]
    pub signature: Option<String>,
    /// List of Properties and Arrays to be appended to them
    #[serde(rename = "https://atomicdata.dev/properties/push")]
    pub push: Option<std::collections::HashMap<String, Value>>,
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
        // Check if the set hashset has a parent property and if it matches with this subject.
        if let Some(set) = &self.set {
            if let Some(parent) = set.get(urls::PARENT) {
                if parent.to_string() == self.subject {
                    return Err("Circular parent reference".into());
                }
            }
        }

        // TODO: Check for circular parents by going up the parent tree.
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
        commit_builder.subject = temp_subject.clone();

        let mut commit = Commit {
            subject: temp_subject,
            signer: agent.subject.to_string(),
            set: Some(commit_builder.set),
            y_update: Some(commit_builder.y_update),
            remove: Some(commit_builder.remove.into_iter().collect()),
            destroy: Some(commit_builder.destroy),
            created_at: now,
            previous_commit: None,
            is_genesis: Some(true),
            signature: None,
            push: Some(commit_builder.push),
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
        commit.subject = did;

        Ok(commit)
    }

    /// Check if the Commit's signature matches the signer's public key.
    pub async fn validate_signature(&self, store: &impl Storelike) -> AtomicResult<()> {
        let commit = self;
        let signature = match commit.signature.as_ref() {
            Some(sig) => sig,
            None => return Err("No signature set".into()),
        };
        let signer_subject = store.normalize_subject(&commit.signer.clone().into());
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
                } else if commit.signer.starts_with("did:key:") {
                    // Extract from did:key (placeholder for future implementation)
                    return Err(format!(
                        "did:key not yet fully supported for signature verification: {}",
                        commit.signer
                    )
                    .into());
                } else if commit.signer.starts_with("did:ad:agent:") {
                    commit
                        .signer
                        .strip_prefix("did:ad:agent:")
                        .ok_or("Invalid did:ad:agent signer")?
                        .to_string()
                } else if commit.signer == commit.subject && commit.previous_commit.is_none() {
                    // If the signer is not found in the store AND signer == subject,
                    // it's likely a self-signed genesis commit (e.g. creating a new DID/agent).
                    if commit.destroy.unwrap_or(false) {
                        return Err("Cannot verify signature for self-signed destroy commit".into());
                    }
                    if let Some(set) = &commit.set {
                        if let Some(pk_val) = set.get(urls::PUBLIC_KEY) {
                            pk_val.to_string()
                        } else {
                            return Err("Self-signed genesis commit must contain public key in 'set' field for non-extractable signer URLs".into());
                        }
                    } else {
                        return Err("Self-signed genesis commit must contain 'set' field".into());
                    }
                } else {
                    return Err(format!("Signer {} not found in store, and this is not a self-signed genesis commit or extractable URL. Error: {}", commit.signer, e).into());
                }
            }
        };
        let agent_pubkey = decode_base64(&pubkey_b64)?;
        let stringified_commit = commit.serialize_deterministically_json_ad(store).await?;
        let peer_public_key =
            ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, agent_pubkey);
        let signature_bytes = decode_base64(signature)?;
        peer_public_key
            .verify(stringified_commit.as_bytes(), &signature_bytes)
            .map_err(|_e| {
                format!(
                    "Incorrect signature for Commit. This could be due to an error during signing or serialization of the commit. Compare this to the serialized commit in the server: {}",
                    stringified_commit,
                )
            })?;

        // For genesis resource commits (did:ad:{signature}), the subject must equal the signature.
        // Agent DIDs (did:ad:agent:{pubkey}) are identity-based and exempt from this check.
        if commit.subject.starts_with("did:ad:")
            && !commit.subject.starts_with("did:ad:agent:")
            && commit.previous_commit.is_none()
        {
            let subject_val = commit
                .subject
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
        let is_agent = commit.subject.starts_with("did:ad:agent:");
        if !is_new
            && commit.subject.starts_with("did:ad:")
            && !is_agent
            && commit.previous_commit.is_none()
        {
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
            .apply_changes(resource_old.clone(), store)
            .await
            .map_err(|e| {
                format!(
                    "Error applying changes to Resource {}. {}",
                    commit.subject, e
                )
            })?;

        if opts.validate_rights {
            let validate_for = opts.validate_for_agent.as_ref().unwrap_or(&commit.signer);
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
                        if !writers.contains(&commit.signer) {
                            writers.push(commit.signer.clone());
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
        })
    }

    /// Checks if the Commit has been created in the future or if it is expired.
    #[tracing::instrument(skip_all)]
    pub fn validate_timestamp(&self) -> AtomicResult<()> {
        crate::utils::check_timestamp_in_past(self.created_at, ACCEPTABLE_TIME_DIFFERENCE)
    }

    /// Updates the values in the Resource according to the `set`, `remove`, `push`, and `destroy` attributes in the Commit.
    /// Optionally also returns the updated Atoms.
    #[tracing::instrument(skip(store))]
    pub async fn apply_changes(
        &self,
        mut resource: Resource,
        store: &impl Storelike,
    ) -> AtomicResult<CommitApplied> {
        let resource_unedited = resource.clone();

        let mut remove_atoms: Vec<Atom> = Vec::new();
        let mut add_atoms: Vec<Atom> = Vec::new();

        if let Some(remove) = self.remove.clone() {
            for prop in remove.iter() {
                resource.remove_propval(prop);

                if let Ok(val) = resource_unedited.get(prop) {
                    let atom = Atom::new(resource.get_subject().clone(), prop.into(), val.clone());
                    remove_atoms.push(atom);
                } else {
                    // The property does not exist, so nothing to remove.
                    //
                    // This may happen if another concurrent commit has removed it first, or
                    // client removed it without validating it exists. (Currently rust and
                    // typescript clients do not validate that.)
                }
            }
        }
        if let Some(set) = self.set.clone() {
            for (prop, mut new_val) in set {
                new_val.normalize(store);
                resource
                    .set(prop.clone().into(), new_val.to_owned(), store)
                    .await
                    .map_err(|e| {
                        format!(
                            "Failed to set property '{}' to '{}' in Commit. Error: {}",
                            prop, new_val, e
                        )
                    })?;

                let new_atom = Atom::new(
                    resource.get_subject().clone(),
                    prop.clone(),
                    new_val.clone(),
                );
                if let Ok(old_val) = resource_unedited.get(&prop) {
                    let old_atom = Atom::new(
                        resource.get_subject().clone(),
                        prop.clone(),
                        old_val.clone(),
                    );
                    remove_atoms.push(old_atom);
                }
                add_atoms.push(new_atom);
            }
        }
        if let Some(push) = self.push.clone() {
            for (prop, mut val) in push {
                val.normalize(store);
                let mut old_vec = match resource.get(&prop) {
                    Ok(val) => match val {
                        Value::ResourceArray(res_arr) => res_arr.clone(),
                        _other => return Err("Wrong datatype when pushing to array".into()),
                    },
                    Err(_) => Vec::new(),
                };
                let new_vec = match val {
                    Value::ResourceArray(res_arr) => res_arr.clone(),
                    _other => return Err("Wrong datatype when pushing to array".into()),
                };
                old_vec.append(&mut new_vec.clone());
                resource.set_unsafe(prop.clone().into(), old_vec.into());
                for added_resource in new_vec {
                    let atom = Atom::new(
                        resource.get_subject().clone(),
                        prop.clone().into(),
                        added_resource.into(),
                    );
                    add_atoms.push(atom);
                }
            }
        }
        if let Some(y_update) = self.y_update.clone() {
            for (prop, update) in y_update.iter() {
                let update_bin = match update {
                    Value::YDoc(bin) => bin,
                    _ => {
                        return Err(
                            format!("Value in y_update is not of type YDoc: {}", prop).into()
                        )
                    }
                };

                match resource.get(prop) {
                    Ok(val) => match val {
                        Value::YDoc(bin) => {
                            // Resource already has state so we will merge the update into it.
                            // let decoded_state = yrs::Update::decode_v2(bin)
                            //     .map_err(|e| format!("Error decoding Yjs state: {}", e))?;

                            // We can merge the state (that is saved as an update) and the incoming update without having to create a Yjs doc.
                            let merged_update = yrs::merge_updates_v2(vec![bin, update_bin])
                                .map_err(|e| format!("Error merging Yjs updates: {}", e))?;

                            resource
                                .set(prop.into(), Value::YDoc(merged_update), store)
                                .await?;
                        }
                        _ => return Err(format!("Property is not of type YDoc: {}", prop).into()),
                    },
                    _ => {
                        // The property was not set yet so we initialize it with the update.
                        resource
                            .set(prop.into(), Value::YDoc(update_bin.clone()), store)
                            .await?;
                    }
                };
                // We don't create any atoms because indexing yjs updates doesn't make much sense.
            }
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
        })
    }

    /// Converts a Resource of a Commit into a Commit
    pub fn from_resource(resource: Resource) -> AtomicResult<Commit> {
        let subject = resource.get(urls::SUBJECT)?.to_string();
        let created_at = resource.get(urls::CREATED_AT)?.to_int()?;
        let signer = resource.get(SIGNER)?.to_string();
        let set = match resource.get(SET) {
            Ok(found) => Some(found.to_nested()?.to_owned()),
            Err(_) => None,
        };
        let push = match resource.get(urls::PUSH) {
            Ok(found) => Some(found.to_nested()?.to_owned()),
            Err(_) => None,
        };
        let y_update = match resource.get(urls::Y_UPDATE) {
            Ok(found) => Some(found.to_nested()?.to_owned()),
            Err(_) => None,
        };
        let remove = match resource.get(urls::REMOVE) {
            Ok(found) => Some(found.to_subjects(None)?),
            Err(_) => None,
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
            subject,
            created_at,
            signer,
            set,
            push,
            y_update,
            remove,
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
            Value::new(&self.subject, &DataType::AtomicUrl)?,
        );
        let classes = vec![urls::COMMIT.to_string()];
        resource.set_unsafe(urls::IS_A.into(), classes.into());
        resource.set_unsafe(
            urls::CREATED_AT.into(),
            Value::new(&self.created_at.to_string(), &DataType::Timestamp)?,
        );
        resource.set_unsafe(
            SIGNER.into(),
            Value::new(&self.signer, &DataType::AtomicUrl)?,
        );
        if let Some(set) = &self.set {
            let mut newset = PropVals::new();
            for (prop, val) in set {
                newset.insert(prop.into(), val.clone());
            }
            resource.set_unsafe(urls::SET.into(), newset.into());
        };
        if let Some(remove) = &self.remove {
            if !remove.is_empty() {
                resource.set_unsafe(urls::REMOVE.into(), remove.clone().into());
            }
        };
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
        if let Some(y_update) = &self.y_update {
            if !y_update.is_empty() {
                let mut newy_update = PropVals::new();
                for (prop, val) in y_update {
                    newy_update.insert(prop.into(), val.clone());
                }
                resource.set_unsafe(urls::Y_UPDATE.into(), newy_update.into());
            }
        }
        resource.set_unsafe(
            SIGNER.into(),
            Value::new(&self.signer, &DataType::AtomicUrl)?,
        );
        if let Some(signature) = &self.signature {
            resource.set_unsafe(urls::SIGNATURE.into(), signature.clone().into());
        }
        if let Some(push) = &self.push {
            if !push.is_empty() {
                resource.set_unsafe(urls::PUSH.into(), push.clone().into());
            }
        }
        Ok(resource)
    }

    pub fn get_subject(&self) -> &str {
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
        // Special logic for did:ad genesis commits: remove subject from serialization
        if self.subject.starts_with("did:ad:")
            && !self.subject.starts_with("did:ad:agent:")
            && self.previous_commit.is_none()
        {
            commit_resource.remove_propval(urls::SUBJECT);
            commit_resource.remove_propval(urls::IS_GENESIS);
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
    pub set: Option<std::collections::HashMap<String, serde_json::Value>>,
    pub push: Option<std::collections::HashMap<String, Vec<String>>>,
    pub y_update: Option<std::collections::HashMap<String, serde_json::Value>>,
    pub remove: Option<Vec<String>>,
    pub destroy: bool,
    pub previous_commit: Option<String>,
}

/// Use this for creating Commits.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CommitBuilder {
    /// The subject URL that is to be modified by this Delta.
    /// Not the URL of the Commit itself.
    /// https://atomicdata.dev/properties/subject
    pub subject: String,
    /// The set of PropVals that need to be added.
    /// Overwrites existing values
    /// https://atomicdata.dev/properties/set
    set: std::collections::HashMap<String, Value>,
    /// The set of PropVals that need to be appended to resource arrays.
    push: std::collections::HashMap<String, Value>,
    /// A map of Propvals containing Yjs updates to be applied to the YDocs
    y_update: std::collections::HashMap<String, Value>,
    /// The set of property URLs that need to be removed
    /// https://atomicdata.dev/properties/remove
    remove: HashSet<String>,
    /// If set to true, deletes the entire resource
    /// https://atomicdata.dev/properties/destroy
    destroy: bool,
    // pub signature: String,
    /// The previous Commit that was applied to the target resource (the subject) of this Commit. You should be able to follow these from Commit to Commit to establish an audit trail.
    /// https://atomicdata.dev/properties/previousCommit
    previous_commit: Option<String>,
}

impl CommitBuilder {
    /// Start constructing a Commit.
    pub fn new(subject: String) -> Self {
        CommitBuilder {
            push: HashMap::new(),
            subject,
            set: HashMap::new(),
            y_update: HashMap::new(),
            remove: HashSet::new(),
            destroy: false,
            previous_commit: None,
        }
    }

    pub async fn from_commit_builder_json(
        commit_builder_json: CommitBuilderJSON,
        store: &impl Storelike,
    ) -> AtomicResult<Self> {
        let mut commit_builder = CommitBuilder::new(commit_builder_json.subject);
        let mut parse_opts = ParseOpts::default();
        parse_opts.save = SaveOpts::DontSave;

        if let Some(set) = commit_builder_json.set {
            for (prop, val) in set.iter() {
                let (_, parsed_val) =
                    crate::parse::parse_propval(prop, val, None, store, &parse_opts).await?;
                commit_builder.set(prop.into(), parsed_val);
            }
        }

        if let Some(y_update) = commit_builder_json.y_update {
            for (prop, val) in y_update.iter() {
                let (_, parsed_val) =
                    crate::parse::parse_propval(prop, val, None, store, &parse_opts).await?;
                commit_builder.add_y_update(prop.into(), parsed_val)?;
            }
        }

        if let Some(push) = commit_builder_json.push {
            for (prop, vec) in push.iter() {
                for value in vec {
                    commit_builder
                        .push_propval(prop, SubResource::Subject(value.clone().into()))?;
                }
            }
        }

        if let Some(remove) = commit_builder_json.remove {
            for prop in remove {
                commit_builder.remove(prop);
            }
        }

        commit_builder.destroy(commit_builder_json.destroy);

        Ok(commit_builder)
    }

    /// Appends a URL or (nested anonymous) Resource to a ResourceArray.
    pub fn push_propval(&mut self, property: &str, value: SubResource) -> AtomicResult<()> {
        let mut vec = match self.push.get(property) {
            Some(val) => match val {
                Value::ResourceArray(resources) => resources.to_owned(),
                other => {
                    return Err(
                        format!("Expected ResourceArray in push_propval, got {}", other).into(),
                    )
                }
            },
            None => Vec::new(),
        };
        vec.push(value);
        self.push.insert(property.into(), Value::ResourceArray(vec));
        Ok(())
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

        let now = crate::utils::now();
        sign_at(self, agent, now, store).await
    }

    /// Set Property / Value combinations that will either be created or overwritten.
    pub fn set(&mut self, prop: String, val: Value) {
        self.set.insert(prop, val);
    }

    /// Set a new subject for this Commit
    pub fn set_subject(&mut self, subject: String) {
        self.subject = subject;
    }

    pub fn add_y_update(&mut self, prop: String, update: Value) -> AtomicResult<()> {
        match update {
            Value::YDoc(_) => {
                self.y_update.insert(prop, update);
                Ok(())
            }
            _ => Err(format!("Expected YDoc in add_y_update, got {}", update).into()),
        }
    }

    /// Set Property URLs which values to be removed
    pub fn remove(&mut self, prop: String) {
        self.remove.insert(prop);
    }

    /// Whether the resource needs to be removed fully
    pub fn destroy(&mut self, destroy: bool) {
        self.destroy = destroy
    }
}

/// Signs a CommitBuilder at a specific unix timestamp.
#[tracing::instrument(skip(store))]
async fn sign_at(
    commitbuilder: CommitBuilder,
    agent: &crate::agents::Agent,
    sign_date: i64,
    store: &impl Storelike,
) -> AtomicResult<Commit> {
    let mut commit = Commit {
        subject: commitbuilder.subject,
        signer: agent.subject.to_string(),
        set: Some(commitbuilder.set),
        y_update: Some(commitbuilder.y_update),
        remove: Some(commitbuilder.remove.into_iter().collect()),
        destroy: Some(commitbuilder.destroy),
        created_at: sign_date,
        previous_commit: commitbuilder.previous_commit,
        is_genesis: None,
        signature: None,
        push: Some(commitbuilder.push),
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
    let key_pair = ring::signature::Ed25519KeyPair::from_seed_and_public_key(
        &private_key_bytes,
        &public_key_bytes,
    )
    .map_err(|_| "Can't create Ed25519 keypair from Agent's Private Key.")?;
    let message_bytes = message.as_bytes();
    let signature = key_pair.sign(message_bytes);
    Ok(encode_base64(signature.as_ref()))
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
        let _created_resource = store.apply_commit(commit, &OPTS, None).await.unwrap();

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
        let mut set: HashMap<String, Value> = HashMap::new();
        let shortname = Value::new("shortname", &DataType::String).unwrap();
        let description = Value::new("Some description", &DataType::String).unwrap();
        set.insert(urls::SHORTNAME.into(), shortname);
        set.insert(urls::DESCRIPTION.into(), description);
        let remove = vec![String::from(urls::IS_A)];
        let destroy = false;
        let commit = Commit {
            subject: String::from("https://localhost/test"),
            created_at: 1603638837,
            signer: String::from("https://localhost/author"),
            set: Some(set),
            push: None,
            y_update: None,
            remove: Some(remove),
            previous_commit: None,
            is_genesis: None,
            destroy: Some(destroy),
            signature: None,
            url: None,
        };
        let serialized = commit
            .serialize_deterministically_json_ad(&store)
            .await
            .unwrap();
        let should_be = "{\"https://atomicdata.dev/properties/createdAt\":1603638837,\"https://atomicdata.dev/properties/isA\":[\"https://atomicdata.dev/classes/Commit\"],\"https://atomicdata.dev/properties/remove\":[\"https://atomicdata.dev/properties/isA\"],\"https://atomicdata.dev/properties/set\":{\"https://atomicdata.dev/properties/description\":\"Some description\",\"https://atomicdata.dev/properties/shortname\":\"shortname\"},\"https://atomicdata.dev/properties/signer\":\"https://localhost/author\",\"https://atomicdata.dev/properties/subject\":\"https://localhost/test\"}";
        assert_eq!(serialized, should_be)
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
        let commit = sign_at(commitbuilder, &agent, 0, &store).await.unwrap();
        let serialized = commit
            .serialize_deterministically_json_ad(&store)
            .await
            .unwrap();

        assert_eq!(serialized, "{\"https://atomicdata.dev/properties/createdAt\":0,\"https://atomicdata.dev/properties/isA\":[\"https://atomicdata.dev/classes/Commit\"],\"https://atomicdata.dev/properties/set\":{\"https://atomicdata.dev/properties/description\":\"Some value\",\"https://atomicdata.dev/properties/shortname\":\"someval\"},\"https://atomicdata.dev/properties/signer\":\"did:ad:agent:7LsjMW5gOfDdJzK/atgjQ1t20J/rw8MjVg6xwqm+h8U=\",\"https://atomicdata.dev/properties/subject\":\"https://localhost/new_thing\"}");
        // Verify signature is valid rather than checking a hardcoded value,
        // since the serialized form changed with the did:ad: prefix.
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

        {
            let subject = "invalid URL";
            let commitbuiler = crate::commit::CommitBuilder::new(subject.into());
            let _ = commitbuiler
                .sign(&agent, &store, &resource)
                .await
                .unwrap_err();
        }
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
    }

    #[tokio::test]
    async fn deserialize_from_json() {
        let store = Store::init().await.unwrap();
        store.set_base_url("http://localhost:9883");
        store.populate().await.unwrap();

        let json = r#"
        {
            "subject": "https://localhost/test",
            "set": {
                "https://atomicdata.dev/properties/description": "Some description"
            },
            "push": {
                "https://atomicdata.dev/properties/isA": ["https://localhost/classes/Test"]
            },
            "remove": ["https://atomicdata.dev/properties/name"],
            "destroy": false,
            "y_update": null
        }
        "#;

        let commit_builder_json: CommitBuilderJSON = serde_json::from_str(json).unwrap();
        let commit_builder = CommitBuilder::from_commit_builder_json(commit_builder_json, &store)
            .await
            .unwrap();

        assert_eq!(commit_builder.subject, "https://localhost/test");
        assert_eq!(
            commit_builder
                .set
                .get("https://atomicdata.dev/properties/description")
                .unwrap()
                .to_string(),
            "Some description"
        );
        assert_eq!(
            commit_builder
                .push
                .get("https://atomicdata.dev/properties/isA")
                .unwrap()
                .to_subjects(None)
                .unwrap(),
            ["https://localhost/classes/Test"]
        );
        assert!(commit_builder
            .remove
            .contains("https://atomicdata.dev/properties/name"));
        assert!(!commit_builder.destroy);
        assert!(commit_builder.y_update.is_empty());
    }
}
