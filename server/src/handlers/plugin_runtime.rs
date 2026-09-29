//! `GET /plugin-runtime?installation=<subject>`: this node's runtime agent
//! for an installation, `{ "agent", "publicKey" }`, or `404`.
//!
//! An operator sidecar asks this to learn whether the agent that signed a
//! request ([`crate::plugins::sidecar_auth`]) really is the installation's
//! app agent here. It is unauthenticated on purpose: it only reveals a public
//! key, which every signed request carries anyway, and a sidecar has no
//! credentials of its own to present.

use actix_web::{web, HttpResponse};
use atomic_lib::{urls, Storelike, Value};
use serde::Deserialize;

use crate::{appstate::AppState, errors::AtomicServerResult};

#[derive(Deserialize)]
pub struct RuntimeQuery {
    installation: String,
}

/// The agent the host signs this installation's sidecar requests with: the
/// same one `HostCore::for_run` resolves (`installation::resolve`).
pub async fn agent_of(appstate: &AppState, installation: &str) -> Option<(String, String)> {
    let store = &appstate.store;
    let resource = store.get_resource(&installation.into()).await.ok()?;
    let drive = match resource.get(urls::PARENT).ok()? {
        Value::AtomicUrl(s) => s.to_string(),
        other => other.to_string(),
    };
    let key = crate::plugins::installation::resolve(store, &drive, installation)
        .await
        .ok()?
        .signing_as?;
    store
        .with_app_agent(&key, |agent| {
            (agent.subject.to_string(), agent.public_key.clone())
        })
        .ok()
        .flatten()
}

pub async fn runtime(
    appstate: web::Data<AppState>,
    query: web::Query<RuntimeQuery>,
) -> AtomicServerResult<HttpResponse> {
    Ok(match agent_of(&appstate, &query.installation).await {
        Some((agent, public_key)) => HttpResponse::Ok()
            .insert_header(("cache-control", "no-store"))
            .json(serde_json::json!({ "agent": agent, "publicKey": public_key })),
        None => HttpResponse::NotFound()
            .insert_header(("cache-control", "no-store"))
            .json(serde_json::json!({
                "error": "this node has no runtime agent for that installation"
            })),
    })
}
