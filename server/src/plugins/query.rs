use atomic_lib::{
    collections,
    endpoints::{BoxFuture, Endpoint, HandleGetContext},
    errors::AtomicResult,
    storelike::ResourceResponse,
    urls, Resource,
};

// Note that the actual logic of this endpoint resides in `atomic-server`, as it depends on the Actix runtime.
pub fn query_endpoint() -> Endpoint {
    Endpoint::builder(urls::PATH_QUERY)
        .shortname("query")
        .params([
            urls::COLLECTION_PROPERTY,
            urls::COLLECTION_VALUE,
            urls::COLLECTION_PAGE_SIZE,
            urls::COLLECTION_CURRENT_PAGE,
            urls::COLLECTION_INCLUDE_EXTERNAL,
            urls::COLLECTION_INCLUDE_NESTED,
            urls::COLLECTION_SORT_BY,
            urls::COLLECTION_SORT_DESC,
            "drive",
        ])
        .description("Query the server for resources matching the query filter.")
        .handle(handle_query_request)
        .build()
}

#[tracing::instrument(skip(context))]
fn handle_query_request<'a>(
    context: HandleGetContext<'a>,
) -> BoxFuture<'a, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        let HandleGetContext {
            subject,
            store,
            for_agent,
        } = context;

        if subject.query_pairs().into_iter().next().is_none() {
            return query_endpoint()
                .to_resource_response(store, subject.as_str())
                .await;
        }

        let mut resource = Resource::new(subject.to_string());
        let collection_resource_response = collections::construct_collection_from_params(
            store,
            subject.query_pairs(),
            &mut resource,
            for_agent,
        )
        .await?;

        Ok(collection_resource_response)
    })
}
