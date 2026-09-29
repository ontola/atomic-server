//! `/app-after-commit`: what an app's durable `afterCommit` hook is doing on
//! the tables it follows, and the person's answers to it (#1851). The rules
//! and records live in [`crate::plugins::after_commit`].
//!
//! - `GET ?drive&app[&table]` → `{ enabled, declares, subscriptions }`.
//!   `enabled`: the server runs with `--plugin-after-commit`. `declares`: the
//!   app exports `afterCommit`, so adding it as a view makes it follow the
//!   table (the dialog says so). `subscriptions`: the live ones, for one
//!   table or, without `table`, every table the app (or the Installation
//!   named as `app`) follows. Needs read on the app.
//! - `POST {op, drive, table, app}` with `op` one of `apply`, `allow-all`,
//!   `decline` (a waiting proposal) or `retry` (a stopped table). Needs write
//!   on the table.
//!
//! Starting to follow a table is not here: it is part of the row-grant
//! gesture, `POST /app-row-grant` with `op: "grant"` or `op: "follow"`.

use actix_web::{web, HttpRequest, HttpResponse};
use atomic_lib::{agents::ForAgent, hierarchy::check_read, Storelike, Subject};
use serde_json::json;

use crate::{
    appstate::AppState,
    errors::{AtomicServerError, AtomicServerResult},
    helpers::get_client_agent_of,
    plugins::{
        after_commit::{self, Answer},
        app_row_grant::pure,
    },
};

#[derive(serde::Deserialize, Debug)]
pub struct StatusQuery {
    pub drive: String,
    pub app: String,
    pub table: Option<String>,
}

#[derive(serde::Deserialize, Debug)]
pub struct AnswerBody {
    pub op: String,
    pub drive: String,
    pub table: String,
    pub app: String,
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

    match get_client_agent_of(req, appstate, &signed_subject).await? {
        ForAgent::AgentSubject(agent) => Ok(agent.to_string()),
        _ => Err(AtomicServerError {
            message: "Sign in to see what an app does with a table's changes".into(),
            error_type: crate::errors::AppErrorType::Unauthorized,
            error_resource: None,
        }),
    }
}

#[tracing::instrument(skip(appstate, req))]
pub async fn get_status(
    appstate: web::Data<AppState>,
    query: web::Query<StatusQuery>,
    req: HttpRequest,
    context: crate::context::RequestContext,
) -> AtomicServerResult<HttpResponse> {
    let store = &appstate.store;
    let agent = signer(&appstate, &req, &context).await?;
    let app = store.get_resource(&query.app.as_str().into()).await?;
    check_read(store, &app, &ForAgent::AgentSubject(agent.as_str().into())).await?;

    let enabled = store.after_commit_enabled();
    let declares = enabled
        && after_commit::package_of(store, &query.drive, &query.app)
            .await
            .is_ok_and(|p| after_commit::declares_after_commit(&p.manifest));
    let wanted = pure(&query.app);
    let table = query.table.as_deref().map(pure);
    let subscriptions: Vec<serde_json::Value> = after_commit::all(store)
        .map_err(AtomicServerError::bad_request)?
        .into_iter()
        .filter(|s| s.is_live() && pure(&s.drive) == pure(&query.drive))
        .filter(|s| {
            s.app == wanted || s.installation.as_deref().map(pure).as_deref() == Some(&wanted)
        })
        .filter(|s| table.as_ref().is_none_or(|t| &s.table == t))
        .map(|s| after_commit::status_json(store, &s))
        .collect();

    Ok(HttpResponse::Ok().json(json!({
        "enabled": enabled,
        "declares": declares,
        "subscriptions": subscriptions,
    })))
}

#[tracing::instrument(skip(appstate, req))]
pub async fn post_answer(
    appstate: web::Data<AppState>,
    body: web::Json<AnswerBody>,
    req: HttpRequest,
    context: crate::context::RequestContext,
) -> AtomicServerResult<HttpResponse> {
    let store = &appstate.store;
    let agent = signer(&appstate, &req, &context).await?;
    let answer = match body.op.as_str() {
        "apply" => Some(Answer::Apply),
        "allow-all" => Some(Answer::AllowAll),
        "decline" => Some(Answer::Decline),
        "retry" => None,
        other => {
            return Err(AtomicServerError::bad_request(format!(
                "An afterCommit subscription cannot {other}"
            )))
        }
    };
    let sub = match answer {
        Some(answer) => {
            after_commit::review(store, &body.drive, &body.table, &body.app, answer, &agent)
                .await
                .map_err(AtomicServerError::bad_request)?
        }
        None => {
            if !crate::plugins::app_row_grant::may_write(store, &body.table, &agent).await {
                return Err(AtomicServerError::bad_request(
                    "Only someone who can edit this table can retry this",
                ));
            }
            after_commit::retry(store, &body.drive, &body.table, &body.app)
                .map_err(AtomicServerError::bad_request)?
        }
    };
    Ok(HttpResponse::Ok().json(after_commit::status_json(store, &sub)))
}
