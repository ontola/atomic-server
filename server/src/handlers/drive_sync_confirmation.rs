use crate::{
    appstate::AppState, errors::AtomicServerResult, helpers::get_client_agent_for_signed_url,
};
use actix_web::{web, HttpRequest, HttpResponse};
use atomic_lib::{sync::confirmation::confirm_drive, Storelike, Subject};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationParams {
    subject: String,
    hash: String,
    hash_version: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfirmationResponse {
    version: u8,
    drive: String,
    hash_version: u8,
    drive_hash: String,
    confirmed: bool,
    checked_blobs: u64,
}

pub async fn handle_drive_sync_confirmation(
    appstate: web::Data<AppState>,
    params: web::Query<ConfirmationParams>,
    req: HttpRequest,
) -> AtomicServerResult<HttpResponse> {
    if params.hash_version != 2
        || params.hash.len() != 64
        || !params
            .hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Ok(HttpResponse::BadRequest()
            .insert_header(("Cache-Control", "no-store"))
            .finish());
    }
    let store = &appstate.store;
    let agent = match get_client_agent_for_signed_url(&req, &appstate).await {
        Ok(agent) => agent,
        Err(_) => {
            return Ok(HttpResponse::Unauthorized()
                .insert_header(("Cache-Control", "no-store"))
                .finish())
        }
    };
    let subject = Subject::from_raw(&params.subject, store.get_base_domain().as_deref());
    if !subject.is_local() {
        return Ok(HttpResponse::NotFound()
            .insert_header(("Cache-Control", "no-store"))
            .finish());
    }
    let normalized = atomic_lib::sync::engine::WireScheme::CANONICAL
        .subject(&store.normalize_subject(&subject).pure_id());
    match confirm_drive(store, &subject, &agent, &params.hash).await {
        Ok((drive_hash, confirmed, checked_blobs)) => Ok(HttpResponse::Ok()
            .insert_header(("Cache-Control", "no-store"))
            .json(ConfirmationResponse {
                version: 1,
                drive: normalized,
                hash_version: 2,
                drive_hash,
                confirmed,
                checked_blobs,
            })),
        // An incomplete inventory, failed storage operation, or concurrent
        // mutation is no receipt. Do not expose internal subjects or errors.
        Err(e) if e.error_type == atomic_lib::errors::AtomicErrorType::UnauthorizedError => {
            Ok(HttpResponse::Unauthorized()
                .insert_header(("Cache-Control", "no-store"))
                .finish())
        }
        Err(_) => Ok(HttpResponse::ServiceUnavailable()
            .insert_header(("Cache-Control", "no-store"))
            .finish()),
    }
}
