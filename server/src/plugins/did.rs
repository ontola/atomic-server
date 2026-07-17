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
            "Resolves a DID (Decentralized Identifier) `did:ad:...` to an Atomic Resource.",
        )
        .form_when_missing(["subject"])
        .handle(handle_did_request)
        .build()
}

#[tracing::instrument]
fn handle_did_request<'a>(
    context: HandleGetContext<'a>,
) -> BoxFuture<'a, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        let HandleGetContext {
            store,
            for_agent,
            subject,
        } = context;

        // `form_when_missing` guarantees a `subject` here.
        let did = subject
            .query_pairs()
            .find(|(k, _)| k == "subject")
            .map(|(_, v)| v.to_string())
            .ok_or("No subject query parameter")?;

        let did_subject = atomic_lib::Subject::from_raw(&did, None);
        store
            .fetch_resource_with_did_fallback(&did_subject, &store.get_server_url(), for_agent)
            .await
    })
}
