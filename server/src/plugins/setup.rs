use atomic_lib::{
    commit::CommitBuilder,
    endpoints::{BoxFuture, Endpoint, HandlePostContext},
    errors::AtomicResult,
    hierarchy::check_write,
    storelike::ResourceResponse,
    urls, Resource, Storelike,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct BindDriveRequest {
    #[serde(rename = "https://atomicdata.dev/properties/initialDrive")]
    drive: String,
}

pub fn setup_endpoint() -> Endpoint {
    Endpoint {
        path: "/setup".to_string(),
        params: vec![urls::SETUP_RESET.into()],
        description: "Binds the current host to a Drive DID, routing all requests on this domain to that drive. Only works if the host is uninitialized.".to_string(),
        shortname: "setup".to_string(),
        handle: None,
        handle_post: Some(handle_setup_request),
    }
}

fn handle_setup_request<'a>(
    context: HandlePostContext<'a>,
) -> BoxFuture<'a, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        let HandlePostContext {
            store,
            body,
            subject,
            for_agent,
        } = context;

        let host = subject.host_str().unwrap_or("localhost");

        // ?reset clears the drive mapping for this host, restoring the uninitialized state.
        // Intended for development use only.
        let is_reset = subject.query_pairs().any(|(k, _)| k == "reset");

        if is_reset {
            store.remove_drive_mapping(host)?;
            let root = store
                .get_resource(&"internal:/".into())
                .await
                .unwrap_or_else(|_| Resource::new("internal:/".into()));
            return Ok(root.into());
        }

        // If the host is already bound, only allow rebinding if the caller has
        // write rights on the current drive.
        if !store.is_uninitialized_for_host(host).await {
            let current_drive = store
                .get_drive_did(host)
                .await?
                .ok_or("Host is bound but no drive DID found")?;
            let drive_resource = store.get_resource(&current_drive).await?;
            check_write(store, &drive_resource, for_agent).await.map_err(|_| {
                "This host is already bound to a drive. Only agents with write access to the current drive can rebind it."
            })?;
        }

        let request: BindDriveRequest =
            serde_json::from_slice(&body).map_err(|e| format!("Failed to parse request: {}", e))?;

        let server_agent = store.get_default_agent()?;

        // Commit INITIAL_DRIVE on internal:/ — the db layer picks this up and
        // calls add_drive_mapping(host, drive_did).
        let mut builder = CommitBuilder::new("internal:/".into());
        builder.set(
            urls::INITIAL_DRIVE.into(),
            atomic_lib::Value::AtomicUrl(request.drive.into()),
        );

        let root = store
            .get_resource(&"internal:/".into())
            .await
            .unwrap_or_else(|_| Resource::new("internal:/".into()));
        let commit = builder.sign(&server_agent, store, &root).await?;

        let mut opts = atomic_lib::commit::CommitOpts::no_validations_no_index();
        opts.update_index = true;
        store.apply_commit(commit, &opts).await?;

        let root = store.get_resource(&"internal:/".into()).await?;
        Ok(root.into())
    })
}
