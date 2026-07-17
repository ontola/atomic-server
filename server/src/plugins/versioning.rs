//! Versioning endpoints: a resource's history, and any past version of it.
//!
//! Both read the resource's Loro oplog (see [atomic_lib::history]). They used to
//! replay the Commit log instead, from before the move to Loro: every edit is
//! already a change in the document, so there is nothing to replay and no
//! separate log to keep consistent with the state it describes.
//!
//! A version is addressed as `/version?subject=<subject>&version-id=<id>`, with
//! ids handed out by `/all-versions?subject=<subject>`. The id is opaque —
//! encoded Loro Frontiers — so it is not something clients construct themselves.

use atomic_lib::{
    agents::ForAgent,
    collections::Collection,
    endpoints::{BoxFuture, Endpoint, HandleGetContext},
    errors::AtomicResult,
    history,
    storelike::ResourceResponse,
    urls, Db, Resource, Storelike,
};

const SUBJECT_KEY: &str = "subject";
const VERSION_ID_KEY: &str = "version-id";
const CURRENT_PAGE_KEY: &str = "current-page";
const PAGE_SIZE: usize = 30;

pub fn version_endpoint() -> Endpoint {
    Endpoint::builder("/version")
        .shortname("versions")
        .params([urls::SUBJECT, urls::VERSION_ID])
        .description(
            "Returns a resource as it was at one version of its history. \
             Version ids come from the `all-versions` endpoint.",
        )
        .form_when_missing([SUBJECT_KEY, VERSION_ID_KEY])
        .handle(handle_version_request)
        .build()
}

pub fn all_versions_endpoint() -> Endpoint {
    Endpoint::builder("/all-versions")
        .params([urls::SUBJECT, urls::COLLECTION_CURRENT_PAGE])
        .description("Lists every version of a resource, newest first.")
        .form_when_missing([SUBJECT_KEY])
        .handle(handle_all_versions_request)
        .build()
}

fn query_param(url: &url::Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.to_string())
}

/// The resource whose history is being asked about, if the agent may read it.
async fn readable_resource(
    subject: &str,
    store: &Db,
    for_agent: &ForAgent,
) -> AtomicResult<Resource> {
    let resource = store.get_resource(&subject.into()).await?;
    atomic_lib::hierarchy::check_read(store, &resource, for_agent).await?;

    Ok(resource)
}

fn version_url(store: &Db, target: &str, id: &history::VersionID) -> AtomicResult<String> {
    let base = store.get_base_domain().ok_or("No base domain set")?;
    let mut url = url::Url::parse(&format!("{base}/version"))?;
    url.query_pairs_mut()
        .append_pair(SUBJECT_KEY, target)
        .append_pair(VERSION_ID_KEY, &history::encode_version_id(id));

    Ok(url.to_string())
}

fn handle_version_request<'a>(
    context: HandleGetContext<'a>,
) -> BoxFuture<'a, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        let HandleGetContext {
            store,
            for_agent,
            subject,
        } = context;

        // `form_when_missing` guarantees both keys here.
        let target = query_param(&subject, SUBJECT_KEY).ok_or("No subject query parameter")?;
        let version_id =
            query_param(&subject, VERSION_ID_KEY).ok_or("No version-id query parameter")?;

        let resource = readable_resource(&target, store, for_agent).await?;
        let version_id = history::decode_version_id(&version_id)?;
        let mut version = history::at_version(&resource, &version_id)?;
        // Addressed by its version URL, so it does not masquerade as the live resource.
        version.set_subject(subject.to_string());

        Ok(ResourceResponse::Resource(version))
    })
}

fn handle_all_versions_request<'a>(
    context: HandleGetContext<'a>,
) -> BoxFuture<'a, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        let HandleGetContext {
            store,
            for_agent,
            subject,
        } = context;

        // `form_when_missing` guarantees a `subject` here.
        let target = query_param(&subject, SUBJECT_KEY).ok_or("No subject query parameter")?;
        let resource = readable_resource(&target, store, for_agent).await?;

        let versions = history::versions(&resource)?;
        let total_items = versions.len();
        let total_pages = total_items.div_ceil(PAGE_SIZE);
        let current_page = query_param(&subject, CURRENT_PAGE_KEY)
            .and_then(|p| p.parse::<usize>().ok())
            .unwrap_or(0);

        let members = versions
            .iter()
            .skip(current_page * PAGE_SIZE)
            .take(PAGE_SIZE)
            .map(|version| version_url(store, &target, &version.id))
            .collect::<AtomicResult<Vec<String>>>()?;

        let collection = Collection {
            subject: subject.to_string(),
            property: None,
            value: None,
            members,
            referenced_resources: None,
            sort_by: None,
            sort_desc: false,
            page_size: PAGE_SIZE,
            current_page,
            total_items,
            total_pages,
            name: Some(format!("Versions of {target}")),
            include_nested: false,
            include_external: false,
        };

        collection.to_resource(store).await
    })
}
