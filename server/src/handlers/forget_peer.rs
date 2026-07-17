use crate::{
    appstate::AppState, context::RequestContext, errors::AtomicServerResult,
    helpers::get_client_agent,
};
use actix_web::{web, HttpRequest, HttpResponse};
use atomic_lib::agents::ForAgent;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct ForgetPeerParams {
    /// The peer's node id, as `did:ad:node:<hex>` or raw hex.
    pub node: String,
}

/// `POST /forget-peer?node=<did:ad:node:...>` — stop syncing with a paired
/// device. A browser tab is not itself a node, so this is how someone reading a
/// server disconnects the phone that paired with it.
///
/// Requires a proven agent identity, but not node-admin: forgetting a peer
/// grants and revokes no data access — per-resource ACL still governs
/// everything the device can read or write — so a valid signature is the right
/// bar. Gating on root-write would lock out the drive owner, who is not
/// necessarily the node's root admin (a phone that pushed its drive here owns
/// that drive, not the server root).
///
/// This drops the live connection and removes the reconnect entry. It does not
/// blocklist: a device that actively dials again will reconnect, because the
/// pairing is mutual and only the other device can forget its side.
#[tracing::instrument(skip_all)]
pub async fn handle_forget_peer(
    appstate: web::Data<AppState>,
    params: web::Query<ForgetPeerParams>,
    req: HttpRequest,
) -> AtomicServerResult<HttpResponse> {
    let store = &appstate.store;
    let origin = RequestContext::new(&req, &appstate).origin;

    // The client signs the full request URL (path + query); rebuild it exactly
    // so the signature check matches what it signed.
    let full_url = format!("{}{}", origin, req.uri());
    let for_agent = get_client_agent(req.headers(), &appstate, &full_url).await?;

    if matches!(for_agent, ForAgent::Public) {
        return Err("Forgetting a device requires a signed-in agent.".into());
    }

    let node = params.node.clone();
    crate::iroh_transport::remove_live_peer(&node);
    crate::iroh_transport::remove_known_peer(store, &node);

    Ok(HttpResponse::Ok().json(serde_json::json!({ "ok": true })))
}
