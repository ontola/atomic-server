//! Collections are dynamic resources that refer to multiple resources.
//! They are constructed using a [Query]
#[cfg(feature = "db")]
use crate::class_extender::{ClassExtender, GetExtenderContext};
#[cfg(feature = "db")]
use crate::db::drive_prefix_from_subject;
use crate::{
    agents::ForAgent,
    errors::AtomicResult,
    storelike::{Query, ResourceCollection, ResourceResponse},
    urls, Resource, Storelike, Subject, Value,
};

#[cfg(feature = "db")]
pub fn get_collection_class_extender() -> ClassExtender {
    ClassExtender::builder()
        .id("collection".to_string())
        .classes(vec![urls::COLLECTION.to_string()])
        .on_resource_get(ClassExtender::wrap_get_handler(|context| {
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
        }))
        .build()
}

const DEFAULT_PAGE_SIZE: usize = 30;

/// Used to construct a Collection. Does not contain results / members.
/// Has to be constructed using `Collection::new()` or `storelike.new_collection()`.
#[derive(Debug)]
pub struct CollectionBuilder {
    /// Full Subject URL of the resource, including query parameters
    pub subject: String,
    /// The property which the results are to be filtered by
    pub property: Option<String>,
    /// The value which the results are to be filtered by
    pub value: Option<String>,
    /// URL of the value to sort by
    pub sort_by: Option<String>,
    /// Sorts ascending by default
    pub sort_desc: bool,
    /// Current page number, defaults to 0 (first page)
    pub current_page: usize,
    /// How many items per page
    pub page_size: usize,
    /// A human readable name
    pub name: Option<String>,
    /// Whether it's children should be included as nested resources in the response
    pub include_nested: bool,
    /// Whether to include resources from other servers
    pub include_external: bool,
    /// Scope results to a specific drive. When set, the query index is drive-scoped so watched
    /// queries only trigger for resources in this drive.
    pub drive: Option<Subject>,
}

impl CollectionBuilder {
    /// Converts a CollectionBuilder into a Resource.
    /// Note that this does not calculate any members, and it does not generate any pages.
    /// If that is what you need, use `.into_resource`
    pub async fn to_resource(&self, store: &impl Storelike) -> AtomicResult<crate::Resource> {
        let mut resource = store.get_resource_new(&self.subject.as_str().into()).await;
        resource.set_class(urls::COLLECTION);
        if let Some(val) = &self.property {
            resource
                .set_string(crate::urls::COLLECTION_PROPERTY.into(), val, store)
                .await?;
        }
        if let Some(val) = &self.value {
            resource
                .set_string(crate::urls::COLLECTION_VALUE.into(), val, store)
                .await?;
        }
        if let Some(val) = &self.name {
            resource
                .set_string(crate::urls::NAME.into(), val, store)
                .await?;
        }
        if let Some(val) = &self.sort_by {
            resource
                .set_string(crate::urls::COLLECTION_SORT_BY.into(), val, store)
                .await?;
        }
        if self.include_nested {
            resource
                .set_string(crate::urls::COLLECTION_INCLUDE_NESTED.into(), "true", store)
                .await?;
        }
        if self.include_external {
            resource
                .set_string(
                    crate::urls::COLLECTION_INCLUDE_EXTERNAL.into(),
                    "true",
                    store,
                )
                .await?;
        }
        if self.sort_desc {
            resource
                .set_string(crate::urls::COLLECTION_SORT_DESC.into(), "true", store)
                .await?;
        }
        resource
            .set_string(
                crate::urls::COLLECTION_CURRENT_PAGE.into(),
                &self.current_page.to_string(),
                store,
            )
            .await?;
        resource
            .set(
                crate::urls::COLLECTION_PAGE_SIZE.into(),
                self.page_size.into(),
                store,
            )
            .await?;
        // Maybe include items directly
        Ok(resource)
    }

    /// Default CollectionBuilder for Classes. Finds all resources by class URL. Has sensible defaults.
    pub fn class_collection(
        class_url: &str,
        path: &str,
        _store: &impl Storelike,
    ) -> AtomicResult<CollectionBuilder> {
        Ok(CollectionBuilder {
            subject: format!("/{}", path),
            property: Some(urls::IS_A.into()),
            value: Some(class_url.into()),
            sort_by: None,
            sort_desc: false,
            page_size: DEFAULT_PAGE_SIZE,
            current_page: 0,
            name: Some(format!("{} collection", path)),
            include_nested: true,
            include_external: false,
            drive: None,
        })
    }

    /// Converts the CollectionBuilder into a collection, with Members
    pub async fn into_collection(
        self,
        store: &impl Storelike,
        for_agent: &ForAgent,
    ) -> AtomicResult<Collection> {
        Collection::collect_members(store, self, for_agent).await
    }
}

/// Dynamic resource used for ordering, filtering and querying content.
/// Contains members / results. Use CollectionBuilder if you don't (yet) need the results.
/// Features pagination.
#[derive(Debug)]
pub struct Collection {
    /// Full Subject URL of the resource, including query parameters
    pub subject: String,
    /// The property which the results are to be filtered by
    pub property: Option<String>,
    /// The value which the results are to be filtered by
    pub value: Option<String>,
    /// The actual items that you're interested in. List the member subjects of the current page.
    pub members: Vec<String>,
    /// The members as full resources, instead of a list of subjects. Is only populated if `nested` is true.
    pub referenced_resources: Option<Vec<Resource>>,
    /// URL of the value to sort by
    pub sort_by: Option<String>,
    // Sorts ascending by default
    pub sort_desc: bool,
    /// How many items per page
    pub page_size: usize,
    /// Current page number, defaults to 0 (first page)
    pub current_page: usize,
    /// Total number of items
    pub total_items: usize,
    /// Total number of pages
    pub total_pages: usize,
    /// Human readable name of a resource
    pub name: Option<String>,
    /// Whether it's children should be included as nested resources in the response
    pub include_nested: bool,
    /// Include resources from other servers
    pub include_external: bool,
}

/// Sorts a vector or resources by some property.
#[tracing::instrument(skip_all)]
pub fn sort_resources(
    mut resources: ResourceCollection,
    sort_by: &str,
    sort_desc: bool,
) -> ResourceCollection {
    resources.sort_by(|a, b| {
        let val_a = a.get(sort_by);
        let val_b = b.get(sort_by);
        if val_a.is_err() || val_b.is_err() {
            return std::cmp::Ordering::Greater;
        };
        if val_b.unwrap().to_string() > val_a.unwrap().to_string() {
            if sort_desc {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Less
            }
        } else if sort_desc {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });
    resources
}

impl Collection {
    /// Constructs a Collection, which is a paginated list of items with some sorting applied.
    /// Gets the required data from the store.
    /// Applies sorting settings.
    #[tracing::instrument(skip_all)]
    pub async fn collect_members(
        store: &impl Storelike,
        collection_builder: crate::collections::CollectionBuilder,
        for_agent: &ForAgent,
    ) -> AtomicResult<Collection> {
        if collection_builder.page_size < 1 {
            return Err("Page size must be greater than 0".into());
        }

        // Warning: this _assumes_ that the Value is a string.
        // This will work for most datatypes, but not for things like resource arrays!
        // We could improve this by taking the datatype of the `property`, and parsing the string.
        let value_filter = collection_builder
            .value
            .as_ref()
            .map(|val| Value::String(val.clone()));

        let q = Query {
            property: collection_builder.property.clone(),
            value: value_filter,
            limit: Some(collection_builder.page_size),
            start_val: None,
            end_val: None,
            offset: collection_builder.page_size * collection_builder.current_page,
            sort_by: collection_builder.sort_by.clone(),
            sort_desc: collection_builder.sort_desc,
            include_external: collection_builder.include_external,
            include_nested: collection_builder.include_nested,
            for_agent: for_agent.clone(),
            drive: collection_builder.drive.clone(),
        };

        let query_result = store.query(&q).await?;
        let members: Vec<String> = query_result
            .subjects
            .iter()
            .map(|s| s.to_string())
            .collect();
        let referenced_resources = if collection_builder.include_nested {
            Some(query_result.resources)
        } else {
            None
        };
        let total_items = query_result.count;
        let pages_fraction = total_items as f64 / collection_builder.page_size as f64;
        let total_pages = pages_fraction.ceil() as usize;
        if collection_builder.current_page > total_pages {
            return Err(format!(
                "Page number out of bounds, got {}, max {}",
                collection_builder.current_page, total_pages
            )
            .into());
        }

        let collection = Collection {
            total_pages,
            members,
            referenced_resources,
            total_items,
            subject: collection_builder.subject,
            property: collection_builder.property,
            value: collection_builder.value,
            sort_by: collection_builder.sort_by,
            sort_desc: collection_builder.sort_desc,
            current_page: collection_builder.current_page,
            page_size: collection_builder.page_size,
            name: collection_builder.name,
            include_nested: collection_builder.include_nested,
            include_external: collection_builder.include_external,
        };
        Ok(collection)
    }

    pub async fn to_resource(&self, store: &impl Storelike) -> AtomicResult<ResourceResponse> {
        let mut resource = crate::Resource::new(self.subject.clone());
        self.add_to_resource(&mut resource, store).await
    }

    /// Adds the Collection props to an existing Resource.
    pub async fn add_to_resource(
        &self,
        resource: &mut Resource,
        store: &impl Storelike,
    ) -> AtomicResult<ResourceResponse> {
        resource
            .set(
                crate::urls::COLLECTION_MEMBERS.into(),
                self.members.clone().into(),
                store,
            )
            .await?;
        if let Some(prop) = &self.property {
            resource
                .set_string(crate::urls::COLLECTION_PROPERTY.into(), prop, store)
                .await?;
        }
        if self.include_nested {
            resource
                .set_string(crate::urls::COLLECTION_INCLUDE_NESTED.into(), "true", store)
                .await?;
        }
        if self.include_external {
            resource
                .set_string(
                    crate::urls::COLLECTION_INCLUDE_EXTERNAL.into(),
                    "true",
                    store,
                )
                .await?;
        }
        if let Some(val) = &self.value {
            resource
                .set_string(crate::urls::COLLECTION_VALUE.into(), val, store)
                .await?;
        }
        if let Some(val) = &self.name {
            resource
                .set_string(crate::urls::NAME.into(), val, store)
                .await?;
        }
        resource
            .set(
                crate::urls::COLLECTION_MEMBER_COUNT.into(),
                self.total_items.into(),
                store,
            )
            .await?;
        let classes: Vec<String> = vec![crate::urls::COLLECTION.into()];
        resource
            .set(crate::urls::IS_A.into(), classes.into(), store)
            .await?;
        resource
            .set(
                crate::urls::COLLECTION_TOTAL_PAGES.into(),
                self.total_pages.into(),
                store,
            )
            .await?;
        resource
            .set(
                crate::urls::COLLECTION_CURRENT_PAGE.into(),
                self.current_page.into(),
                store,
            )
            .await?;
        resource
            .set(
                crate::urls::COLLECTION_PAGE_SIZE.into(),
                self.page_size.into(),
                store,
            )
            .await?;

        match &self.referenced_resources {
            Some(referenced_resources) => Ok(ResourceResponse::ResourceWithReferenced(
                resource.clone(),
                referenced_resources.clone(),
            )),
            None => Ok(ResourceResponse::Resource(resource.clone())),
        }
    }
}

/// Builds a collection from query params and the passed Collection resource.
/// The query params are used to override the stored Collection resource properties.
/// This also sets defaults for Collection properties when fields are missing
#[cfg(feature = "db")]
#[tracing::instrument(skip_all)]
pub async fn construct_collection_from_params(
    store: &impl Storelike,
    query_params: url::form_urlencoded::Parse<'_>,
    resource: &mut Resource,
    for_agent: &ForAgent,
) -> AtomicResult<ResourceResponse> {
    let mut sort_by = None;
    let mut sort_desc = false;
    let mut current_page = 0;
    let mut page_size = DEFAULT_PAGE_SIZE;
    let mut value = None;
    let mut property = None;
    let mut name = None;
    let mut include_nested = false;
    let mut include_external = false;
    let mut drive: Option<Subject> = None;

    if let Ok(val) = resource.get(urls::COLLECTION_PROPERTY) {
        property = Some(val.to_string());
    }
    if let Ok(val) = resource.get(urls::COLLECTION_PAGE_SIZE) {
        page_size = val.to_int()?.try_into().unwrap_or(DEFAULT_PAGE_SIZE);
    }
    if let Ok(val) = resource.get(urls::COLLECTION_VALUE) {
        value = Some(val.to_string());
    }
    if let Ok(val) = resource.get(urls::NAME) {
        name = Some(val.to_string());
    }
    if let Ok(val) = resource.get(urls::COLLECTION_INCLUDE_NESTED) {
        include_nested = val.to_bool()?;
    }
    if let Ok(val) = resource.get(urls::COLLECTION_INCLUDE_EXTERNAL) {
        include_external = val.to_bool()?;
    }
    for (k, v) in query_params {
        match k.as_ref() {
            "property" => property = Some(v.to_string()),
            "value" => value = Some(v.to_string()),
            "sort_by" => sort_by = Some(v.to_string()),
            "sort_desc" => sort_desc = v.parse::<bool>()?,
            "current_page" => current_page = v.parse::<usize>()?,
            "page_size" => page_size = v.parse::<usize>()?,
            "include_nested" => include_nested = v.parse::<bool>()?,
            "include_external" => include_external = v.parse::<bool>()?,
            "drive" => drive = Some(Subject::from(v.as_ref())),
            e => {
                return Err(format!("Invalid query param: {}", e).into());
            }
        };
    }
    let collection_builder = crate::collections::CollectionBuilder {
        subject: resource.get_subject().to_string(),
        property,
        value,
        sort_by,
        sort_desc,
        current_page,
        page_size,
        name,
        include_nested,
        include_external,
        drive: Some(drive.unwrap_or_else(|| drive_prefix_from_subject(resource.get_subject()))),
    };
    let collection = Collection::collect_members(store, collection_builder, for_agent).await?;
    collection.add_to_resource(resource, store).await
}

/// Creates a Collection resource in the Store for a Class, for example `/documents`.
/// Does not save it, though.
pub async fn create_collection_resource_for_class(
    store: &impl Storelike,
    class_subject: &str,
) -> AtomicResult<Resource> {
    let class = store.get_class(class_subject).await?;

    // Pluralize the shortname
    let pluralized = match class.shortname.as_ref() {
        "class" => "classes".to_string(),
        "property" => "properties".to_string(),
        other => format!("{}s", other),
    };

    let mut collection = CollectionBuilder::class_collection(&class.subject, &pluralized, store)?;

    collection.sort_by = match class_subject {
        urls::COMMIT => Some(urls::CREATED_AT.to_string()),
        urls::CLASS | urls::PROPERTY => Some(urls::SHORTNAME.to_string()),
        urls::COLLECTION => Some(urls::COLLECTION_VALUE.to_string()),
        _other => None,
    };

    collection.sort_desc = match class_subject {
        urls::COMMIT => true,
        _other => false,
    };

    // Agents use DID subjects which are external, so we need to include external resources
    collection.include_external = match class_subject {
        urls::AGENT => true,
        _other => false,
    };

    let mut collection_resource = collection.to_resource(store).await?;

    let drive = "/";

    // Let the Collections collection be the top level item
    let parent = if class.subject == urls::COLLECTION {
        drive.to_string()
    } else if drive == "/" {
        "/collections".to_string()
    } else {
        format!("{}/collections", drive)
    };

    collection_resource
        .set_string(urls::PARENT.into(), &parent, store)
        .await?;

    collection_resource
        .set_string(urls::NAME.into(), &pluralized, store)
        .await?;

    // Should we use save_locally, which creates commits, or add_resource_unsafe, which is faster?
    Ok(collection_resource)
}

#[cfg(test)]
#[cfg(feature = "db")]
mod test {
    use super::*;
    use crate::urls;
    use crate::values::SubResource;
    use crate::Storelike;

    #[tokio::test]
    async fn create_collection() {
        let store = crate::Store::init().await.unwrap();
        store.populate().await.unwrap();
        let collection_builder = CollectionBuilder {
            subject: "test_subject".into(),
            property: Some(urls::IS_A.into()),
            value: Some(urls::CLASS.into()),
            sort_by: None,
            sort_desc: false,
            page_size: DEFAULT_PAGE_SIZE,
            current_page: 0,
            name: Some("Test collection".into()),
            include_nested: false,
            include_external: false,
            drive: None,
        };
        let collection = Collection::collect_members(&store, collection_builder, &ForAgent::Sudo)
            .await
            .unwrap();
        assert!(collection.members.contains(&urls::PROPERTY.into()));
    }

    #[tokio::test]
    async fn create_collection_2() {
        let store = crate::Store::init().await.unwrap();
        store.populate().await.unwrap();
        let collection_builder = CollectionBuilder {
            subject: "test_subject".into(),
            property: Some(urls::IS_A.into()),
            value: Some(urls::CLASS.into()),
            sort_by: None,
            sort_desc: false,
            page_size: DEFAULT_PAGE_SIZE,
            current_page: 0,
            name: None,
            include_nested: false,
            include_external: false,
            drive: None,
        };
        let collection = Collection::collect_members(&store, collection_builder, &ForAgent::Sudo)
            .await
            .unwrap();
        assert!(collection.members.contains(&urls::PROPERTY.into()));

        let resource_collection = &collection.to_resource(&store).await.unwrap().to_single();
        resource_collection
            .get(urls::COLLECTION_INCLUDE_NESTED)
            .unwrap_err();
    }

    #[tokio::test]
    async fn query_on_resource_arrays() {
        let store = crate::db::Db::init_temp("query_on_resource_arrays")
            .await
            .unwrap();
        crate::test_utils::setup_test_env(&store).await.unwrap();

        store.populate().await.unwrap();
        let mut resource1 = Resource::new_instance(urls::TAG, &store).await.unwrap();
        resource1
            .set(urls::SHORTNAME.into(), Value::Slug("tag1".into()), &store)
            .await
            .unwrap();
        resource1
            .push(
                urls::ENDPOINT_RESULTS,
                SubResource::Subject("https://example.com/resource1".into()),
                false,
            )
            .unwrap();

        resource1.save(&store).await.unwrap();

        let collection_builder = CollectionBuilder {
            subject: "test_subject".into(),
            property: Some(urls::ENDPOINT_RESULTS.into()),
            value: Some("https://example.com/resource1".into()),
            sort_by: None,
            sort_desc: false,
            page_size: DEFAULT_PAGE_SIZE,
            current_page: 0,
            name: None,
            include_nested: false,
            include_external: false,
            drive: None,
        };
        let collection = Collection::collect_members(&store, collection_builder, &ForAgent::Sudo)
            .await
            .unwrap();

        assert!(collection
            .members
            .contains(&resource1.get_subject().to_string()));

        resource1
            .set(
                urls::ENDPOINT_RESULTS.into(),
                Value::ResourceArray(vec![SubResource::Subject(
                    "https://example.com/resource3".into(),
                )]),
                &store,
            )
            .await
            .unwrap();

        resource1.save(&store).await.unwrap();

        let collection_builder = CollectionBuilder {
            subject: "test_subject".into(),
            property: Some(urls::ENDPOINT_RESULTS.into()),
            value: Some("https://example.com/resource1".into()),
            sort_by: None,
            sort_desc: false,
            page_size: DEFAULT_PAGE_SIZE,
            current_page: 0,
            name: None,
            include_nested: false,
            include_external: false,
            drive: None,
        };

        let collection = Collection::collect_members(&store, collection_builder, &ForAgent::Sudo)
            .await
            .unwrap();

        assert!(!collection
            .members
            .contains(&resource1.get_subject().to_string()));

        resource1
            .push(
                urls::ENDPOINT_RESULTS,
                SubResource::Subject("https://example.com/resource2".into()),
                false,
            )
            .unwrap();

        resource1.save(&store).await.unwrap();

        let collection_builder = CollectionBuilder {
            subject: "test_subject".into(),
            property: Some(urls::ENDPOINT_RESULTS.into()),
            value: Some("https://example.com/resource2".into()),
            sort_by: None,
            sort_desc: false,
            page_size: DEFAULT_PAGE_SIZE,
            current_page: 0,
            name: None,
            include_nested: false,
            include_external: false,
            drive: None,
        };

        let collection = Collection::collect_members(&store, collection_builder, &ForAgent::Sudo)
            .await
            .unwrap();

        assert!(collection
            .members
            .contains(&resource1.get_subject().to_string()));
    }

    /// Tests that multiple consecutive push operations work correctly with collections.
    /// This specifically tests the scenario where array length changes with each push,
    /// ensuring the query index keys remain consistent.
    #[tokio::test]
    async fn query_on_resource_arrays_multiple_pushes() {
        let store = crate::db::Db::init_temp("query_on_resource_arrays_multiple_pushes")
            .await
            .unwrap();
        crate::test_utils::setup_test_env(&store).await.unwrap();

        store.populate().await.unwrap();
        let mut resource1 = Resource::new_instance(urls::TAG, &store).await.unwrap();
        resource1
            .set(urls::SHORTNAME.into(), Value::Slug("tag1".into()), &store)
            .await
            .unwrap();

        // Push first item
        resource1
            .push(
                urls::ENDPOINT_RESULTS,
                SubResource::Subject("https://example.com/item1".into()),
                false,
            )
            .unwrap();
        resource1.save(&store).await.unwrap();

        // Should find resource when querying for item1
        let collection = Collection::collect_members(
            &store,
            CollectionBuilder {
                subject: "test_subject".into(),
                property: Some(urls::ENDPOINT_RESULTS.into()),
                value: Some("https://example.com/item1".into()),
                sort_by: None,
                sort_desc: false,
                page_size: DEFAULT_PAGE_SIZE,
                current_page: 0,
                name: None,
                include_nested: false,
                include_external: false,
                drive: None,
            },
            &ForAgent::Sudo,
        )
        .await
        .unwrap();
        assert!(
            collection
                .members
                .contains(&resource1.get_subject().to_string()),
            "Should find resource after first push"
        );

        // Push second item (array length changes from 1 to 2)
        resource1
            .push(
                urls::ENDPOINT_RESULTS,
                SubResource::Subject("https://example.com/item2".into()),
                false,
            )
            .unwrap();
        resource1.save(&store).await.unwrap();

        // Should still find resource when querying for item1
        let collection = Collection::collect_members(
            &store,
            CollectionBuilder {
                subject: "test_subject".into(),
                property: Some(urls::ENDPOINT_RESULTS.into()),
                value: Some("https://example.com/item1".into()),
                sort_by: None,
                sort_desc: false,
                page_size: DEFAULT_PAGE_SIZE,
                current_page: 0,
                name: None,
                include_nested: false,
                include_external: false,
                drive: None,
            },
            &ForAgent::Sudo,
        )
        .await
        .unwrap();
        assert!(
            collection
                .members
                .contains(&resource1.get_subject().to_string()),
            "Should still find resource for item1 after second push"
        );

        // Should also find resource when querying for item2
        let collection = Collection::collect_members(
            &store,
            CollectionBuilder {
                subject: "test_subject".into(),
                property: Some(urls::ENDPOINT_RESULTS.into()),
                value: Some("https://example.com/item2".into()),
                sort_by: None,
                sort_desc: false,
                page_size: DEFAULT_PAGE_SIZE,
                current_page: 0,
                name: None,
                include_nested: false,
                include_external: false,
                drive: None,
            },
            &ForAgent::Sudo,
        )
        .await
        .unwrap();
        assert!(
            collection
                .members
                .contains(&resource1.get_subject().to_string()),
            "Should find resource for item2 after second push"
        );

        // Push third item (array length changes from 2 to 3)
        resource1
            .push(
                urls::ENDPOINT_RESULTS,
                SubResource::Subject("https://example.com/item3".into()),
                false,
            )
            .unwrap();
        resource1.save(&store).await.unwrap();

        // Should find resource for all three items
        for item in ["item1", "item2", "item3"] {
            let collection = Collection::collect_members(
                &store,
                CollectionBuilder {
                    subject: "test_subject".into(),
                    property: Some(urls::ENDPOINT_RESULTS.into()),
                    value: Some(format!("https://example.com/{}", item)),
                    sort_by: None,
                    sort_desc: false,
                    page_size: DEFAULT_PAGE_SIZE,
                    current_page: 0,
                    name: None,
                    include_nested: false,
                    include_external: false,
                    drive: None,
                },
                &ForAgent::Sudo,
            )
            .await
            .unwrap();
            assert!(
                collection
                    .members
                    .contains(&resource1.get_subject().to_string()),
                "Should find resource for {} after third push",
                item
            );
        }

        // Now set to replace with completely different items
        resource1
            .set(
                urls::ENDPOINT_RESULTS.into(),
                Value::ResourceArray(vec![SubResource::Subject(
                    "https://example.com/newitem".into(),
                )]),
                &store,
            )
            .await
            .unwrap();
        resource1.save(&store).await.unwrap();

        // Old items should no longer be found
        for item in ["item1", "item2", "item3"] {
            let collection = Collection::collect_members(
                &store,
                CollectionBuilder {
                    subject: "test_subject".into(),
                    property: Some(urls::ENDPOINT_RESULTS.into()),
                    value: Some(format!("https://example.com/{}", item)),
                    sort_by: None,
                    sort_desc: false,
                    page_size: DEFAULT_PAGE_SIZE,
                    current_page: 0,
                    name: None,
                    include_nested: false,
                    include_external: false,
                    drive: None,
                },
                &ForAgent::Sudo,
            )
            .await
            .unwrap();
            assert!(
                !collection
                    .members
                    .contains(&resource1.get_subject().to_string()),
                "Should NOT find resource for {} after set replacement",
                item
            );
        }

        // New item should be found
        let collection = Collection::collect_members(
            &store,
            CollectionBuilder {
                subject: "test_subject".into(),
                property: Some(urls::ENDPOINT_RESULTS.into()),
                value: Some("https://example.com/newitem".into()),
                sort_by: None,
                sort_desc: false,
                page_size: DEFAULT_PAGE_SIZE,
                current_page: 0,
                name: None,
                include_nested: false,
                include_external: false,
                drive: None,
            },
            &ForAgent::Sudo,
        )
        .await
        .unwrap();
        assert!(
            collection
                .members
                .contains(&resource1.get_subject().to_string()),
            "Should find resource for newitem after set"
        );
    }

    #[tokio::test]
    async fn create_collection_nested_members_and_sorting() {
        let store = crate::Store::init().await.unwrap();
        store.populate().await.unwrap();
        let collection_builder = CollectionBuilder {
            subject: "test_subject".into(),
            property: Some(urls::IS_A.into()),
            value: Some(urls::CLASS.into()),
            sort_by: Some(urls::SHORTNAME.into()),
            sort_desc: false,
            page_size: DEFAULT_PAGE_SIZE,
            current_page: 0,
            name: None,
            // The important bit here
            include_nested: true,
            include_external: false,
            drive: None,
        };
        let collection = Collection::collect_members(&store, collection_builder, &ForAgent::Sudo)
            .await
            .unwrap();
        let first_resource = &collection.referenced_resources.clone().unwrap()[0];
        assert!(first_resource.get_subject().as_str().contains("Agent"));

        let resource_collection = &collection.to_resource(&store).await.unwrap().to_single();
        let val = resource_collection
            .get(urls::COLLECTION_INCLUDE_NESTED)
            .unwrap()
            .to_bool()
            .unwrap();
        assert!(val, "Include nested must be true");
    }

    #[tokio::test]
    #[cfg(feature = "db")]
    async fn get_collection() {
        let store = crate::db::test::get_shared_db()
            .await
            .lock()
            .unwrap()
            .clone();
        let collections_collection = store
            .get_resource_extended(&"internal:/collections".into(), false, &ForAgent::Public)
            .await
            .unwrap()
            .to_single();
        assert!(
            collections_collection
                .get(urls::COLLECTION_PROPERTY)
                .unwrap()
                .to_string()
                == urls::IS_A
        );
        let member_count = collections_collection
            .get(urls::COLLECTION_MEMBER_COUNT)
            .unwrap();
        println!("Member Count is {}", member_count);
        assert!(
            member_count.to_int().unwrap() > 10,
            "Member count is too small"
        );
    }

    #[tokio::test]
    #[ignore]
    // TODO: This currently only tests atomicdata.dev, should test local resources. These need to be rewritten
    async fn get_collection_params() {
        let store = crate::Store::init().await.unwrap();
        store.populate().await.unwrap();

        let collection_page_size = store
            .get_resource_extended(
                &"https://atomicdata.dev/classes?page_size=1".into(),
                false,
                &ForAgent::Public,
            )
            .await
            .unwrap()
            .to_single();
        assert!(
            collection_page_size
                .get(urls::COLLECTION_PAGE_SIZE)
                .unwrap()
                .to_string()
                == "1"
        );
        let collection_page_nr = store
            .get_resource_extended(
                &"https://atomicdata.dev/classes?current_page=2&page_size=1".into(),
                false,
                &ForAgent::Public,
            )
            .await
            .unwrap()
            .to_single();
        assert!(
            collection_page_nr
                .get(urls::COLLECTION_PAGE_SIZE)
                .unwrap()
                .to_string()
                == "1"
        );
        let members_vec = match collection_page_nr.get(urls::COLLECTION_MEMBERS).unwrap() {
            crate::Value::ResourceArray(vec) => vec,
            _ => panic!(),
        };
        assert!(members_vec.len() == 1);
        assert!(
            collection_page_nr
                .get(urls::COLLECTION_CURRENT_PAGE)
                .unwrap()
                .to_string()
                == "2"
        );
    }

    #[test]
    fn sorting_resources() {
        let prop = urls::DESCRIPTION.to_string();
        let mut a = Resource::new("first".into());
        a.set_unsafe(prop.clone(), Value::Markdown("1".into()));
        let mut b = Resource::new("second".into());
        b.set_unsafe(prop.clone(), Value::Markdown("2".into()));
        let c = Resource::new("third_missing_property".into());

        let asc = vec![a.clone(), b.clone(), c.clone()];
        let sorted = sort_resources(asc.clone(), &prop, false);
        assert_eq!(a.get_subject(), sorted[0].get_subject());
        assert_eq!(b.get_subject(), sorted[1].get_subject());
        assert_eq!(c.get_subject(), sorted[2].get_subject());

        let sorted_desc = sort_resources(asc, &prop, true);
        assert_eq!(b.get_subject(), sorted_desc[0].get_subject());
        assert_eq!(a.get_subject(), sorted_desc[1].get_subject());
        assert_eq!(
            c.get_subject(),
            sorted_desc[2].get_subject(),
            "c is missing the sorted property - it should _alway_ be last"
        );
    }

    /// Verifies that resources with DID subjects (`did:ad:...`) are correctly indexed and
    /// returned by sorted queries. This simulates the chatroom refresh scenario where messages
    /// have DID subjects but must appear when the chatroom queries by parent + sort by createdAt.
    #[tokio::test]
    async fn did_subject_resource_appears_in_sorted_query() {
        let store = crate::db::Db::init_temp("did_subject_resource_appears_in_sorted_query")
            .await
            .unwrap();
        crate::test_utils::setup_test_env(&store).await.unwrap();
        store.populate().await.unwrap();

        // Create a chatroom-like resource (normal internal subject)
        let mut chatroom = Resource::new_instance(urls::CHATROOM, &store)
            .await
            .unwrap();
        chatroom
            .set(
                urls::NAME.into(),
                crate::Value::String("Test Chat".into()),
                &store,
            )
            .await
            .unwrap();
        store
            .add_resource_opts(&chatroom, false, true, true)
            .await
            .unwrap();
        let chatroom_subject = chatroom.get_subject().clone();

        // First query to register the query as watched (empty chatroom)
        let q = crate::storelike::Query {
            property: Some(urls::PARENT.into()),
            value: Some(crate::Value::AtomicUrl(chatroom_subject.clone())),
            sort_by: Some(urls::CREATED_AT.into()),
            sort_desc: true,
            limit: Some(10),
            include_nested: false,
            include_external: false,
            drive: Some(crate::Subject::from("internal:/")),
            ..Default::default()
        };
        let result = store.query(&q).await.unwrap();
        assert_eq!(result.subjects.len(), 0, "Chatroom should start empty");

        // Create a message with a DID subject (simulating genesis commit result)
        let did_subject = crate::Subject::from("did:ad:TestSignatureHere123");
        let mut message = Resource::new(did_subject.to_string());
        message.set_unsafe(
            urls::PARENT.into(),
            crate::Value::AtomicUrl(chatroom_subject.clone()),
        );
        message.set_unsafe(urls::CREATED_AT.into(), crate::Value::Timestamp(1000000));
        message.set_unsafe(
            urls::IS_A.into(),
            crate::Value::ResourceArray(vec![crate::values::SubResource::Subject(
                urls::MESSAGE.into(),
            )]),
        );

        // Add the DID message to the store with index update (simulating apply_commit)
        store
            .add_resource_opts(&message, false, true, true)
            .await
            .unwrap();

        // Query again - should now find the DID message
        let result = store.query(&q).await.unwrap();
        assert_eq!(
            result.subjects.len(),
            1,
            "DID message should appear in chatroom query after being added"
        );
        assert_eq!(
            result.subjects[0].as_str(),
            "did:ad:TestSignatureHere123",
            "The DID subject should be returned"
        );
    }
}
