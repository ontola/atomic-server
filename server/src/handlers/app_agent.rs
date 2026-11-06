//! Handing an app's signing key to the node that will use it.
//!
//! The key is minted in the browser, where the app is created, and posted
//! here once. It is never returned: the only accessor hands it to a closure
//! that signs, and nothing that gives a private key back to a caller can
//! promise where it goes next.
//!
//! Why the node holds it at all: an app that imports at 3am has nobody to ask
//! for a credential, so whatever signs its writes must be openable unattended.
//! At rest it is wrapped with the node key, like every other secret here.

use actix_web::{web, HttpResponse};
use atomic_lib::{
    agents::{Agent, ForAgent},
    db::app_agent::{AppAgent, AppAgentKey, AppAgentState},
    hierarchy::check_write,
    Storelike,
};

use crate::{
    appstate::AppState,
    errors::{AtomicServerError, AtomicServerResult},
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAppAgentBody {
    pub drive: String,
    pub app: String,
    /// The agent secret, as `Agent::buildSecret` produces it.
    pub secret: String,
    /// Durable browser handovers may initialize, never replace or revive keys.
    #[serde(default)]
    pub initialize_only: bool,
}

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppAgentQuery {
    pub drive: String,
    pub app: String,
    #[serde(default)]
    pub handover: bool,
}

/// Deliberately not `Debug`: the body holds a private key, and a handler that
/// logs its arguments on error is how secrets reach a log file.
#[tracing::instrument(skip(appstate, raw, req))]
pub async fn handle_set_app_agent(
    appstate: web::Data<AppState>,
    raw: web::Bytes,
    req: actix_web::HttpRequest,
    context: crate::context::RequestContext,
) -> AtomicServerResult<HttpResponse> {
    // Raw bytes rather than `web::Json`: a version 2 request signature covers
    // the SHA-256 of exactly these bytes, which carry a private key.
    let body: SetAppAgentBody = crate::helpers::parse_json(&raw)?;
    // Write rights on the app: giving it an identity is changing what it can
    // do, which is at least as consequential as editing it.
    let agent = authorize(&appstate, &req, &raw, &context, &body.app).await?;

    let ForAgent::AgentSubject(_) = &agent else {
        return Err(AtomicServerError::bad_request(
            "Only a signed-in agent can give an app a key",
        ));
    };

    // Parsed before storing, so a malformed key fails now rather than at 3am
    // in a scheduler with nobody watching.
    let parsed = Agent::from_secret(&body.secret)
        .map_err(|e| AtomicServerError::bad_request(format!("That is not an agent secret: {e}")))?;

    let key = AppAgentKey::new(&body.drive, &body.app);
    let _guard = appstate.store.lock_plugin(&handover_lock(&key)).await;
    if body.initialize_only {
        match appstate.store.get_app_agent_state(&key)? {
            AppAgentState::Legacy => (),
            AppAgentState::Active(info) if info.agent == parsed.subject => {
                appstate.store.flush()?;
                return Ok(HttpResponse::Ok().json(Some(info)));
            }
            _ => {
                return Ok(HttpResponse::Conflict().body(
                    "This app identity was replaced or revoked; its pending handover was cancelled",
                ));
            }
        }
    }
    appstate.store.set_app_agent(
        &key,
        &AppAgent::new(
            parsed.subject.to_string(),
            body.secret.clone(),
            atomic_lib::utils::now(),
        ),
    )?;
    appstate.store.flush()?;

    Ok(HttpResponse::Ok().json(appstate.store.get_app_agent_info(&key)?))
}

/// Which DID an app writes as. Never the key itself.
#[tracing::instrument(skip(appstate, req))]
pub async fn handle_get_app_agent(
    appstate: web::Data<AppState>,
    query: web::Query<AppAgentQuery>,
    req: actix_web::HttpRequest,
    context: crate::context::RequestContext,
) -> AtomicServerResult<HttpResponse> {
    authorize(&appstate, &req, &[], &context, &query.app).await?;

    if query.handover {
        let state = appstate
            .store
            .get_app_agent_state(&AppAgentKey::new(&query.drive, &query.app))?;
        let (state, agent) = match state {
            AppAgentState::Legacy => ("missing", None),
            AppAgentState::Active(info) => ("active", Some(info.agent)),
            AppAgentState::Revoked => ("revoked", None),
        };
        return Ok(HttpResponse::Ok().json(serde_json::json!({
            "handover": "initialize-only-v1", "state": state, "agent": agent
        })));
    }

    Ok(HttpResponse::Ok().json(
        appstate
            .store
            .get_app_agent_info(&AppAgentKey::new(&query.drive, &query.app))?,
    ))
}

/// Erases the signing key and retains a revocation tombstone. The agent
/// resource and ACL entries stay; future runs cannot fall back to server signing.
#[tracing::instrument(skip(appstate, req))]
pub async fn handle_delete_app_agent(
    appstate: web::Data<AppState>,
    query: web::Query<AppAgentQuery>,
    req: actix_web::HttpRequest,
    context: crate::context::RequestContext,
) -> AtomicServerResult<HttpResponse> {
    authorize(&appstate, &req, &[], &context, &query.app).await?;

    let key = AppAgentKey::new(&query.drive, &query.app);
    let _guard = appstate.store.lock_plugin(&handover_lock(&key)).await;

    appstate.store.delete_app_agent(&key)?;

    Ok(HttpResponse::Ok().finish())
}

fn handover_lock(key: &AppAgentKey) -> String {
    // Same namespace for initialization, replacement and revocation, including
    // legacy/canonical spellings of either identifier.
    format!(
        "app-agent:{:?}:{:?}",
        atomic_lib::Subject::from(key.drive.as_str()).pure_id(),
        atomic_lib::Subject::from(key.app.as_str()).pure_id()
    )
}

async fn authorize(
    appstate: &AppState,
    req: &actix_web::HttpRequest,
    body: &[u8],
    context: &crate::context::RequestContext,
    app: &str,
) -> AtomicServerResult<ForAgent> {
    let store = &appstate.store;
    let resource = store.get_resource(&app.into()).await?;

    let agent = crate::helpers::authenticate(req, appstate, context, body).await?;
    check_write(store, &resource, &agent).await?;

    Ok(agent)
}
