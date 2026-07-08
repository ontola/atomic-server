//! Transport-agnostic sync engine.
//!
//! Handles drive synchronization using Loro CRDT version vectors.
//! The engine processes v2 binary frames and produces response frames.
//! The transport (WebSocket, Iroh QUIC, etc.) is responsible for
//! sending/receiving the raw bytes.
//!
//! Wire format for `SYNC`, `SYNC_DIFF`, `SYNC_PUSH`, and the resource
//! `UPDATE` frames this engine emits is documented in
//! `docs/src/websockets.md` (canonical spec). Frame encoders/decoders live
//! in [`super::protocol`]; matching TypeScript helpers in
//! `browser/lib/src/ws-v2.ts`.

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
                            Err(e) => vec![protocol::encode_error(
                                0,
                                protocol::error_code::UNKNOWN,
                                &format!("Auth failed: {e}"),
                            )],
                        }
                    }
                    Err(e) => vec![protocol::encode_error(
                        0,
                        protocol::error_code::UNKNOWN,
                        &format!("Invalid auth JSON: {e}"),
                    )],
                }
            } else {
                vec![protocol::encode_error(
                    0,
                    protocol::error_code::UNKNOWN,
                    "Invalid UTF-8 in auth",
                )]
            }
        }

        protocol::tag::GET => {
            if let Some(decoded) = protocol::decode_get(payload) {
                let subject =
                    crate::Subject::from_raw(decoded.subject, store.get_base_domain().as_deref());

                match store.get_resource_extended(&subject, false, agent).await {
                    Ok(r) => {
                        let resource = r.to_single();
                        let snapshot = resource.materialized_state().unwrap_or_else(|| {
                            resource
                                .build_state_doc()
                                .map(|doc| doc.export_snapshot())
                                .unwrap_or_default()
                        });

                        if snapshot.is_empty() {
                            vec![protocol::encode_error(
                                decoded.request_id,
                                protocol::error_code::UNKNOWN,
                                "No state",
                            )]
                        } else {
                            // Resolve `internal:/…` to this node's origin —
                            // `internal:` is a node-local concept and must not
                            // cross the wire; the recipient keys its resource
                            // cache on whatever subject we emit. A no-op for
                            // normal (External/DID) subjects, so it's safe on
                            // every transport, not just the server's origin.
                            let origin = store
                                .get_base_domain()
                                .unwrap_or_else(|| "http://localhost".to_string());
                            let subject_resolved = resource.get_subject().resolve(&origin);
                            // Include `lastCommit` so the recipient can set
                            // `previousCommit` on its next save. See
                            // `planning/fix-canvas-genesis-save.md`.
                            let last_commit = resource
                                .get(crate::urls::LAST_COMMIT)
                                .ok()
                                .map(|v| v.to_string())
                                .filter(|s| !s.is_empty());
                            let mut flags = protocol::flags::SNAPSHOT;
                            if last_commit.is_some() {
                                flags |= protocol::flags::HAS_COMMIT_ID;
                            }
                            vec![protocol::encode_update(
                                flags,
                                decoded.request_id,
                                &subject_resolved,
                                last_commit.as_deref(),
                                &snapshot,
                            )]
                        }
                    }
                    Err(e) => {
                        vec![protocol::encode_error(
                            decoded.request_id,
                            protocol::error_code::UNKNOWN,
                            &e.to_string(),
                        )]
                    }
                }
            } else {
                vec![protocol::encode_error(
                    0,
                    protocol::error_code::UNKNOWN,
                    "Invalid GET frame",
                )]
            }
        }

        protocol::tag::COMMIT => {
            // A signed commit is the unit of authority on every transport: it
            // carries its own signature and the signer's rights are checked
            // here, so a peer relaying it can only ever apply a change its
            // signer was already entitled to make — no escalation from "I
            // dialed you." This is what lets a serverless peer apply a `COMMIT`
            // exactly like atomic-server's HTTP path does; the connection's own
            // AUTH identity is not the gate (the commit's signature is).
            //
            // Differs from the server's WS `COMMIT` arm in two deliberate ways:
            // no `source_id` echo-suppression (peer transports don't fan out
            // through the commit monitor), and `validate_loro_causality` is
            // OFF because concurrent writes between peers are expected (see the
            // field's own docs in `commit.rs`).
            match protocol::decode_commit(payload) {
                Some(decoded) => {
                    let request_id = decoded.request_id;
                    match apply_peer_commit(store, decoded.commit_json).await {
                        Ok(commit_json) => {
                            vec![protocol::encode_commit_ok(request_id, &commit_json)]
                        }
                        Err(e) => {
                            let msg = e.to_string();
                            vec![protocol::encode_error(
                                request_id,
                                protocol::classify_commit_error(&msg),
                                &msg,
                            )]
                        }
                    }
                }
                None => vec![protocol::encode_error(
                    0,
                    protocol::error_code::UNKNOWN,
                    "Invalid COMMIT frame",
                )],
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
                vec![protocol::encode_error(
                    0,
                    protocol::error_code::UNKNOWN,
                    "Invalid SYNC frame",
                )]
            }
        }

        protocol::tag::SYNC_PUSH => {
            if let Some(push) = protocol::decode_sync_push(payload) {
                let (_count, mut blob_requests) = import_sync_push(&push, store, agent).await;
                let mut responses = vec![protocol::encode_sync_ok(&push.drive)];
                responses.append(&mut blob_requests);
                responses
            } else {
                vec![protocol::encode_error(
                    0,
                    protocol::error_code::UNKNOWN,
                    "Invalid SYNC_PUSH frame",
                )]
            }
        }

        protocol::tag::BLOB_REQUEST => {
            if let Some(hash) = protocol::decode_blob_request(payload) {
                match store.kv.get(Tree::Blobs, &hash) {
                    Ok(Some(bytes)) => vec![protocol::encode_blob_response(&hash, &bytes)],
                    _ => vec![protocol::encode_error(
                        0,
                        protocol::error_code::UNKNOWN,
                        "Blob not found",
                    )],
                }
            } else {
                vec![protocol::encode_error(
                    0,
                    protocol::error_code::UNKNOWN,
                    "Invalid BLOB_REQUEST frame",
                )]
            }
        }

        protocol::tag::BLOB_RESPONSE => {
            if let Some(resp) = protocol::decode_blob_response(payload) {
                // F4 (planning/unified-sync.md): a `BLOB_RESPONSE` with no
                // matching `BLOB_REQUEST` we issued is unsolicited — reject
                // it rather than storing arbitrary bytes with no admission
                // check at all. A matching entry names the (already-
                // admitted at request time) drive; re-check admission here
                // too, since enrollment/quota state can change between the
                // request and this response.
                match store.take_pending_blob_request(&resp.hash) {
                    Some(drive) if store.sync_policy().admit_drive_write(&drive) => {
                        let _ = store.kv.insert(Tree::Blobs, &resp.hash, &resp.bytes);
                        vec![]
                    }
                    Some(drive) => {
                        tracing::warn!(
                            "BLOB_RESPONSE: drive {} not admitted by sync policy, dropping blob",
                            drive
                        );
                        vec![protocol::encode_error(
                            0,
                            protocol::error_code::UNKNOWN,
                            "Drive not admitted for sync",
                        )]
                    }
                    None => {
                        tracing::warn!(
                            "BLOB_RESPONSE: no matching pending BLOB_REQUEST, dropping blob"
                        );
                        vec![protocol::encode_error(
                            0,
                            protocol::error_code::UNKNOWN,
                            "Unsolicited blob response",
                        )]
                    }
                }
            } else {
                vec![protocol::encode_error(
                    0,
                    protocol::error_code::UNKNOWN,
                    "Invalid BLOB_RESPONSE frame",
                )]
            }
        }

        _ => {
            tracing::debug!("Unhandled frame tag: 0x{:02x}", tag);
            vec![]
        }
    }
}

/// Policy knobs distinguishing a hub ingesting a client's commit from a peer
/// replica ingesting another peer's commit. The validation *core* (signature,
/// schema, timestamp, signer rights) is identical in both roles.
pub struct CommitIngestOpts {
    /// Transport/source identity for echo suppression by the hub's commit
    /// monitor. Peers have no commit-monitor fanout, so `None` there.
    pub source_id: Option<String>,
    /// Hub semantics: reject commits whose Loro ops are concurrent with stored
    /// state (client doc wasn't seeded from this node). Off between peers,
    /// where concurrent writes are expected.
    pub validate_loro_causality: bool,
    /// Hub semantics: reject commits for subjects this node cannot own. Off
    /// for peer replicas — hosting subjects the node does not own is what
    /// replication is.
    pub enforce_subject_ownership: bool,
    /// Peer-transport semantics: hold the importing flag while applying so the
    /// live push loop doesn't rebroadcast the commit back to live peers (the
    /// sender included). Off on the hub, where WS fanout is suppressed
    /// per-source via `source_id` and Iroh live peers SHOULD receive the
    /// update.
    pub suppress_live_echo: bool,
    /// Origin used to resolve `internal:/` subjects in the response JSON-AD.
    /// `None` falls back to the store's base domain.
    pub response_origin: Option<String>,
}

/// Ingest a signed JSON-AD `COMMIT`, returning the server-created commit
/// resource as JSON-AD. This is the single implementation shared by the
/// server's HTTP/WS commit application and peer-transport `COMMIT` frames
/// (see [`CommitIngestOpts`] for what differs between the two roles).
///
/// Signature, schema, and signer-rights validation always run — the commit is
/// a self-authorizing certificate, so those checks (not a connection's AUTH
/// identity) are the authority. What varies is domain-ownership enforcement,
/// Loro-causality enforcement, live-echo suppression, and source-id-based
/// echo suppression, all controlled by `opts`.
pub async fn ingest_commit_json(
    store: &Db,
    commit_json: &str,
    opts: &CommitIngestOpts,
) -> crate::errors::AtomicResult<String> {
    // Reject commits with deprecated set/push/remove fields — use loroUpdate instead.
    if commit_json.contains("\"https://atomicdata.dev/properties/set\"")
        || commit_json.contains("\"https://atomicdata.dev/properties/push\"")
        || commit_json.contains("\"https://atomicdata.dev/properties/remove\"")
    {
        return Err(
            "Commits with `set`, `push`, or `remove` fields are no longer accepted. Use `loroUpdate` instead."
                .into(),
        );
    }

    let incoming_commit_resource =
        crate::parse::parse_json_ad_commit_resource(commit_json, store).await?;
    let incoming_commit = crate::commit::Commit::from_resource(incoming_commit_resource)?;

    // Log incoming commit details for debugging
    if let Some(loro_bytes) = &incoming_commit.loro_update {
        let doc = crate::loro::AtomicLoroDoc::new();
        if doc.import_update(loro_bytes).is_ok() {
            let props = doc.get_all_properties();
            let prop_summary: Vec<String> = props
                .keys()
                .map(|k| k.rsplit('/').next().unwrap_or(k).to_string())
                .collect();
            tracing::info!(
                subject = %incoming_commit.subject,
                signer = %incoming_commit.signer,
                properties = ?prop_summary,
                loro_bytes = loro_bytes.len(),
                "Incoming commit"
            );
        }
    } else {
        tracing::info!(
            subject = %incoming_commit.subject,
            destroy = ?incoming_commit.destroy,
            "Incoming commit (no loroUpdate)"
        );
    }

    if opts.enforce_subject_ownership {
        let is_internal = incoming_commit.subject.is_internal();
        let is_did = incoming_commit.subject.is_did();
        let matches_base = if let Some(base) = store.get_base_domain() {
            incoming_commit.subject.as_str().contains(&base)
        } else {
            false
        };

        // Fallback: if it's a local path like http://localhost/ or https://atomicdata.dev/
        // and it matches the current request's Host, we should also allow it.
        let is_local_path =
            !is_did && !is_internal && incoming_commit.subject.as_str().ends_with('/');

        if !is_internal && !is_did && !matches_base && !is_local_path {
            return Err(
                "Subject of commit should be sent to other domain - this store can not own this resource."
                    .into(),
            );
        }
    }

    let signer = incoming_commit.signer.clone();
    let signer_pure = signer.pure_id();

    // Ensure the agent exists before applying the commit.
    // This is important because the commit might be editing the agent itself.
    // Run unconditionally on both roles: a commit rejected later by
    // `apply_commit` still leaves this auto-created agent resource behind —
    // accepted hub behavior, now shared with peer ingestion.
    let is_self_creating_agent =
        incoming_commit.subject.is_agent_did() && incoming_commit.subject == signer;

    if signer.is_agent_did()
        && !is_self_creating_agent
        && store.get_resource(&signer).await.is_err()
    {
        let mut new_agent = crate::Resource::new_instance(crate::urls::AGENT, store).await?;
        new_agent.set_subject(signer_pure.clone());
        if let Some(pk) = signer.as_str().strip_prefix("did:ad:agent:") {
            new_agent
                .set_string(crate::urls::PUBLIC_KEY.into(), pk, store)
                .await?;
        }
        new_agent.save_locally(store).await?;
        tracing::info!("Auto-created agent resource for {}", signer_pure);
    }

    let commit_opts = crate::commit::CommitOpts {
        validate_schema: true,
        validate_signature: true,
        // Timestamp validation bounds replay: without it, a captured signed
        // destroy commit could be replayed unboundedly later (e.g. after the
        // subject was legitimately recreated). Peers therefore need
        // roughly-sane clocks — the same requirement AUTH already imposes.
        validate_timestamp: true,
        validate_rights: true,
        // https://github.com/atomicdata-dev/atomic-server/issues/412
        validate_previous_commit: false,
        // Reject commits whose Loro ops are concurrent with stored state
        // (i.e. the client's doc wasn't seeded from the server). Without this,
        // LWW silently drops the client's write. For P2P sync use a path that
        // leaves this off — concurrent writes are expected there.
        validate_loro_causality: opts.validate_loro_causality,
        validate_for_agent: Some(signer.to_string()),
        update_index: true,
        source_id: opts.source_id.clone(),
    };

    let base_domain = store.get_base_domain();

    let response = if opts.suppress_live_echo {
        // Applying a remote peer's commit must not rebroadcast to live peers
        // (the sender included) — mirrors `ws_apply::apply_commit_json`'s
        // suppression of the same echo via the live push loop.
        super::ws_apply::set_importing(true);
        let result = store.apply_commit(incoming_commit, &commit_opts).await;
        super::ws_apply::set_importing(false);
        result?
    } else {
        store.apply_commit(incoming_commit, &commit_opts).await?
    };

    let origin = opts.response_origin.as_deref().or(base_domain.as_deref());
    let json = response.commit_resource.to_json_ad(origin)?;
    Ok(json)
}

/// Apply a JSON-AD `COMMIT` received over a peer transport, returning the
/// server-created commit resource as JSON-AD (the `COMMIT_OK` payload).
///
/// This is the transport-agnostic sibling of the server's HTTP/WS commit
/// application. It validates signature, schema, and the signer's rights — the
/// commit is a self-authorizing certificate, so those checks (not the
/// connection's AUTH identity) are the authority. `validate_loro_causality` is
/// off (concurrent peer writes are expected) and `validate_previous_commit` is
/// off (peers don't share a single linear commit chain), mirroring the Iroh
/// sync paths. No `source_id`: peer transports don't fan out through the
/// commit monitor, so there's no echo to suppress.
///
/// Deliberately skips the server's domain-ownership gate (`apply_commit_json`
/// in `server/src/handlers/commit.rs` rejects a commit whose subject belongs
/// to another domain): a peer replica legitimately hosts subjects it doesn't
/// own — that's what replication is — so no such gate applies here.
async fn apply_peer_commit(store: &Db, commit_json: &str) -> crate::errors::AtomicResult<String> {
    ingest_commit_json(
        store,
        commit_json,
        &CommitIngestOpts {
            source_id: None,
            validate_loro_causality: false,
            enforce_subject_ownership: false,
            suppress_live_echo: true,
            response_origin: None,
        },
    )
    .await
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
                filters: Vec::new(),
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
            // Read the version vector from the snapshot header instead of
            // rebuilding the whole CRDT doc (see `vv_map_from_snapshot`).
            if let Ok(vv) = AtomicLoroDoc::vv_map_from_snapshot(&snapshot_bytes) {
                vvs.insert(subject_str.clone(), vv);
            }
        }
    }

    vvs
}

/// The drive's version-vector hash — the same value `handle_sync_vv` compares
/// against for its fast path, computed on its own. Used by the hash-first probe
/// path: a client sends only its hash, and the server answers "in sync" or
/// "resend your full state" without the client ever transmitting an
/// O(drive-size) version vector when nothing changed.
pub async fn drive_sync_hash(store: &Db, drive: &str) -> String {
    let drive_subject = crate::Subject::from_raw(drive, store.get_base_domain().as_deref());
    let drive_subjects = collect_drive_subjects(store, &drive_subject).await;
    let server_vvs = build_drive_vvs(store, &drive_subjects);
    compute_drive_hash(&server_vvs)
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
    let mut pull_from: std::collections::HashMap<String, std::collections::HashMap<String, i32>> =
        std::collections::HashMap::new();
    let mut remove: Vec<String> = Vec::new();
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
                pull_from.insert(subject.clone(), server_vv.clone());
            }

            // New logic: even if VVs match (or server is ahead), if the server is missing the blob, we must pull it.
            // This handles the case where metadata was pushed via HTTP POST /commit but the blob is still on the client.
            if let Ok(blob_val) = resource.get(crate::urls::BLOB) {
                let blob_did = blob_val.to_string();
                if let Some(hash_hex) = crate::Subject::from_raw(&blob_did, None).blob_hash_hex() {
                    if let Ok(hash_bytes) = hex::decode(hash_hex) {
                        if hash_bytes.len() == 32 {
                            let mut hash = [0u8; 32];
                            hash.copy_from_slice(&hash_bytes);
                            if !store.kv.contains_key(Tree::Blobs, &hash).unwrap_or(false) {
                                // If we don't have the blob, add to pull so the server requests it
                                if !pull.contains(subject) {
                                    pull.push(subject.clone());
                                    pull_from.insert(subject.clone(), server_vv.clone());
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

    // Client resources not on server: pull new data, or tell client to delete tombstones.
    for subject in client_vvs.keys() {
        if !server_vvs.contains_key(subject) {
            if super::tombstones::is_tombstoned(store, subject) {
                remove.push(subject.clone());
            } else {
                pull.push(subject.clone());
                pull_from
                    .entry(subject.clone())
                    .or_insert_with(std::collections::HashMap::new);
            }
        }
    }

    let push_subjects: Vec<String> = push_entries.iter().map(|(s, _)| s.clone()).collect();

    tracing::info!(
        "SYNC_VV: drive {} — {} to push, {} to pull, {} to remove",
        drive,
        push_subjects.len(),
        pull.len(),
        remove.len(),
    );

    let mut frames = Vec::new();
    frames.push(protocol::encode_sync_diff(
        drive,
        &pull,
        &push_subjects,
        &remove,
        &pull_from,
    ));

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

    // Managed admission gate. No-op under the default OpenPolicy (self-hosted /
    // FOSS), so this only bites on a managed node: it admits writes to enrolled
    // drives (within quota), plus a bootstrap grace for a drive whose enrollment
    // is still propagating to the allowlist.
    if !store.sync_policy().admit_drive_write(&push.drive) {
        tracing::warn!(
            "import_sync_push: drive {} not admitted by sync policy",
            push.drive
        );
        return (0, vec![]);
    }

    let mut count = 0;
    let mut blob_requests = Vec::new();

    for entry in &push.entries {
        if super::tombstones::is_tombstoned(store, &entry.subject) {
            tracing::debug!(
                "import_sync_push: skip {:?} (tombstoned locally)",
                &entry.subject[..entry.subject.len().min(24)]
            );
            continue;
        }

        let snapshot_key =
            crate::Subject::from_raw(&entry.subject, store.get_base_domain().as_deref()).pure_id();

        // Load existing doc or create new
        let doc = if let Ok(Some(existing)) =
            store.kv.get(Tree::LoroSnapshots, snapshot_key.as_bytes())
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
            .insert(Tree::LoroSnapshots, snapshot_key.as_bytes(), &snapshot)
            .is_err()
        {
            continue;
        }

        // No `get_resource` — `apply_state_doc` rebuilds propvals from the
        // merged doc, so the read would be discarded. Sync builds directly.
        let subject = crate::Subject::from_raw(&snapshot_key, store.get_base_domain().as_deref());
        let mut resource = crate::Resource::new(subject.to_string());

        if resource.apply_state_doc(doc).is_err() {
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
                if let Ok(hash_bytes) = hex::decode(hash_hex) {
                    if hash_bytes.len() == 32 {
                        let mut hash = [0u8; 32];
                        hash.copy_from_slice(&hash_bytes);
                        if !store.kv.contains_key(Tree::Blobs, &hash).unwrap_or(false) {
                            // Record which (already-admitted, see the top of
                            // this fn) drive this hash belongs to so the
                            // BLOB_RESPONSE handler can gate the write
                            // instead of accepting it unconditionally
                            // (planning/unified-sync.md F4).
                            store.note_pending_blob_request(hash, push.drive.clone());
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
