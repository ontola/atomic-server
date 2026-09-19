//! Signed commit envelopes kept per resource.
//!
//! Authorization is decided on state (`read` / `write` / `parent` in the
//! projection); the Loro oplog is the history of *what* changed and when. What
//! neither carries is *who signed the state you are looking at*: the oplog's
//! change messages are opaque drain tokens, and `lastCommit` is only an id.
//! This tree keeps the signed JSON-AD of the commits that produced a resource,
//! so any node holding it can re-verify the signature and attribute the state,
//! offline. See `planning/completed/commit-retention-floor-decision.md`
//! (F6 latest envelope, F7 every envelope).
//!
//! Layout ([`Tree::Envelopes`]): key
//! `pure_id || 0x00 || createdAt (u64 BE) || 0x00 || signature`, value a
//! compact `AE01` payload (header propvals + raw `loroUpdate`). Readers
//! reconstruct JSON-AD. A prefix scan on the pure id lists a resource's
//! envelopes in time order. The rows are not resources and not indexed: they
//! never show up in queries, `all_resources`, search or collections, so
//! nothing has to filter `did:ad:commit:` subjects by hand.
//!
//! How many rows survive is [`EnvelopeRetention`]: `Latest` keeps the one
//! that produced the current state (the floor), `All` keeps every envelope
//! and turns the oplog into a signed audit log ([`attribute_history`]).
//!
//! On disk the value is a compact binary (`AE01` + header + raw `loroUpdate`)
//! so the snapshot is not stored again as JSON-AD base64. Readers still see
//! JSON-AD via [`StoredEnvelope::json`]. Legacy rows that start with `{` are
//! accepted as the old JSON-AD form.
//!
//! What is deliberately not here: envelopes inside the Loro doc (an envelope
//! would then sign a document containing itself), and a retention schedule
//! beyond the two settings. Replication of these rows is the sync layer's
//! job (`planning/auditability-loro-history.md`).

use crate::db::trees::{Method, Operation, Transaction, Tree};
use crate::errors::AtomicResult;
use crate::{commit::CommitResponse, urls, Db, Resource, Value};

/// On-disk envelope magic: compact header + raw `loroUpdate` (not JSON+base64).
const ENVELOPE_V1: &[u8] = b"AE01";

/// Which envelopes a node keeps per resource.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EnvelopeRetention {
    /// One row per resource: the envelope that produced the current state.
    /// Attribution of the current state stays verifiable; older edits are
    /// visible in the Loro oplog but unattributed.
    #[default]
    Latest,
    /// Every envelope. Each Loro change maps back to the signed commit that
    /// introduced it, so History can show a verified signer per version.
    All,
}

impl EnvelopeRetention {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "latest" => Some(Self::Latest),
            "all" | "full" => Some(Self::All),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Latest => "latest",
            Self::All => "all",
        }
    }
}

/// One retained envelope, decoded from its key. `json` is the signed body.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StoredEnvelope {
    /// Pure id of the resource the commit is about.
    pub subject: String,
    /// Commit `createdAt`, Unix milliseconds.
    pub created_at: i64,
    pub signature: String,
    /// The commit's JSON-AD exactly as accepted.
    pub json: String,
}

impl StoredEnvelope {
    /// The commit id this envelope is stored under (`did:ad:commit:<sig>`),
    /// the same value `lastCommit` stamps on the resource.
    pub fn commit_id(&self) -> String {
        format!("did:ad:commit:{}", self.signature)
    }

    /// Whether this envelope is a destroy.
    pub fn is_destroy(&self) -> bool {
        serde_json::from_str::<serde_json::Value>(&self.json)
            .ok()
            .and_then(|v| v.get(crate::urls::DESTROY).and_then(|d| d.as_bool()))
            .unwrap_or(false)
    }
}

fn prefix(subject: &str) -> Vec<u8> {
    let pure = crate::Subject::from_raw(subject, None).pure_id();
    let mut key = Vec::with_capacity(pure.len() + 1);
    key.extend_from_slice(pure.as_bytes());
    key.push(0);
    key
}

fn key(subject: &str, created_at: i64, signature: &str) -> Vec<u8> {
    let mut key = prefix(subject);
    key.extend_from_slice(&(created_at.max(0) as u64).to_be_bytes());
    key.push(0);
    key.extend_from_slice(signature.as_bytes());
    key
}

fn decode(key: &[u8], value: Vec<u8>) -> Option<StoredEnvelope> {
    let subject_end = key.iter().position(|b| *b == 0)?;
    let subject = std::str::from_utf8(&key[..subject_end]).ok()?.to_string();
    let rest = &key[subject_end + 1..];
    if rest.len() < 9 || rest[8] != 0 {
        return None;
    }
    let created_at = u64::from_be_bytes(rest[..8].try_into().ok()?) as i64;
    let signature = std::str::from_utf8(&rest[9..]).ok()?.to_string();
    let json = envelope_value_to_json(&value, &signature)?;
    Some(StoredEnvelope {
        subject,
        created_at,
        signature,
        json,
    })
}

/// Persist the signed envelope as header propvals + raw `loroUpdate` bytes.
/// JSON-AD with base64 is reconstructed on read so verification and History
/// keep the same surface.
fn encode_envelope(commit: &Resource) -> AtomicResult<Vec<u8>> {
    let mut propvals = commit.get_propvals().clone();
    let loro = match propvals.remove(urls::LORO_UPDATE) {
        Some(Value::LoroDoc(bytes)) => bytes,
        _ => Vec::new(),
    };
    let header = crate::db::encoding::encode_propvals(&propvals)?;
    let header_len = u32::try_from(header.len()).map_err(|_| "envelope header exceeds u32::MAX")?;
    let mut out = Vec::with_capacity(ENVELOPE_V1.len() + 4 + header.len() + loro.len());
    out.extend_from_slice(ENVELOPE_V1);
    out.extend_from_slice(&header_len.to_le_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(&loro);
    Ok(out)
}

fn envelope_value_to_json(value: &[u8], signature: &str) -> Option<String> {
    if value.first() == Some(&b'{') {
        return String::from_utf8(value.to_vec()).ok();
    }
    if value.len() < 8 || !value.starts_with(ENVELOPE_V1) {
        return None;
    }
    let header_len = u32::from_le_bytes(value[4..8].try_into().ok()?) as usize;
    let header_end = 8usize.checked_add(header_len)?;
    if value.len() < header_end {
        return None;
    }
    let mut propvals = crate::db::encoding::decode_propvals(&value[8..header_end]).ok()?;
    let loro = value[header_end..].to_vec();
    if !loro.is_empty() {
        propvals.insert(urls::LORO_UPDATE.into(), Value::LoroDoc(loro));
    }
    let resource = Resource::from_propvals(propvals, format!("did:ad:commit:{signature}").into());
    resource.to_json_ad(None).ok()
}

/// Queue the writes that keep this commit's envelope, honouring the store's
/// retention. Appended to the apply transaction so the envelope lands with
/// the state it signs, or not at all. Unsigned commits (internal writes)
/// have nothing to keep.
pub fn record_ops(
    store: &Db,
    response: &CommitResponse,
    transaction: &mut Transaction,
) -> AtomicResult<()> {
    let Some(signature) = response.commit.signature.as_deref() else {
        return Ok(());
    };
    let subject = response.commit.subject.as_str();
    let stored = encode_envelope(&response.commit_resource)?;
    let new_key = key(subject, response.commit.created_at, signature);

    if store.envelope_retention() == EnvelopeRetention::Latest {
        for existing in store.kv.scan_prefix(Tree::Envelopes, &prefix(subject)) {
            let (old_key, _) = existing?;
            if old_key != new_key {
                transaction.push(Operation {
                    tree: Tree::Envelopes,
                    method: Method::Delete,
                    key: old_key,
                    val: None,
                });
            }
        }
    }

    transaction.push(Operation {
        tree: Tree::Envelopes,
        method: Method::Insert,
        key: new_key,
        val: Some(stored),
    });
    Ok(())
}

/// Every retained envelope of a resource, oldest first.
pub fn envelopes(store: &Db, subject: &str) -> Vec<StoredEnvelope> {
    store
        .kv
        .scan_prefix(Tree::Envelopes, &prefix(subject))
        .filter_map(|entry| entry.ok())
        .filter_map(|(k, v)| decode(&k, v))
        .collect()
}

/// The envelope that produced the resource's current state, if kept.
pub fn latest_envelope(store: &Db, subject: &str) -> Option<StoredEnvelope> {
    envelopes(store, subject).into_iter().last()
}

/// The retained envelopes of each subject as commit JSON-AD, for a bulk
/// push or a vault pack. Subjects with none are absent.
pub fn for_subjects<'a>(
    store: &Db,
    subjects: impl IntoIterator<Item = &'a str>,
) -> std::collections::HashMap<String, Vec<String>> {
    let mut out = std::collections::HashMap::new();
    for subject in subjects {
        let rows: Vec<String> = envelopes(store, subject)
            .into_iter()
            .map(|e| e.json)
            .collect();
        if !rows.is_empty() {
            out.insert(subject.to_string(), rows);
        }
    }
    out
}

/// Keep an envelope that arrived with a bulk push or a vault pack.
///
/// It is verified the way apply verifies a commit (the signature, by the
/// signer the commit names) and must be about `expected_subject`, the entry
/// it travelled with; otherwise nothing is written. Retention applies as for
/// a local commit: on `latest` only the newest envelope by `createdAt`
/// survives, which may be one already here. Idempotent for a row already
/// stored.
pub async fn import_envelope(store: &Db, expected_subject: &str, json: &str) -> AtomicResult<()> {
    let resource = crate::parse::parse_json_ad_commit_resource(json, store).await?;
    let commit = crate::commit::Commit::from_resource(resource.clone())?;
    let expected = crate::Subject::from_raw(expected_subject, None).pure_id();
    let actual = commit.subject.pure_id();
    if actual != expected {
        return Err(format!("envelope is about {actual}, not {expected}").into());
    }
    commit.validate_signature(store).await?;
    let signature = commit
        .signature
        .as_deref()
        .ok_or("envelope has no signature")?;
    let new_key = key(commit.subject.as_str(), commit.created_at, signature);
    if store.kv.contains_key(Tree::Envelopes, &new_key)? {
        return Ok(());
    }

    let mut ops = Vec::new();
    if store.envelope_retention() == EnvelopeRetention::Latest {
        let existing = envelopes(store, commit.subject.as_str());
        if existing.iter().any(|e| e.created_at > commit.created_at) {
            // A newer envelope is already the latest; the incoming one is
            // history this node chose not to keep.
            return Ok(());
        }
        for old in existing {
            ops.push(Operation {
                tree: Tree::Envelopes,
                method: Method::Delete,
                key: key(&old.subject, old.created_at, &old.signature),
                val: None,
            });
        }
    }
    ops.push(Operation {
        tree: Tree::Envelopes,
        method: Method::Insert,
        key: new_key,
        val: Some(encode_envelope(&resource)?),
    });
    store.kv.apply_batch(&ops)
}

/// Drop every retained envelope of a resource. Not called on destroy: the
/// destroy envelope is the proof a peer needs (`SYNC_DIFF.removeCommits`).
pub fn clear_envelopes(store: &Db, subject: &str) {
    for (k, _) in store
        .kv
        .scan_prefix(Tree::Envelopes, &prefix(subject))
        .flatten()
    {
        let _ = store.kv.remove(Tree::Envelopes, &k);
    }
}

/// The genesis change's message is the creator's agent subject (written by
/// the browser and by `Commit::create_did`), which `createdBy` reads.
fn is_genesis_carrier(token: &str) -> bool {
    token.starts_with("did:ad:agent:")
}

/// One signed change, as History shows it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Attribution {
    pub signer: String,
    /// Commit `createdAt`, Unix milliseconds.
    pub created_at: i64,
    pub signature: String,
    /// The signature checks out against the signer's key on this node.
    pub verified: bool,
    /// Loro change messages (the client's drain tokens) the envelope's update
    /// introduced. History buckets versions by the same token, so a version
    /// maps to its signer by lookup.
    pub tokens: Vec<String>,
    pub destroy: bool,
    pub genesis: bool,
}

/// What this node can say about who signed a resource's history.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HistoryAttribution {
    pub subject: String,
    /// Retention this node runs; tells a reader whether missing attributions
    /// are a gap or a policy.
    pub retention: &'static str,
    /// Oldest first.
    pub attributions: Vec<Attribution>,
    /// Every client-authored change in the stored oplog (a change carrying
    /// a drain token) is claimed by a verified envelope. Server bookkeeping
    /// (the `lastCommit` stamp, derived `drive`) writes untokened changes and
    /// is not counted. `false` while the subject is destroyed or nothing is
    /// retained.
    pub complete: bool,
}

/// Verify the retained envelopes of a resource and map them onto its Loro
/// history. Each envelope's signature is checked with the same code apply
/// uses, and its `loroUpdate` is imported into a fresh doc to read which
/// change tokens it introduced. `complete` is whether every tokened change
/// in the stored oplog is claimed by a verified envelope. Anything not
/// covered is unattributed, never a guessed signer.
pub async fn attribute_history(store: &Db, subject: &str) -> AtomicResult<HistoryAttribution> {
    let retention = store.envelope_retention().as_str();
    let mut attributions: Vec<Attribution> = Vec::new();
    let pure = crate::Subject::from_raw(subject, None).pure_id();
    // The stored doc is where an update's changes can be read back with
    // their messages: a delta carries only its own ops, and only a doc that
    // already holds their dependencies can list them.
    let stored_doc = store
        .kv
        .get(Tree::LoroSnapshots, pure.as_bytes())
        .ok()
        .flatten()
        .and_then(|bytes| crate::loro::AtomicLoroDoc::from_snapshot(&bytes).ok());

    for envelope in envelopes(store, subject) {
        let resource = crate::parse::parse_json_ad_commit_resource(&envelope.json, store).await?;
        let commit = crate::commit::Commit::from_resource(resource)?;
        let verified = commit.validate_signature(store).await.is_ok();

        // Tokens this envelope introduced. A genesis carries a snapshot and
        // a browser edit only its delta, but a Rust builder commit (and a
        // client re-exporting from an older cursor) repeats earlier changes;
        // a token is credited to the first retained envelope that carried
        // it, so each change has one signer. The genesis change's message is
        // the creator's subject and is proven by the inline genesis
        // certificate, not by whoever later shipped a snapshot containing
        // it: only a genesis envelope may claim it.
        let is_genesis = commit.is_genesis == Some(true);
        let mut tokens = Vec::new();
        if let (Some(update), Some(doc)) = (commit.loro_update.as_deref(), stored_doc.as_ref()) {
            if let Ok((start, end)) = crate::loro::AtomicLoroDoc::update_range(update) {
                for message in doc.change_messages_in(&start, &end) {
                    if is_genesis_carrier(&message) && !is_genesis {
                        continue;
                    }
                    let claimed = attributions.iter().any(|a| a.tokens.contains(&message));
                    if !claimed && !tokens.contains(&message) {
                        tokens.push(message);
                    }
                }
            }
        }

        attributions.push(Attribution {
            signer: commit.signer.to_string(),
            created_at: commit.created_at,
            signature: envelope.signature.clone(),
            verified,
            tokens,
            destroy: commit.destroy.unwrap_or(false),
            genesis: is_genesis,
        });
    }

    let stored_tokens: Option<Vec<String>> = stored_doc.as_ref().map(|doc| {
        doc.get_history()
            .into_iter()
            .filter_map(|change| change.message)
            .collect()
    });
    // The genesis change is covered by the resource's inline certificate
    // (F1), so it is not required here; every other tokened change must be.
    let complete = match stored_tokens {
        Some(tokens) => {
            !attributions.is_empty()
                && tokens
                    .iter()
                    .filter(|token| !is_genesis_carrier(token))
                    .all(|token| {
                        attributions
                            .iter()
                            .any(|a| a.verified && a.tokens.contains(token))
                    })
        }
        None => false,
    };

    Ok(HistoryAttribution {
        subject: pure,
        retention,
        attributions,
        complete,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::ForAgent;
    use crate::sync::engine::{ingest_commit_json, CommitIngestOpts};
    use crate::{urls, Storelike, Value};

    /// A signed content edit by the store's default agent, applied through
    /// `Db::apply_commit` like every other write.
    async fn signed_edit(db: &Db, subject: &crate::Subject, name: &str) {
        let mut resource = db.get_resource(subject).await.unwrap();
        resource
            .set(urls::NAME.into(), Value::String(name.into()), db)
            .await
            .unwrap();
        let response = resource.save_locally(db).await.unwrap();
        assert!(response.commit.signature.is_some(), "save_locally signs");
    }

    async fn child(db: &Db, drive: &str) -> crate::Subject {
        let subject = db
            .create_resource(
                urls::CLASS,
                drive,
                "Doc",
                Some(vec![
                    (urls::DESCRIPTION, Value::String("d".into())),
                    (urls::SHORTNAME, Value::Slug("doc".into())),
                ]),
            )
            .await
            .unwrap();
        crate::Subject::from_raw(&subject, None)
    }

    #[tokio::test]
    async fn latest_retention_keeps_one_envelope_per_resource() {
        let db = Db::init_temp("envelopes_latest").await.unwrap();
        let (_alice, drive) = db.setup("Alice").await.unwrap();
        let subject = child(&db, &drive).await;
        assert_eq!(
            envelopes(&db, subject.as_str()).len(),
            1,
            "create_resource signs a genesis"
        );

        for name in ["one", "two"] {
            signed_edit(&db, &subject, name).await;
        }
        let kept = envelopes(&db, subject.as_str());
        assert_eq!(kept.len(), 1, "Latest keeps only the newest envelope");
        let latest = latest_envelope(&db, subject.as_str()).unwrap();
        assert_eq!(kept[0], latest);
        let stamp = db
            .get_resource(&subject)
            .await
            .unwrap()
            .get(urls::LAST_COMMIT)
            .unwrap()
            .to_string();
        assert_eq!(latest.commit_id(), stamp, "the kept envelope is lastCommit");
    }

    #[tokio::test]
    async fn all_retention_keeps_every_envelope_in_time_order() {
        let db = Db::init_temp("envelopes_all").await.unwrap();
        db.set_envelope_retention(EnvelopeRetention::All);
        let (_alice, drive) = db.setup("Alice").await.unwrap();
        let subject = child(&db, &drive).await;

        for name in ["one", "two", "three"] {
            signed_edit(&db, &subject, name).await;
        }
        let kept = envelopes(&db, subject.as_str());
        assert_eq!(kept.len(), 4, "genesis plus three edits");
        assert!(kept.windows(2).all(|w| w[0].created_at <= w[1].created_at));
        let stamp = db
            .get_resource(&subject)
            .await
            .unwrap()
            .get(urls::LAST_COMMIT)
            .unwrap()
            .to_string();
        assert_eq!(kept.last().unwrap().commit_id(), stamp);
    }

    /// A receiver keeps a pushed envelope only after verifying it: a
    /// tampered signature or a mismatched subject writes nothing.
    #[tokio::test]
    async fn import_envelope_verifies_before_storing() {
        let source = Db::init_temp("envelopes_import_source").await.unwrap();
        let (_alice, drive) = source.setup("Alice").await.unwrap();
        let subject = child(&source, &drive).await;
        signed_edit(&source, &subject, "edited").await;
        let envelope = latest_envelope(&source, subject.as_str()).unwrap();

        let sink = Db::init_temp("envelopes_import_sink").await.unwrap();
        assert!(envelopes(&sink, subject.as_str()).is_empty());

        assert!(
            import_envelope(&sink, "did:ad:someone-else", &envelope.json)
                .await
                .is_err(),
            "an envelope about another subject is refused"
        );
        let tampered = envelope.json.replace(&envelope.signature[..8], "AAAAAAAA");
        assert!(
            import_envelope(&sink, subject.as_str(), &tampered)
                .await
                .is_err(),
            "a bad signature is refused"
        );
        assert!(envelopes(&sink, subject.as_str()).is_empty());

        import_envelope(&sink, subject.as_str(), &envelope.json)
            .await
            .unwrap();
        // Idempotent.
        import_envelope(&sink, subject.as_str(), &envelope.json)
            .await
            .unwrap();
        let kept = envelopes(&sink, subject.as_str());
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].signature, envelope.signature);
        assert_eq!(kept[0].json, envelope.json);
    }

    /// `latest` retention on the receiver keeps the newest envelope whatever
    /// order they arrive in; `all` keeps every one.
    #[tokio::test]
    async fn import_envelope_honours_the_receivers_retention() {
        let source = Db::init_temp("envelopes_import_ret_source").await.unwrap();
        source.set_envelope_retention(EnvelopeRetention::All);
        let (_alice, drive) = source.setup("Alice").await.unwrap();
        let subject = child(&source, &drive).await;
        signed_edit(&source, &subject, "one").await;
        signed_edit(&source, &subject, "two").await;
        let all = envelopes(&source, subject.as_str());
        assert_eq!(all.len(), 3);
        let newest = all.last().unwrap().clone();

        let latest_sink = Db::init_temp("envelopes_import_ret_latest").await.unwrap();
        // Newest first, then older ones: the older must not displace it.
        for e in all.iter().rev() {
            import_envelope(&latest_sink, subject.as_str(), &e.json)
                .await
                .unwrap();
        }
        let kept = envelopes(&latest_sink, subject.as_str());
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].signature, newest.signature);

        let all_sink = Db::init_temp("envelopes_import_ret_all").await.unwrap();
        all_sink.set_envelope_retention(EnvelopeRetention::All);
        for e in &all {
            import_envelope(&all_sink, subject.as_str(), &e.json)
                .await
                .unwrap();
        }
        assert_eq!(envelopes(&all_sink, subject.as_str()).len(), 3);
    }

    #[tokio::test]
    async fn envelope_is_stored_compact_not_json_ad() {
        let db = Db::init_temp("envelopes_compact").await.unwrap();
        let (_alice, drive) = db.setup("Alice").await.unwrap();
        let subject = child(&db, &drive).await;
        let latest = latest_envelope(&db, subject.as_str()).unwrap();
        assert!(
            latest.json.starts_with('{'),
            "readers still see reconstructed JSON-AD"
        );
        assert!(
            latest.json.contains(urls::LORO_UPDATE),
            "reconstructed JSON-AD still carries the signed update"
        );

        let mut prefix = subject.pure_id().as_bytes().to_vec();
        prefix.push(0);
        let stored = db
            .kv
            .scan_prefix(Tree::Envelopes, &prefix)
            .filter_map(|item| item.ok())
            .map(|(_, val)| val)
            .next()
            .expect("one envelope row");
        assert!(
            stored.starts_with(ENVELOPE_V1),
            "on-disk envelope must be AE01, not JSON-AD"
        );
        assert!(
            stored.len() < latest.json.len(),
            "compact envelope ({}) must be smaller than reconstructed JSON-AD ({})",
            stored.len(),
            latest.json.len()
        );
    }

    /// A critical commit (a genesis, a destroy, a rights change) is persisted
    /// as its own resource so the audit trail survives, and `Latest`
    /// retention deletes that resource's older envelopes on its next commit.
    /// So the commit row has to be self-contained: its `loroUpdate` is the
    /// payload its signature covers, and the envelope is not a place to keep
    /// it. Moving the payload out of the blob is what this pins against.
    #[tokio::test]
    async fn stored_genesis_commit_keeps_its_signed_payload_after_a_later_edit() {
        let db = Db::init_temp("envelope_genesis_payload").await.unwrap();
        let (_alice, drive) = db.setup("Alice").await.unwrap();
        assert_eq!(db.envelope_retention(), EnvelopeRetention::Latest);

        let subject = child(&db, &drive).await;
        let genesis = latest_envelope(&db, subject.as_str()).unwrap();
        let commit_subject =
            crate::Subject::from_raw(&format!("did:ad:commit:{}", genesis.signature), None);

        let before = db.get_resource(&commit_subject).await.unwrap();
        assert!(
            matches!(before.get(urls::LORO_UPDATE), Ok(Value::LoroDoc(b)) if !b.is_empty()),
            "the genesis commit resource carries its signed payload"
        );

        signed_edit(&db, &subject, "renamed").await;

        // `Latest` has now dropped the genesis envelope, as it is meant to.
        assert_eq!(envelopes(&db, subject.as_str()).len(), 1);

        let after = db.get_resource(&commit_subject).await.unwrap();
        assert!(
            matches!(after.get(urls::LORO_UPDATE), Ok(Value::LoroDoc(b)) if !b.is_empty()),
            "a later edit must not strip the stored genesis commit's payload"
        );
    }

    #[tokio::test]
    async fn envelopes_are_not_resources_or_query_hits() {
        let db = Db::init_temp("envelopes_not_indexed").await.unwrap();
        let (_alice, drive) = db.setup("Alice").await.unwrap();
        let subject = child(&db, &drive).await;
        let latest = latest_envelope(&db, subject.as_str()).unwrap();
        // The genesis commit row is retained as a resource (critical), but the
        // envelope tree itself is invisible to the resource model.
        assert!(!db.has_resource_locally(&format!("envelope:{}", latest.signature)));
        let mut query = crate::storelike::Query::new_prop_val(urls::SIGNER, "did:ad:agent:nobody");
        query.limit = Some(10);
        assert_eq!(db.query(&query).await.unwrap().count, 0);
    }

    #[tokio::test]
    async fn history_attribution_maps_verified_signers_onto_loro_tokens() {
        let db = Db::init_temp("envelopes_attribution").await.unwrap();
        db.set_envelope_retention(EnvelopeRetention::All);
        let (alice, drive) = db.setup("Alice").await.unwrap();
        let subject = child(&db, &drive).await;
        signed_edit(&db, &subject, "edited").await;

        let report = attribute_history(&db, subject.as_str()).await.unwrap();
        assert_eq!(report.retention, "all");
        assert_eq!(report.attributions.len(), 2);
        assert!(report.attributions.iter().all(|a| a.verified));
        assert!(report.attributions[0].genesis);
        assert!(!report.attributions[1].genesis);
        assert!(report
            .attributions
            .iter()
            .all(|a| a.signer == alice.subject));
        assert!(
            report.complete,
            "replaying the retained envelopes must reproduce the stored oplog"
        );

        // Every Loro change of the stored doc is claimed by exactly one envelope.
        let resource = db.get_resource(&subject).await.unwrap();
        let versions = crate::history::versions(&resource).unwrap();
        for version in versions.iter().filter_map(|v| v.message.clone()) {
            let owners = report
                .attributions
                .iter()
                .filter(|a| a.tokens.contains(&version))
                .count();
            assert_eq!(owners, 1, "token {version} must map to one signer");
        }
    }

    #[tokio::test]
    async fn tampered_envelope_is_unverified_and_history_incomplete() {
        let db = Db::init_temp("envelopes_tampered").await.unwrap();
        db.set_envelope_retention(EnvelopeRetention::All);
        let (_alice, drive) = db.setup("Alice").await.unwrap();
        let subject = child(&db, &drive).await;
        signed_edit(&db, &subject, "edited").await;

        // Corrupt the newest stored row in place.
        let rows = envelopes(&db, subject.as_str());
        let last = rows.last().unwrap();
        let mut broken: serde_json::Value = serde_json::from_str(&last.json).unwrap();
        broken[urls::SIGNATURE] = serde_json::Value::String("AAAA".into());
        db.kv
            .insert(
                Tree::Envelopes,
                &key(subject.as_str(), last.created_at, &last.signature),
                broken.to_string().as_bytes(),
            )
            .unwrap();

        let report = attribute_history(&db, subject.as_str()).await.unwrap();
        assert!(report.attributions[0].verified);
        assert!(!report.attributions[1].verified);
        assert!(!report.complete);
    }

    #[tokio::test]
    async fn latest_retention_under_a_second_writer_keeps_the_newest_signer() {
        let db = Db::init_temp("envelopes_two_writers").await.unwrap();
        let (alice, drive) = db.setup("Alice").await.unwrap();
        let bob = db.create_agent(Some("Bob")).await.unwrap();
        let subject = child(&db, &drive).await;
        let mut resource = db.get_resource(&subject).await.unwrap();
        resource
            .set_unsafe(
                urls::WRITE.into(),
                Value::ResourceArray(vec![
                    alice.subject.to_string().into(),
                    bob.subject.to_string().into(),
                ]),
            )
            .unwrap();
        db.add_resource_opts(&resource, false, true, true)
            .await
            .unwrap();

        db.set_default_agent(bob.clone());
        signed_edit(&db, &subject, "by bob").await;
        db.set_default_agent(alice.clone());
        let report = attribute_history(&db, subject.as_str()).await.unwrap();
        assert_eq!(report.attributions.len(), 1);
        assert_eq!(report.attributions[0].signer, bob.subject.to_string());
        assert!(report.attributions[0].verified);
        assert!(
            !report.attributions[0]
                .tokens
                .iter()
                .any(|t| t.starts_with("did:ad:agent:")),
            "a snapshot-carrying edit must not be credited with the genesis change"
        );
        assert!(
            report.complete,
            "the genesis is proven by its certificate; the only other signed change is Bob's"
        );
    }

    #[tokio::test]
    async fn all_retention_credits_each_writer_with_their_own_change() {
        let db = Db::init_temp("envelopes_two_writers_all").await.unwrap();
        db.set_envelope_retention(EnvelopeRetention::All);
        let (alice, drive) = db.setup("Alice").await.unwrap();
        let bob = db.create_agent(Some("Bob")).await.unwrap();
        let subject = child(&db, &drive).await;
        let mut resource = db.get_resource(&subject).await.unwrap();
        resource
            .set_unsafe(
                urls::WRITE.into(),
                Value::ResourceArray(vec![
                    alice.subject.to_string().into(),
                    bob.subject.to_string().into(),
                ]),
            )
            .unwrap();
        db.add_resource_opts(&resource, false, true, true)
            .await
            .unwrap();

        signed_edit(&db, &subject, "by alice").await;
        db.set_default_agent(bob.clone());
        signed_edit(&db, &subject, "by bob").await;
        db.set_default_agent(alice.clone());

        let report = attribute_history(&db, subject.as_str()).await.unwrap();
        assert!(report.complete);
        let signers: Vec<&str> = report
            .attributions
            .iter()
            .map(|a| a.signer.as_str())
            .collect();
        assert_eq!(
            signers,
            vec![
                alice.subject.as_str(),
                alice.subject.as_str(),
                bob.subject.as_str()
            ],
            "genesis, Alice's edit, Bob's edit"
        );
        assert!(report.attributions[0].genesis);
        assert_eq!(report.attributions[1].tokens.len(), 1);
        assert_eq!(report.attributions[2].tokens.len(), 1);
        assert_ne!(report.attributions[1].tokens, report.attributions[2].tokens);
        let stored = db.get_resource(&subject).await.unwrap();
        let versions = crate::history::versions(&stored).unwrap();
        for token in versions.iter().filter_map(|v| v.message.clone()) {
            let owners = report
                .attributions
                .iter()
                .filter(|a| a.tokens.contains(&token))
                .count();
            assert_eq!(owners, 1, "token {token} must map to exactly one signer");
        }
    }

    /// The browser signs a *delta* (ops since its last save) tagged with a
    /// drain token, not a snapshot. Its tokens must still be read: a delta
    /// imported into an empty doc is pending (missing deps) and lists no
    /// changes, which is how attribution first shipped with empty tokens.
    #[tokio::test]
    async fn browser_style_delta_envelope_is_attributed_by_its_token() {
        let db = Db::init_temp("envelopes_delta").await.unwrap();
        db.set_envelope_retention(EnvelopeRetention::All);
        let (alice, drive) = db.setup("Alice").await.unwrap();
        let subject = child(&db, &drive).await;

        // A client that holds the current state edits it and exports only
        // the new change, tagged the way the drain tags it.
        let resource = db.get_resource(&subject).await.unwrap();
        let snapshot = resource.materialized_state().expect("stored state");
        let base_vv = crate::loro::AtomicLoroDoc::from_snapshot(&snapshot)
            .unwrap()
            .oplog_vv();
        let client_doc = crate::loro::AtomicLoroDoc::from_snapshot(&snapshot).unwrap();
        client_doc
            .set_property(urls::NAME, &Value::String("delta edit".into()))
            .unwrap();
        client_doc.commit_with_message("c-01test-delta-token");
        let delta = client_doc.export_updates_since(&base_vv);
        assert!(!delta.is_empty());

        let mut builder = crate::commit::CommitBuilder::new(subject.clone());
        builder.set_loro_update(delta);
        let commit = builder.sign(&alice, &db, &resource).await.unwrap();
        let json = commit
            .into_resource(&db)
            .await
            .unwrap()
            .to_json_ad(None)
            .unwrap();
        ingest_commit_json(&db, &json, &CommitIngestOpts::peer())
            .await
            .expect("the delta applies");

        let report = attribute_history(&db, subject.as_str()).await.unwrap();
        let last = report.attributions.last().unwrap();
        assert!(last.verified);
        assert_eq!(
            last.tokens,
            vec!["c-01test-delta-token".to_string()],
            "the delta's own change token is credited to its envelope"
        );
        assert!(report.complete, "{report:?}");
        let stored = db.get_resource(&subject).await.unwrap();
        assert!(crate::history::versions(&stored)
            .unwrap()
            .iter()
            .any(|v| v.message.as_deref() == Some("c-01test-delta-token")));
    }

    #[tokio::test]
    async fn destroy_envelope_is_the_latest_row_of_a_destroyed_subject() {
        let db = Db::init_temp("envelopes_destroy").await.unwrap();
        let (alice, drive) = db.setup("Alice").await.unwrap();
        let subject = child(&db, &drive).await;
        let resource = db.get_resource(&subject).await.unwrap();
        let mut builder = crate::commit::CommitBuilder::new(subject.clone());
        builder.destroy(true);
        let commit = builder.sign(&alice, &db, &resource).await.unwrap();
        let json = commit
            .into_resource(&db)
            .await
            .unwrap()
            .to_json_ad(None)
            .unwrap();
        ingest_commit_json(&db, &json, &CommitIngestOpts::peer())
            .await
            .unwrap();

        let latest = latest_envelope(&db, subject.as_str()).unwrap();
        assert!(latest.is_destroy());
        assert_eq!(
            crate::sync::tombstones::destroy_envelope(&db, subject.as_str()).as_deref(),
            Some(latest.json.as_str()),
            "the tombstone's envelope is the envelope tree's latest row"
        );
        assert!(crate::sync::tombstones::is_tombstoned(
            &db,
            subject.as_str()
        ));
        let _ = ForAgent::Public;
    }
}
