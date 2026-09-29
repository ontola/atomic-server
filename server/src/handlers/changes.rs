//! `GET /changes?table=<subject>&since=<cursor>&limit=<n>` — rows of a table
//! changed since a cursor, including rows that left it (#1850). See
//! `atomic_lib::change_log` for what a table and a row are, the cursor and
//! retention.
//!
//! Answers `{changes: [{subject, kind, version, at}], cursor, hasMore}`.
//! Refusals the client acts on carry a stable `error` code:
//! `410 CURSOR_EXPIRED` (resync without `since`), `400 INVALID_CURSOR`,
//! `400 NOT_A_TABLE`. Rights failures are the usual 401/404, and never name
//! a row.

use crate::{
    appstate::AppState, context::RequestContext, errors::AtomicServerResult,
    helpers::get_client_agent,
};
use actix_web::{web, HttpRequest, HttpResponse};
use atomic_lib::change_log::{self, ChangeListError};
use atomic_lib::Subject;
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Deserialize)]
pub struct ChangesParams {
    pub table: String,
    pub since: Option<String>,
    pub limit: Option<usize>,
}

#[tracing::instrument(skip_all)]
pub async fn handle_changes(
    appstate: web::Data<AppState>,
    params: web::Query<ChangesParams>,
    req: HttpRequest,
) -> AtomicServerResult<HttpResponse> {
    let store = &appstate.store;
    let origin = RequestContext::new(&req, &appstate).origin;
    // The client signs the full request URL (path + query).
    let full_url = format!("{}{}", origin, req.uri());
    let for_agent = get_client_agent(req.headers(), &appstate, &full_url).await?;

    let table = Subject::from(params.table.as_str());
    let since = params.since.as_deref().filter(|s| !s.is_empty());
    match change_log::table_changes(store, &table, since, params.limit, &for_agent).await {
        Ok(mut page) => {
            for change in page.changes.iter_mut() {
                change.subject = Subject::from(change.subject.as_str()).resolve(&origin);
            }
            Ok(HttpResponse::Ok().json(page))
        }
        Err(ChangeListError::Atomic(e)) => Err(e.into()),
        Err(e) => {
            let body = json!({ "error": e.code(), "message": e.to_string() });
            Ok(match e {
                ChangeListError::CursorExpired => HttpResponse::Gone().json(body),
                _ => HttpResponse::BadRequest().json(body),
            })
        }
    }
}
