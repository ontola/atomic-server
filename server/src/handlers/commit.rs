use crate::{appstate::AppState, db_writer::ApplyCommitMessage, errors::AtomicServerResult};
use actix_web::{web, HttpResponse};
use atomic_lib::{commit::CommitOpts, parse::parse_json_ad_commit_resource, Commit, Storelike};
use tokio::sync::oneshot;

/// Send and process a Commit.
/// Currently only accepts JSON-AD
#[tracing::instrument(skip(appstate))]
pub async fn post_commit(
    appstate: web::Data<AppState>,
    body: String,
) -> AtomicServerResult<HttpResponse> {
    if appstate.config.opts.slow_mode {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let random_number = rng.gen_range(100..1000);
        tokio::time::sleep(tokio::time::Duration::from_millis(random_number)).await;
    }
    let store = &appstate.store;
    let mut builder = HttpResponse::Ok();
    let incoming_commit_resource = parse_json_ad_commit_resource(&body, store)?;
    let incoming_commit = Commit::from_resource(incoming_commit_resource)?;
    if !incoming_commit.subject.contains(
        &store
            .get_self_url()
            .ok_or("Cannot apply commits to this store. No self_url is set.")?,
    ) {
        return Err("Subject of commit should be sent to other domain - this store can not own this resource.".into());
    }
    let opts = CommitOpts {
        validate_schema: true,
        validate_signature: true,
        validate_timestamp: true,
        validate_rights: true,
        // https://github.com/atomicdata-dev/atomic-server/issues/412
        validate_previous_commit: false,
        validate_for_agent: Some(incoming_commit.signer.to_string()),
        update_index: true,
    };
    // Send commit to the single-writer actor and wait for response
    let (tx, rx) = oneshot::channel();
    let actor_message = ApplyCommitMessage {
        commit: incoming_commit,
        opts,
        respond_to: tx,
    };
    
    // Send message to actor and await completion
    appstate.db_writer.send(actor_message).await
        .map_err(|_| "DbWriter actor mailbox is full or closed")?;
    
    // Wait for response from actor
    let commit_response = rx.await
        .map_err(|_| "DbWriter actor dropped response channel")?
        .map_err(|e| format!("Commit failed: {}", e))?;

    let response_body = commit_response.commit_resource.to_json_ad()?;

    Ok(builder.body(response_body))
}
