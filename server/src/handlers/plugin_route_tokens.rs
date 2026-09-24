//! The host's side of route tokens (#1718): the consent page's API (D6) and
//! listing and revoking an installation's tokens.
//!
//! - `GET /plugin-route-consent?request=<id>`: what a consent request asks
//!   for, to show on `/app/route-consent`.
//! - `POST /plugin-route-consent?request=<id>&decision=approve|deny`: the
//!   answer; returns `{ redirect }`, the route URL with a one-time `code`
//!   (or `error=access_denied`) and the plugin's `state`.
//! - `GET /plugin-route-tokens?installation=<subject>`: the tokens' metadata,
//!   never a token or its hash.
//! - `POST /plugin-route-tokens?installation=<subject>&revoke=<id>`.
//!
//! All four need an agent with write rights on the Installation, signed
//! with Atomic headers. The two `POST`s refuse cookie sessions and carry
//! their arguments in the signed URL, so a signature cannot be reused for
//! another request or another answer.

use actix_web::{http::header, web, HttpRequest, HttpResponse};
use atomic_lib::{agents::ForAgent, hierarchy::check_write, urls, Resource, Storelike, Value};
use serde::Deserialize;
use serde_json::json;

use crate::{
    appstate::AppState,
    context::RequestContext,
    errors::{AppErrorType, AtomicServerError, AtomicServerResult},
    plugins::{manifest::Manifest, route_tokens},
};

fn error(error_type: AppErrorType, message: &str) -> AtomicServerError {
    AtomicServerError {
        message: message.to_string(),
        error_type,
        error_resource: None,
    }
}

/// The signed agent. `headers_only`: a cookie session is not enough.
async fn agent(
    state: &AppState,
    req: &HttpRequest,
    context: &RequestContext,
    headers_only: bool,
) -> AtomicServerResult<ForAgent> {
    if headers_only && !req.headers().contains_key("x-atomic-signature") {
        return Err(error(
            AppErrorType::Unauthorized,
            "Sign this request with Atomic headers; a session cookie is not enough.",
        ));
    }
    let path_and_query = req
        .head()
        .uri
        .path_and_query()
        .ok_or("Path must be given")?
        .to_string();
    let signed_subject =
        atomic_lib::Subject::from_raw(&path_and_query, None).resolve(&context.origin);
    let agent = crate::helpers::get_client_agent(req.headers(), state, &signed_subject).await?;
    if agent == ForAgent::Public {
        return Err(error(AppErrorType::Unauthorized, "Sign in to continue."));
    }
    Ok(agent)
}

/// The Installation `subject` is, or the nearest one above it (an app's
/// entry point names its app).
async fn installation_of(state: &AppState, subject: &str) -> AtomicServerResult<Resource> {
    let mut current = state.store.get_resource(&subject.into()).await?;
    for _ in 0..16 {
        if current.has_class(urls::INSTALLATION) {
            return Ok(current);
        }
        let Ok(parent) = current.get(urls::PARENT) else {
            break;
        };
        current = state
            .store
            .get_resource(&parent.to_string().as_str().into())
            .await?;
    }
    Err(error(
        AppErrorType::NotFound,
        "No Installation found there.",
    ))
}

fn text(resource: &Resource, property: &str) -> Option<String> {
    match resource.get(property).ok()? {
        Value::String(s) | Value::Markdown(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

fn manifest(state: &AppState, installation: &Resource) -> Option<Manifest> {
    let id = text(installation, urls::RELEASE_ID)?;
    let release = state.store.get_plugin_release(&id).ok()?;
    Manifest::parse(release.manifest).ok().flatten()
}

fn no_store(json: serde_json::Value) -> HttpResponse {
    HttpResponse::Ok()
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .json(json)
}

#[derive(Deserialize)]
pub struct ConsentQuery {
    request: String,
    #[serde(default)]
    decision: Option<String>,
}

/// What a consent request asks for.
pub async fn consent(
    state: web::Data<AppState>,
    req: HttpRequest,
    query: web::Query<ConsentQuery>,
    context: RequestContext,
) -> AtomicServerResult<HttpResponse> {
    let agent = agent(&state, &req, &context, false).await?;
    let now = atomic_lib::utils::now();
    let pending = state
        .route_exec
        .consents
        .get(&query.request, now)
        .ok_or_else(|| {
            error(
                AppErrorType::NotFound,
                "This consent request is unknown, answered or expired. Start again from the app.",
            )
        })?;
    let installation = state
        .store
        .get_resource(&pending.installation.as_str().into())
        .await?;
    check_write(&state.store, &installation, &agent).await?;
    let manifest = manifest(&state, &installation);
    let reason = manifest
        .as_ref()
        .and_then(|m| m.http.as_ref())
        .and_then(|h| h.tokens.iter().find(|t| t.name == pending.name))
        .and_then(|t| t.reason.clone());
    let plugin = text(&installation, urls::NAME)
        .or_else(|| manifest.as_ref().and_then(|m| m.name.clone()))
        .unwrap_or_else(|| pending.installation.clone());
    let redirect_origin = url::Url::parse(&pending.redirect)
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_default();
    Ok(no_store(json!({
        "request": query.request,
        "installation": pending.installation,
        "plugin": plugin,
        "drive": text(&installation, urls::PARENT),
        "token": { "name": pending.name, "reason": reason },
        "scopes": pending.scopes,
        "client": pending.client,
        "redirectOrigin": redirect_origin,
        "expiresAt": pending.expires_at,
    })))
}

/// A person's answer to a consent request.
pub async fn decide(
    state: web::Data<AppState>,
    req: HttpRequest,
    query: web::Query<ConsentQuery>,
    context: RequestContext,
) -> AtomicServerResult<HttpResponse> {
    let agent = agent(&state, &req, &context, true).await?;
    let approve = match query.decision.as_deref() {
        Some("approve") => true,
        Some("deny") => false,
        _ => {
            return Err(error(
                AppErrorType::BadRequest,
                "Give `decision=approve` or `decision=deny`.",
            ))
        }
    };
    let now = atomic_lib::utils::now();
    let pending = state
        .route_exec
        .consents
        .get(&query.request, now)
        .ok_or_else(|| {
            error(
                AppErrorType::NotFound,
                "This consent request is unknown, answered or expired. Start again from the app.",
            )
        })?;
    let installation = state
        .store
        .get_resource(&pending.installation.as_str().into())
        .await?;
    check_write(&state.store, &installation, &agent).await?;
    let approved_by = agent.to_string();
    let redirect = state
        .route_exec
        .consents
        .decide(&query.request, approve.then_some(approved_by.as_str()), now)
        .map_err(|e| error(AppErrorType::NotFound, &e))?;
    tracing::info!(
        installation = pending.installation,
        approved = approve,
        agent = %approved_by,
        "plugin route consent answered"
    );
    Ok(no_store(json!({ "redirect": redirect })))
}

#[derive(Deserialize)]
pub struct TokensQuery {
    installation: String,
    #[serde(default)]
    revoke: Option<String>,
}

/// The installation's route tokens: metadata only.
pub async fn tokens(
    state: web::Data<AppState>,
    req: HttpRequest,
    query: web::Query<TokensQuery>,
    context: RequestContext,
) -> AtomicServerResult<HttpResponse> {
    let agent = agent(&state, &req, &context, false).await?;
    let installation = installation_of(&state, &query.installation).await?;
    check_write(&state.store, &installation, &agent).await?;
    let subject = installation.get_subject().to_string();
    Ok(no_store(json!({
        "installation": subject,
        "tokens": route_tokens::list(&state.store, &subject),
    })))
}

/// Revokes one of the installation's route tokens.
pub async fn revoke(
    state: web::Data<AppState>,
    req: HttpRequest,
    query: web::Query<TokensQuery>,
    context: RequestContext,
) -> AtomicServerResult<HttpResponse> {
    let agent = agent(&state, &req, &context, true).await?;
    let id = query
        .revoke
        .as_deref()
        .ok_or_else(|| error(AppErrorType::BadRequest, "Give `revoke=<token id>`."))?;
    let installation = installation_of(&state, &query.installation).await?;
    check_write(&state.store, &installation, &agent).await?;
    let subject = installation.get_subject().to_string();
    let revoked = route_tokens::revoke(&state.store, &subject, id)
        .map_err(|e| error(AppErrorType::BadRequest, &e))?;
    Ok(no_store(json!({ "revoked": revoked })))
}
