//! Signed JSON-AD commit ingest — one implementation, role-specific opts.
//!
//! Callers: hub HTTP/WS (`CommitIngestOpts::hub`), Iroh/peer `COMMIT`
//! frames (`peer`), Flutter WS catch-up (`replica`).

use crate::db::Db;
use crate::Storelike;

/// Policy knobs distinguishing a hub ingesting a client's commit from a peer
/// replica ingesting another peer's commit. Signature and schema always run.
/// Build with [`CommitIngestOpts::hub`], [`peer`](Self::peer), or
/// [`replica`](Self::replica) — fields are crate-private so a new knob cannot
/// be added at one call site and forgotten at the others.
pub struct CommitIngestOpts {
    source_id: Option<String>,
    validate_loro_causality: bool,
    enforce_subject_ownership: bool,
    suppress_live_echo: bool,
    response_origin: Option<String>,
    validate_rights: bool,
    validate_timestamp: bool,
}

impl CommitIngestOpts {
    /// HTTP `/commit` and hub WS `COMMIT`.
    pub fn hub(source_id: Option<String>, response_origin: Option<String>) -> Self {
        Self {
            source_id,
            validate_loro_causality: true,
            enforce_subject_ownership: true,
            suppress_live_echo: false,
            response_origin,
            validate_rights: true,
            validate_timestamp: true,
        }
    }

    /// Iroh / peer-transport `COMMIT` frame. Concurrent writes expected;
    /// replica hosts subjects it does not own.
    pub fn peer() -> Self {
        Self {
            source_id: None,
            validate_loro_causality: false,
            enforce_subject_ownership: false,
            suppress_live_echo: true,
            response_origin: None,
            validate_rights: true,
            validate_timestamp: true,
        }
    }

    /// Flutter WS catch-up: apply a commit the hub already accepted.
    pub fn replica() -> Self {
        Self {
            source_id: None,
            validate_loro_causality: false,
            enforce_subject_ownership: false,
            suppress_live_echo: true,
            response_origin: None,
            validate_rights: false,
            validate_timestamp: false,
        }
    }
}

/// Ingest a signed JSON-AD `COMMIT`, returning the server-created commit
/// resource as JSON-AD. See [`CommitIngestOpts`] for hub / peer / replica.
pub async fn ingest_commit_json(
    store: &Db,
    commit_json: &str,
    opts: &CommitIngestOpts,
) -> crate::errors::AtomicResult<String> {
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
        validate_timestamp: opts.validate_timestamp,
        validate_rights: opts.validate_rights,
        validate_previous_commit: false,
        validate_loro_causality: opts.validate_loro_causality,
        validate_for_agent: Some(signer.to_string()),
        update_index: true,
        source_id: opts.source_id.clone(),
    };

    let base_domain = store.get_base_domain();

    let response = if opts.suppress_live_echo {
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
