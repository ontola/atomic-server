use crate::{
    class_extender::{ClassExtender, GetExtenderContext},
    collections::construct_collection_from_params,
    storelike::ResourceResponse,
    urls,
};

pub fn build_collection_extender() -> ClassExtender {
    ClassExtender {
        class: urls::COLLECTION.to_string(),
        on_resource_get: Some(ClassExtender::wrap_get_handler(|context| {
            Box::pin(async move {
                let GetExtenderContext {
                    store,
                    url,
                    db_resource: resource,
                    for_agent,
                } = context;
                construct_collection_from_params(store, url.query_pairs(), resource, for_agent)
                    .await
            })
        })),
        before_commit: None,
        after_commit: None,
    }
}
