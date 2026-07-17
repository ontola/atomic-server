use atomic_lib::{
    endpoints::{BoxFuture, Endpoint, HandleGetContext},
    errors::AtomicResult,
    storelike::ResourceResponse,
    urls,
};

pub fn vector_search_endpoint() -> Endpoint {
    Endpoint::builder("/vector_search")
        .shortname("vector-search")
        .params([
            urls::SEARCH_QUERY,
            urls::SEARCH_LIMIT,
            "https://atomicdata.dev/properties/search/parents",
            urls::CLASSES,
        ])
        .description("Vector search endpoint powered by PolarisDB and FastEmbed. Supports filtering by parents and isA.")
        .handle(handle_vector_search)
        .build()
}

#[tracing::instrument(skip(context))]
fn handle_vector_search<'a>(
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
            return vector_search_endpoint()
                .to_resource_response(store, &subject.to_string())
                .await;
        }
        return Err(
            "Vector search endpoint is only available through HTTP requests, not through webhooks"
                .into(),
        );
    })
}
