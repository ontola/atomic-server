//! `/app-row-grant`: give, take back and look up an app's grant to edit the
//! rows of a table it is a view of (#1740). The rules and the record live in
//! [`crate::plugins::app_row_grant`]; this is the signed HTTP surface.
//!
//! - `GET ?drive&table&app` → `{ grant, history }`: the live grant or `null`,
//!   and every grant this app had on this table. Needs read on the table.
//! - `POST {op: "grant", drive, table, app, view, via}` → the grant. The
//!   request's signer is recorded as `grantedBy`.
//! - `POST {op: "revoke", drive, table, app, via}` → the revoked grant, or
//!   `null` when there was none.

use actix_web::{web, HttpRequest, HttpResponse};
use atomic_lib::{agents::ForAgent, hierarchy::check_read, Storelike, Subject};

use crate::{
    appstate::AppState,
    errors::{AtomicServerError, AtomicServerResult},
    helpers::get_client_agent,
    plugins::app_row_grant::{self, RowGrant, VIA_MENU, VIA_VIEW_KIND_CHANGED, VIA_VIEW_REMOVED},
};

#[derive(serde::Deserialize, Debug)]
pub struct RowGrantQuery {
    pub drive: String,
    pub table: String,
    pub app: String,
}

#[derive(serde::Deserialize, Debug)]
pub struct RowGrantBody {
    /// `grant` or `revoke`.
    pub op: String,
    pub drive: String,
    pub table: String,
    pub app: String,
    /// The View the gesture was made on. Needed to grant.
    pub view: Option<String>,
    /// How: `add-view`, `view-type`, `request` or `menu` to grant; `menu`
    /// (the default) or `view-removed` to revoke.
    pub via: Option<String>,
}

#[derive(serde::Serialize)]
pub struct RowGrantStatus {
    pub grant: Option<RowGrant>,
    pub history: Vec<RowGrant>,
}

async fn signer(
    appstate: &AppState,
    req: &HttpRequest,
    context: &crate::context::RequestContext,
) -> AtomicServerResult<String> {
    let path_and_query = req
        .head()
        .uri
        .path_and_query()
        .ok_or("Path must be given")?
        .to_string();
    let signed_subject = Subject::from_raw(&path_and_query, None).resolve(&context.origin);

    match get_client_agent(req.headers(), appstate, &signed_subject).await? {
        ForAgent::AgentSubject(agent) => Ok(agent.to_string()),
        _ => Err(AtomicServerError {
            message: "Sign in to see or change what an app may edit".into(),
            error_type: crate::errors::AppErrorType::Unauthorized,
            error_resource: None,
        }),
    }
}

#[tracing::instrument(skip(appstate, req))]
pub async fn get_row_grant(
    appstate: web::Data<AppState>,
    query: web::Query<RowGrantQuery>,
    req: HttpRequest,
    context: crate::context::RequestContext,
) -> AtomicServerResult<HttpResponse> {
    let store = &appstate.store;
    let agent = signer(&appstate, &req, &context).await?;
    let table = store.get_resource(&query.table.as_str().into()).await?;
    check_read(
        store,
        &table,
        &ForAgent::AgentSubject(agent.as_str().into()),
    )
    .await?;

    let grant = app_row_grant::live(store, &query.drive, &query.table, &query.app)
        .await
        .map_err(AtomicServerError::bad_request)?;
    let history = app_row_grant::history(store, &query.table, &query.app)
        .map_err(AtomicServerError::bad_request)?;

    Ok(HttpResponse::Ok().json(RowGrantStatus { grant, history }))
}

#[tracing::instrument(skip(appstate, req))]
pub async fn post_row_grant(
    appstate: web::Data<AppState>,
    body: web::Json<RowGrantBody>,
    req: HttpRequest,
    context: crate::context::RequestContext,
) -> AtomicServerResult<HttpResponse> {
    let store = &appstate.store;
    let agent = signer(&appstate, &req, &context).await?;

    match body.op.as_str() {
        "grant" => {
            let view = body
                .view
                .as_deref()
                .ok_or_else(|| AtomicServerError::bad_request("A grant needs its view"))?;
            let via = body
                .via
                .as_deref()
                .ok_or_else(|| AtomicServerError::bad_request("A grant needs its gesture (via)"))?;
            let grant = app_row_grant::grant(
                store,
                &body.drive,
                &body.table,
                &body.app,
                view,
                &agent,
                via,
            )
            .await
            .map_err(AtomicServerError::bad_request)?;
            Ok(HttpResponse::Ok().json(grant))
        }
        "revoke" => {
            let via = body.via.as_deref().unwrap_or(VIA_MENU);
            if ![VIA_MENU, VIA_VIEW_REMOVED, VIA_VIEW_KIND_CHANGED].contains(&via) {
                return Err(AtomicServerError::bad_request(format!(
                    "A grant is revoked from the menu or by removing its view, not by '{via}'"
                )));
            }
            let revoked = app_row_grant::revoke(store, &body.table, &body.app, &agent, via)
                .await
                .map_err(AtomicServerError::bad_request)?;
            Ok(HttpResponse::Ok().json(revoked))
        }
        other => Err(AtomicServerError::bad_request(format!(
            "An app row grant cannot {other}"
        ))),
    }
}
