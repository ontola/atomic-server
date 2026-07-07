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
    let store = &appstate.store;
    let message = apply_commit_json(store, &context.origin, &body, None).await?;

    Ok(HttpResponse::Ok()
        .content_type("application/ad+json")
        .body(message))
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
        &CommitIngestOpts {
            source_id,
            validate_loro_causality: true,
            enforce_subject_ownership: true,
            suppress_live_echo: false,
            response_origin: Some(origin.to_string()),
        },
    )
    .await?;

    crate::metrics::commit_applied();

    Ok(message)
}
