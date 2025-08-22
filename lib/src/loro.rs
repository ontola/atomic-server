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

/// Wraps a LoroDoc for an Atomic Resource, providing helpers to convert between
/// Atomic Data property/value pairs and Loro containers.
pub struct AtomicLoroDoc {
    doc: LoroDoc,
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
        Self {
            doc: LoroDoc::new(),
        }
    }

    /// Create from an existing snapshot (e.g. loaded from the database).
    pub fn from_snapshot(snapshot: &[u8]) -> AtomicResult<Self> {
        let doc = LoroDoc::new();
        doc.import(snapshot)
            .map_err(|e| format!("Failed to import Loro snapshot: {e}"))?;
        Ok(Self { doc })
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
                // Serialize as a plain JSON array of strings
                let subjects: Vec<String> = arr.iter().map(|s| s.to_string()).collect();
                let json = serde_json::to_string(&subjects)
                    .map_err(|e| format!("Failed to serialize ResourceArray: {e}"))?;
                root.insert(property, json.as_str())
                    .map_err(|e| format!("Loro set error: {e}"))?;
            }
            _ => {
                // For other complex types, serialize the display string.
                root.insert(property, value.to_string().as_str())
                    .map_err(|e| format!("Loro set error: {e}"))?;
            }
        }
        Ok(())
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
            if let Ok(v) = value.into_value() {
                result.insert(key.to_string(), v);
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
/// Returns None for container types that don't map directly.
///
/// Strings that look like JSON arrays or objects are parsed back to their
/// proper Atomic Data types (ResourceArray, NestedResource, etc.), since
/// the client JSON.stringify's complex values before storing in the Loro map.
pub fn loro_value_to_atomic_value(lv: &loro::LoroValue) -> Option<Value> {
    match lv {
        loro::LoroValue::String(s) => {
            let s = s.to_string();

            // Try to detect JSON-encoded arrays (e.g. ResourceArray values)
            if s.starts_with('[') {
                if let Ok(arr) = serde_json::from_str::<Vec<String>>(&s) {
                    let subjects: Vec<crate::values::SubResource> =
                        arr.into_iter().map(|v| v.into()).collect();
                    return Some(Value::ResourceArray(subjects));
                }
            }

            // Try to detect JSON-encoded objects (e.g. NestedResource values)
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
        // Container types (List, Map, Text, etc.) don't produce simple atoms
        _ => None,
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
                &Value::String("Original".into()),
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
                &Value::Markdown("# Hello".into()),
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
            Some("# Hello".into())
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
}
