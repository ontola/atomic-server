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
            "Resolves an Atomic DID (Decentralized Identifier) `did:ad:...` to an Atomic Resource."
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
        let params = subject.query_pairs();
        let mut did = None;
        for (k, v) in params {
            if let "subject" = k.as_ref() {
                did = Some(v.to_string())
            };
        }
        if did.is_none() {
            return did_endpoint().to_resource_response(store).await;
        }

        let did_subject = atomic_lib::Subject::from_raw(&did.unwrap(), None);
        store
            .get_resource_extended(&did_subject, false, for_agent)
            .await
    })
}
