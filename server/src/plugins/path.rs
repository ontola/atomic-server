use atomic_lib::{
    endpoints::{BoxFuture, Endpoint, HandleGetContext},
    errors::AtomicResult,
    storelike::{PathReturn, ResourceResponse},
    urls, Resource, Storelike,
};

pub fn path_endpoint() -> Endpoint {
    Endpoint::builder("/path")
        .params([urls::PATH])
        .description("An Atomic Path is a string that starts with the URL of some Atomic Resource, followed by one or multiple other Property URLs or Property Shortnames. It resolves to one specific Resource or Value. At this moment, Values are not yet supported.")
        .form_when_missing(["path"])
        .handle(handle_path_request)
        .build()
}

#[tracing::instrument]
fn handle_path_request<'a>(
    context: HandleGetContext<'a>,
) -> BoxFuture<'a, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        let HandleGetContext {
            store,
            for_agent,
            subject,
        } = context;
        // `form_when_missing` guarantees a `path` here.
        let path = subject
            .query_pairs()
            .find(|(k, _)| k == "path")
            .map(|(_, v)| v.to_string())
            .ok_or("No path query parameter")?;

        let result = store.get_path(&path, None, for_agent).await?;
        match result {
            PathReturn::Subject(subject) => {
                store
                    .get_resource_extended(&subject.into(), false, for_agent)
                    .await
            }
            PathReturn::Atom(atom) => {
                let mut resource = Resource::new(subject.to_string());
                resource
                    .set_string(urls::ATOM_SUBJECT.into(), atom.subject.as_str(), store)
                    .await?;
                resource
                    .set_string(urls::ATOM_PROPERTY.into(), &atom.property, store)
                    .await?;
                resource
                    .set_string(urls::ATOM_VALUE.into(), &atom.value.to_string(), store)
                    .await?;

                Ok(ResourceResponse::Resource(resource))
            }
        }
    })
}
