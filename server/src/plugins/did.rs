use atomic_lib::{
    endpoints::{BoxFuture, Endpoint, HandleGetContext},
    errors::AtomicResult,
    storelike::ResourceResponse,
    urls, Storelike,
};

pub fn did_endpoint() -> Endpoint {
    Endpoint {
        path: "/did".to_string(),
        params: [urls::SUBJECT.to_string()].into(),
        description:
            "Resolves a DID (Decentralized Identifier) `did:ad:...` to an Atomic Resource."
                .to_string(),
        shortname: "did".to_string(),
        handle: Some(handle_did_request),
        handle_post: None,
    }
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
        let mut did = None;
        for (k, v) in subject.query_pairs() {
            if k == "subject" {
                did = Some(v.to_string())
            };
        }
        if did.is_none() {
            return did_endpoint()
                .to_resource_response(store, subject.as_str())
                .await;
        }

        let did_subject = atomic_lib::Subject::from_raw(&did.unwrap(), None);
        store
            .fetch_resource_with_did_fallback(&did_subject, &store.get_server_url(), for_agent)
            .await
    })
}
