//! Endpoint: describes the node you are talking to.
//!
//! This replaces the ad-hoc `/node-info` and `/iroh-node-id` JSON handlers. Those
//! returned bespoke JSON shapes that only our own data-browser could read, and
//! that nothing in the ontology described. A node is a thing worth naming, so it
//! is a [`urls::SERVER`] resource like anything else: self-describing, readable
//! by any Atomic client, and reachable through the normal store.
//!
//! The `managed` / `portalUrl` values are owned by [`crate::appstate::AppState`],
//! so the handler closes over them at registration time.

use std::sync::{atomic::AtomicBool, Arc, RwLock};

use atomic_lib::{
    endpoints::{BoxFuture, Endpoint, HandleGetContext},
    errors::AtomicResult,
    storelike::ResourceResponse,
    urls, Resource, Value,
};

/// The node facts that live in AppState rather than in the store.
#[derive(Clone)]
pub struct ServerInfo {
    /// True if this node reports to a control plane. Flipped by the managed-node
    /// wrapper via `serve_with_hook`; the open server is always self-hosted.
    pub managed: Arc<AtomicBool>,
    /// The portal a managed node is administered from, learned from the control plane.
    pub managed_dashboard_url: Arc<RwLock<Option<String>>>,
}

pub fn server_info_endpoint(info: ServerInfo) -> Endpoint {
    Endpoint::builder("/server")
        .description(
            "Describes this server node: its version, peer-to-peer node ID, and whether it is managed.",
        )
        .handle(move |context| handle_get(context, info.clone()))
        .build()
}

fn handle_get(
    context: HandleGetContext<'_>,
    info: ServerInfo,
) -> BoxFuture<'_, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        let HandleGetContext { subject, .. } = context;

        // `set_unsafe` rather than `set`: the latter validates each value against
        // the Property resource in the store, and a store seeded before these
        // properties existed doesn't have them — so a node would answer "who are
        // you?" with a 500 until someone ran ATOMIC_REPOPULATE_DEFAULTS. The
        // datatypes are known statically here, and this resource is synthesized
        // per request and never committed, so there is nothing to validate against.
        let mut resource = Resource::new(subject.to_string());
        resource.set_unsafe(urls::IS_A.into(), vec![urls::SERVER.to_string()].into())?;
        resource.set_unsafe(
            urls::SERVER_VERSION.into(),
            Value::String(env!("CARGO_PKG_VERSION").into()),
        )?;

        // Absent rather than null: a node with no p2p transport has no node ID.
        if let Some(node_id) = crate::iroh_transport::get_node_id() {
            resource.set_unsafe(
                urls::SERVER_NODE_ID.into(),
                Value::String(format!("did:ad:node:{node_id}")),
            )?;
        }

        let managed = info.managed.load(std::sync::atomic::Ordering::Relaxed);
        resource.set_unsafe(urls::SERVER_MANAGED.into(), Value::Boolean(managed))?;

        let portal_url = info
            .managed_dashboard_url
            .read()
            .ok()
            .and_then(|guard| guard.clone());

        if let Some(portal_url) = portal_url {
            resource.set_unsafe(urls::SERVER_PORTAL_URL.into(), Value::String(portal_url))?;
        }

        Ok(resource.into())
    })
}
