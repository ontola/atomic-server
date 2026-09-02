use atomic_lib::{
    endpoints::{BoxFuture, Endpoint, HandleGetContext},
    errors::AtomicResult,
    storelike::ResourceResponse,
    urls,
};

// Note that the actual logic of this endpoint resides in `atomic-server`, as it depends on the Actix runtime.
pub fn search_endpoint() -> Endpoint {
    Endpoint::builder("/search")
        .params([urls::SEARCH_QUERY, urls::SEARCH_LIMIT, urls::SEARCH_PROPERTY])
        .description("Full text-search endpoint. You can use the keyword `AND` and `OR`, or use `\"` for advanced searches. ")
        .handle(handle_search)
        .build()
}

#[tracing::instrument(skip(context))]
fn handle_search<'a>(
    context: HandleGetContext<'a>,
) -> BoxFuture<'a, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        let HandleGetContext {
            subject,
            store,
            for_agent: _for_agent,
        } = context;
        let params = subject.query_pairs();
        if params.into_iter().next().is_none() {
            return search_endpoint()
                .to_resource_response(store, subject.as_str())
                .await;
        }
        Err("Search endpoint is only available through HTTP requests, not through webhooks".into())
    })
}
