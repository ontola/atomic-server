use atomic_lib::{
    endpoints::{BoxFuture, Endpoint, HandleGetContext},
    errors::AtomicResult,
    storelike::ResourceResponse,
    urls, Storelike,
};

pub fn did_endpoint() -> Endpoint {
    Endpoint::builder("/did")
        .params([urls::SUBJECT])
        .description(
            "Alias of `/resource`. Resolves an `atomic:` (or legacy `did:ad:`) identifier.",
        )
        .form_when_missing(["subject"])
        .handle(handle_identifier_request)
        .build()
}

pub fn resource_endpoint() -> Endpoint {
    Endpoint::builder("/resource")
        .params([urls::SUBJECT])
        .description(
            "Resolves an `atomic:` (or legacy `did:ad:`) identifier to an Atomic Resource.",
        )
        .form_when_missing(["subject"])
        .handle(handle_identifier_request)
        .build()
}

pub fn atomic_endpoint() -> Endpoint {
    Endpoint::builder("/atomic")
        .params([urls::SUBJECT])
        .description(
            "Alias of `/resource`. Resolves an `atomic:` (or legacy `did:ad:`) identifier.",
        )
        .form_when_missing(["subject"])
        .handle(handle_identifier_request)
        .build()
}

#[tracing::instrument]
fn handle_identifier_request<'a>(
    context: HandleGetContext<'a>,
) -> BoxFuture<'a, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        let HandleGetContext {
            store,
            for_agent,
            subject,
        } = context;

        // `form_when_missing` guarantees a `subject` here.
        let identifier = subject
            .query_pairs()
            .find(|(k, _)| k == "subject")
            .map(|(_, v)| v.to_string())
            .ok_or("No subject query parameter")?;

        let identifier_subject = atomic_lib::Subject::from_raw(&identifier, None);
        store
            .fetch_resource_with_did_fallback(
                &identifier_subject,
                &store.get_server_url(),
                for_agent,
            )
            .await
    })
}
