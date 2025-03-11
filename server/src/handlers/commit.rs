use crate::{appstate::AppState, errors::AtomicServerResult};
use actix_web::{web, HttpResponse};
use atomic_lib::{commit::CommitOpts, parse::parse_json_ad_commit_resource, Commit, Storelike};

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
    let origin = context.origin.clone();
    let store = &appstate.store;
    let mut builder = HttpResponse::Ok();
    let incoming_commit_resource = parse_json_ad_commit_resource(&body, store).await?;
    let incoming_commit = Commit::from_resource(incoming_commit_resource)?;
    let is_internal = incoming_commit.subject.starts_with("internal:");
    let is_did = incoming_commit.subject.starts_with("did:ad:");
    let matches_base = if let Some(base) = store.get_base_domain() {
        incoming_commit.subject.contains(&base)
    } else {
        false
    };
    if !is_internal && !is_did && !matches_base {
        return Err(
            "Subject of commit should be sent to other domain - this store can not own this resource."
                .into(),
        );
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
    let commit_response = store.apply_commit(incoming_commit, &opts).await?;

    let message = commit_response
        .commit_resource
        .to_json_ad(Some(&origin))?;

    Ok(builder.body(message))
}
