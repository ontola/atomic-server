//! A [Resource] is a set of [Atom]s that share a URL.
//! Has methods for saving resources and getting properties inside them.

use crate::commit::{CommitOpts, CommitResponse};
use crate::storelike::Query;
use crate::urls;
use crate::utils::random_string;
use crate::values::{SubResource, Value};
use crate::{commit::CommitBuilder, errors::AtomicResult};
use crate::{
    mapping::is_url,
    schema::{Class, Property},
    Atom, Storelike, Subject,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tracing::instrument;
use ulid::Ulid;

/// A Resource is a set of Atoms that shares a single Subject.
/// Backed by a Loro CRDT document for conflict-free state management.
/// PropVals is a materialized read cache; mutations go through the Loro doc.
#[derive(Serialize, Deserialize, Debug)]
pub struct Resource {
    /// Materialized property-value pairs (read cache)
    propvals: PropVals,
    subject: Subject,
    /// Legacy commit builder — still used by server-side code that calls set_unsafe().
    /// Will be removed once all server code uses Loro.
    commit: CommitBuilder,
    /// The Loro CRDT document backing this resource. Lazily initialized.
    #[serde(skip)]
    loro: Option<crate::loro::AtomicLoroDoc>,
}

/// Maps Property URLs to their values
pub type PropVals = HashMap<String, Value>;

impl Clone for Resource {
    fn clone(&self) -> Self {
        let loro = self.loro.as_ref().map(|doc| {
            let snapshot = doc.export_snapshot();
            crate::loro::AtomicLoroDoc::from_snapshot(&snapshot).expect("Failed to clone Loro doc")
        });
        Resource {
            propvals: self.propvals.clone(),
            subject: self.subject.clone(),
            commit: self.commit.clone(),
            loro: loro,
        }
    }
}

impl Resource {
    fn clone_loro_state(doc: &crate::loro::AtomicLoroDoc) -> crate::loro::AtomicLoroDoc {
        let snapshot = doc.export_snapshot();
        crate::loro::AtomicLoroDoc::from_snapshot(&snapshot).expect("Failed to clone Loro doc")
    }

    fn adopt_resource_state(&mut self, new: &Resource) {
        self.subject = new.subject.clone();
        self.propvals = new.propvals.clone();
        self.loro = new.loro.as_ref().map(Self::clone_loro_state);
    }

    /// Builds a Loro doc from propvals. Skips the `LORO_UPDATE` value because that
    /// is the encoded snapshot itself; the rest are typed property values that need
    /// to be inserted as ops on the new doc.
    ///
    /// Public so callers like the WS GET handler can build a fresh snapshot that
    /// reflects extender-modified propvals rather than the persisted (pre-extender)
    /// Loro state.
    pub fn seed_loro_doc_from_propvals(
        doc: &crate::loro::AtomicLoroDoc,
        propvals: &PropVals,
    ) -> AtomicResult<()> {
        for (prop, val) in propvals {
            if prop == urls::LORO_UPDATE {
                continue;
            }

            doc.set_property(prop, val)?;
        }

        Ok(())
    }

    fn materialize_propvals_from_loro_doc(doc: &crate::loro::AtomicLoroDoc) -> PropVals {
        let mut propvals = PropVals::new();

        for (prop, loro_val) in doc.get_all_properties() {
            if let Some(atomic_val) = crate::loro::loro_value_to_atomic_value(&loro_val) {
                propvals.insert(prop, atomic_val);
            }
        }

        propvals
    }

    pub fn build_loro_doc_from_state(&self) -> AtomicResult<crate::loro::AtomicLoroDoc> {
        if let Some(doc) = &self.loro {
            return crate::loro::AtomicLoroDoc::from_snapshot(&doc.export_snapshot());
        }

        if let Some(Value::LoroDoc(snapshot)) = self.propvals.get(urls::LORO_UPDATE) {
            return crate::loro::AtomicLoroDoc::from_snapshot(snapshot);
        }

        let doc = crate::loro::AtomicLoroDoc::new();
        Self::seed_loro_doc_from_propvals(&doc, &self.propvals)?;
        Ok(doc)
    }

    /// Replace the resource's property state entirely from a Loro doc.
    /// Used by the sync protocol to materialize state after importing deltas.
    pub fn replace_state_from_loro_doc(
        &mut self,
        doc: crate::loro::AtomicLoroDoc,
    ) -> AtomicResult<()> {
        let snapshot = doc.export_snapshot();
        let mut propvals = Self::materialize_propvals_from_loro_doc(&doc);
        propvals.insert(urls::LORO_UPDATE.into(), Value::LoroDoc(snapshot));
        self.propvals = propvals;
        self.loro = Some(doc);
        Ok(())
    }

    fn set_loro_snapshot_state(&mut self, snapshot: Vec<u8>) -> AtomicResult<()> {
        self.propvals
            .insert(urls::LORO_UPDATE.into(), Value::LoroDoc(snapshot.clone()));
        self.loro = Some(crate::loro::AtomicLoroDoc::from_snapshot(&snapshot)?);
        Ok(())
    }

    /// Fetches all 'required' properties. Returns an error if any are missing in this Resource.
    pub async fn check_required_props(&self, store: &impl Storelike) -> AtomicResult<()> {
        let classvec = self.get_classes(store).await?;
        for class in classvec.iter() {
            tracing::debug!(
                "Checking required props for class {} on resource {}",
                class.subject,
                self.get_subject()
            );
            for required_prop in class.requires.clone() {
                if self.get(&required_prop).is_err() {
                    tracing::error!(
                        "Property {} missing from {}. Resource has properties: {:?}",
                        required_prop,
                        self.get_subject(),
                        self.propvals.keys().collect::<Vec<_>>()
                    );
                    return Err(format!(
                        "Property {} missing. Is required in class {} ",
                        required_prop, class.subject
                    )
                    .into());
                }
            }
        }
        Ok(())
    }

    /// Removes / deletes the resource from the store by performing a Commit.
    /// Recursively deletes the resource's children.
    #[tracing::instrument(skip(store))]
    pub async fn destroy(
        &mut self,
        store: &impl Storelike,
    ) -> AtomicResult<crate::commit::CommitResponse> {
        self.commit.destroy(true);
        self.save(store)
            .await
            .map_err(|e| format!("Failed to destroy {} : {}", self.subject, e).into())
    }

    /// Gets the children of this resource.
    pub async fn get_children(&self, store: &impl Storelike) -> AtomicResult<Vec<Resource>> {
        let result = store
            .query(&Query::new_prop_val(
                urls::PARENT,
                self.get_subject().as_str(),
            ))
            .await?;
        Ok(result.resources)
    }

    pub fn from_propvals(propvals: PropVals, subject: Subject) -> Resource {
        Resource {
            propvals,
            commit: CommitBuilder::new(subject.clone()),
            subject,
            loro: None,
        }
    }

    /// Ensure the Loro CRDT document is initialized.
    /// Lazily builds from the current state (snapshot or propvals).
    /// After this call, `self.loro` is guaranteed to be `Some`.
    pub fn init_loro(&mut self) -> AtomicResult<()> {
        if self.loro.is_none() {
            self.loro = Some(self.build_loro_doc_from_state()?);
        }
        Ok(())
    }

    /// Initialize the Loro UndoManager so that subsequent mutations are tracked.
    /// Must be called after `init_loro()` and before the operations you want to undo.
    pub fn init_undo(&mut self) {
        if let Some(doc) = &self.loro {
            doc.ensure_undo_manager();
        }
    }

    /// Get a reference to the Loro doc. Panics if `init_loro()` hasn't been called.
    fn loro(&self) -> &crate::loro::AtomicLoroDoc {
        self.loro
            .as_ref()
            .expect("loro not initialized — call init_loro() first")
    }

    /// Rebuild propvals + commit from the current Loro doc state.
    /// Used after undo/redo to keep everything in sync.
    /// Rebuild propvals from the live Loro doc state.
    /// Does NOT export a snapshot — that happens once at save time.
    fn sync_propvals_from_loro(&mut self) {
        self.propvals = Self::materialize_propvals_from_loro_doc(self.loro());
    }

    /// Set a property on the resource through the Loro doc.
    /// Updates both the Loro doc and the propvals cache.
    pub fn set_loro(&mut self, property: &str, value: &Value) -> AtomicResult<()> {
        self.init_loro()?;
        self.loro().set_property(property, value)?;
        self.propvals.insert(property.into(), value.clone());
        Ok(())
    }

    /// Export the Loro snapshot, checking the live doc first, then propvals.
    pub fn get_loro_snapshot(&self) -> Option<Vec<u8>> {
        if let Some(doc) = &self.loro {
            return Some(doc.export_snapshot());
        }

        if let Some(Value::LoroDoc(snapshot)) = self.propvals.get(urls::LORO_UPDATE) {
            return Some(snapshot.clone());
        }

        None
    }

    /// Export the Loro delta since this resource was loaded/last saved.
    pub fn export_loro_snapshot(&self) -> Option<Vec<u8>> {
        self.loro.as_ref().map(|doc| doc.export_snapshot())
    }

    /// Ensure the Loro doc is loaded ("warmed") for history operations.
    /// Call this before `get_history()` or `view_at()` to avoid lazy-init overhead.
    pub fn warm_history(&mut self) -> AtomicResult<()> {
        self.init_loro()
    }

    /// Returns the edit history of this resource from the Loro oplog.
    pub fn get_history(&self) -> Vec<crate::loro::VersionMetadata> {
        match &self.loro {
            Some(doc) => doc.get_history(),
            None => Vec::new(),
        }
    }

    /// Returns the current Loro version (frontiers) for this resource.
    /// Useful for branching: save the version, checkout a previous one, then
    /// compare or restore later.
    pub fn get_current_version(&mut self) -> AtomicResult<crate::loro::VersionID> {
        self.init_loro()?;
        Ok(self.loro().current_version())
    }

    /// Checkout a specific historical version. The resource enters a detached
    /// read-only state — call `attach()` to return to the latest version.
    pub fn checkout(&mut self, version: &crate::loro::VersionID) -> AtomicResult<()> {
        self.init_loro()?;
        self.loro().checkout(version)?;
        self.sync_propvals_from_loro();
        Ok(())
    }

    /// Return to the latest version after a `checkout()`.
    pub fn attach(&mut self) -> AtomicResult<()> {
        self.init_loro()?;
        self.loro().attach()?;
        self.sync_propvals_from_loro();
        Ok(())
    }

    /// Returns a read-only snapshot of this resource at a historical version.
    /// The returned Resource has propvals materialized from the Loro state at that version.
    pub fn view_at(&self, version: &crate::loro::VersionID) -> AtomicResult<Resource> {
        let doc = self
            .loro
            .as_ref()
            .ok_or_else(|| "No Loro doc loaded — call warm_history() first")?;
        let props = doc.get_properties_at(version)?;
        let mut propvals = PropVals::new();
        for (key, loro_val) in &props {
            if let Some(atomic_val) = crate::loro::loro_value_to_atomic_value(loro_val) {
                propvals.insert(key.clone(), atomic_val);
            }
        }
        Ok(Resource {
            propvals,
            subject: self.subject.clone(),
            commit: CommitBuilder::new(self.subject.clone()),
            loro: None,
        })
    }

    /// Returns the subject of the resource as a Subject enum.
    pub fn get_subject_enum(&self) -> &Subject {
        &self.subject
    }

    /// Get a value by property URL
    pub fn get(&self, property_url: &str) -> AtomicResult<&Value> {
        Ok(self.propvals.get(property_url).ok_or(format!(
            "Property {} for resource {} not found",
            property_url, self.subject
        ))?)
    }

    pub fn get_commit_builder(&self) -> &CommitBuilder {
        &self.commit
    }

    /// Checks if the classes are there, if not, fetches them.
    /// Returns an empty vector if there are no classes found.
    pub async fn get_classes(&self, store: &impl Storelike) -> AtomicResult<Vec<Class>> {
        let mut classes: Vec<Class> = Vec::new();
        if let Ok(val) = self.get(crate::urls::IS_A) {
            for class in val.to_subjects(None)? {
                classes.push(store.get_class(&class).await?)
            }
        }
        Ok(classes)
    }

    /// Returns the first item of the is_ array
    pub fn get_main_class(&self) -> AtomicResult<String> {
        match self.get(crate::urls::IS_A) {
            Ok(val) => {
                let subjects = val.to_subjects(None)?;
                subjects
                    .first()
                    .cloned()
                    .ok_or_else(|| format!("Resource {} has no class", self.subject).into())
            }
            Err(_) => Err(format!("Resource {} has no class", self.subject).into()),
        }
    }

    /// Returns the `Parent` of this Resource.
    /// Throws in case of recursion
    pub async fn get_parent(&self, store: &impl Storelike) -> AtomicResult<Resource> {
        match self.get(urls::PARENT) {
            Ok(parent_val) => {
                let subject = Subject::from(parent_val.to_string());
                match store.get_resource(&subject).await {
                    Ok(parent) => {
                        if self.get_subject() == parent.get_subject() {
                            return Err(format!(
                                "There is a circular relationship in {} (parent = same resource).",
                                self.get_subject()
                            )
                            .into());
                        }
                        // Check write right
                        Ok(parent)
                    }
                    Err(_err) => Err(format!(
                        "Parent of {} ({}) not found: {}",
                        self.get_subject(),
                        parent_val,
                        _err
                    )
                    .into()),
                }
            }
            Err(e) => Err(format!("Parent of {} not found: {}", self.get_subject(), e).into()),
        }
    }

    /// Walks the parent tree upwards until there is no parent, then returns them as a vector.
    pub async fn get_parent_tree(&self, store: &impl Storelike) -> AtomicResult<Vec<Resource>> {
        let mut parents: Vec<Resource> = Vec::new();
        let mut current = self.clone();

        while let Ok(parent) = current.get_parent(store).await {
            parents.push(parent.clone());
            current = parent;
        }

        Ok(parents)
    }

    /// Returns all PropVals.
    /// Useful if you want to iterate over all Atoms / Properties.
    pub fn get_propvals(&self) -> &PropVals {
        &self.propvals
    }

    fn propvals_for_serialization(&self) -> PropVals {
        let mut propvals = self.propvals.clone();

        if let Some(doc) = &self.loro {
            propvals.insert(
                urls::LORO_UPDATE.into(),
                Value::LoroDoc(doc.export_snapshot()),
            );
        }

        propvals
    }

    /// Gets a value by its property shortname or property URL.
    // Todo: should use both the Classes AND the existing props
    pub async fn get_shortname(
        &self,
        shortname: &str,
        store: &impl Storelike,
    ) -> AtomicResult<&Value> {
        let prop = self.resolve_shortname_to_property(shortname, store).await?;
        self.get(&prop.subject)
    }

    pub fn get_subject(&self) -> &Subject {
        &self.subject
    }

    /// checks if a resouce has a specific parent. iterates over all parents.
    pub async fn has_parent(&self, store: &impl Storelike, parent: &str) -> bool {
        let mut mut_res = self.to_owned();
        loop {
            if let Ok(found_parent) = mut_res.get_parent(store).await {
                if found_parent.get_subject().as_str() == parent {
                    return true;
                }
                mut_res = found_parent;
            } else {
                return false;
            }
        }
    }

    /// Returns all PropVals.
    pub fn into_propvals(self) -> PropVals {
        self.propvals
    }

    /// Create a new, empty Resource.
    pub fn new(subject: String) -> Resource {
        let propvals: PropVals = HashMap::new();
        let subj: Subject = subject.into();
        Resource {
            propvals,
            commit: CommitBuilder::new(subj.clone()),
            subject: subj,
            loro: None,
        }
    }

    pub fn random_subject(_store: &impl Storelike) -> AtomicResult<String> {
        Ok(format!("/{}", Ulid::new().to_string()))
    }

    /// Create a new resource with a generated Subject
    pub fn new_generate_subject(store: &impl Storelike) -> AtomicResult<Resource> {
        let subject = Resource::random_subject(store)?;
        Ok(Resource::new(subject))
    }

    /// Create a new instance of some Class.
    /// The subject is generated, but can be changed.
    /// Does not save the resource to the store.
    pub async fn new_instance(class_url: &str, store: &impl Storelike) -> AtomicResult<Resource> {
        let propvals: PropVals = HashMap::new();
        let class = store.get_class(class_url).await?;
        let subject = format!("/{}/{}", &class.shortname, random_string(10));
        let subj: Subject = subject.into();
        let mut resource = Resource {
            propvals,
            commit: CommitBuilder::new(subj.clone()),
            subject: subj,
            loro: None,
        };
        let class_urls = Vec::from([String::from(class_url)]);
        resource
            .set(crate::urls::IS_A.into(), class_urls.into(), store)
            .await?;
        Ok(resource)
    }

    /// Appends a Resource to a specific property through the commitbuilder.
    /// Useful if you want to have compact Commits that add things to existing ResourceArrays.
    pub fn push(
        &mut self,
        property: &str,
        value: SubResource,
        skip_existing: bool,
    ) -> AtomicResult<&mut Self> {
        let mut vec = match self.propvals.get(property) {
            Some(some) => match some {
                Value::ResourceArray(vec) => {
                    if skip_existing {
                        let str_val = value.to_string();
                        for i in vec {
                            if i.to_string() == str_val {
                                // Value already exists
                                return Ok(self);
                            }
                        }
                    }
                    vec.to_owned()
                }
                _other => return Err("Wrong datatype, expected ResourceArray".into()),
            },
            None => Vec::new(),
        };
        vec.push(value.clone());
        let full_array: Value = vec.into();
        self.propvals.insert(property.into(), full_array.clone());
        // Mirror the change into the live Loro doc if it's been initialized.
        // Without this, `sign()` exports a stale snapshot (it prefers the
        // live doc over the commitbuilder's set map), and the appended
        // element is silently dropped from the resulting commit's loroUpdate.
        if let Some(doc) = &self.loro {
            let _ = doc.set_property(property, &full_array);
        }
        // Store the full array value in the commit builder so the Loro update
        // contains the complete state, not just the appended item.
        self.commit.set(property.into(), full_array);
        Ok(self)
    }

    /// Append a JSON item to a JsonArray property. CRDT-friendly — appends to the
    /// LoroList instead of replacing it. Items from different devices merge cleanly.
    pub fn push_list_item(
        &mut self,
        property: &str,
        item: serde_json::Value,
    ) -> crate::errors::AtomicResult<()> {
        match self.propvals.get_mut(property) {
            Some(Value::JsonArray(arr)) => arr.push(item.clone()),
            _ => {
                self.propvals
                    .insert(property.into(), Value::JsonArray(vec![item.clone()]));
            }
        };
        self.init_loro()?;
        self.loro().push_to_json_array(property, &item)?;
        Ok(())
    }

    /// Alias for `push_list_item` (legacy name).
    pub fn push_json_item(
        &mut self,
        property: &str,
        item: serde_json::Value,
    ) -> crate::errors::AtomicResult<()> {
        self.push_list_item(property, item)
    }

    /// Insert a JSON item at a specific index in a JsonArray property.
    /// CRDT-friendly — records a Loro list insert that merges across devices.
    pub fn insert_list_item(
        &mut self,
        property: &str,
        index: usize,
        item: serde_json::Value,
    ) -> crate::errors::AtomicResult<()> {
        match self.propvals.get_mut(property) {
            Some(Value::JsonArray(arr)) => {
                if index > arr.len() {
                    return Err(format!(
                        "Index {index} out of bounds for {property} (len {})",
                        arr.len()
                    )
                    .into());
                }
                arr.insert(index, item.clone());
            }
            _ => {
                if index != 0 {
                    return Err(format!("{property} is not a JsonArray").into());
                }
                self.propvals
                    .insert(property.into(), Value::JsonArray(vec![item.clone()]));
            }
        };
        self.init_loro()?;
        self.loro().insert_into_json_array(property, index, &item)?;
        Ok(())
    }

    /// Clear all items from a JsonArray property. Clears the LoroList too.
    pub fn clear_json_array(&mut self, property: &str) -> crate::errors::AtomicResult<()> {
        self.propvals
            .insert(property.into(), Value::JsonArray(vec![]));
        self.init_loro()?;
        self.loro().clear_json_array(property)?;
        Ok(())
    }

    /// Delete a single item from a JsonArray property by index. CRDT-friendly —
    /// records a Loro list delete operation that merges across devices.
    pub fn delete_list_item(
        &mut self,
        property: &str,
        index: usize,
    ) -> crate::errors::AtomicResult<()> {
        // Update propvals cache
        match self.propvals.get_mut(property) {
            Some(Value::JsonArray(arr)) => {
                if index >= arr.len() {
                    return Err(format!(
                        "Index {index} out of bounds for {property} (len {})",
                        arr.len()
                    )
                    .into());
                }
                arr.remove(index);
            }
            _ => {
                return Err(format!("{property} is not a JsonArray").into());
            }
        }

        self.init_loro()?;
        self.loro().delete_from_json_array(property, index)?;
        Ok(())
    }

    /// Undo the last local Loro operation on this resource.
    /// Returns true if something was undone.
    /// After undo, call `save_locally()` to persist and sync the change.
    pub fn undo(&mut self) -> crate::errors::AtomicResult<bool> {
        self.init_loro()?;
        if !self.loro().undo()? {
            return Ok(false);
        }
        self.sync_propvals_from_loro();
        Ok(true)
    }

    /// Redo the last undone Loro operation on this resource.
    /// Returns true if something was redone.
    /// After redo, call `save_locally()` to persist and sync the change.
    pub fn redo(&mut self) -> crate::errors::AtomicResult<bool> {
        self.init_loro()?;
        if !self.loro().redo()? {
            return Ok(false);
        }
        self.sync_propvals_from_loro();
        Ok(true)
    }

    pub fn can_undo(&self) -> bool {
        self.loro.as_ref().is_some_and(|d| d.can_undo())
    }

    pub fn can_redo(&self) -> bool {
        self.loro.as_ref().is_some_and(|d| d.can_redo())
    }

    /// Remove a propval from a resource by property URL.
    pub fn remove_propval(&mut self, property_url: &str) {
        self.propvals.remove_entry(property_url);
        self.commit.remove(property_url.into());
        if let Some(doc) = &self.loro {
            let _ = doc.remove_property(property_url);
        }
    }

    /// Remove a propval from a resource by property URL or shortname.
    /// Returns error if propval does not exist in this resource or its class.
    pub async fn remove_propval_shortname(
        &mut self,
        property_shortname: &str,
        store: &impl Storelike,
    ) -> AtomicResult<()> {
        let property_url = self
            .resolve_shortname_to_property(property_shortname, store)
            .await?;
        self.remove_propval(&property_url.subject);
        Ok(())
    }

    /// Tries to resolve the shortname of a Property to a Property.
    /// Currently only tries the shortnames for linked classes - not for other properties.
    // TODO: Not spec compliant - does not use the correct order (required, recommended, other)
    // TODO: Seems more costly then needed. Maybe resources need to keep a hashmap for resolving shortnames?
    pub async fn resolve_shortname_to_property(
        &self,
        shortname: &str,
        store: &impl Storelike,
    ) -> AtomicResult<Property> {
        // If it's a URL, were done quickly!
        if is_url(shortname) {
            return store.get_property(shortname).await;
        }
        // First, iterate over all existing properties, see if any of these work.
        for (url, _val) in self.propvals.iter() {
            if let Ok(prop) = store.get_property(url).await {
                if prop.shortname == shortname {
                    return Ok(prop);
                }
            }
        }
        // If that fails, load the classes for the resource, iterate over these
        let classes = self.get_classes(store).await?;
        // Loop over all Requires and Recommends props
        for class in classes {
            for required_prop_subject in class.requires {
                let required_prop = store.get_property(&required_prop_subject).await?;
                if required_prop.shortname == shortname {
                    return Ok(required_prop);
                }
            }
            for recommended_prop_subject in class.recommends {
                let recommended_prop = store.get_property(&recommended_prop_subject).await?;
                if recommended_prop.shortname == shortname {
                    return Ok(recommended_prop);
                }
            }
        }
        Err(format!("Shortname '{}' for '{}' not found", shortname, self.subject).into())
    }

    pub fn reset_commit_builder(&mut self) {
        self.commit = CommitBuilder::new(self.subject.clone());
    }

    /// Saves the resource (with all the changes) to the store by creating a Commit.
    /// Uses default Agent to sign the Commit.
    /// Stores changes on the Subject's Server by sending a Commit.
    /// Returns the generated Commit, the new Resource and the old Resource.
    pub async fn save(
        &mut self,
        store: &impl Storelike,
    ) -> AtomicResult<crate::commit::CommitResponse> {
        let agent = store.get_default_agent()?;
        let commit_builder = self.get_commit_builder().clone();
        // No-op save: same rationale as `save_locally`. Avoids tripping
        // `apply_commit`'s "no loroUpdate" rejection for callers that
        // call save defensively without checking dirtiness first.
        if !commit_builder.has_changes() {
            self.reset_commit_builder();
            return Ok(crate::commit::CommitResponse {
                commit: crate::Commit {
                    subject: self.get_subject().clone(),
                    signer: agent.subject.clone(),
                    loro_update: None,
                    destroy: Some(false),
                    created_at: crate::utils::now(),
                    previous_commit: None,
                    is_genesis: None,
                    signature: None,
                    url: None,
                },
                commit_resource: Resource::new(self.get_subject().to_string()),
                resource_new: Some(self.clone()),
                resource_old: None,
                add_atoms: Vec::new(),
                remove_atoms: Vec::new(),
                changed_props: std::collections::HashSet::new(),
            });
        }
        let commit = commit_builder.sign(&agent, store, self).await?;
        // If the current client is a server, and the subject is hosted here, don't post
        let should_post = match self.subject.clone() {
            crate::Subject::Internal { .. } => false,
            crate::Subject::External(_) => true,
            crate::Subject::Did { .. } => false,
        };
        if should_post {
            crate::client::post_commit(&commit, store).await?;
        }
        let opts = CommitOpts {
            validate_schema: true,
            validate_signature: false,
            validate_timestamp: false,
            validate_rights: false,
            validate_for_agent: Some(agent.subject.to_string()),
            // TODO: auto-merge should work before we enable this https://github.com/atomicdata-dev/atomic-server/issues/412
            validate_previous_commit: false,
            validate_loro_causality: false,
            update_index: true,
        };
        let commit_response = store.apply_commit(commit, &opts).await?;
        if let Some(new) = &commit_response.resource_new {
            self.adopt_resource_state(new);
        }
        self.reset_commit_builder();
        Ok(commit_response)
    }

    /// Saves the resource (with all the changes) to the store by creating a Commit.
    /// Uses default Agent to sign the Commit.
    /// Returns the generated Commit and the new Resource.
    /// Does not validate rights / hierarchy.
    /// Does not store these changes on the server of the Subject - the Commit will be lost, unless you handle it manually.
    pub async fn save_locally(&mut self, store: &impl Storelike) -> AtomicResult<CommitResponse> {
        let agent = store.get_default_agent()?;
        let commitbuilder = self.get_commit_builder().clone();
        // Saving a resource that hasn't been touched is a no-op. Without
        // this short-circuit, `apply_commit` would reject the empty
        // commit ("no `loroUpdate` and is not a destroy"), which surfaces
        // as a hard error in idiomatic init code like
        // `Resource::new_generate_subject(&store).save_locally(&store)`.
        if !commitbuilder.has_changes() {
            self.reset_commit_builder();
            return Ok(CommitResponse {
                commit: crate::Commit {
                    subject: self.get_subject().clone(),
                    signer: agent.subject.clone(),
                    loro_update: None,
                    destroy: Some(false),
                    created_at: crate::utils::now(),
                    previous_commit: None,
                    is_genesis: None,
                    signature: None,
                    url: None,
                },
                commit_resource: Resource::new(self.get_subject().to_string()),
                resource_new: Some(self.clone()),
                resource_old: None,
                add_atoms: Vec::new(),
                remove_atoms: Vec::new(),
                changed_props: std::collections::HashSet::new(),
            });
        }
        let commit = commitbuilder.sign(&agent, store, self).await?;
        let opts = CommitOpts {
            validate_schema: true,
            validate_signature: false,
            validate_timestamp: false,
            validate_rights: false,
            validate_for_agent: Some(agent.subject.to_string()),
            // https://github.com/atomicdata-dev/atomic-server/issues/412
            validate_previous_commit: false,
            validate_loro_causality: false,
            update_index: true,
        };
        let commit_response = store.apply_commit(commit, &opts).await?;
        if let Some(new) = &commit_response.resource_new {
            self.adopt_resource_state(new);
        }
        self.reset_commit_builder();
        Ok(commit_response)
    }

    /// Saves the resource as a new DID-native resource.
    /// The subject will be set to `did:ad:{genesis_signature}`.
    pub async fn save_as_genesis(
        &mut self,
        store: &impl Storelike,
    ) -> AtomicResult<CommitResponse> {
        let agent = store.get_default_agent()?;
        // Use a placeholder that starts with did:ad: to trigger special genesis serialization logic
        self.subject = Subject::from_raw("did:ad:placeholder", None);
        self.commit.set_subject(self.subject.clone());

        let mut commitbuilder = self.get_commit_builder().clone();
        commitbuilder.is_genesis = true;
        let commit = commitbuilder.sign(&agent, store, self).await?;

        let signature = commit
            .signature
            .as_ref()
            .ok_or("No signature generated for genesis commit")?;
        let did_subject = Subject::from_raw(&format!("did:ad:{}", signature), None);

        // Update both the resource and the commit subject to the real DID
        self.subject = did_subject.clone();
        let mut final_commit = commit;
        final_commit.subject = did_subject.clone();

        let opts = CommitOpts {
            validate_schema: true,
            validate_signature: true,
            validate_timestamp: false,
            validate_rights: false,
            validate_for_agent: Some(agent.subject.to_string()),
            validate_previous_commit: false,
            validate_loro_causality: false,
            update_index: true,
        };

        let commit_response = store.apply_commit(final_commit, &opts).await?;
        if let Some(new) = &commit_response.resource_new {
            self.adopt_resource_state(new);
        }
        self.reset_commit_builder();
        Ok(commit_response)
    }

    /// Save the resource to a remote server via HTTP POST.
    /// Signs the commit and sends it to the server's `/commit` endpoint.
    /// Use this for client-side code that talks to an AtomicServer.
    pub async fn save_remote(&mut self, store: &impl Storelike) -> AtomicResult<String> {
        let agent = store.get_default_agent()?;
        let snapshot = self.build_loro_doc_from_state()?.export_snapshot();

        // If this is a genesis commit (new DID resource), use create_did
        if self.subject.as_str() == "did:ad:placeholder" {
            let mut commitbuilder = self.commit.clone();
            commitbuilder.is_genesis = true;
            commitbuilder.set_loro_update(snapshot.clone());

            let commit = crate::Commit::create_did(commitbuilder, &agent, store).await?;
            let subject = commit.subject.clone();
            let commit_id = commit
                .signature
                .as_ref()
                .map(|sig| format!("did:ad:commit:{}", sig));
            crate::client::post_commit(&commit, store).await?;
            self.subject = subject.clone();
            // Store lastCommit so subsequent saves can chain
            if let Some(id) = commit_id {
                self.propvals
                    .insert(urls::LAST_COMMIT.into(), Value::AtomicUrl(id.into()));
            }
            self.set_loro_snapshot_state(snapshot)?;
            self.reset_commit_builder();
            Ok(subject.to_string())
        } else {
            let mut commitbuilder = self.commit.clone();
            commitbuilder.set_loro_update(snapshot.clone());

            let commit = commitbuilder.sign(&agent, store, self).await?;
            let commit_id = commit
                .signature
                .as_ref()
                .map(|sig| format!("did:ad:commit:{}", sig));
            crate::client::post_commit(&commit, store).await?;
            if let Some(id) = commit_id {
                self.propvals
                    .insert(urls::LAST_COMMIT.into(), Value::AtomicUrl(id.into()));
            }
            self.set_loro_snapshot_state(snapshot)?;
            self.reset_commit_builder();
            Ok(self.subject.to_string())
        }
    }

    /// Set the name property.
    pub fn set_name(&mut self, name: &str) {
        self.set_unsafe(urls::NAME.into(), Value::String(name.into()));
    }

    /// Get the name property.
    pub fn get_name(&self) -> Option<String> {
        self.get(urls::NAME).ok().map(|v| v.to_string())
    }

    /// Overwrites the is_a (Class) of the Resource.
    pub fn set_class(&mut self, is_a: &str) {
        self.set_unsafe(
            crate::urls::IS_A.into(),
            Value::ResourceArray([is_a.into()].into()),
        );
    }

    /// Insert a Property/Value combination.
    /// Overwrites existing Property/Value.
    /// Validates the datatype.
    pub async fn set_string(
        &mut self,
        property_url: String,
        value: &str,
        store: &impl Storelike,
    ) -> AtomicResult<&mut Self> {
        let fullprop = store.get_property(&property_url).await.map_err(|e| {
            format!(
                "Failed setting propval for '{}' because property '{}' could not be found. {}",
                self.get_subject(),
                property_url,
                e
            )
        })?;
        let val = Value::new(value, &fullprop.data_type)?;
        self.set_unsafe(property_url, val);
        Ok(self)
    }

    /// Inserts a Property/Value combination.
    /// Checks datatype.
    /// Overwrites existing.
    /// Adds the change to the commit builder's `set` map.
    pub async fn set(
        &mut self,
        property: String,
        value: Value,
        store: &impl Storelike,
    ) -> AtomicResult<&mut Self> {
        let full_prop = store.get_property(&property).await?;
        if let Some(allowed) = full_prop.allows_only {
            let error = Err(format!(
                "Property '{}' does not allow value '{}'. Allowed: {:?}",
                property, value, allowed
            )
            .into());

            match &value {
                Value::ResourceArray(value_array) => {
                    for item in value_array {
                        if !allowed.contains(&item.to_string()) {
                            return error;
                        }
                    }
                }
                _ => {
                    if !allowed.contains(&value.to_string()) {
                        return error;
                    }
                }
            }
        }
        if full_prop.data_type == value.datatype() {
            self.set_unsafe(property, value);
            Ok(self)
        } else {
            Err(format!("Datatype for subject '{}', property '{}', value '{}' did not match. Wanted '{}', got '{}'",
                self.get_subject(),
                property,
                value,
                full_prop.data_type,
                value.datatype()
            ).into())
        }
    }

    /// Does not validate property / datatype combination.
    /// Inserts a Property/Value combination.
    /// Overwrites existing.
    /// Writes to Loro if initialized, and always to propvals + commit builder.
    /// Loro is initialized lazily on first save, not here — avoids overhead
    /// during bulk resource construction (e.g. populate).
    pub fn set_unsafe(&mut self, property: String, value: Value) -> &mut Self {
        if let Some(doc) = &self.loro {
            let _ = doc.set_property(&property, &value);
        }
        self.propvals.insert(property.clone(), value.clone());
        self.commit.set(property, value);
        self
    }

    /// Sets a property / value combination.
    /// Property can be a shortname (e.g. 'description' instead of the full URL).
    /// Returns error if propval does not exist in this resource or its class.
    pub async fn set_shortname(
        &mut self,
        property: &str,
        value: &str,
        store: &impl Storelike,
    ) -> AtomicResult<&mut Self> {
        let fullprop = self.resolve_shortname_to_property(property, store).await?;
        let fullval = Value::new(value, &fullprop.data_type)?;
        self.set_unsafe(fullprop.subject, fullval);
        Ok(self)
    }

    /// Overwrites all current PropVals. Does not perform validation.
    pub fn set_propvals_unsafe(&mut self, propvals: PropVals) {
        self.propvals = propvals;
        self.loro = None;
    }

    /// Changes the subject of the Resource.
    /// Does not 'move' the Resource
    /// See https://github.com/atomicdata-dev/atomic-server/issues/44
    pub fn set_subject(&mut self, url: String) -> &mut Self {
        let subj: Subject = url.into();
        self.commit.set_subject(subj.clone());
        self.subject = subj;
        self
    }

    /// Converts Resource to JSON-AD string.
    /// If origin is provided, Internal subjects are resolved to it.
    #[instrument(skip_all)]
    pub fn to_json_ad(&self, origin: Option<&str>) -> AtomicResult<String> {
        let origin = origin.unwrap_or("http://localhost");
        let propvals = self.propvals_for_serialization();
        let res = crate::serialize::propvals_to_json_ad_map(
            &propvals,
            Some(self.get_subject().resolve(origin)),
            origin,
            true,
        )?;
        Ok(serde_json::to_string(&res)?)
    }

    /// Serializes the resource to JSON-AD string, using the provided base_url for resolving Local subjects.
    pub fn to_json_ad_with_url(&self, base_url: &str) -> AtomicResult<String> {
        let propvals = self.propvals_for_serialization();
        let mut map = serde_json::Map::new();
        for (prop, val) in propvals.iter() {
            map.insert(
                prop.clone(),
                crate::serialize::val_to_serde(val.clone(), base_url, true)?,
            );
        }
        Ok(serde_json::to_string(&map)?)
    }

    /// Converts Resource to plain JSON string.
    #[instrument(skip_all)]
    pub async fn to_json(
        &self,
        store: &impl Storelike,
        origin: Option<&str>,
    ) -> AtomicResult<String> {
        let propvals = self.propvals_for_serialization();
        let obj = crate::serialize::propvals_to_json_ld(
            &propvals,
            Some(self.get_subject().to_string()),
            store,
            false,
            origin,
        )
        .await?;
        serde_json::to_string_pretty(&obj).map_err(|_| "Could not serialize to JSON".into())
    }

    /// Converts Resource to JSON-LD string, with @context object and RDF compatibility.
    #[instrument(skip_all)]
    pub async fn to_json_ld(
        &self,
        store: &impl Storelike,
        origin: Option<&str>,
    ) -> AtomicResult<String> {
        let propvals = self.propvals_for_serialization();
        let obj = crate::serialize::propvals_to_json_ld(
            &propvals,
            Some(self.get_subject().to_string()),
            store,
            true,
            origin,
        )
        .await?;
        serde_json::to_string_pretty(&obj).map_err(|_| "Could not serialize to JSON-LD".into())
    }

    pub fn to_atoms_iter(&self) -> impl Iterator<Item = Atom> + '_ {
        self.propvals.iter().map(|(property, value)| {
            Atom::new(self.subject.clone(), property.clone(), value.clone())
        })
    }

    #[instrument(skip_all)]
    pub fn to_atoms(&self) -> Vec<Atom> {
        self.to_atoms_iter().collect()
    }

    #[instrument(skip_all)]
    #[cfg(feature = "rdf")]
    /// Serializes the Resource to the RDF N-Triples format.
    pub async fn to_n_triples(&self, store: &impl Storelike) -> AtomicResult<String> {
        crate::serialize::atoms_to_ntriples(self.to_atoms(), store).await
    }

    pub fn vec_to_json_ad(resources: &[Resource], origin: Option<&str>) -> AtomicResult<String> {
        let str = resources
            .iter()
            .map(|r| r.to_json_ad(origin))
            .collect::<AtomicResult<Vec<String>>>()?
            .join(",");

        Ok(format!("[{}]", str))
    }

    pub async fn vec_to_json(
        resources: &Vec<Resource>,
        store: &impl Storelike,
        origin: Option<&str>,
    ) -> AtomicResult<String> {
        let mut strings = Vec::new();
        for r in resources {
            strings.push(r.to_json(store, origin).await?);
        }
        let str = strings.join(",");

        Ok(format!("[{}]", str))
    }

    pub async fn vec_to_json_ld(
        resources: &Vec<Resource>,
        store: &impl Storelike,
        origin: Option<&str>,
    ) -> AtomicResult<String> {
        let mut strings = Vec::new();
        for r in resources {
            strings.push(r.to_json_ld(store, origin).await?);
        }
        let str = strings.join(",");

        Ok(format!("[{}]", str))
    }

    pub fn vec_to_atoms(resources: &Vec<Resource>) -> Vec<Atom> {
        let mut atoms = Vec::new();

        for resource in resources {
            atoms.extend(resource.to_atoms_iter());
        }

        atoms
    }

    #[cfg(feature = "rdf")]
    pub async fn vec_to_n_triples(
        resources: &Vec<Resource>,
        store: &impl Storelike,
    ) -> AtomicResult<String> {
        let atoms = Self::vec_to_atoms(resources);
        crate::serialize::atoms_to_ntriples(atoms, store).await
    }
}

impl From<Resource> for crate::storelike::ResourceResponse {
    fn from(resource: Resource) -> Self {
        crate::storelike::ResourceResponse::Resource(resource)
    }
}

impl From<&Resource> for crate::storelike::ResourceResponse {
    fn from(resource: &Resource) -> Self {
        crate::storelike::ResourceResponse::Resource(resource.clone())
    }
}

#[cfg(all(test, feature = "db"))]
mod test {
    use super::*;
    use crate::{test_utils::init_store, urls};

    #[tokio::test]
    async fn get_and_set_resource_props() {
        let store: crate::Db = init_store().await;
        let mut resource = store.get_resource(&urls::CLASS.into()).await.unwrap();
        assert!(
            resource
                .get_shortname("shortname", &store)
                .await
                .unwrap()
                .to_string()
                == "class"
        );
        resource
            .set_shortname("shortname", "something-valid", &store)
            .await
            .unwrap();
        assert!(
            resource
                .get_shortname("shortname", &store)
                .await
                .unwrap()
                .to_string()
                == "something-valid"
        );
        resource
            .set_shortname("shortname", "should not contain spaces", &store)
            .await
            .unwrap_err();
    }

    #[tokio::test]
    async fn check_required_props() {
        let store: crate::Db = init_store().await;
        let mut new_resource = Resource::new_instance(urls::CLASS, &store).await.unwrap();
        new_resource
            .set_shortname("shortname", "should-fail", &store)
            .await
            .unwrap();
        new_resource.check_required_props(&store).await.unwrap_err();
        new_resource
            .set_shortname("description", "Should succeed!", &store)
            .await
            .unwrap();
        new_resource.check_required_props(&store).await.unwrap();
    }

    #[tokio::test]
    async fn new_instance() {
        let store: crate::Db = init_store().await;
        let mut new_resource = Resource::new_instance(urls::CLASS, &store).await.unwrap();
        new_resource
            .set_shortname("shortname", "person", &store)
            .await
            .unwrap();
        assert!(
            new_resource
                .get_shortname("shortname", &store)
                .await
                .unwrap()
                .to_string()
                == "person"
        );
        new_resource
            .set_shortname("shortname", "human", &store)
            .await
            .unwrap();
        new_resource
            .set_shortname("description", "A real human being", &store)
            .await
            .unwrap();
        new_resource.save_locally(&store).await.unwrap();
        assert!(
            new_resource
                .get_shortname("shortname", &store)
                .await
                .unwrap()
                .to_string()
                == "human"
        );
        let resource_from_store = store
            .get_resource(new_resource.get_subject())
            .await
            .unwrap();
        assert!(
            resource_from_store
                .get_shortname("shortname", &store)
                .await
                .unwrap()
                .to_string()
                == "human"
        );
        println!(
            "{}",
            resource_from_store
                .get_shortname("is-a", &store)
                .await
                .unwrap()
        );
        assert_eq!(
            resource_from_store
                .get_shortname("is-a", &store)
                .await
                .unwrap()
                .to_string(),
            "https://atomicdata.dev/classes/Class"
        );
        assert!(resource_from_store.get_classes(&store).await.unwrap()[0].shortname == "class");
    }

    #[tokio::test]
    async fn new_instance_using_commit() {
        let store: crate::Db = init_store().await;
        let agent = store.get_default_agent().unwrap();
        let mut new_resource = Resource::new_instance(urls::CLASS, &store).await.unwrap();
        new_resource
            .set_shortname("shortname", "person", &store)
            .await
            .unwrap();
        assert!(
            new_resource
                .get_shortname("shortname", &store)
                .await
                .unwrap()
                .to_string()
                == "person"
        );
        new_resource
            .set_shortname("shortname", "human", &store)
            .await
            .unwrap();
        new_resource
            .set_shortname("description", "A real human being", &store)
            .await
            .unwrap();
        let commit = new_resource
            .get_commit_builder()
            .clone()
            .sign(&agent, &store, &new_resource)
            .await
            .unwrap();
        store
            .apply_commit(
                commit,
                &CommitOpts {
                    validate_schema: true,
                    validate_signature: true,
                    validate_timestamp: true,
                    validate_rights: false,
                    validate_previous_commit: true,
                    validate_loro_causality: false,
                    validate_for_agent: None,
                    update_index: true,
                },
            )
            .await
            .unwrap();
        assert!(
            new_resource
                .get_shortname("shortname", &store)
                .await
                .unwrap()
                .to_string()
                == "human"
        );
        let resource_from_store = store
            .get_resource(new_resource.get_subject())
            .await
            .unwrap();
        assert!(
            resource_from_store
                .get_shortname("shortname", &store)
                .await
                .unwrap()
                .to_string()
                == "human"
        );
        println!(
            "{}",
            resource_from_store
                .get_shortname("is-a", &store)
                .await
                .unwrap()
        );
        assert_eq!(
            resource_from_store
                .get_shortname("is-a", &store)
                .await
                .unwrap()
                .to_string(),
            "https://atomicdata.dev/classes/Class"
        );
        assert!(resource_from_store.get_classes(&store).await.unwrap()[0].shortname == "class");
    }

    #[tokio::test]
    async fn iterate() {
        let store: crate::Db = init_store().await;
        let new_resource = Resource::new_instance(urls::CLASS, &store).await.unwrap();
        let mut success = false;
        for (prop, val) in new_resource.get_propvals() {
            if prop == urls::IS_A {
                assert!(val.to_subjects(None).unwrap()[0] == urls::CLASS);
                success = true;
            }
        }
        assert!(success);
    }

    #[tokio::test]
    async fn save() {
        let store: crate::Db = init_store().await;
        let property: String = urls::DESCRIPTION.into();
        let value = Value::Markdown("joe".into());
        let mut new_resource = Resource::new_instance(urls::CLASS, &store).await.unwrap();
        new_resource
            .set(property.clone(), value.clone(), &store)
            .await
            .unwrap();
        // Should fail, because a propval is missing
        assert!(new_resource.save_locally(&store).await.is_err());
        new_resource
            .set(urls::SHORTNAME.into(), Value::Slug("joe".into()), &store)
            .await
            .unwrap();
        let subject = new_resource.get_subject().clone();
        println!("subject new {}", new_resource.get_subject());
        new_resource.save_locally(&store).await.unwrap();
        let found_resource = store.get_resource(&subject).await.unwrap();
        println!("subject found {}", found_resource.get_subject());
        println!("subject all {:?}", found_resource.get_propvals());

        let found_prop = found_resource.get(&property).unwrap().clone();
        assert_eq!(found_prop.to_string(), value.to_string());
    }

    #[tokio::test]
    async fn push_propval() {
        let store: crate::Db = init_store().await;
        let property: String = urls::CHILDREN.into();
        let append_value = "https://localhost/someURL";
        let mut resource = Resource::new_generate_subject(&store).unwrap();
        resource
            .push(&property, append_value.into(), false)
            .unwrap();
        let vec = resource.get(&property).unwrap().to_subjects(None).unwrap();
        assert_eq!(
            append_value,
            vec.first().unwrap(),
            "The first element should be the appended value"
        );
        let resp = resource.save_locally(&store).await.unwrap();
        assert!(
            resp.commit_resource.get(urls::LORO_UPDATE).is_ok(),
            "Commit should have a loroUpdate"
        );

        let new_val = resp
            .resource_new
            .unwrap()
            .get(&property)
            .unwrap()
            .to_subjects(None)
            .unwrap();
        // Loro preserves the value as-given (no URL normalization on property values)
        assert_eq!(new_val.first().unwrap(), append_value);
    }

    #[tokio::test]
    async fn json_ad_serialization_includes_current_loro_snapshot() {
        let store: crate::Db = init_store().await;
        let mut resource = Resource::new_generate_subject(&store).unwrap();
        resource.set_name("Loro-backed resource");
        resource
            .set_loro(
                urls::DESCRIPTION,
                &Value::String("Server-side snapshot".into()),
            )
            .unwrap();

        let json = resource.to_json_ad(Some("http://localhost")).unwrap();

        assert!(
            json.contains(urls::LORO_UPDATE),
            "serialized JSON-AD should include the latest loroUpdate"
        );
        assert!(
            json.contains("Server-side snapshot"),
            "serialized JSON-AD should still include materialized properties"
        );
    }

    #[tokio::test]
    async fn set_propvals_unsafe_resets_stale_loro_state() {
        let store: crate::Db = init_store().await;
        let mut resource = Resource::new_generate_subject(&store).unwrap();
        resource
            .set_loro(urls::DESCRIPTION, &Value::String("Old loro value".into()))
            .unwrap();

        let mut propvals = PropVals::new();
        propvals.insert(urls::NAME.into(), Value::String("Fresh propvals".into()));
        resource.set_propvals_unsafe(propvals);

        resource.init_loro().unwrap();
        let doc = resource.loro.as_ref().unwrap();
        let properties = doc.get_all_properties();

        assert!(
            !properties.contains_key(urls::DESCRIPTION),
            "stale loro-only properties should be dropped when propvals are replaced"
        );
        assert_eq!(
            resource.get(urls::NAME).unwrap().to_string(),
            "Fresh propvals"
        );
    }

    #[tokio::test]
    async fn get_children() {
        let store: crate::Db = init_store().await;
        let mut resource1 = Resource::new_generate_subject(&store).unwrap();
        let subject1 = resource1.get_subject().to_string();
        resource1.save_locally(&store).await.unwrap();

        let mut resource2 = Resource::new_generate_subject(&store).unwrap();
        resource2
            .set(
                urls::PARENT.into(),
                Value::AtomicUrl(subject1.into()),
                &store,
            )
            .await
            .unwrap();
        let subject2 = resource2.get_subject().to_string();
        resource2.save_locally(&store).await.unwrap();

        let children = resource1.get_children(&store).await.unwrap();

        assert_eq!(children.len(), 1);
        assert_eq!(children[0].get_subject().to_string(), subject2);
    }
}
