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
                    Err(e) => vec![protocol::encode_error(
                        0,
                        &format!("Invalid auth JSON: {e}"),
                    )],
                }
            } else {
                vec![protocol::encode_error(0, "Invalid UTF-8 in auth")]
            }
        }

        protocol::tag::GET => {
            if let Some(decoded) = protocol::decode_get(payload) {
                let subject =
                    crate::Subject::from_raw(decoded.subject, store.get_base_domain().as_deref());

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

        protocol::tag::SYNC => {
            if let Some(sync) = protocol::decode_sync(payload) {
                handle_sync_vv(
                    &sync.drive,
                    &sync.drive_hash,
                    &sync.peers,
                    &sync.resources,
                    store,
                    agent,
                )
                .await
            } else {
                vec![protocol::encode_error(0, "Invalid SYNC frame")]
            }
        }

        protocol::tag::SYNC_PUSH => {
            if let Some(push) = protocol::decode_sync_push(payload) {
                let (_count, mut blob_requests) = import_sync_push(&push, store, agent).await;
                let mut responses = vec![protocol::encode_sync_ok(&push.drive)];
                responses.append(&mut blob_requests);
                responses
            } else {
                vec![protocol::encode_error(0, "Invalid SYNC_PUSH frame")]
            }
        }

        protocol::tag::BLOB_REQUEST => {
            if let Some(hash) = protocol::decode_blob_request(payload) {
                match store.kv.get(Tree::Blobs, &hash) {
                    Ok(Some(bytes)) => vec![protocol::encode_blob_response(&hash, &bytes)],
                    _ => vec![protocol::encode_error(0, "Blob not found")],
                }
            } else {
                vec![protocol::encode_error(0, "Invalid BLOB_REQUEST frame")]
            }
        }

        protocol::tag::BLOB_RESPONSE => {
            if let Some(resp) = protocol::decode_blob_response(payload) {
                let _ = store.kv.insert(Tree::Blobs, &resp.hash, &resp.bytes);
                vec![]
            } else {
                vec![protocol::encode_error(0, "Invalid BLOB_RESPONSE frame")]
            }
        }

        _ => {
            tracing::debug!("Unhandled frame tag: 0x{:02x}", tag);
            vec![]
        }
    }
}

/// Collects all resource subjects belonging to a drive via BFS on parent relationships.
/// Collects all resource subjects belonging to a drive via BFS on parent relationships.
/// Returns pure_id() strings (no query params/drive hints) to match LoroSnapshot keys.
pub async fn collect_drive_subjects(
    store: &Db,
    drive_subject: &crate::Subject,
) -> std::collections::HashSet<String> {
    let drive_str = drive_subject.pure_id();
    let mut result = std::collections::HashSet::new();
    result.insert(drive_str.clone());

    if drive_subject.is_did() {
        // BFS through the parent-index. Querying
        // `property=parent value=current` hits the same index used by
        // `useChildren` / `/query` and returns only the subjects that
        // actually point at `current` — no full-store scan, no commits
        // touched (commits have no `parent` propval, so they're absent
        // from the index by construction). Cost drops from
        // O(total `Tree::Resources` rows, including every commit ever
        // signed) to O(drive subjects) — see the
        // `collect_drive_subjects_scales_with_target_drive_only`
        // regression test in `sync/tests.rs`.
        let mut queue = vec![drive_str];

        while let Some(current) = queue.pop() {
            let q = crate::storelike::Query {
                property: Some(crate::urls::PARENT.into()),
                value: Some(crate::Value::AtomicUrl(current.clone().into())),
                limit: None,
                start_val: None,
                end_val: None,
                offset: 0,
                sort_by: None,
                sort_desc: false,
                include_external: true,
                include_nested: false,
                // Sudo: sync needs to enumerate every subject the
                // drive actually contains. Per-agent ACL filtering
                // happens later in `handle_sync_vv` (`check_read` on
                // each subject before push/pull). Scoping the index
                // walk by `for_agent` here would also re-trigger the
                // count-drift fix path for unauthorized rows, which
                // is the wrong layer.
                for_agent: crate::agents::ForAgent::Sudo,
                drive: None,
            };

            if let Ok(qr) = store.query(&q).await {
                for child in qr.subjects {
                    let child_str = child.pure_id();
                    if result.insert(child_str.clone()) {
                        queue.push(child_str);
                    }
                }
            }
        }
    } else {
        // Non-DID (HTTP-URL) drive: subjects start with the drive
        // origin. We keep the legacy full-scan here — there's no
        // parent-index entry for the drive root itself in the
        // HTTP-URL case, and DID drives are the hot path for the
        // SUB → SYNC_DIFF latency we're targeting.
        let drive_pure = drive_subject.pure_id();
        for resource in store.all_resources(false) {
            let subject = resource.get_subject();
            if subject.pure_id().starts_with(&drive_pure) {
                result.insert(subject.pure_id());
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
    let drive_subject = crate::Subject::from_raw(drive, store.get_base_domain().as_deref());

    // Fast-fail for non-DID drives. The browser's `handleOpen`
    // (websockets.ts) fires SYNC_VV for whatever `store.getDrive()`
    // returns; for an anonymous page that's the server's HTTP origin,
    // not a real drive DID. The non-DID branch of
    // `collect_drive_subjects` (engine.rs:202) walks every resource
    // in the store — on a populated DB that's seconds of CPU work
    // and the spawned future starves the WebSocketConnection actor,
    // queueing any follow-up GET behind it (the failing-bench root
    // cause). For a non-DID "drive" the right answer is "nothing to
    // sync" — return SYNC_OK so the client's startup state machine
    // moves on without sweeping the server.
    if !drive_subject.is_did() {
        tracing::debug!(
            "SYNC_VV: drive {} is not a DID — skipping full-store scan, returning SYNC_OK",
            drive
        );
        return vec![protocol::encode_sync_ok(drive)];
    }

    let drive_subjects = collect_drive_subjects(store, &drive_subject).await;
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
    let mut client_vvs: std::collections::HashMap<String, std::collections::HashMap<String, i32>> =
        std::collections::HashMap::new();

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
        let resource = match store
            .get_resource(&crate::Subject::from_raw(
                subject,
                store.get_base_domain().as_deref(),
            ))
            .await
        {
            Ok(r) => {
                if crate::hierarchy::check_read(store, &r, agent)
                    .await
                    .is_err()
                {
                    continue;
                }
                r
            }
            Err(_) => continue,
        };

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

            // New logic: even if VVs match (or server is ahead), if the server is missing the blob, we must pull it.
            // This handles the case where metadata was pushed via HTTP POST /commit but the blob is still on the client.
            if let Ok(blob_val) = resource.get(crate::urls::BLOB) {
                let blob_did = blob_val.to_string();
                if let Some(hash_hex) = crate::Subject::from_raw(&blob_did, None).blob_hash_hex() {
                    if let Ok(hash_bytes) = hex::decode(&hash_hex) {
                        if hash_bytes.len() == 32 {
                            let mut hash = [0u8; 32];
                            hash.copy_from_slice(&hash_bytes);
                            if !store.kv.contains_key(Tree::Blobs, &hash).unwrap_or(false) {
                                // If we don't have the blob, add to pull so the server requests it
                                if !pull.contains(subject) {
                                    pull.push(subject.clone());
                                }
                            }
                        }
                    }
                }
            }
        } else {
            if let Ok(Some(snapshot_bytes)) = store.kv.get(Tree::LoroSnapshots, subject.as_bytes())
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
        // `encode_sync_push_chunks` splits by entry count + byte budget and
        // marks the final frame LAST. Each frame is independent on the wire;
        // the receiver loops reading SYNC_PUSH until it sees LAST.
        for chunk in protocol::encode_sync_push_chunks(drive, &entries) {
            frames.push(chunk);
        }
    }

    frames
}

/// Import resources from a SYNC_PUSH message into the local store.
/// When called from handle_frame (server receiving from a peer), `for_agent` is checked
/// for write access to the drive. When called locally (e.g. client importing), pass `Sudo`.
pub async fn import_sync_push(
    push: &protocol::DecodedSyncPush,
    store: &Db,
    for_agent: &crate::agents::ForAgent,
) -> (usize, Vec<Vec<u8>>) {
    // Check write access to the drive
    let drive_subject = crate::Subject::from_raw(&push.drive, store.get_base_domain().as_deref());
    if let Ok(drive_resource) = store.get_resource(&drive_subject).await {
        if crate::hierarchy::check_write(store, &drive_resource, for_agent)
            .await
            .is_err()
        {
            tracing::warn!(
                "import_sync_push: agent {:?} has no write access to drive {}",
                for_agent,
                push.drive
            );
            return (0, vec![]);
        }
    }
    // If drive doesn't exist yet, allow import (bootstrap case — new drive arriving)

    let mut count = 0;
    let mut blob_requests = Vec::new();

    for entry in &push.entries {
        // Load existing doc or create new
        let doc = if let Ok(Some(existing)) =
            store.kv.get(Tree::LoroSnapshots, entry.subject.as_bytes())
        {
            match AtomicLoroDoc::from_snapshot(&existing) {
                Ok(d) => {
                    // Import as delta
                    if d.import_update(&entry.loro_bytes).is_err() {
                        tracing::warn!(
                            "import_sync_push: delta import failed for {}",
                            entry.subject
                        );
                        continue;
                    }
                    d
                }
                Err(_) => {
                    // Existing snapshot corrupt, treat incoming as fresh
                    match AtomicLoroDoc::from_snapshot(&entry.loro_bytes) {
                        Ok(d) => d,
                        Err(_) => continue,
                    }
                }
            }
        } else {
            // New resource — import as snapshot
            let doc = AtomicLoroDoc::new();
            if doc.import_update(&entry.loro_bytes).is_err() {
                // Try as snapshot
                match AtomicLoroDoc::from_snapshot(&entry.loro_bytes) {
                    Ok(d) => d,
                    Err(_) => {
                        tracing::warn!("import_sync_push: import failed for {}", entry.subject);
                        continue;
                    }
                }
            } else {
                doc
            }
        };

        let snapshot = doc.export_snapshot();
        if store
            .kv
            .insert(Tree::LoroSnapshots, entry.subject.as_bytes(), &snapshot)
            .is_err()
        {
            continue;
        }

        let subject = crate::Subject::from_raw(&entry.subject, store.get_base_domain().as_deref());
        let mut resource = store
            .get_resource(&subject)
            .await
            .unwrap_or_else(|_| crate::Resource::new(subject.to_string()));

        if resource.replace_state_from_loro_doc(doc).is_err() {
            continue;
        }

        // Log what properties arrived
        let has_strokes = resource
            .get("https://atomicdata.dev/ontology/canvas/strokeData")
            .is_ok();
        tracing::info!(
            "  sync imported {}: {} props, has_strokes={}",
            &entry.subject[..entry.subject.len().min(30)],
            resource.get_propvals().len(),
            has_strokes,
        );

        let _ = store.add_resource_opts(&resource, false, true, true).await;
        count += 1;

        // Check for missing blobs
        if let Ok(blob_val) = resource.get(crate::urls::BLOB) {
            let blob_did = blob_val.to_string();
            if let Some(hash_hex) = crate::Subject::from_raw(&blob_did, None).blob_hash_hex() {
                if let Ok(hash_bytes) = hex::decode(&hash_hex) {
                    if hash_bytes.len() == 32 {
                        let mut hash = [0u8; 32];
                        hash.copy_from_slice(&hash_bytes);
                        if !store.kv.contains_key(Tree::Blobs, &hash).unwrap_or(false) {
                            blob_requests.push(protocol::encode_blob_request(&hash));
                        }
                    }
                }
            }
        }
    }

    tracing::info!(
        "import_sync_push: imported {} resources for drive {}",
        count,
        push.drive
    );
    for entry in &push.entries {
        tracing::info!(
            "  imported: {} ({} bytes)",
            &entry.subject[..entry.subject.len().min(30)],
            entry.loro_bytes.len()
        );
    }
    (count, blob_requests)
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
        let Ok(delta_bytes) = base64::engine::general_purpose::STANDARD.decode(delta_b64) else {
            tracing::warn!("SYNC_DELTAS: bad base64 for {}", subject_str);
            continue;
        };

        let doc =
            if let Ok(Some(snapshot)) = store.kv.get(Tree::LoroSnapshots, subject_str.as_bytes()) {
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

        let subject = crate::Subject::from_raw(subject_str, store.get_base_domain().as_deref());
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
