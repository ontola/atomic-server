use atomic_lib::{
    endpoints::{BoxFuture, Endpoint, HandlePostContext},
    errors::AtomicResult,
    hierarchy::check_write,
    storelike::ResourceResponse,
    urls, Resource, Storelike, Value,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct BindDriveRequest {
    #[serde(rename = "https://atomicdata.dev/properties/initialDrive")]
    drive: String,
}

pub fn bind_drive_endpoint() -> Endpoint {
    Endpoint {
        path: "/bind-drive".to_string(),
        params: vec![urls::SETUP_RESET.into()],
        description: "Binds the current host to a Drive DID, routing all requests on this domain to that drive.".to_string(),
        shortname: "bind-drive".to_string(),
        handle: None,
        handle_post: Some(handle_bind_drive_request),
    }
}

fn handle_bind_drive_request<'a>(
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

        // ?reset clears the drive mapping for this host. Intended for development use only.
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
        if let Some(current_drive) = store.get_drive_did(host).await? {
            let drive_resource = store.get_resource(&current_drive).await?;
            check_write(store, &drive_resource, for_agent).await.map_err(|_| {
                "This host is already bound to a drive. Only agents with write access to the current drive can rebind it."
            })?;
        }

        let request: BindDriveRequest =
            serde_json::from_slice(&body).map_err(|e| format!("Failed to parse request: {}", e))?;

        // Binding a host to a drive must never be possible for a caller with no
        // relationship to that drive. An unbound host previously had NO check at
        // all here, so an unauthenticated caller could claim a fresh host and
        // point it at any drive DID — including one the legitimate operator can
        // never write to, which would permanently lock them out of re-binding it
        // via this endpoint (rebinding above requires write on the CURRENT drive).
        let target_drive = store
            .get_resource(&request.drive.clone().into())
            .await
            .map_err(|_| format!("Drive not found: {}", request.drive))?;
        check_write(store, &target_drive, for_agent)
            .await
            .map_err(|_| "You need write access to the drive you're binding this host to.")?;

        // The mapping is the routing source of truth: requests on this host now
        // resolve `/` (and drive-relative paths) to the bound drive.
        store.add_drive_mapping(host, &Value::AtomicUrl(request.drive.into()))?;

        Ok(target_drive.into())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use atomic_lib::{agents::ForAgent, Db, Subject};

    fn bind_body(drive: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "https://atomicdata.dev/properties/initialDrive": drive
        }))
        .unwrap()
    }

    async fn call(
        store: &Db,
        url: &str,
        body: Vec<u8>,
        for_agent: &ForAgent,
    ) -> AtomicResult<ResourceResponse> {
        handle_bind_drive_request(HandlePostContext {
            subject: url::Url::parse(url).unwrap(),
            store,
            for_agent,
            body,
        })
        .await
    }

    #[tokio::test]
    async fn binds_host_and_routes_root_to_drive() {
        let store = Db::init_temp("setup_endpoint_bind").await.unwrap();
        let (agent, drive) = store.setup("Setup Tester").await.unwrap();
        let for_agent = ForAgent::AgentSubject(agent.subject.clone());

        // An anonymous caller must not be able to claim an unbound host.
        let denied = call(
            &store,
            "http://example.com/bind-drive",
            bind_body(&drive),
            &ForAgent::Public,
        )
        .await;
        assert!(denied.is_err());
        assert!(store.get_drive_did("example.com").await.unwrap().is_none());

        // An agent with write access on the drive binds the host.
        call(
            &store,
            "http://example.com/bind-drive",
            bind_body(&drive),
            &for_agent,
        )
        .await
        .unwrap();
        let bound = store.get_drive_did("example.com").await.unwrap().unwrap();
        assert_eq!(bound.as_str(), drive);

        // Root on the bound host now resolves to the drive.
        let resolved = store
            .resolve_request_target(
                &Subject::from_raw("/", None),
                "example.com",
                "/",
                "http://example.com",
            )
            .await
            .unwrap();
        assert_eq!(resolved.subject.as_str(), drive);

        // ?reset unbinds the host again.
        call(
            &store,
            "http://example.com/bind-drive?reset=true",
            Vec::new(),
            &for_agent,
        )
        .await
        .unwrap();
        assert!(store.get_drive_did("example.com").await.unwrap().is_none());
    }
}
