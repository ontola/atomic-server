use atomic_lib::{
    endpoints::{BoxFuture, Endpoint, HandleGetContext},
    errors::AtomicResult,
    storelike::ResourceResponse,
    urls,
};

pub fn vector_search_endpoint() -> Endpoint {
    Endpoint {
        path: "/vector_search".to_string(),
        params: vec![
            urls::SEARCH_QUERY.into(), 
            urls::SEARCH_LIMIT.into(),
            "https://atomicdata.dev/properties/search/parents".into(),
            urls::CLASSES.into(),
        ],
        description: "Vector search endpoint powered by PolarisDB and FastEmbed. Supports filtering by parents and isA.".to_string(),
        shortname: "vector-search".to_string(),
        handle: Some(handle_vector_search),
        handle_post: None,
    }
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
            return vector_search_endpoint().to_resource_response(store).await;
        }
        return Err(
            "Vector search endpoint is only available through HTTP requests, not through webhooks"
                .into(),
        );
    })
}
