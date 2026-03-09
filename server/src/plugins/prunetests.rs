use tracing::info;

use atomic_lib::{
    endpoints::{BoxFuture, Endpoint, HandleGetContext, HandlePostContext},
    errors::AtomicResult,
    storelike::{Query, ResourceResponse},
    urls, Resource, Storelike, Value,
};

/// Drives created by `/app/dev-drive` include this in `description`. Keep in sync with
/// `DEV_DRIVE_PRUNE_MARKER` in `browser/data-browser/src/hooks/useDevDrive.ts`.
const PRUNE_DEV_DRIVE_MARKER: &str = "[atomic-data:dev-drive]";

/// E2E `newDrive()` uses names like `testdrive-…`.
const PRUNE_TEST_DRIVE_NAME_SUBSTR: &str = "testdrive-";

fn drive_should_be_pruned(resource: &Resource) -> bool {
    let name = match resource.get(urls::NAME) {
        Ok(Value::String(n)) => n.as_str(),
        _ => "",
    };
    if name.contains(PRUNE_TEST_DRIVE_NAME_SUBSTR) {
        return true;
    }
    match resource.get(urls::DESCRIPTION) {
        Ok(Value::String(d)) => d.contains(PRUNE_DEV_DRIVE_MARKER),
        _ => false,
    }
}

pub fn prune_tests_endpoint() -> Endpoint {
    Endpoint {
        path: urls::PATH_PRUNE_TESTS.into(),
        params: [].into(),
        description: format!(
            "Deletes drives created by dev-drive ({PRUNE_DEV_DRIVE_MARKER} in description) or E2E ({PRUNE_TEST_DRIVE_NAME_SUBSTR} in name)."
        ),
        shortname: "prunetests".to_string(),
        handle: Some(handle_get),
        handle_post: Some(handle_prune_tests_request),
    }
}

pub fn handle_get<'a>(
    context: HandleGetContext<'a>,
) -> BoxFuture<'a, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        prune_tests_endpoint()
            .to_resource_response(context.store, context.subject.as_str())
            .await
    })
}

fn handle_prune_tests_request<'a>(
    context: HandlePostContext<'a>,
) -> BoxFuture<'a, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        let HandlePostContext { store, .. } = context;

        let mut query = Query::new_class(urls::DRIVE);
        query.for_agent = context.for_agent.clone();
        let mut deleted_drives = 0;

        if let Ok(mut query_result) = store.query(&query).await {
            info!(
                "Received prune request, deleting {} drives",
                query_result.resources.len()
            );

            let total_drives = query_result.resources.len();

            for resource in query_result.resources.iter_mut() {
                if drive_should_be_pruned(resource) {
                    resource.destroy(store).await?;
                    deleted_drives += 1;

                    if (deleted_drives % 10) == 0 {
                        info!("Deleted {} of {} drives", deleted_drives, total_drives);
                    }
                }
            }

            info!("Done pruning drives");
        } else {
            info!("Received prune request but there are no drives to prune");
        }

        let resource = build_response(store, 200, format!("Deleted {} drives", deleted_drives))?;
        Ok(ResourceResponse::Resource(resource))
    })
}

fn build_response(store: &impl Storelike, status: i32, message: String) -> AtomicResult<Resource> {
    let mut resource = Resource::new_generate_subject(store)?;
    resource.set_class(urls::ENDPOINT_RESPONSE)?;
    resource.set_unsafe(urls::STATUS.to_string(), status.into())?;
    resource.set_unsafe(urls::RESPONSE_MESSAGE.to_string(), message.into())?;
    Ok(resource)
}
