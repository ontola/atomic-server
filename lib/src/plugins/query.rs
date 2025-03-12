use crate::{
    endpoints::{Endpoint, HandleGetContext},
    errors::AtomicResult,
    storelike::ResourceResponse,
    urls, Resource,
};

// Note that the actual logic of this endpoint resides in `atomic-server`, as it depends on the Actix runtime.
pub fn query_endpoint() -> Endpoint {
    Endpoint {
        path: urls::PATH_QUERY.into(),
        params: [
            urls::COLLECTION_PROPERTY.to_string(),
            urls::COLLECTION_VALUE.to_string(),
            urls::COLLECTION_PAGE_SIZE.to_string(),
            urls::COLLECTION_CURRENT_PAGE.to_string(),
            urls::COLLECTION_INCLUDE_EXTERNAL.to_string(),
            urls::COLLECTION_INCLUDE_NESTED.to_string(),
            urls::COLLECTION_SORT_BY.to_string(),
            urls::COLLECTION_SORT_DESC.to_string(),
        ]
        .into(),
        description: "Query the server for resources matching the query filter.".to_string(),
        shortname: "query".to_string(),
        handle: Some(handle_query_request),
        handle_post: None,
    }
}

#[tracing::instrument(skip(context))]
fn handle_query_request(context: HandleGetContext) -> AtomicResult<ResourceResponse> {
    let HandleGetContext {
        subject,
        store,
        for_agent,
    } = context;

    if subject.query_pairs().into_iter().next().is_none() {
        return query_endpoint().to_resource_response(store);
    }

    let mut resource = Resource::new(subject.to_string());
    let collection_resource_response = crate::collections::construct_collection_from_params(
        store,
        subject.query_pairs(),
        &mut resource,
        for_agent,
    )?;

    Ok(collection_resource_response)
}
