//! Loro CRDT integration for Atomic Data.
//!
//! Each Atomic Resource can be backed by a LoroDoc. Properties become named containers
//! within the document. Commits carry Loro binary updates instead of (or in addition to)
//! set/remove/push deltas. The server imports the update, derives add/remove atoms from
//! the diff events, and updates indexes — the read path (JSON-AD) stays unchanged.

use crate::errors::AtomicResult;
use crate::values::Value;
use crate::Atom;
use loro::{ExportMode, LoroDoc, VersionVector};
use std::ops::ControlFlow;

/// Opaque identifier for a specific version of a resource.
/// Internally wraps Loro's Frontiers.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct VersionID(Vec<u8>);

impl VersionID {
    pub fn from_frontiers(f: &loro::Frontiers) -> Self {
        Self(f.encode())
    }

    pub fn to_frontiers(&self) -> AtomicResult<loro::Frontiers> {
        loro::Frontiers::decode(&self.0)
            .map_err(|e| format!("Failed to decode VersionID: {e}").into())
    }

    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    pub fn bytes(&self) -> &[u8] {
        &self.0
    }
}

/// Metadata about a specific historical version (change) in the Loro oplog.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct VersionMetadata {
    /// Opaque version identifier (encoded Loro Frontiers).
    pub id: VersionID,
    /// Unix timestamp in milliseconds (0 if not recorded).
    pub timestamp: i64,
    /// The peer that authored this change (Loro PeerID as string).
    pub peer_id: String,
    /// Lamport timestamp — establishes causal order across peers.
    pub lamport: u64,
    /// Number of operations in this change.
    pub len: usize,
    /// Optional commit message attached to the change.
    pub message: Option<String>,
}

/// Wraps a LoroDoc for an Atomic Resource, providing helpers to convert between
/// Atomic Data property/value pairs and Loro containers.
pub struct AtomicLoroDoc {
    doc: LoroDoc,
    /// Lazily initialized undo manager. Only created when undo/redo is needed.
    undo_manager: std::sync::Mutex<Option<loro::UndoManager>>,
}

impl std::fmt::Debug for AtomicLoroDoc {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AtomicLoroDoc")
            .field("peer_id", &self.doc.peer_id())
            .finish()
    }
}

/// The result of applying a Loro update to a document.
/// Contains the atom-level diff needed to update indexes.
pub struct LoroDiff {
    pub add_atoms: Vec<Atom>,
    pub remove_atoms: Vec<Atom>,
}

impl AtomicLoroDoc {
    /// Create a new empty LoroDoc for a resource.
    pub fn new() -> Self {
        let doc = LoroDoc::new();
        // Enable timestamps for history scrubbing
        doc.set_record_timestamp(true);
        Self {
            doc,
            undo_manager: std::sync::Mutex::new(None),
        }
    }

    /// Create from an existing snapshot (e.g. loaded from the database).
    pub fn from_snapshot(snapshot: &[u8]) -> AtomicResult<Self> {
        let doc = LoroDoc::new();
        doc.set_record_timestamp(true);
        doc.import(snapshot)
            .map_err(|e| format!("Failed to import Loro snapshot: {e}"))?;
        Ok(Self {
            doc,
            undo_manager: std::sync::Mutex::new(None),
        })
    }

    /// Import a binary update (from a commit's loroUpdate field).
    pub fn import_update(&self, update: &[u8]) -> AtomicResult<()> {
        self.doc
            .import(update)
            .map_err(|e| format!("Failed to import Loro update: {e}"))?;
        Ok(())
    }

    /// Export a snapshot of the full document state.
    pub fn export_snapshot(&self) -> Vec<u8> {
        self.doc.export(ExportMode::Snapshot).unwrap()
    }

    /// Export only the updates since a given version.
    pub fn export_updates_since(&self, version: &VersionVector) -> Vec<u8> {
        self.doc.export(ExportMode::updates(version)).unwrap()
    }

    /// Returns the current version of the document.
    pub fn current_version(&self) -> VersionID {
        VersionID::from_frontiers(&self.doc.state_frontiers())
    }

    /// Moves the document to a historical version.
    /// The doc enters a "detached" read-only state.
    pub fn checkout(&self, version: &VersionID) -> AtomicResult<()> {
        let f = version.to_frontiers()?;
        self.doc.checkout(&f)
            .map_err(|e| format!("Loro checkout error: {e}").into())
    }

    /// Returns the document to the latest version and enables editing.
    pub fn attach(&self) -> AtomicResult<()> {
        self.doc.checkout_to_latest();
        Ok(())
    }

    /// Returns a list of all historical versions (changes) in the document,
    /// sorted by timestamp descending (newest first).
    ///
    /// Each entry represents a change made by a peer, with its version ID,
    /// timestamp, peer ID, and operation count.
    pub fn get_history(&self) -> Vec<VersionMetadata> {
        let mut history = Vec::new();
        let frontier_ids: Vec<loro::ID> = self.doc.oplog_frontiers().iter().collect();

        if frontier_ids.is_empty() {
            return history;
        }

        let _ = self.doc.travel_change_ancestors(&frontier_ids, &mut |change| {
            let id = VersionID::from_frontiers(&loro::Frontiers::from_id(change.id));
            history.push(VersionMetadata {
                id,
                timestamp: change.timestamp,
                peer_id: change.id.peer.to_string(),
                lamport: change.lamport as u64,
                len: change.len,
                message: change.message.map(|m| m.to_string()),
            });
            ControlFlow::Continue(())
        });

        // travel_change_ancestors yields in reverse lamport order (newest first),
        // but sort explicitly by timestamp for consistent output.
        history.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        history
    }

    /// Returns the properties at a specific historical version without
    /// mutating the document's checkout state. Creates a fork of the doc
    /// at the requested version and reads all properties.
    pub fn get_properties_at(
        &self,
        version: &VersionID,
    ) -> AtomicResult<std::collections::HashMap<String, loro::LoroValue>> {
        let frontiers = version.to_frontiers()?;
        let fork = self.doc.fork_at(&frontiers);
        let root = fork.get_map("properties");
        let mut result = std::collections::HashMap::new();
        root.for_each(|key, value: loro::ValueOrContainer| {
            result.insert(key.to_string(), value.get_deep_value());
        });
        Ok(result)
    }

    /// Get the oplog version vector as a serializable map (peer_id → counter).
    pub fn oplog_vv_map(&self) -> std::collections::HashMap<String, i32> {
        self.doc
            .oplog_vv()
            .iter()
            .map(|(peer_id, counter)| (peer_id.to_string(), *counter))
            .collect()
    }

    /// Get the raw oplog version vector.
    pub fn oplog_vv(&self) -> VersionVector {
        self.doc.oplog_vv()
    }

    /// Encode the version vector to bytes (for hashing).
    pub fn oplog_vv_bytes(&self) -> Vec<u8> {
        self.doc.oplog_vv().encode()
    }

    /// Build a VersionVector from a map of peer_id_string → counter.
    pub fn vv_from_map(map: &std::collections::HashMap<String, i32>) -> VersionVector {
        map.iter()
            .filter_map(|(peer_str, &counter)| {
                peer_str.parse::<u64>().ok().map(|pid| (pid, counter))
            })
            .collect()
    }

    /// Get a reference to the inner LoroDoc.
    pub fn doc(&self) -> &LoroDoc {
        &self.doc
    }

    /// Set a property on the root map of the document.
    /// This is the Loro equivalent of a `set` in a commit.
    pub fn set_property(&self, property: &str, value: &Value) -> AtomicResult<()> {
        let root = self.doc.get_map("properties");
        match value {
            Value::String(s) | Value::Markdown(s) | Value::Slug(s) | Value::Date(s) => {
                root.insert(property, s.as_str())
                    .map_err(|e| format!("Loro set error: {e}"))?;
            }
            Value::Integer(i) | Value::Timestamp(i) => {
                root.insert(property, *i)
                    .map_err(|e| format!("Loro set error: {e}"))?;
            }
            Value::Float(f) => {
                root.insert(property, *f)
                    .map_err(|e| format!("Loro set error: {e}"))?;
            }
            Value::Boolean(b) => {
                root.insert(property, *b)
                    .map_err(|e| format!("Loro set error: {e}"))?;
            }
            Value::AtomicUrl(subject) => {
                root.insert(property, subject.to_string().as_str())
                    .map_err(|e| format!("Loro set error: {e}"))?;
            }
            Value::Uri(s) => {
                root.insert(property, s.as_str())
                    .map_err(|e| format!("Loro set error: {e}"))?;
            }
            Value::ResourceArray(arr) => {
                // Use native LoroList for arrays — enables per-element CRDT merge.
                let list = root
                    .insert_container(property, loro::LoroList::new())
                    .map_err(|e| format!("Loro insert_container error: {e}"))?;

                for item in arr {
                    list.push(item.to_string())
                        .map_err(|e| format!("Loro list push error: {e}"))?;
                }
            }
            Value::Json(json_val) => {
                root.insert(property, json_val.to_string().as_str())
                    .map_err(|e| format!("Loro set error: {e}"))?;
            }
            Value::JsonArray(arr) => {
                // LoroList of LoroMaps — each element merges independently via CRDT.
                let list = root
                    .insert_container(property, loro::LoroList::new())
                    .map_err(|e| format!("Loro insert_container error: {e}"))?;
                for item in arr {
                    let map = list
                        .push_container(loro::LoroMap::new())
                        .map_err(|e| format!("Loro push_container error: {e}"))?;
                    json_value_to_loro_map(item, &map)?;
                }
            }
            _ => {
                // For other complex types, serialize the display string.
                root.insert(property, value.to_string().as_str())
                    .map_err(|e| format!("Loro set error: {e}"))?;
            }
        }
        Ok(())
    }

    /// Push an item to a JsonArray property's LoroList.
    /// Creates the list if it doesn't exist. Does NOT replace existing items.
    pub fn push_to_json_array(&self, property: &str, item: &serde_json::Value) -> AtomicResult<()> {
        let root = self.doc.get_map("properties");

        // Get or create the LoroList for this property
        let list = match root.get(property) {
            Some(loro::ValueOrContainer::Container(c)) => {
                c.into_list().map_err(|_| format!("{property} is not a list"))?
            }
            _ => {
                root.insert_container(property, loro::LoroList::new())
                    .map_err(|e| format!("Loro insert_container error: {e}"))?
            }
        };

        let map = list
            .push_container(loro::LoroMap::new())
            .map_err(|e| format!("Loro push_container error: {e}"))?;
        json_value_to_loro_map(item, &map)?;
        Ok(())
    }

    /// Clear all items from a JsonArray property's LoroList.
    pub fn clear_json_array(&self, property: &str) -> AtomicResult<()> {
        let root = self.doc.get_map("properties");
        if let Some(loro::ValueOrContainer::Container(c)) = root.get(property) {
            if let Ok(list) = c.into_list() {
                let len = list.len();
                if len > 0 {
                    list.delete(0, len).map_err(|e| format!("Loro list delete error: {e}"))?;
                }
            }
        }
        Ok(())
    }

    /// Insert a JSON item at a specific index in a JsonArray property's LoroList.
    pub fn insert_into_json_array(
        &self,
        property: &str,
        index: usize,
        item: &serde_json::Value,
    ) -> AtomicResult<()> {
        let root = self.doc.get_map("properties");
        match root.get(property) {
            Some(loro::ValueOrContainer::Container(c)) => {
                let list = c
                    .into_list()
                    .map_err(|_| format!("{property} is not a list"))?;
                if index > list.len() {
                    return Err(format!(
                        "Index {index} out of bounds for {property} (len {})",
                        list.len()
                    )
                    .into());
                }
                let map = list
                    .insert_container(index, loro::LoroMap::new())
                    .map_err(|e| format!("Loro insert_container error: {e}"))?;
                json_value_to_loro_map(item, &map)?;
                Ok(())
            }
            _ => Err(format!("{property} is not a list container").into()),
        }
    }

    /// Delete an item at a specific index from a JsonArray property's LoroList.
    pub fn delete_from_json_array(&self, property: &str, index: usize) -> AtomicResult<()> {
        let root = self.doc.get_map("properties");
        match root.get(property) {
            Some(loro::ValueOrContainer::Container(c)) => {
                let list = c
                    .into_list()
                    .map_err(|_| format!("{property} is not a list"))?;
                if index >= list.len() {
                    return Err(format!(
                        "Index {index} out of bounds for {property} (len {})",
                        list.len()
                    )
                    .into());
                }
                list.delete(index, 1)
                    .map_err(|e| format!("Loro list delete error: {e}"))?;
                Ok(())
            }
            _ => Err(format!("{property} is not a list container").into()),
        }
    }

    /// Ensure the UndoManager is initialized. Call before mutations that
    /// should be undoable. Subsequent calls are no-ops.
    pub fn ensure_undo_manager(&self) {
        let mut guard = self.undo_manager.lock().unwrap();
        if guard.is_none() {
            let mut um = loro::UndoManager::new(&self.doc);
            um.set_max_undo_steps(200);
            // Each top-level operation (push_stroke, delete_stroke) is its own
            // undo step — don't merge based on time.
            um.set_merge_interval(0);
            *guard = Some(um);
        }
    }

    /// Record a checkpoint so that subsequent operations form a new undo group.
    pub fn checkpoint(&self) -> AtomicResult<()> {
        self.ensure_undo_manager();
        let mut guard = self.undo_manager.lock().unwrap();
        if let Some(um) = guard.as_mut() {
            um.record_new_checkpoint()
                .map_err(|e| format!("Loro checkpoint error: {e}"))?;
        }
        Ok(())
    }

    /// Undo the last local operation. Returns true if something was undone.
    pub fn undo(&self) -> AtomicResult<bool> {
        self.ensure_undo_manager();
        let mut guard = self.undo_manager.lock().unwrap();
        match guard.as_mut() {
            Some(um) if um.can_undo() => um
                .undo()
                .map_err(|e| format!("Loro undo error: {e}").into()),
            _ => Ok(false),
        }
    }

    /// Redo the last undone operation. Returns true if something was redone.
    pub fn redo(&self) -> AtomicResult<bool> {
        self.ensure_undo_manager();
        let mut guard = self.undo_manager.lock().unwrap();
        match guard.as_mut() {
            Some(um) if um.can_redo() => um
                .redo()
                .map_err(|e| format!("Loro redo error: {e}").into()),
            _ => Ok(false),
        }
    }

    /// Whether undo is available.
    pub fn can_undo(&self) -> bool {
        self.undo_manager
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|um| um.can_undo()))
            .unwrap_or(false)
    }

    /// Whether redo is available.
    pub fn can_redo(&self) -> bool {
        self.undo_manager
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|um| um.can_redo()))
            .unwrap_or(false)
    }

    /// Remove a property from the root map.
    pub fn remove_property(&self, property: &str) -> AtomicResult<()> {
        let root = self.doc.get_map("properties");
        root.delete(property)
            .map_err(|e| format!("Loro remove error: {e}"))?;
        Ok(())
    }

    /// Get a string property from the root map.
    pub fn get_string_property(&self, property: &str) -> Option<String> {
        let root = self.doc.get_map("properties");
        root.get(property)
            .and_then(|v| v.into_value().ok())
            .and_then(|v| match v {
                loro::LoroValue::String(s) => Some(s.to_string()),
                _ => None,
            })
    }

    /// Get an integer property from the root map.
    pub fn get_integer_property(&self, property: &str) -> Option<i64> {
        let root = self.doc.get_map("properties");
        root.get(property)
            .and_then(|v| v.into_value().ok())
            .and_then(|v| match v {
                loro::LoroValue::I64(i) => Some(i),
                _ => None,
            })
    }

    /// Get all properties from the root map as a HashMap of LoroValues.
    pub fn get_all_properties(&self) -> std::collections::HashMap<String, loro::LoroValue> {
        let root = self.doc.get_map("properties");
        let mut result = std::collections::HashMap::new();
        root.for_each(|key, value| {
            match value.into_value() {
                Ok(v) => {
                    result.insert(key.to_string(), v);
                }
                Err(container) => {
                    // Container types (LoroList, LoroMap, etc.) — get their deep value.
                    result.insert(key.to_string(), container.get_deep_value());
                }
            }
        });
        result
    }

    /// Import an update and compute the diff as add/remove atoms.
    /// Compares the properties map before and after the import.
    pub fn import_update_with_diff(&self, update: &[u8], subject: &str) -> AtomicResult<LoroDiff> {
        let before = self.get_all_properties();
        self.import_update(update)?;
        let after = self.get_all_properties();

        let mut add_atoms = Vec::new();
        let mut remove_atoms = Vec::new();

        // Check for added/changed properties
        for (key, new_val) in &after {
            match before.get(key) {
                Some(old_val) if old_val != new_val => {
                    // Changed: remove old, add new
                    if let Some(old_v) = loro_value_to_atomic_value(old_val) {
                        remove_atoms.push(Atom::new(subject.into(), key.clone(), old_v));
                    }
                    if let Some(new_v) = loro_value_to_atomic_value(new_val) {
                        add_atoms.push(Atom::new(subject.into(), key.clone(), new_v));
                    }
                }
                None => {
                    // Added
                    if let Some(new_v) = loro_value_to_atomic_value(new_val) {
                        add_atoms.push(Atom::new(subject.into(), key.clone(), new_v));
                    }
                }
                _ => {} // Unchanged
            }
        }

        // Check for removed properties
        for (key, old_val) in &before {
            if !after.contains_key(key) {
                if let Some(old_v) = loro_value_to_atomic_value(old_val) {
                    remove_atoms.push(Atom::new(subject.into(), key.clone(), old_v));
                }
            }
        }

        Ok(LoroDiff {
            add_atoms,
            remove_atoms,
        })
    }
}

/// Convert a Loro value to an Atomic Data Value.
pub fn loro_value_to_atomic_value(lv: &loro::LoroValue) -> Option<Value> {
    match lv {
        loro::LoroValue::String(s) => {
            let s = s.to_string();

            // Legacy: try to detect JSON-encoded arrays from older Loro docs
            if s.starts_with('[') {
                if let Ok(arr) = serde_json::from_str::<Vec<String>>(&s) {
                    let subjects: Vec<crate::values::SubResource> =
                        arr.into_iter().map(|v| v.into()).collect();
                    return Some(Value::ResourceArray(subjects));
                }
            }

            // Legacy: try to detect JSON-encoded objects from older Loro docs
            if s.starts_with('{') {
                if let Ok(obj) =
                    serde_json::from_str::<std::collections::HashMap<String, Value>>(&s)
                {
                    return Some(Value::NestedResource(crate::values::SubResource::Nested(
                        obj,
                    )));
                }
            }

            Some(Value::String(s))
        }
        loro::LoroValue::I64(i) => Some(Value::Integer(*i)),
        loro::LoroValue::Double(f) => Some(Value::Float(*f)),
        loro::LoroValue::Bool(b) => Some(Value::Boolean(*b)),
        loro::LoroValue::Null => None,
        loro::LoroValue::List(items) => {
            if items.is_empty() {
                return None;
            }

            // Check the first item to determine list type:
            // - Map items → JsonArray (native LoroMap elements)
            // - String items → ResourceArray or legacy JsonArray
            match &items[0] {
                loro::LoroValue::Map(_) => {
                    // Native LoroMaps → JsonArray
                    let json_items: Vec<serde_json::Value> = items
                        .iter()
                        .map(|item| loro_value_to_json(item))
                        .collect();
                    Some(Value::JsonArray(json_items))
                }
                loro::LoroValue::String(first_s) => {
                    let first = first_s.to_string();
                    let trimmed = first.trim_start();
                    if trimmed.starts_with('{') || trimmed.starts_with('[') {
                        // Legacy: JSON strings in list → JsonArray
                        let json_items: Vec<serde_json::Value> = items
                            .iter()
                            .filter_map(|item| match item {
                                loro::LoroValue::String(s) => serde_json::from_str(s.as_ref()).ok(),
                                _ => None,
                            })
                            .collect();
                        if json_items.is_empty() { None } else { Some(Value::JsonArray(json_items)) }
                    } else {
                        // ResourceArray: plain URL strings
                        let subjects: Vec<crate::values::SubResource> = items
                            .iter()
                            .filter_map(|item| match item {
                                loro::LoroValue::String(s) => Some(s.to_string().into()),
                                _ => None,
                            })
                            .collect();
                        if subjects.is_empty() { None } else { Some(Value::ResourceArray(subjects)) }
                    }
                }
                _ => None,
            }
        }
        loro::LoroValue::Map(m) => {
            // Single map → JSON object
            Some(Value::Json(loro_value_to_json(&loro::LoroValue::Map(m.clone()))))
        }
        _ => None,
    }
}

/// Write a serde_json::Value into a LoroMap. Handles nested objects and arrays.
fn json_value_to_loro_map(
    json: &serde_json::Value,
    map: &loro::LoroMap,
) -> AtomicResult<()> {
    if let serde_json::Value::Object(obj) = json {
        for (key, val) in obj {
            match val {
                serde_json::Value::String(s) => {
                    map.insert(key, s.as_str())
                        .map_err(|e| format!("Loro map insert error: {e}"))?;
                }
                serde_json::Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        map.insert(key, i)
                            .map_err(|e| format!("Loro map insert error: {e}"))?;
                    } else if let Some(f) = n.as_f64() {
                        map.insert(key, f)
                            .map_err(|e| format!("Loro map insert error: {e}"))?;
                    }
                }
                serde_json::Value::Bool(b) => {
                    map.insert(key, *b)
                        .map_err(|e| format!("Loro map insert error: {e}"))?;
                }
                serde_json::Value::Array(arr) => {
                    let list = map
                        .insert_container(key, loro::LoroList::new())
                        .map_err(|e| format!("Loro insert_container error: {e}"))?;
                    for item in arr {
                        json_value_to_loro_list_item(item, &list)?;
                    }
                }
                serde_json::Value::Object(_) => {
                    let nested = map
                        .insert_container(key, loro::LoroMap::new())
                        .map_err(|e| format!("Loro insert_container error: {e}"))?;
                    json_value_to_loro_map(val, &nested)?;
                }
                serde_json::Value::Null => {}
            }
        }
    }
    Ok(())
}

/// Push a JSON value into a LoroList.
fn json_value_to_loro_list_item(
    json: &serde_json::Value,
    list: &loro::LoroList,
) -> AtomicResult<()> {
    match json {
        serde_json::Value::String(s) => {
            list.push(s.as_str()).map_err(|e| format!("Loro list push error: {e}"))?;
        }
        serde_json::Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                list.push(f).map_err(|e| format!("Loro list push error: {e}"))?;
            }
        }
        serde_json::Value::Bool(b) => {
            list.push(*b).map_err(|e| format!("Loro list push error: {e}"))?;
        }
        serde_json::Value::Array(arr) => {
            let nested = list
                .push_container(loro::LoroList::new())
                .map_err(|e| format!("Loro push_container error: {e}"))?;
            for item in arr {
                json_value_to_loro_list_item(item, &nested)?;
            }
        }
        serde_json::Value::Object(_) => {
            let nested = list
                .push_container(loro::LoroMap::new())
                .map_err(|e| format!("Loro push_container error: {e}"))?;
            json_value_to_loro_map(json, &nested)?;
        }
        serde_json::Value::Null => {}
    }
    Ok(())
}

/// Convert a LoroValue back to serde_json::Value.
fn loro_value_to_json(lv: &loro::LoroValue) -> serde_json::Value {
    match lv {
        loro::LoroValue::String(s) => serde_json::Value::String(s.to_string()),
        loro::LoroValue::I64(i) => serde_json::json!(*i),
        loro::LoroValue::Double(f) => serde_json::json!(*f),
        loro::LoroValue::Bool(b) => serde_json::Value::Bool(*b),
        loro::LoroValue::Null => serde_json::Value::Null,
        loro::LoroValue::List(items) => {
            serde_json::Value::Array(items.iter().map(loro_value_to_json).collect())
        }
        loro::LoroValue::Map(map) => {
            let obj: serde_json::Map<String, serde_json::Value> = map
                .iter()
                .map(|(k, v)| (k.to_string(), loro_value_to_json(v)))
                .collect();
            serde_json::Value::Object(obj)
        }
        _ => serde_json::Value::Null,
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::Storelike;

    #[test]
    fn create_doc_set_and_get_properties() {
        let doc = AtomicLoroDoc::new();
        doc.set_property(
            "https://atomicdata.dev/properties/name",
            &Value::String("Alice".into()),
        )
        .unwrap();
        doc.set_property("https://atomicdata.dev/properties/age", &Value::Integer(30))
            .unwrap();
        doc.set_property(
            "https://atomicdata.dev/properties/score",
            &Value::Float(9.5),
        )
        .unwrap();

        assert_eq!(
            doc.get_string_property("https://atomicdata.dev/properties/name"),
            Some("Alice".into())
        );
        assert_eq!(
            doc.get_integer_property("https://atomicdata.dev/properties/age"),
            Some(30)
        );
    }

    #[test]
    fn snapshot_roundtrip() {
        let doc = AtomicLoroDoc::new();
        doc.set_property(
            "https://atomicdata.dev/properties/name",
            &Value::String("Bob".into()),
        )
        .unwrap();

        let snapshot = doc.export_snapshot();
        let doc2 = AtomicLoroDoc::from_snapshot(&snapshot).unwrap();

        assert_eq!(
            doc2.get_string_property("https://atomicdata.dev/properties/name"),
            Some("Bob".into())
        );
    }

    #[test]
    fn incremental_update_sync() {
        let doc_a = AtomicLoroDoc::new();
        doc_a
            .set_property(
                "https://atomicdata.dev/properties/name",
                &Value::String("Alice".into()),
            )
            .unwrap();

        // Sync doc_a -> doc_b via snapshot
        let snapshot = doc_a.export_snapshot();
        let doc_b = AtomicLoroDoc::from_snapshot(&snapshot).unwrap();

        // Now doc_a makes a new change
        let version_before = doc_a.doc().oplog_vv();
        doc_a
            .set_property("https://atomicdata.dev/properties/age", &Value::Integer(25))
            .unwrap();

        // Export only the delta
        let update = doc_a.export_updates_since(&version_before);

        // Apply delta to doc_b
        doc_b.import_update(&update).unwrap();

        // doc_b now has both properties
        assert_eq!(
            doc_b.get_string_property("https://atomicdata.dev/properties/name"),
            Some("Alice".into())
        );
        assert_eq!(
            doc_b.get_integer_property("https://atomicdata.dev/properties/age"),
            Some(25)
        );
    }

    #[test]
    fn concurrent_edits_merge_automatically() {
        // Two peers start from the same state
        let doc_a = AtomicLoroDoc::new();
        doc_a
            .set_property(
                "https://atomicdata.dev/properties/name",
                &Value::String("Original Name".into()),
            )
            .unwrap();
        let snapshot = doc_a.export_snapshot();
        let doc_b = AtomicLoroDoc::from_snapshot(&snapshot).unwrap();

        let version_a = doc_a.doc().oplog_vv();
        let version_b = doc_b.doc().oplog_vv();

        // Peer A changes name
        doc_a
            .set_property(
                "https://atomicdata.dev/properties/name",
                &Value::String("From A".into()),
            )
            .unwrap();
        // Peer A adds a property
        doc_a
            .set_property(
                "https://atomicdata.dev/properties/description",
                &Value::String("Desc from A".into()),
            )
            .unwrap();

        // Peer B changes a different property concurrently
        doc_b
            .set_property("https://atomicdata.dev/properties/age", &Value::Integer(42))
            .unwrap();

        // Exchange updates — this is the core of the sync protocol
        let update_a = doc_a.export_updates_since(&version_a);
        let update_b = doc_b.export_updates_since(&version_b);

        doc_a.import_update(&update_b).unwrap();
        doc_b.import_update(&update_a).unwrap();

        // Both docs converge to the same state
        assert_eq!(
            doc_a.get_string_property("https://atomicdata.dev/properties/name"),
            doc_b.get_string_property("https://atomicdata.dev/properties/name"),
        );
        assert_eq!(
            doc_a.get_integer_property("https://atomicdata.dev/properties/age"),
            Some(42)
        );
        assert_eq!(
            doc_a.get_string_property("https://atomicdata.dev/properties/description"),
            Some("Desc from A".into())
        );
        // Both docs have the same state
        assert_eq!(
            doc_b.get_integer_property("https://atomicdata.dev/properties/age"),
            Some(42)
        );
        assert_eq!(
            doc_b.get_string_property("https://atomicdata.dev/properties/description"),
            Some("Desc from A".into())
        );
    }

    #[test]
    fn remove_property_works() {
        let doc = AtomicLoroDoc::new();
        doc.set_property(
            "https://atomicdata.dev/properties/name",
            &Value::String("Alice".into()),
        )
        .unwrap();
        assert!(doc
            .get_string_property("https://atomicdata.dev/properties/name")
            .is_some());

        doc.remove_property("https://atomicdata.dev/properties/name")
            .unwrap();
        assert!(doc
            .get_string_property("https://atomicdata.dev/properties/name")
            .is_none());
    }

    #[test]
    fn rich_text_collaboration() {
        // Loro's Text type — this would replace Yjs for rich text
        let doc_a = LoroDoc::new();
        let text_a = doc_a.get_text("description");
        text_a.insert(0, "Hello World").unwrap();

        let snapshot = doc_a.export(ExportMode::Snapshot).unwrap();
        let doc_b = LoroDoc::new();
        doc_b.import(&snapshot).unwrap();

        let text_b = doc_b.get_text("description");
        assert_eq!(text_b.to_string(), "Hello World");

        // Concurrent edits to the same text
        let v_a = doc_a.oplog_vv();
        let v_b = doc_b.oplog_vv();

        text_a.insert(5, " Beautiful").unwrap();
        // "Hello Beautiful World"
        text_b.insert(11, "!").unwrap();
        // "Hello World!"

        let update_a = doc_a.export(ExportMode::updates(&v_a)).unwrap();
        let update_b = doc_b.export(ExportMode::updates(&v_b)).unwrap();

        doc_a.import(&update_b).unwrap();
        doc_b.import(&update_a).unwrap();

        // Both converge — the exact merge result depends on Loro's CRDT semantics,
        // but both docs will have the same string.
        assert_eq!(text_a.to_string(), text_b.to_string());
        // Both insertions are preserved
        assert!(text_a.to_string().contains("Beautiful"));
        assert!(text_a.to_string().contains("!"));
    }

    #[test]
    fn loro_update_in_commit_flow() {
        // Simulates the commit flow:
        // 1. Client creates a LoroDoc, makes changes
        // 2. Client exports update as binary, base64-encodes it, puts in commit
        // 3. Server receives commit, decodes update, imports into its LoroDoc

        // === Client side ===
        let client_doc = AtomicLoroDoc::new();
        client_doc
            .set_property(
                "https://atomicdata.dev/properties/name",
                &Value::String("New Resource".into()),
            )
            .unwrap();
        client_doc
            .set_property(
                "https://atomicdata.dev/properties/description",
                &Value::Markdown("Hello".into()),
            )
            .unwrap();

        // Client exports update bytes
        let update_bytes = client_doc.export_snapshot();
        // In a real commit, this would be base64-encoded into the commit body
        use base64::Engine;
        let base64_update = base64::engine::general_purpose::STANDARD.encode(&update_bytes);

        // === Server side ===
        // Server decodes the base64 update from the commit
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&base64_update)
            .unwrap();

        // Server has an existing (or new) LoroDoc for this resource
        let server_doc = AtomicLoroDoc::new();
        server_doc.import_update(&decoded).unwrap();

        // Server can now read the materialized state for JSON-AD
        assert_eq!(
            server_doc.get_string_property("https://atomicdata.dev/properties/name"),
            Some("New Resource".into())
        );
        assert_eq!(
            server_doc.get_string_property("https://atomicdata.dev/properties/description"),
            Some("Hello".into())
        );

        // Server persists the snapshot for future merges
        let server_snapshot = server_doc.export_snapshot();
        assert!(!server_snapshot.is_empty());
    }

    #[test]
    fn movable_list_for_kanban() {
        // MovableList is perfect for kanban columns where items get reordered
        let doc = LoroDoc::new();
        let list = doc.get_movable_list("kanban_column");

        list.push("task-1").unwrap();
        list.push("task-2").unwrap();
        list.push("task-3").unwrap();

        // Move task-3 to the front
        list.mov(2, 0).unwrap();

        let items: Vec<String> = (0..list.len())
            .map(|i| {
                list.get(i)
                    .unwrap()
                    .into_value()
                    .unwrap()
                    .as_string()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(items, vec!["task-3", "task-1", "task-2"]);
    }

    #[test]
    fn tree_for_hierarchy() {
        // Loro's Tree type maps well to Atomic Data's parent-child hierarchy
        let doc = LoroDoc::new();
        let tree = doc.get_tree("hierarchy");

        let root = tree.create(loro::TreeParentId::Root).unwrap();
        let child1 = tree.create(loro::TreeParentId::Node(root)).unwrap();
        let child2 = tree.create(loro::TreeParentId::Node(root)).unwrap();

        // Move child2 under child1
        tree.mov(child2, loro::TreeParentId::Node(child1)).unwrap();

        // Verify structure
        let root_children = tree.children(loro::TreeParentId::Root).unwrap();
        assert_eq!(root_children.len(), 1); // only root node
        let child1_children = tree.children(loro::TreeParentId::Node(child1)).unwrap();
        assert_eq!(child1_children.len(), 1); // child2 is now under child1
    }

    // === Integration tests: loroUpdate through the commit pipeline ===

    #[tokio::test]
    async fn loro_update_commit_through_store() {
        // Full pipeline: create LoroDoc → export update → build CommitBuilder with
        // loroUpdate → sign → apply_commit → verify resource has materialized propvals
        let store = crate::Store::init().await.unwrap();
        store.set_base_url("http://localhost:9883");
        store.populate().await.unwrap();
        let agent = store.create_agent(Some("loro_test")).await.unwrap();
        let subject = "https://localhost/loro_test_resource";

        // Client-side: create a LoroDoc with properties
        let client_doc = AtomicLoroDoc::new();
        client_doc
            .set_property(
                crate::urls::DESCRIPTION,
                &Value::String("Hello from Loro".into()),
            )
            .unwrap();
        client_doc
            .set_property(crate::urls::SHORTNAME, &Value::String("loro-test".into()))
            .unwrap();

        // Export the update
        let update = client_doc.export_snapshot();

        // Build a commit with the loro update
        let mut builder = crate::commit::CommitBuilder::new(subject.into());
        builder.set_loro_update(update);
        // Also set isA so schema validation can work (or we skip it)
        builder.set(
            crate::urls::IS_A.into(),
            Value::ResourceArray(vec![crate::urls::CLASS.into()]),
        );

        let resource = crate::Resource::new(subject.into());
        let commit = builder.sign(&agent, &store, &resource).await.unwrap();

        // Apply the commit
        let opts = crate::commit::CommitOpts {
            validate_schema: false,
            validate_signature: true,
            validate_timestamp: true,
            validate_rights: false,
            validate_previous_commit: false,
            update_index: false,
            validate_for_agent: None,
        };
        let response = store.apply_commit(commit, &opts).await.unwrap();

        // Verify the resource now has the materialized properties from Loro
        let new_resource = response.resource_new.unwrap();
        assert_eq!(
            new_resource
                .get(crate::urls::DESCRIPTION)
                .unwrap()
                .to_string(),
            "Hello from Loro"
        );
        assert_eq!(
            new_resource
                .get(crate::urls::SHORTNAME)
                .unwrap()
                .to_string(),
            "loro-test"
        );

        // Verify the Loro snapshot was persisted on the resource
        let loro_snap = new_resource.get(crate::urls::LORO_UPDATE);
        assert!(loro_snap.is_ok(), "Resource should have a LoroDoc snapshot");
    }

    #[tokio::test]
    async fn loro_update_concurrent_merge() {
        // Two clients make concurrent edits via loroUpdate, both applied to the same resource.
        // The second commit should merge with the first without conflict.
        let store = crate::Store::init().await.unwrap();
        store.set_base_url("http://localhost:9883");
        store.populate().await.unwrap();
        let agent = store.create_agent(Some("loro_merge")).await.unwrap();
        let subject = "https://localhost/loro_merge_resource";

        let opts = crate::commit::CommitOpts {
            validate_schema: false,
            validate_signature: true,
            validate_timestamp: true,
            validate_rights: false,
            validate_previous_commit: false,
            update_index: false,
            validate_for_agent: None,
        };

        // Client A sets name
        let doc_a = AtomicLoroDoc::new();
        doc_a
            .set_property(crate::urls::SHORTNAME, &Value::String("from-a".into()))
            .unwrap();
        let update_a = doc_a.export_snapshot();

        let mut builder_a = crate::commit::CommitBuilder::new(subject.into());
        builder_a.set_loro_update(update_a);
        let resource = crate::Resource::new(subject.into());
        let commit_a = builder_a.sign(&agent, &store, &resource).await.unwrap();
        store.apply_commit(commit_a, &opts).await.unwrap();

        // Client B starts from same empty state, sets description
        let doc_b = AtomicLoroDoc::new();
        doc_b
            .set_property(crate::urls::DESCRIPTION, &Value::String("from-b".into()))
            .unwrap();
        let update_b = doc_b.export_snapshot();

        let mut builder_b = crate::commit::CommitBuilder::new(subject.into());
        builder_b.set_loro_update(update_b);
        let resource_after_a = store.get_resource(&subject.into()).await.unwrap();
        let commit_b = builder_b
            .sign(&agent, &store, &resource_after_a)
            .await
            .unwrap();
        let response_b = store.apply_commit(commit_b, &opts).await.unwrap();

        // After both commits, the resource should have BOTH properties
        let final_resource = response_b.resource_new.unwrap();
        assert_eq!(
            final_resource
                .get(crate::urls::SHORTNAME)
                .unwrap()
                .to_string(),
            "from-a"
        );
        assert_eq!(
            final_resource
                .get(crate::urls::DESCRIPTION)
                .unwrap()
                .to_string(),
            "from-b"
        );
    }

    #[test]
    fn import_update_with_diff_generates_atoms() {
        let doc = AtomicLoroDoc::new();
        doc.set_property("https://example.com/name", &Value::String("Alice".into()))
            .unwrap();

        let subject = "https://example.com/resource1";

        // Now apply an update that changes name and adds age
        let doc2 = AtomicLoroDoc::from_snapshot(&doc.export_snapshot()).unwrap();
        let version_before = doc2.doc().oplog_vv();
        doc2.set_property("https://example.com/name", &Value::String("Bob".into()))
            .unwrap();
        doc2.set_property("https://example.com/age", &Value::Integer(30))
            .unwrap();
        let update = doc2.export_updates_since(&version_before);

        // Apply the delta update to the original doc
        let diff = doc.import_update_with_diff(&update, subject).unwrap();

        // Should have: remove old name "Alice", add new name "Bob", add age 30
        assert_eq!(diff.remove_atoms.len(), 1);
        assert_eq!(diff.remove_atoms[0].value.to_string(), "Alice");

        assert_eq!(diff.add_atoms.len(), 2);
        let added_values: Vec<String> =
            diff.add_atoms.iter().map(|a| a.value.to_string()).collect();
        assert!(added_values.contains(&"Bob".to_string()));
        assert!(added_values.contains(&"30".to_string()));
    }

    #[test]
    fn deterministic_serialization_with_loro_update() {
        // Verify that a commit with loroUpdate serializes deterministically
        let doc = AtomicLoroDoc::new();
        doc.set_property("https://example.com/name", &Value::String("test".into()))
            .unwrap();
        let update = doc.export_snapshot();

        let commit = crate::commit::Commit {
            subject: "https://localhost/test".into(),
            created_at: 1700000000,
            signer: "https://localhost/agent".into(),
            loro_update: Some(update.clone()),
            destroy: None,
            previous_commit: None,
            is_genesis: None,
            signature: None,
            url: None,
        };

        // Serialize twice — must produce identical output
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let store = rt.block_on(async { crate::Store::init().await.unwrap() });
        let s1 = rt
            .block_on(commit.serialize_deterministically_json_ad(&store))
            .unwrap();
        let s2 = rt
            .block_on(commit.serialize_deterministically_json_ad(&store))
            .unwrap();
        assert_eq!(s1, s2);

        // Must contain the loroUpdate key
        assert!(s1.contains("loroUpdate"));
    }

    /// Simulate a client storing arrays as JSON strings (like the JS client does)
    /// and verify the server materializes them back to ResourceArray.
    #[test]
    fn client_json_stringified_arrays_materialize_as_resource_array() {
        // Client side: stores write/read as JSON.stringify(["did:ad:agent:abc"])
        let client_doc = AtomicLoroDoc::new();
        let root = client_doc.doc().get_map("properties");

        // This is what the JS client does:
        // map.set(prop, JSON.stringify(value))
        root.insert(
            "https://atomicdata.dev/properties/write",
            r#"["did:ad:agent:abc"]"#,
        )
        .unwrap();
        root.insert(
            "https://atomicdata.dev/properties/read",
            r#"["did:ad:agent:abc"]"#,
        )
        .unwrap();
        root.insert("https://atomicdata.dev/properties/name", "Test Drive")
            .unwrap();

        // Export as snapshot (simulates the loroUpdate in a commit)
        let snapshot = client_doc.export_snapshot();

        // Server side: import the snapshot and materialize
        let server_doc = AtomicLoroDoc::from_snapshot(&snapshot).unwrap();
        let props = server_doc.get_all_properties();

        // Materialize using the same function the server uses
        let write_val = loro_value_to_atomic_value(
            props.get("https://atomicdata.dev/properties/write").unwrap(),
        );
        let read_val = loro_value_to_atomic_value(
            props.get("https://atomicdata.dev/properties/read").unwrap(),
        );
        let name_val = loro_value_to_atomic_value(
            props.get("https://atomicdata.dev/properties/name").unwrap(),
        );

        // write/read must be ResourceArray, not String
        match write_val.unwrap() {
            Value::ResourceArray(arr) => {
                assert_eq!(arr.len(), 1);
                assert_eq!(arr[0].to_string(), "did:ad:agent:abc");
            }
            other => panic!("Expected ResourceArray for write, got {:?}", other),
        }

        match read_val.unwrap() {
            Value::ResourceArray(arr) => {
                assert_eq!(arr.len(), 1);
                assert_eq!(arr[0].to_string(), "did:ad:agent:abc");
            }
            other => panic!("Expected ResourceArray for read, got {:?}", other),
        }

        match name_val.unwrap() {
            Value::String(s) => assert_eq!(s, "Test Drive"),
            other => panic!("Expected String for name, got {:?}", other),
        }
    }

    #[test]
    fn native_loro_list_arrays_round_trip() {
        let doc = AtomicLoroDoc::new();
        doc.set_property(
            "https://atomicdata.dev/properties/write",
            &Value::ResourceArray(vec![
                "did:ad:agent:alice".into(),
                "did:ad:agent:bob".into(),
            ]),
        )
        .unwrap();
        doc.set_property(
            "https://atomicdata.dev/properties/name",
            &Value::String("Test".into()),
        )
        .unwrap();

        // Export and reimport (simulates network round-trip)
        let snapshot = doc.export_snapshot();
        let doc2 = AtomicLoroDoc::from_snapshot(&snapshot).unwrap();
        let props = doc2.get_all_properties();

        // write should materialize as ResourceArray from LoroList
        let write_val =
            loro_value_to_atomic_value(props.get("https://atomicdata.dev/properties/write").unwrap());
        match write_val.unwrap() {
            Value::ResourceArray(arr) => {
                assert_eq!(arr.len(), 2);
                assert_eq!(arr[0].to_string(), "did:ad:agent:alice");
                assert_eq!(arr[1].to_string(), "did:ad:agent:bob");
            }
            other => panic!("Expected ResourceArray, got {:?}", other),
        }

        // name should still be a plain string
        let name_val =
            loro_value_to_atomic_value(props.get("https://atomicdata.dev/properties/name").unwrap());
        assert_eq!(name_val.unwrap().to_string(), "Test");
    }

    // --- Sync protocol tests ---

    /// Simulate two peers (client and server) with the same drive.
    /// Both start with the same state, then each makes independent edits.
    /// After exchanging VVs and deltas, both should converge to the same state.
    #[test]
    fn sync_two_peers_converge() {
        // Peer A: "client"
        let doc_a = AtomicLoroDoc::new();
        doc_a
            .set_property(
                "https://atomicdata.dev/properties/name",
                &Value::String("Original Name".into()),
            )
            .unwrap();
        doc_a
            .set_property(
                "https://atomicdata.dev/properties/description",
                &Value::String("Shared doc".into()),
            )
            .unwrap();

        // Peer B: "server" — starts with same state via snapshot
        let snapshot = doc_a.export_snapshot();
        let doc_b = AtomicLoroDoc::from_snapshot(&snapshot).unwrap();

        // Both should have identical VVs
        let vv_a_initial = doc_a.oplog_vv_map();
        let vv_b_initial = doc_b.oplog_vv_map();
        assert_eq!(vv_a_initial, vv_b_initial);

        // Peer A edits name (offline)
        doc_a
            .set_property(
                "https://atomicdata.dev/properties/name",
                &Value::String("Name from Client".into()),
            )
            .unwrap();

        // Peer B edits description (independently)
        doc_b
            .set_property(
                "https://atomicdata.dev/properties/description",
                &Value::String("Description from Server".into()),
            )
            .unwrap();

        // VVs should now differ
        let vv_a = doc_a.oplog_vv_map();
        let vv_b = doc_b.oplog_vv_map();
        assert_ne!(vv_a, vv_b);

        // Sync: A sends delta to B (from B's version)
        let vv_b_loro = AtomicLoroDoc::vv_from_map(&vv_b);
        let delta_a_to_b = doc_a.export_updates_since(&vv_b_loro);
        assert!(!delta_a_to_b.is_empty());

        // Sync: B sends delta to A (from A's version)
        let vv_a_loro = AtomicLoroDoc::vv_from_map(&vv_a);
        let delta_b_to_a = doc_b.export_updates_since(&vv_a_loro);
        assert!(!delta_b_to_a.is_empty());

        // Both import the other's delta
        doc_a.import_update(&delta_b_to_a).unwrap();
        doc_b.import_update(&delta_a_to_b).unwrap();

        // Both should now have the same state
        assert_eq!(
            doc_a.get_string_property("https://atomicdata.dev/properties/name"),
            Some("Name from Client".into())
        );
        assert_eq!(
            doc_a.get_string_property("https://atomicdata.dev/properties/description"),
            Some("Description from Server".into())
        );
        assert_eq!(
            doc_b.get_string_property("https://atomicdata.dev/properties/name"),
            Some("Name from Client".into())
        );
        assert_eq!(
            doc_b.get_string_property("https://atomicdata.dev/properties/description"),
            Some("Description from Server".into())
        );

        // VVs should match after sync
        assert_eq!(doc_a.oplog_vv_map(), doc_b.oplog_vv_map());
    }

    /// Test VV comparison: detect which peer is ahead for a resource.
    #[test]
    fn vv_comparison_detects_ahead_behind() {
        let doc_a = AtomicLoroDoc::new();
        doc_a
            .set_property(
                "https://atomicdata.dev/properties/name",
                &Value::String("V1".into()),
            )
            .unwrap();

        // B starts from A's state
        let snapshot = doc_a.export_snapshot();
        let doc_b = AtomicLoroDoc::from_snapshot(&snapshot).unwrap();

        // A makes more edits — A is now ahead
        doc_a
            .set_property(
                "https://atomicdata.dev/properties/name",
                &Value::String("V2 from A".into()),
            )
            .unwrap();

        let vv_a = doc_a.oplog_vv_map();
        let vv_b = doc_b.oplog_vv_map();

        // A should be ahead: for at least one peer, A's counter > B's counter
        let a_ahead = vv_a
            .iter()
            .any(|(peer, &counter)| counter > *vv_b.get(peer).unwrap_or(&0));
        let b_ahead = vv_b
            .iter()
            .any(|(peer, &counter)| counter > *vv_a.get(peer).unwrap_or(&0));

        assert!(a_ahead, "A should be ahead of B");
        assert!(!b_ahead, "B should not be ahead of A");
    }

    /// Simulate a full drive sync scenario with multiple resources:
    /// - Client has 3 resources (drive, table, readme)
    /// - Server has 2 resources (drive, table) with a different version of table
    /// - After sync, both should have all 3 resources with merged state
    #[test]
    fn drive_sync_multiple_resources() {
        // --- Setup: shared initial state ---
        let drive_doc = AtomicLoroDoc::new();
        drive_doc
            .set_property(
                "https://atomicdata.dev/properties/name",
                &Value::String("My Drive".into()),
            )
            .unwrap();

        let table_doc = AtomicLoroDoc::new();
        table_doc
            .set_property(
                "https://atomicdata.dev/properties/name",
                &Value::String("Tasks".into()),
            )
            .unwrap();

        // Server gets initial snapshots
        let server_drive = AtomicLoroDoc::from_snapshot(&drive_doc.export_snapshot()).unwrap();
        let server_table = AtomicLoroDoc::from_snapshot(&table_doc.export_snapshot()).unwrap();

        // --- Client creates a new resource (readme) that server doesn't have ---
        let client_readme = AtomicLoroDoc::new();
        client_readme
            .set_property(
                "https://atomicdata.dev/properties/name",
                &Value::String("README".into()),
            )
            .unwrap();
        client_readme
            .set_property(
                "https://atomicdata.dev/properties/description",
                &Value::String("Read this first".into()),
            )
            .unwrap();

        // --- Server edits table independently ---
        server_table
            .set_property(
                "https://atomicdata.dev/properties/description",
                &Value::String("Server-side task list".into()),
            )
            .unwrap();

        // --- Client edits table independently ---
        table_doc
            .set_property(
                "https://atomicdata.dev/properties/name",
                &Value::String("My Tasks".into()),
            )
            .unwrap();

        // --- Collect VVs (simulating the SYNC_VV exchange) ---
        let client_vvs: std::collections::HashMap<String, std::collections::HashMap<String, i32>> = [
            ("did:ad:drive".to_string(), drive_doc.oplog_vv_map()),
            ("did:ad:table".to_string(), table_doc.oplog_vv_map()),
            ("did:ad:readme".to_string(), client_readme.oplog_vv_map()),
        ]
        .into();

        let server_vvs: std::collections::HashMap<String, std::collections::HashMap<String, i32>> = [
            ("did:ad:drive".to_string(), server_drive.oplog_vv_map()),
            ("did:ad:table".to_string(), server_table.oplog_vv_map()),
        ]
        .into();

        // --- Compute diff ---
        let mut client_ahead: Vec<String> = Vec::new();
        let mut server_ahead: Vec<String> = Vec::new();
        let mut client_only: Vec<String> = Vec::new();

        for (subject, client_vv) in &client_vvs {
            if let Some(server_vv) = server_vvs.get(subject) {
                let c_ahead = client_vv
                    .iter()
                    .any(|(p, &c)| c > *server_vv.get(p).unwrap_or(&0));
                let s_ahead = server_vv
                    .iter()
                    .any(|(p, &c)| c > *client_vv.get(p).unwrap_or(&0));
                if c_ahead {
                    client_ahead.push(subject.clone());
                }
                if s_ahead {
                    server_ahead.push(subject.clone());
                }
            } else {
                client_only.push(subject.clone());
            }
        }

        // drive: identical (no edits on either side since initial sync)
        assert!(!client_ahead.contains(&"did:ad:drive".to_string()));
        assert!(!server_ahead.contains(&"did:ad:drive".to_string()));

        // table: both edited → both ahead
        assert!(client_ahead.contains(&"did:ad:table".to_string()));
        assert!(server_ahead.contains(&"did:ad:table".to_string()));

        // readme: client only
        assert!(client_only.contains(&"did:ad:readme".to_string()));

        // --- Exchange deltas ---

        // Server sends table delta to client
        let client_table_vv = AtomicLoroDoc::vv_from_map(client_vvs.get("did:ad:table").unwrap());
        let server_table_delta = server_table.export_updates_since(&client_table_vv);

        // Client sends table delta + readme snapshot to server
        let server_table_vv = AtomicLoroDoc::vv_from_map(server_vvs.get("did:ad:table").unwrap());
        let client_table_delta = table_doc.export_updates_since(&server_table_vv);
        let readme_snapshot = client_readme.export_snapshot();

        // Apply deltas
        table_doc.import_update(&server_table_delta).unwrap();
        server_table.import_update(&client_table_delta).unwrap();
        let server_readme = AtomicLoroDoc::from_snapshot(&readme_snapshot).unwrap();

        // --- Verify convergence ---

        // Table: both should have merged state
        assert_eq!(
            table_doc.get_string_property("https://atomicdata.dev/properties/name"),
            Some("My Tasks".into()) // client's edit
        );
        assert_eq!(
            table_doc.get_string_property("https://atomicdata.dev/properties/description"),
            Some("Server-side task list".into()) // server's edit
        );
        assert_eq!(
            server_table.get_string_property("https://atomicdata.dev/properties/name"),
            Some("My Tasks".into())
        );
        assert_eq!(
            server_table.get_string_property("https://atomicdata.dev/properties/description"),
            Some("Server-side task list".into())
        );

        // VVs should match for table
        assert_eq!(table_doc.oplog_vv_map(), server_table.oplog_vv_map());

        // Server should now have readme
        assert_eq!(
            server_readme.get_string_property("https://atomicdata.dev/properties/name"),
            Some("README".into())
        );
        assert_eq!(
            server_readme.get_string_property("https://atomicdata.dev/properties/description"),
            Some("Read this first".into())
        );
    }

    /// Test vv_from_map helper: roundtrip from map to VV and back.
    #[test]
    fn vv_map_roundtrip() {
        let doc = AtomicLoroDoc::new();
        doc.set_property(
            "https://atomicdata.dev/properties/name",
            &Value::String("test".into()),
        )
        .unwrap();

        let map = doc.oplog_vv_map();
        assert!(!map.is_empty());

        // Reconstruct VV from map
        let reconstructed = AtomicLoroDoc::vv_from_map(&map);

        // The reconstructed VV should produce a very small delta (just Loro overhead, no ops)
        let delta = doc.export_updates_since(&reconstructed);
        // Loro includes some header bytes even for empty updates.
        // A delta with actual content would be much larger than the snapshot.
        let snapshot = doc.export_snapshot();
        assert!(
            delta.len() < snapshot.len(),
            "Delta ({} bytes) should be smaller than snapshot ({} bytes)",
            delta.len(),
            snapshot.len()
        );
    }

    #[test]
    fn history_and_time_travel() {
        let doc = AtomicLoroDoc::new();

        // Make a first change with explicit timestamp
        doc.set_property(
            "https://atomicdata.dev/properties/name",
            &Value::String("v1".into()),
        )
        .unwrap();
        doc.doc().commit_with(
            loro::CommitOptions::new().timestamp(1000),
        );
        let v1 = doc.current_version();

        // Make a second change with a different timestamp
        doc.set_property(
            "https://atomicdata.dev/properties/name",
            &Value::String("v2".into()),
        )
        .unwrap();
        doc.doc().commit_with(
            loro::CommitOptions::new().timestamp(2000),
        );
        let v2 = doc.current_version();

        // get_history should return at least 1 entry (Loro may merge same-peer changes)
        let history = doc.get_history();
        assert!(
            !history.is_empty(),
            "Expected at least 1 history entry, got 0"
        );

        // Each entry should have a non-zero lamport
        for entry in &history {
            assert!(!entry.peer_id.is_empty());
        }

        // get_properties_at(v1) should return "v1"
        let props_v1 = doc.get_properties_at(&v1).unwrap();
        let name_v1 = props_v1
            .get("https://atomicdata.dev/properties/name")
            .unwrap();
        assert_eq!(
            name_v1,
            &loro::LoroValue::String("v1".into()),
            "v1 should have name=v1"
        );

        // get_properties_at(v2) should return "v2"
        let props_v2 = doc.get_properties_at(&v2).unwrap();
        let name_v2 = props_v2
            .get("https://atomicdata.dev/properties/name")
            .unwrap();
        assert_eq!(
            name_v2,
            &loro::LoroValue::String("v2".into()),
            "v2 should have name=v2"
        );

        // checkout + attach cycle
        doc.checkout(&v1).unwrap();
        assert_eq!(
            doc.get_string_property("https://atomicdata.dev/properties/name"),
            Some("v1".into())
        );
        doc.attach().unwrap();
        assert_eq!(
            doc.get_string_property("https://atomicdata.dev/properties/name"),
            Some("v2".into())
        );
    }

    /// Test that two independent docs pushing to a JsonArray merge correctly.
    /// This simulates two devices drawing strokes independently.
    #[test]
    fn json_array_concurrent_push_merges() {
        let stroke_prop = "https://atomicdata.dev/ontology/canvas/strokeData";

        // Create base doc with initial state
        let base = AtomicLoroDoc::new();
        base.set_property("name", &Value::String("Canvas".into())).unwrap();
        base.set_property(stroke_prop, &Value::JsonArray(vec![
            serde_json::json!({"color": 1, "path": [[0, 0]]}),
        ])).unwrap();
        base.doc().commit();
        let base_snapshot = base.export_snapshot();

        // Device A: fork from base, push stroke A
        let doc_a = AtomicLoroDoc::from_snapshot(&base_snapshot).unwrap();
        doc_a.push_to_json_array(stroke_prop, &serde_json::json!({"color": 2, "path": [[10, 10]]})).unwrap();
        doc_a.doc().commit();
        let snapshot_a = doc_a.export_snapshot();

        // Device B: fork from same base, push stroke B
        let doc_b = AtomicLoroDoc::from_snapshot(&base_snapshot).unwrap();
        doc_b.push_to_json_array(stroke_prop, &serde_json::json!({"color": 3, "path": [[20, 20]]})).unwrap();
        doc_b.doc().commit();
        let snapshot_b = doc_b.export_snapshot();

        // Merge: B imports A's snapshot
        doc_b.import_update(&snapshot_a).unwrap();
        let merged = doc_b.get_all_properties();
        let merged_val = loro_value_to_atomic_value(merged.get(stroke_prop).unwrap()).unwrap();

        match merged_val {
            Value::JsonArray(arr) => {
                println!("Merged array has {} items: {:?}", arr.len(), arr);
                // Should have 3 strokes: base + A + B
                assert_eq!(arr.len(), 3, "Expected 3 strokes after merge, got {}", arr.len());
                // All colors should be present
                let colors: Vec<i64> = arr.iter().map(|s| s["color"].as_i64().unwrap()).collect();
                assert!(colors.contains(&1), "Missing base stroke");
                assert!(colors.contains(&2), "Missing A's stroke");
                assert!(colors.contains(&3), "Missing B's stroke");
            }
            other => panic!("Expected JsonArray, got {:?}", other),
        }

        // Also verify A importing B works the same way
        doc_a.import_update(&snapshot_b).unwrap();
        let merged_a = doc_a.get_all_properties();
        let merged_a_val = loro_value_to_atomic_value(merged_a.get(stroke_prop).unwrap()).unwrap();
        match merged_a_val {
            Value::JsonArray(arr) => {
                assert_eq!(arr.len(), 3, "A should also have 3 strokes after merge");
            }
            _ => panic!("Expected JsonArray"),
        }

        println!("TEST PASSED: concurrent JsonArray pushes merge correctly");
    }

    #[test]
    fn delete_from_json_array() {
        let prop = "https://atomicdata.dev/ontology/canvas/strokeData";
        let doc = AtomicLoroDoc::new();
        doc.set_property(
            prop,
            &Value::JsonArray(vec![
                serde_json::json!({"color": 1}),
                serde_json::json!({"color": 2}),
                serde_json::json!({"color": 3}),
            ]),
        )
        .unwrap();
        doc.doc().commit();

        // Delete the middle item (index 1)
        doc.delete_from_json_array(prop, 1).unwrap();
        doc.doc().commit();

        let props = doc.get_all_properties();
        let val = loro_value_to_atomic_value(props.get(prop).unwrap()).unwrap();
        match val {
            Value::JsonArray(arr) => {
                assert_eq!(arr.len(), 2);
                assert_eq!(arr[0]["color"], 1);
                assert_eq!(arr[1]["color"], 3);
            }
            _ => panic!("Expected JsonArray"),
        }

        // Out of bounds should error
        assert!(doc.delete_from_json_array(prop, 10).is_err());
    }

    #[test]
    fn undo_redo_json_array() {
        let prop = "https://atomicdata.dev/ontology/canvas/strokeData";
        let doc = AtomicLoroDoc::new();
        doc.set_property(prop, &Value::JsonArray(vec![])).unwrap();
        doc.doc().commit();

        // Initialize undo manager before making changes
        doc.ensure_undo_manager();

        // Push stroke 1
        doc.push_to_json_array(prop, &serde_json::json!({"color": 1}))
            .unwrap();
        doc.doc().commit();
        doc.checkpoint().unwrap();

        // Push stroke 2
        doc.push_to_json_array(prop, &serde_json::json!({"color": 2}))
            .unwrap();
        doc.doc().commit();
        doc.checkpoint().unwrap();

        // Should have 2 strokes
        let count = |d: &AtomicLoroDoc| -> usize {
            match d.get_all_properties().get(prop) {
                Some(val) => match loro_value_to_atomic_value(val) {
                    Some(Value::JsonArray(arr)) => arr.len(),
                    _ => 0,
                },
                None => 0,
            }
        };
        assert_eq!(count(&doc), 2);

        // Undo stroke 2
        assert!(doc.undo().unwrap());
        assert_eq!(count(&doc), 1);

        // Undo stroke 1
        assert!(doc.undo().unwrap());
        assert_eq!(count(&doc), 0);

        // Redo stroke 1
        assert!(doc.redo().unwrap());
        assert_eq!(count(&doc), 1);

        // Redo stroke 2
        assert!(doc.redo().unwrap());
        assert_eq!(count(&doc), 2);
    }

    #[test]
    fn undo_delete_restores_item() {
        let prop = "https://atomicdata.dev/ontology/canvas/strokeData";
        let doc = AtomicLoroDoc::new();
        doc.set_property(
            prop,
            &Value::JsonArray(vec![
                serde_json::json!({"color": 1}),
                serde_json::json!({"color": 2}),
            ]),
        )
        .unwrap();
        doc.doc().commit();

        // Initialize undo manager
        doc.ensure_undo_manager();
        doc.checkpoint().unwrap();

        // Delete item at index 0
        doc.delete_from_json_array(prop, 0).unwrap();
        doc.doc().commit();

        let props = doc.get_all_properties();
        let val = loro_value_to_atomic_value(props.get(prop).unwrap()).unwrap();
        match &val {
            Value::JsonArray(arr) => assert_eq!(arr.len(), 1),
            _ => panic!("Expected JsonArray"),
        }

        // Undo the delete — item should come back
        assert!(doc.undo().unwrap());
        let props = doc.get_all_properties();
        let val = loro_value_to_atomic_value(props.get(prop).unwrap()).unwrap();
        match val {
            Value::JsonArray(arr) => {
                assert_eq!(arr.len(), 2, "Undo should restore the deleted item");
            }
            _ => panic!("Expected JsonArray"),
        }
    }
}
