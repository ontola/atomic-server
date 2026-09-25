//! Writing as an app, on behalf of the person using it.
//!
//! An app's view runs in the browser, and in Atomic a commit is signed by
//! whoever's key is in the page — which is the user's. So a write from an
//! app's UI was authored by the person, bounded only by what the host page
//! chose to allow. That is the host being polite, not the server refusing.
//!
//! Here the server performs the write instead, signed by the app's own agent
//! and checked against the app's own rights. The bound stops being advisory,
//! the author is the app, and a click in a tab lands the same way a scheduled
//! run does.
//!
//! Reads are deliberately not routed through here. They stay on the session's
//! store, so an app sees what the person looking at it can see. A write
//! persists and is attributable; a read is already on their screen. Proxying
//! reads would also mean a round trip and no cache for every property an app
//! renders.

use std::collections::HashMap;

use actix_web::{web, HttpResponse};
use atomic_lib::{hierarchy::check_write, Storelike, Subject};
use serde_json::Value as Json;

use crate::{
    appstate::AppState,
    errors::{AtomicServerError, AtomicServerResult},
    helpers::get_client_agent,
    plugins::apply::{ApplyHost, CreateRequest},
    plugins::store_host::StoreApplyHost,
};

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppWriteBody {
    pub drive: String,
    pub app: String,
    /// `create`, `save`, `remove` or `destroy`.
    pub op: String,
    pub subject: Option<String>,
    pub parent: Option<String>,
    #[serde(default)]
    pub is_a: Vec<String>,
    #[serde(default)]
    pub prop_vals: HashMap<String, Json>,
    #[serde(default)]
    pub properties: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWriteResult {
    /// The subject that exists now. Differs from what was asked for on a
    /// create, because a DID drive mints it from the signature.
    pub subject: String,
}

#[tracing::instrument(skip(appstate, body, req))]
pub async fn handle_app_write(
    appstate: web::Data<AppState>,
    body: web::Json<AppWriteBody>,
    req: actix_web::HttpRequest,
    context: crate::context::RequestContext,
) -> AtomicServerResult<HttpResponse> {
    let store = &appstate.store;

    // Write rights on the app, which is what sharing one already means: read
    // to open and look, write to use it to change things. Someone given
    // read-only should not be able to add data through the app's buttons.
    //
    // Two checks have to pass, and they are different questions. This one asks
    // whether this person may use the app to write at all. The app's own
    // rights, checked further down, ask where the app may write — so a person
    // who may write the whole drive still cannot make a buggy app escape its
    // own subtree.
    let app_resource = store.get_resource(&body.app.as_str().into()).await?;

    let path_and_query = req
        .head()
        .uri
        .path_and_query()
        .ok_or("Path must be given")?
        .to_string();
    let signed_subject = Subject::from_raw(&path_and_query, None).resolve(&context.origin);

    let agent = get_client_agent(req.headers(), &appstate, &signed_subject).await?;
    check_write(store, &app_resource, &agent).await?;

    let mut host = StoreApplyHost::for_installation(store, &body.drive, &body.app, agent)
        .await
        .map_err(AtomicServerError::bad_request)?;
    // This endpoint is for a directly installed app, not for borrowing an
    // ancestor's identity or opting into the legacy server signer.
    if host
        .signing_as
        .as_ref()
        .is_none_or(|key| key.app != body.app)
    {
        return Err(AtomicServerError::bad_request(
            "This app has no key of its own; connect an identity before writing",
        ));
    }

    let body = body.into_inner();

    // Outside its own subtree, an app writes only rows of a table it is a
    // view of, and only through the grant someone gave it there (#1740).
    if let Some(subject) = under_row_grant(store, &mut host, &body).await? {
        return Ok(HttpResponse::Ok().json(AppWriteResult { subject }));
    }

    let subject = match body.op.as_str() {
        "create" => {
            host.create(CreateRequest {
                // Defaults to the app: the one place it may always write, so
                // the only sensible default.
                parent: body.parent.unwrap_or_else(|| body.app.clone()),
                is_a: body.is_a,
                prop_vals: body.prop_vals,
            })
            .await
        }
        "save" => {
            let subject = required(body.subject)?;
            host.set(&subject, body.prop_vals).await.map(|_| subject)
        }
        "remove" => {
            let subject = required(body.subject)?;
            host.remove(&subject, body.properties)
                .await
                .map(|_| subject)
        }
        "destroy" => {
            let subject = required(body.subject)?;
            host.destroy(&subject).await.map(|_| subject)
        }
        other => {
            return Err(AtomicServerError::bad_request(format!(
                "An app cannot {other}",
            )))
        }
    }
    .map_err(AtomicServerError::bad_request)?;

    Ok(HttpResponse::Ok().json(AppWriteResult { subject }))
}

/// Performs the write through the app's row grant, when the app's own rights
/// do not reach the target but it is a row of a table the app is a view of.
///
/// `None` means this is not a grant write: the target is within the app's
/// own rights, or not a row of a table showing the app, and the ordinary path
/// decides (and refuses with the rights walk's own error). A table showing
/// the app with no live grant is refused here, saying how to ask for one.
async fn under_row_grant(
    store: &atomic_lib::Db,
    host: &mut StoreApplyHost,
    body: &AppWriteBody,
) -> AtomicServerResult<Option<String>> {
    use crate::plugins::app_row_grant::{self, RowWrite};

    let target = match body.op.as_str() {
        "create" => body.parent.clone().unwrap_or_else(|| body.app.clone()),
        "save" | "remove" | "destroy" => match &body.subject {
            Some(subject) => subject.clone(),
            None => return Ok(None),
        },
        _ => return Ok(None),
    };

    // Within the app's own rights: nothing to grant.
    let Ok(target_resource) = store.get_resource(&target.as_str().into()).await else {
        return Ok(None);
    };
    let app_agent = host
        .signing_as
        .as_ref()
        .and_then(|key| store.get_app_agent_info(key).ok().flatten())
        .map(|info| info.agent);
    let Some(app_agent) = app_agent else {
        return Ok(None);
    };
    if check_write(
        store,
        &target_resource,
        &atomic_lib::agents::ForAgent::AgentSubject(app_agent.as_str().into()),
    )
    .await
    .is_ok()
    {
        return Ok(None);
    }

    // The table: the parent of a new row, or of the row being edited.
    let table = if body.op == "create" {
        target.clone()
    } else {
        match target_resource.get(atomic_lib::urls::PARENT) {
            Ok(parent) => parent.to_string(),
            Err(_) => return Ok(None),
        }
    };

    let Some(grant) = app_row_grant::live(store, &body.drive, &table, &body.app)
        .await
        .map_err(AtomicServerError::bad_request)?
    else {
        if app_row_grant::is_app_view_of(store, &table, &body.app).await {
            return Err(AtomicServerError::bad_request(
                "This app is a view of this table but may not edit its rows. Someone who can edit the table can allow it, or the app can ask with store.requestRowAccess()",
            ));
        }
        return Ok(None);
    };

    let properties: Vec<&str> = match body.op.as_str() {
        "remove" => body.properties.iter().map(String::as_str).collect(),
        _ => body.prop_vals.keys().map(String::as_str).collect(),
    };
    let write = match body.op.as_str() {
        "create" => RowWrite::Create {
            parent: &target,
            is_a: &body.is_a,
            properties,
        },
        "destroy" => RowWrite::Destroy { subject: &target },
        _ => RowWrite::Set {
            subject: &target,
            properties,
        },
    };
    app_row_grant::check_scope(store, &grant, &write)
        .await
        .map_err(AtomicServerError::bad_request)?;

    let subject = match body.op.as_str() {
        "create" => {
            host.create_under_row_grant(CreateRequest {
                parent: target,
                is_a: body.is_a.clone(),
                prop_vals: body.prop_vals.clone(),
            })
            .await
        }
        "remove" => host
            .remove_under_row_grant(&target, body.properties.clone())
            .await
            .map(|_| target),
        _ => host
            .set_under_row_grant(&target, body.prop_vals.clone())
            .await
            .map(|_| target),
    }
    .map_err(AtomicServerError::bad_request)?;

    Ok(Some(subject))
}

fn required(subject: Option<String>) -> AtomicServerResult<String> {
    subject.ok_or_else(|| AtomicServerError::bad_request("That needs a subject"))
}
