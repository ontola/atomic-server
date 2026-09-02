//! Endpoint: replicate a drive to another Atomic Server.
//!
//! The *data* moves over the ordinary sync protocol
//! ([`atomic_lib::sync::replicate`]). This endpoint is only the **trigger**:
//! it's how a user says "back this drive up over there".
//!
//! It is not a sync frame, and that is on purpose. Frames are dispatched by one
//! shared handler for both WebSocket clients and Iroh peers, so a "replicate to
//! host X" frame would let any paired device make this server open outbound
//! connections to hosts of its choosing. Nor is it a resource in the drive: a
//! drive's sync set is its root plus every child, so a target stored there would
//! be pushed to the target itself, and the receiving server — running this same
//! code — would read it and replicate onward. The trigger has to live outside
//! the data it acts on.

use atomic_lib::{
    endpoints::{BoxFuture, Endpoint, HandlePostContext},
    errors::AtomicResult,
    hierarchy::check_write,
    storelike::ResourceResponse,
    sync::replicate::{replicate_drive_to_remote, ReplicateAuth},
    urls, Db, ReplicationTarget, Resource, Storelike, Value,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct ReplicateRequest {
    /// The drive to replicate.
    drive: String,
    /// The remote server, as an origin (`https://example.com`) or a WebSocket
    /// URL (`wss://example.com/ws`).
    target: String,
}

pub fn replicate_drive_endpoint() -> Endpoint {
    Endpoint::builder("/replicate-drive")
        .description(
            "Replicates a Drive to another Atomic Server, so it is hosted in both places. \
             Requires write access to the Drive.",
        )
        .handle_post(handle_replicate_request)
        .build()
}

/// Accept either an origin or a full WebSocket URL, and normalise to the `/ws`
/// endpoint the sync protocol lives on.
fn to_ws_url(target: &str) -> AtomicResult<String> {
    let trimmed = target.trim().trim_end_matches('/');

    if trimmed.starts_with("ws://") || trimmed.starts_with("wss://") {
        return Ok(if trimmed.ends_with("/ws") {
            trimmed.to_string()
        } else {
            format!("{trimmed}/ws")
        });
    }

    if let Some(rest) = trimmed.strip_prefix("https://") {
        return Ok(format!("wss://{rest}/ws"));
    }

    if let Some(rest) = trimmed.strip_prefix("http://") {
        return Ok(format!("ws://{rest}/ws"));
    }

    Err(format!("Not a server URL: {target}").into())
}

fn handle_replicate_request<'a>(
    context: HandlePostContext<'a>,
) -> BoxFuture<'a, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        let HandlePostContext {
            store,
            body,
            subject,
            for_agent,
        } = context;

        let request: ReplicateRequest =
            serde_json::from_slice(&body).map_err(|e| format!("Failed to parse request: {e}"))?;
        let ws_url = to_ws_url(&request.target)?;

        // Saying where a drive is replicated is a write-level decision about
        // that drive, so it takes write rights on it — the same check that
        // guards any other change to the drive.
        let drive_resource = store
            .get_resource(&request.drive.clone().into())
            .await
            .map_err(|_| format!("Drive not found: {}", request.drive))?;
        check_write(store, &drive_resource, for_agent)
            .await
            .map_err(|_| "You need write access to the drive you're replicating.")?;

        let authorized_by = match for_agent {
            atomic_lib::agents::ForAgent::AgentSubject(s) => s.to_string(),
            _ => return Err("Replication must be requested by a signed-in agent.".into()),
        };

        store.add_replication_target(
            &request.drive,
            &ReplicationTarget {
                url: ws_url.clone(),
                authorized_by,
            },
        )?;

        let outcome = run_replication(store, &request.drive, &ws_url, for_agent).await?;

        // `in_sync` is the only honest success signal. The receiver acks a push
        // it silently discarded for lack of rights just the same as one it kept,
        // so a failure here usually means this server's agent isn't authorized
        // on the drive at the remote.
        if !outcome.in_sync {
            return Err(format!(
                "Pushed {} resources to {ws_url}, but it did not accept them — \
                 this server's agent is likely not authorized on the drive there.",
                outcome.pushed
            )
            .into());
        }

        let mut result = Resource::new(subject.to_string());
        result.set_unsafe(
            urls::DESCRIPTION.into(),
            Value::String(format!(
                "Replicated {} resources and {} blobs to {ws_url}.",
                outcome.pushed, outcome.blobs_served
            )),
        )?;

        Ok(result.into())
    })
}

/// Push the drive, under this server's own identity, exporting only what
/// `export_as` may read.
///
/// The server signs as itself rather than as the user because it does not hold
/// the user's private key — and must not. A drive created on this server already
/// lists this server's agent as a writer, which is what the remote checks on
/// import.
async fn run_replication(
    store: &Db,
    drive: &str,
    ws_url: &str,
    export_as: &atomic_lib::agents::ForAgent,
) -> AtomicResult<atomic_lib::sync::replicate::ReplicateOutcome> {
    let agent = store.get_default_agent()?;

    replicate_drive_to_remote(
        store,
        drive,
        ws_url,
        export_as,
        ReplicateAuth::Agent(Box::new(agent)),
    )
    .await
}

/// Re-push every drive that has a replication target, once, at startup.
///
/// This is what makes the feature declarative rather than a one-shot command: a
/// target survives a restart, and anything committed while the remote was
/// unreachable catches up on boot. Failures are logged, never fatal — a hosted
/// backup being down must not stop the server.
pub async fn reconcile_replication_targets(store: &Db) {
    let drives = match store.get_all_replication_targets() {
        Ok(drives) => drives,
        Err(e) => {
            tracing::warn!("[replicate] could not read replication targets: {e}");

            return;
        }
    };

    for (drive, targets) in drives {
        for target in targets {
            let export_as =
                atomic_lib::agents::ForAgent::AgentSubject(target.authorized_by.as_str().into());

            match run_replication(store, &drive, &target.url, &export_as).await {
                Ok(outcome) if outcome.in_sync => tracing::info!(
                    "[replicate] {drive} is in sync with {} ({} pushed)",
                    target.url,
                    outcome.pushed
                ),
                Ok(_) => tracing::warn!("[replicate] {drive} was not accepted by {}", target.url),
                Err(e) => {
                    tracing::warn!("[replicate] could not reach {}: {e}", target.url)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use atomic_lib::agents::ForAgent;

    fn body(drive: &str, target: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "drive": drive, "target": target })).unwrap()
    }

    async fn call(
        store: &Db,
        body: Vec<u8>,
        for_agent: &ForAgent,
    ) -> AtomicResult<ResourceResponse> {
        handle_replicate_request(HandlePostContext {
            subject: url::Url::parse("http://example.com/replicate-drive").unwrap(),
            store,
            for_agent,
            body,
        })
        .await
    }

    #[test]
    fn normalises_a_target_to_the_sync_endpoint() {
        assert_eq!(to_ws_url("https://a.com").unwrap(), "wss://a.com/ws");
        assert_eq!(
            to_ws_url("http://localhost:9883").unwrap(),
            "ws://localhost:9883/ws"
        );
        assert_eq!(
            to_ws_url("http://localhost:9883/").unwrap(),
            "ws://localhost:9883/ws"
        );
        assert_eq!(to_ws_url("wss://a.com/ws").unwrap(), "wss://a.com/ws");
        assert!(to_ws_url("a.com").is_err());
    }

    /// Choosing where a drive is copied to is a decision about that drive, so it
    /// takes write rights on it. Without this, anyone who can reach the server
    /// could name a host and have the drive shipped there.
    #[tokio::test]
    async fn refuses_a_caller_without_write_access_to_the_drive() {
        let store = Db::init_temp("replicate_endpoint_acl").await.unwrap();
        let (agent, drive) = store.setup("Alice").await.unwrap();

        // Lock the drive down to Alice, so "public" is genuinely not a writer.
        let mut drive_resource = store.get_resource(&drive.as_str().into()).await.unwrap();
        drive_resource.ensure_materialized().unwrap();
        drive_resource
            .set_unsafe(
                urls::WRITE.into(),
                Value::ResourceArray(vec![agent.subject.to_string().into()]),
            )
            .unwrap();
        drive_resource.save_locally(&store).await.unwrap();

        let denied = call(
            &store,
            body(&drive, "https://evil.example.com"),
            &ForAgent::Public,
        )
        .await;

        assert!(
            denied.is_err(),
            "an outsider must not be able to replicate the drive"
        );
        assert!(
            store.get_replication_targets(&drive).unwrap().is_empty(),
            "a refused request must not leave a target behind"
        );
    }

    /// The target is server-local config, not drive data — the whole reason this
    /// is an endpoint. It must never appear inside the drive it describes, or it
    /// would be replicated to the target, which would then act on it.
    #[tokio::test]
    async fn the_target_is_not_stored_in_the_drive() {
        let store = Db::init_temp("replicate_endpoint_local").await.unwrap();
        let (agent, drive) = store.setup("Alice").await.unwrap();

        store
            .add_replication_target(
                &drive,
                &ReplicationTarget {
                    url: "wss://backup.example.com/ws".into(),
                    authorized_by: agent.subject.to_string(),
                },
            )
            .unwrap();

        let targets = store.get_replication_targets(&drive).unwrap();
        assert_eq!(targets.len(), 1);

        // The drive's sync set is exactly what would be pushed to the target.
        let subjects =
            atomic_lib::sync::engine::collect_drive_subjects(&store, &drive.as_str().into()).await;

        for subject in &subjects {
            let resource = store.get_resource(&subject.as_str().into()).await.unwrap();
            let as_json = resource.to_json_ad(None).unwrap_or_default();
            assert!(
                !as_json.contains("backup.example.com"),
                "the replication target leaked into {subject}, which gets pushed to it"
            );
        }
    }
}
