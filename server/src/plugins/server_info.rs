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
    urls, Db, Resource, Value,
};

/// The node facts that live in AppState rather than in the store.
#[derive(Clone)]
pub struct ServerInfo {
    /// True if this node reports to a control plane. Flipped by the managed-node
    /// wrapper via `serve_with_hook`; the open server is always self-hosted.
    pub managed: Arc<AtomicBool>,
    /// The portal a managed node is administered from, learned from the control plane.
    pub managed_dashboard_url: Arc<RwLock<Option<String>>>,
    /// The Drive served as this server's front page (`ATOMIC_HOME_DRIVE`), if any.
    ///
    /// The browser learns this from the injected HTML rather than from here —
    /// it must know before the first render. This is for every other client:
    /// the desktop app, the SaaS portal, scripts asking "what does `/` show?".
    pub home_drive: Option<String>,
}

pub fn server_info_endpoint(info: ServerInfo) -> Endpoint {
    Endpoint::builder("/server")
        .description(
            "Describes this server node: its version, peer-to-peer node ID, and whether it is managed.",
        )
        .handle(move |context| handle_get(context, info.clone()))
        .build()
}

/// The devices this node syncs with directly, as nested resources.
///
/// A client is not a node: a browser tab cannot see who its server is paired
/// with, and so cannot show the phone that just paired with it. The node knows
/// — it logged the introduction — so it says.
///
/// Both the peers connected right now and the ones this node would dial again.
/// The union matters: a device that dials *us* is never written to the
/// known-peers table (F9 — an unsolicited connection has not earned a
/// permanent reconnect slot), so a phone that just paired appears only in the
/// live list. Listing known peers alone would answer "nobody is here" to the
/// person watching their phone connect.
///
/// Node-local state, not resources in a drive, so it is built per request.
fn peer_resources(store: &Db) -> Vec<atomic_lib::values::SubResource> {
    let live = crate::iroh_transport::live_peer_ids();
    let known = crate::iroh_transport::get_known_peers(store);

    // (node id, name, live, last synced). `last_synced` is already tracked on
    // the stored peer; reporting it is what lets a device card say when it last
    // exchanged anything instead of only whether a socket is open. "Connected"
    // alone cannot distinguish a healthy link from one that has moved nothing.
    let mut seen: Vec<(
        String,
        Option<String>,
        bool,
        Option<i64>,
        Option<u32>,
        Option<u32>,
    )> = Vec::new();

    let stored_for = |id: &str| -> Option<&atomic_lib::sync::peer::KnownPeer> {
        known
            .iter()
            .find(|p| crate::iroh_transport::normalize_node_id(&p.node_id) == id)
    };

    for id in &live {
        let name = crate::iroh_transport::live_peer_name(id).or_else(|| {
            known
                .iter()
                .find(|p| crate::iroh_transport::normalize_node_id(&p.node_id) == *id)
                .map(|p| p.name.clone())
                .filter(|n| !n.is_empty())
        });
        let stored = stored_for(id);
        seen.push((
            id.clone(),
            name,
            true,
            stored.and_then(|p| p.last_synced),
            stored.and_then(|p| p.last_sent),
            stored.and_then(|p| p.last_received),
        ));
    }

    for peer in &known {
        let id = crate::iroh_transport::normalize_node_id(&peer.node_id);

        if seen.iter().any(|(known_id, ..)| known_id == &id) {
            continue;
        }

        let name = Some(peer.name.clone()).filter(|n| !n.is_empty());
        seen.push((
            id,
            name,
            false,
            peer.last_synced,
            peer.last_sent,
            peer.last_received,
        ));
    }

    seen.into_iter()
        .map(
            |(node_id, name, is_live, last_synced, last_sent, last_received)| {
                let mut propvals = atomic_lib::resources::PropVals::new();
                propvals.insert(urls::IS_A.into(), vec![urls::PEER.to_string()].into());
                propvals.insert(
                    urls::PEER_NODE_ID.into(),
                    Value::String(format!("did:ad:node:{node_id}")),
                );

                if let Some(name) = name {
                    propvals.insert(urls::PEER_DEVICE_NAME.into(), Value::String(name));
                }

                propvals.insert(urls::PEER_LIVE.into(), Value::Boolean(is_live));

                if let Some(last_synced) = last_synced {
                    propvals.insert(urls::PEER_LAST_SEEN.into(), Value::Timestamp(last_synced));
                }

                // What the last sync moved, each way. A timestamp plus
                // "Connected" still cannot distinguish a link carrying data
                // from one being refused every subject; these can.
                if let Some(sent) = last_sent {
                    propvals.insert(urls::PEER_LAST_SENT.into(), Value::Integer(sent as i64));
                }

                if let Some(received) = last_received {
                    propvals.insert(
                        urls::PEER_LAST_RECEIVED.into(),
                        Value::Integer(received as i64),
                    );
                }

                atomic_lib::values::SubResource::Nested(propvals)
            },
        )
        .collect()
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

        let peers = peer_resources(context.store);

        if !peers.is_empty() {
            resource.set_unsafe(urls::SERVER_PEERS.into(), Value::ResourceArray(peers))?;
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

        if let Some(home_drive) = info.home_drive.clone() {
            resource.set_unsafe(
                urls::SERVER_HOME_DRIVE.into(),
                Value::AtomicUrl(home_drive.into()),
            )?;
        }

        Ok(resource.into())
    })
}
