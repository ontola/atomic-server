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

    // Fallback: if it's a local path like http://localhost/ or https://atomicdata.dev/
    // and it matches the current request's Host, we should also allow it.
    let is_local_path = !is_did && !is_internal && incoming_commit.subject.ends_with('/');

    if !is_internal && !is_did && !matches_base && !is_local_path {
        return Err(
            "Subject of commit should be sent to other domain - this store can not own this resource."
                .into(),
        );
    }
    let signer = incoming_commit.signer.clone();

    let opts = CommitOpts {
        validate_schema: true,
        validate_signature: true,
        validate_timestamp: true,
        validate_rights: true,
        // https://github.com/atomicdata-dev/atomic-server/issues/412
        validate_previous_commit: false,
        validate_for_agent: Some(signer.to_string()),
        update_index: true,
    };

    let host = req
        .headers()
        .get("Host")
        .and_then(|h| h.to_str().ok())
        .map(|h| h.split(':').next().unwrap_or(h))
        .unwrap_or("localhost");

    let _subject = atomic_lib::Subject::from_raw(&incoming_commit.subject, None);

    let signer = incoming_commit.signer.clone();
    let signer_subject = atomic_lib::Subject::from_raw(&signer, None);
    let signer_pure = signer_subject.pure_id();

    // Ensure the agent exists before applying the commit.
    // This is important because the commit might be editing the agent itself.
    if signer_subject.is_agent_did() && store.get_resource(&signer_subject).await.is_err() {
        let mut new_agent =
            atomic_lib::Resource::new_instance(atomic_lib::urls::AGENT, store).await?;
        new_agent.set_subject(signer_pure.clone());
        if let Some(pk) = signer.strip_prefix("did:ad:agent:") {
            new_agent
                .set_string(atomic_lib::urls::PUBLIC_KEY.into(), pk, store)
                .await?;
        }
        new_agent.save_locally(store).await?;
        tracing::info!("Auto-created agent resource for {}", signer_pure);
    }

    let commit_response = store.apply_commit(incoming_commit, &opts).await?;
    crate::metrics::commit_applied();

    let message = commit_response.commit_resource.to_json_ad(Some(&origin))?;

    Ok(builder.content_type("application/ad+json").body(message))
}
