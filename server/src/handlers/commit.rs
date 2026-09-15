use crate::{appstate::AppState, errors::AtomicServerResult};
use actix_web::{web, HttpResponse};
use atomic_lib::{
    sync::engine::{ingest_commit_json, CommitIngestOpts},
    Db,
};

/// Send and process a Commit.
/// Currently only accepts JSON-AD
#[tracing::instrument(skip(appstate))]
pub async fn post_commit(
    appstate: web::Data<AppState>,
    req: actix_web::HttpRequest,
    context: crate::context::RequestContext,
    body: String,
) -> AtomicServerResult<HttpResponse> {
    if appstate.config.opts.slow_mode {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let random_number = rng.gen_range(100..1000);
        tokio::time::sleep(tokio::time::Duration::from_millis(random_number)).await;
    }
    // The signer is the acting agent; `ingest_commit_json` verifies the
    // signature, so a forged signer only spends someone else's budget on a
    // commit that is rejected anyway.
    let for_agent = match commit_signer(&body) {
        Some(signer) => atomic_lib::agents::ForAgent::AgentSubject(signer.into()),
        None => atomic_lib::agents::ForAgent::Public,
    };
    crate::helpers::enforce_write_rate_limit(&appstate, &req, &for_agent)?;
    let store = &appstate.store;
    let message = apply_commit_json(store, &context.origin, &body, None).await?;

    Ok(HttpResponse::Ok()
        .content_type("application/ad+json")
        .body(message))
}

/// The `signer` of a JSON-AD commit body, without validating anything else.
fn commit_signer(body: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()?
        .get(atomic_lib::urls::SIGNER)?
        .as_str()
        .map(str::to_owned)
}

/// Apply a signed JSON-AD commit sent by a client. Delegates to the sync
/// engine's [`ingest_commit_json`] with hub policy: subject-ownership and
/// Loro-causality are enforced, the WS commit monitor's `source_id` is
/// threaded through for echo suppression, and live-peer fanout is left
/// unsuppressed (that suppression is per-`source_id`, handled by the commit
/// monitor, not by the engine's importing flag).
pub async fn apply_commit_json(
    store: &Db,
    origin: &str,
    body: &str,
    source_id: Option<String>,
) -> AtomicServerResult<String> {
    let message = ingest_commit_json(
        store,
        body,
        &CommitIngestOpts::hub(source_id, Some(origin.to_string())),
    )
    .await?;

    crate::metrics::commit_applied();

    Ok(message)
}
