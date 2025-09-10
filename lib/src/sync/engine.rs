//! Transport-agnostic sync engine.
//!
//! Handles drive synchronization using Loro CRDT version vectors.
//! The engine processes v2 binary frames and produces response frames.
//! The transport (WebSocket, Iroh QUIC, etc.) is responsible for
//! sending/receiving the raw bytes.

use crate::db::trees::Tree;
use crate::loro::AtomicLoroDoc;
use crate::{Db, Storelike};

use super::protocol;

/// Process a single v2 binary frame. Returns response frames to send back.
/// This is the transport-agnostic entry point — used by WebSocket, Iroh, etc.
pub async fn handle_frame(
    frame: &[u8],
    store: &Db,
    agent: &mut crate::agents::ForAgent,
) -> Vec<Vec<u8>> {
    if frame.is_empty() {
        return vec![];
    }

    let tag = frame[0];
    let payload = &frame[1..];

    match tag {
        protocol::tag::AUTH => {
            if let Ok(json) = std::str::from_utf8(payload) {
                match serde_json::from_str::<crate::authentication::AuthValues>(json) {
                    Ok(auth) => {
                        match crate::authentication::get_agent_from_auth_values_and_check(
                            Some(auth),
                            store,
                        )
                        .await
                        {
                            Ok(a) => {
                                *agent = a;
                                vec![protocol::encode_auth_ok()]
                            }
                            Err(e) => vec![protocol::encode_error(0, &format!("Auth failed: {e}"))],
                        }
                    }
                    Err(e) => vec![protocol::encode_error(0, &format!("Invalid auth JSON: {e}"))],
                }
            } else {
                vec![protocol::encode_error(0, "Invalid UTF-8 in auth")]
            }
        }

        protocol::tag::GET => {
            if let Some(decoded) = protocol::decode_get(payload) {
                let subject = crate::Subject::from_raw(
                    decoded.subject,
                    store.get_base_domain().as_deref(),
                );

                match store.get_resource_extended(&subject, false, agent).await {
                    Ok(r) => {
                        let resource = r.to_single();
                        let snapshot = resource.get_loro_snapshot().unwrap_or_else(|| {
                            resource
                                .build_loro_doc_from_state()
                                .map(|doc| doc.export_snapshot())
                                .unwrap_or_default()
                        });

                        if snapshot.is_empty() {
                            vec![protocol::encode_error(decoded.request_id, "No state")]
                        } else {
                            vec![protocol::encode_update(
                                protocol::flags::SNAPSHOT,
                                decoded.request_id,
                                resource.get_subject().as_str(),
                                None,
                                &snapshot,
                            )]
                        }
                    }
                    Err(e) => {
                        vec![protocol::encode_error(decoded.request_id, &e.to_string())]
                    }
                }
            } else {
                vec![protocol::encode_error(0, "Invalid GET frame")]
            }
        }

        _ => {
            tracing::debug!("Unhandled frame tag: 0x{:02x}", tag);
            vec![]
        }
    }
}

/// Collects all resource subjects belonging to a drive via BFS on parent relationships.
pub fn collect_drive_subjects(
    store: &Db,
    drive_subject: &crate::Subject,
) -> std::collections::HashSet<String> {
    let drive_str = drive_subject.as_str().to_string();
    let mut result = std::collections::HashSet::new();
    result.insert(drive_str.clone());

    if drive_subject.is_did() {
        let mut parent_to_children: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();

        for resource in store.all_resources(false) {
            if let Ok(parent_val) = resource.get(crate::urls::PARENT) {
                parent_to_children
                    .entry(parent_val.to_string())
                    .or_default()
                    .push(resource.get_subject().as_str().to_string());
            }
        }

        let mut queue = vec![drive_str];

        while let Some(current) = queue.pop() {
            if let Some(children) = parent_to_children.get(&current) {
                for child in children {
                    if result.insert(child.clone()) {
                        queue.push(child.clone());
                    }
                }
            }
        }
    } else {
        for resource in store.all_resources(false) {
            let subject = resource.get_subject();

            if subject.as_str().starts_with(drive_subject.as_str()) {
                result.insert(subject.as_str().to_string());
            }
        }
    }

    result
}

/// Compute SHA-256 drive hash matching the client's algorithm.
/// Hash of sorted entries: "subject1:c0,c1|subject2:c0,c1|..."
pub fn compute_drive_hash(
    vvs: &std::collections::HashMap<String, std::collections::HashMap<String, i32>>,
) -> String {
    let mut peer_set = std::collections::BTreeSet::new();

    for vv in vvs.values() {
        for peer_id in vv.keys() {
            peer_set.insert(peer_id.clone());
        }
    }

    let peers: Vec<String> = peer_set.into_iter().collect();
    let peer_index: std::collections::HashMap<&str, usize> = peers
        .iter()
        .enumerate()
        .map(|(i, p)| (p.as_str(), i))
        .collect();

    let mut entries: Vec<(String, Vec<i32>)> = vvs
        .iter()
        .map(|(subject, vv)| {
            let mut counters = vec![0i32; peers.len()];

            for (peer_id, &counter) in vv {
                if let Some(&idx) = peer_index.get(peer_id.as_str()) {
                    counters[idx] = counter;
                }
            }

            (subject.clone(), counters)
        })
        .collect();

    entries.sort_by(|(a, _), (b, _)| a.cmp(b));

    let hash_input: String = entries
        .iter()
        .map(|(s, c)| {
            let counters = c
                .iter()
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join(",");
            format!("{s}:{counters}")
        })
        .collect::<Vec<_>>()
        .join("|");

    // Use SHA-256 via ring when available, otherwise a simple deterministic hash
    #[cfg(feature = "ring")]
    {
        let d = ring::digest::digest(&ring::digest::SHA256, hash_input.as_bytes());
        return hex::encode(d.as_ref());
    }

    #[allow(unreachable_code)]
    {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        hash_input.hash(&mut hasher);
        format!("{:016x}", hasher.finish())
    }
}

/// Build server-side version vector map for a drive.
pub fn build_drive_vvs(
    store: &Db,
    drive_subjects: &std::collections::HashSet<String>,
) -> std::collections::HashMap<String, std::collections::HashMap<String, i32>> {
    let mut vvs = std::collections::HashMap::new();

    for subject_str in drive_subjects {
        if let Ok(Some(snapshot_bytes)) = store.kv.get(Tree::LoroSnapshots, subject_str.as_bytes())
        {
            if let Ok(doc) = AtomicLoroDoc::from_snapshot(&snapshot_bytes) {
                vvs.insert(subject_str.clone(), doc.oplog_vv_map());
            }
        }
    }

    vvs
}

/// Compare client and server VVs, return binary SYNC_OK/SYNC_DIFF/SYNC_PUSH frames.
pub async fn handle_sync_vv(
    drive: &str,
    drive_hash: &str,
    client_peers: &[String],
    client_resources: &std::collections::HashMap<String, Vec<i32>>,
    store: &Db,
    agent: &crate::agents::ForAgent,
) -> Vec<Vec<u8>> {
    let drive_subject =
        crate::Subject::from_raw(drive, store.get_base_domain().as_deref());
    let drive_subjects = collect_drive_subjects(store, &drive_subject);
    let server_vvs = build_drive_vvs(store, &drive_subjects);

    // Fast path: hash match
    if !drive_hash.is_empty() {
        let server_hash = compute_drive_hash(&server_vvs);

        if server_hash == drive_hash {
            tracing::info!("SYNC_VV: drive {} — hashes match, in sync", drive);

            return vec![protocol::encode_sync_ok(drive)];
        }
    }

    // Reconstruct client VVs from compact format
    let mut client_vvs: std::collections::HashMap<
        String,
        std::collections::HashMap<String, i32>,
    > = std::collections::HashMap::new();

    for (subject, counters) in client_resources {
        let mut vv = std::collections::HashMap::new();

        for (i, &counter) in counters.iter().enumerate() {
            if counter != 0 {
                if let Some(peer_id) = client_peers.get(i) {
                    vv.insert(peer_id.clone(), counter);
                }
            }
        }

        client_vvs.insert(subject.clone(), vv);
    }

    let mut pull: Vec<String> = Vec::new();
    let mut push_entries: Vec<(String, Vec<u8>)> = Vec::new();

    for (subject, server_vv) in &server_vvs {
        // Check read permission
        if let Ok(resource) = store
            .get_resource(&crate::Subject::from_raw(
                subject,
                store.get_base_domain().as_deref(),
            ))
            .await
        {
            if crate::hierarchy::check_read(store, &resource, agent)
                .await
                .is_err()
            {
                continue;
            }
        }

        if let Some(client_vv) = client_vvs.get(subject) {
            let server_ahead = server_vv
                .iter()
                .any(|(p, &sc)| client_vv.get(p).copied().unwrap_or(0) < sc);
            let client_ahead = client_vv
                .iter()
                .any(|(p, &cc)| server_vv.get(p).copied().unwrap_or(0) < cc);

            if server_ahead {
                if let Ok(Some(snapshot_bytes)) =
                    store.kv.get(Tree::LoroSnapshots, subject.as_bytes())
                {
                    if let Ok(doc) = AtomicLoroDoc::from_snapshot(&snapshot_bytes) {
                        let client_loro_vv = AtomicLoroDoc::vv_from_map(client_vv);
                        let delta = doc.export_updates_since(&client_loro_vv);

                        if !delta.is_empty() {
                            push_entries.push((subject.clone(), delta));
                        }
                    }
                }
            }

            if client_ahead {
                pull.push(subject.clone());
            }
        } else {
            if let Ok(Some(snapshot_bytes)) =
                store.kv.get(Tree::LoroSnapshots, subject.as_bytes())
            {
                push_entries.push((subject.clone(), snapshot_bytes));
            }
        }
    }

    // Client resources not on server
    for subject in client_vvs.keys() {
        if !server_vvs.contains_key(subject) {
            pull.push(subject.clone());
        }
    }

    let push_subjects: Vec<String> = push_entries.iter().map(|(s, _)| s.clone()).collect();

    tracing::info!(
        "SYNC_VV: drive {} — {} to push, {} to pull",
        drive,
        push_subjects.len(),
        pull.len(),
    );

    let mut frames = Vec::new();
    frames.push(protocol::encode_sync_diff(drive, &pull, &push_subjects));

    if !push_entries.is_empty() {
        let entries: Vec<(&str, &[u8])> = push_entries
            .iter()
            .map(|(s, b)| (s.as_str(), b.as_slice()))
            .collect();
        frames.push(protocol::encode_sync_push(drive, &entries));
    }

    frames
}

/// Import Loro deltas from a peer into server resources.
pub async fn handle_sync_deltas(
    drive: &str,
    deltas: &std::collections::HashMap<String, String>,
    store: &Db,
) {
    use base64::Engine as _;

    let mut count = 0;

    for (subject_str, delta_b64) in deltas {
        let Ok(delta_bytes) =
            base64::engine::general_purpose::STANDARD.decode(delta_b64)
        else {
            tracing::warn!("SYNC_DELTAS: bad base64 for {}", subject_str);
            continue;
        };

        let doc = if let Ok(Some(snapshot)) =
            store.kv.get(Tree::LoroSnapshots, subject_str.as_bytes())
        {
            match AtomicLoroDoc::from_snapshot(&snapshot) {
                Ok(d) => d,
                Err(_) => AtomicLoroDoc::new(),
            }
        } else {
            AtomicLoroDoc::new()
        };

        if doc.import_update(&delta_bytes).is_err() {
            tracing::warn!("SYNC_DELTAS: import failed for {}", subject_str);
            continue;
        }

        let new_snapshot = doc.export_snapshot();

        if store
            .kv
            .insert(Tree::LoroSnapshots, subject_str.as_bytes(), &new_snapshot)
            .is_err()
        {
            continue;
        }

        let subject =
            crate::Subject::from_raw(subject_str, store.get_base_domain().as_deref());
        let mut resource = store
            .get_resource(&subject)
            .await
            .unwrap_or_else(|_| crate::Resource::new(subject.to_string().into()));

        if resource.replace_state_from_loro_doc(doc).is_err() {
            continue;
        }

        let _ = store.add_resource_opts(&resource, false, true, true).await;
        count += 1;
    }

    tracing::info!(
        "SYNC_DELTAS: imported {} resources for drive {}",
        count,
        drive
    );
}
