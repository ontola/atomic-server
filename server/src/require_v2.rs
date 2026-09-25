//! State-changing endpoints that accept only a version 2 request signature,
//! each proof once (#1700, piece 6 and answer 7).
//!
//! A version 1 signature covers `"{url} {timestamp}"` and nothing else, and a
//! session cookie is a reusable v1 proof: whoever captures either can send a
//! different body to the same URL for five minutes. On the routes wrapped with
//! [`require_v2`], a write goes through only with `x-atomic-signature-version:
//! 2` over its method, full URL and the exact body bytes, and only the first
//! time: [`crate::replay_cache`] refuses the same signature again.
//!
//! Reading the body here, before any handler, is what makes the hash match
//! what is parsed: the middleware hashes the bytes it received and gives the
//! handler exactly those bytes back, so a handler keeps its `web::Json`
//! extractor. It sets [`VerifiedAgent`] on the request, which
//! [`crate::helpers::get_client_agent_of`] returns instead of reading the
//! headers again.
//!
//! `GET`, `HEAD` and `OPTIONS` on the same routes pass through unchanged: they
//! do not change state, and a CORS preflight carries no signature.

use actix_web::{
    body::{EitherBody, MessageBody},
    dev::{Payload, ServiceRequest, ServiceResponse},
    http::{header, Method},
    middleware::Next,
    web, HttpMessage,
};
use atomic_lib::{agents::ForAgent, authentication::SIGNATURE_VERSION_HEADER, AtomicError};
use futures::StreamExt;

use crate::{
    appstate::AppState,
    errors::{AppErrorType, AtomicServerError, AtomicServerResult},
    helpers::SignedRequest,
};

/// Why a request without a version 2 signature is refused.
pub const REQUIRES_V2: &str = "This endpoint changes state, so it accepts only a version 2 request signature: send x-atomic-signature-version: 2 with the x-atomic-* headers, signed over the method, the full URL and the body. Version 1 signatures and session cookies are not accepted here.";

/// The agent a version 2 signature on this request proved, set by
/// [`require_v2`] once the signature verified, was fresh and was not a replay.
#[derive(Clone, Debug)]
pub struct VerifiedAgent(pub ForAgent);

/// Refuses a state-changing request that does not carry a fresh, unused
/// version 2 signature over its method, full URL and body.
///
/// A refusal is answered here as an error response rather than returned as an
/// error, so the middleware around it (CORS in particular) still sees a
/// response and a browser can read why.
pub async fn require_v2<B: MessageBody + 'static>(
    mut req: ServiceRequest,
    next: Next<B>,
) -> Result<ServiceResponse<EitherBody<B>>, actix_web::Error> {
    let changes_state = !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if changes_state {
        let Some(appstate) = req.app_data::<web::Data<AppState>>().cloned() else {
            let error = AtomicServerError::from("the server has no state for this request");
            return Ok(req.error_response(error).map_into_right_body());
        };
        // In public mode nobody is authenticated: everyone is the public agent.
        if !appstate.config.opts.public_mode {
            match verify(&mut req, &appstate).await {
                Ok(agent) => {
                    req.extensions_mut().insert(VerifiedAgent(agent));
                }
                Err(error) => return Ok(req.error_response(error).map_into_right_body()),
            }
        }
    }
    next.call(req)
        .await
        .map(ServiceResponse::map_into_left_body)
}

async fn verify(req: &mut ServiceRequest, appstate: &AppState) -> AtomicServerResult<ForAgent> {
    let asks_for_v2 = req
        .headers()
        .get(SIGNATURE_VERSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim() == atomic_lib::authentication::SIGNATURE_VERSION_2);
    if !asks_for_v2 {
        return Err(AtomicError::unauthorized(REQUIRES_V2.into()).into());
    }
    // The signature covers the bytes on the wire, and the handler parses what
    // it is given back; a compressed body would be decompressed in between.
    if req
        .headers()
        .get(header::CONTENT_ENCODING)
        .is_some_and(|v| v.as_bytes() != b"identity")
    {
        return Err(AtomicServerError::bad_request(
            "A request with a version 2 signature is sent without Content-Encoding",
        ));
    }

    let body = read_body(req).await?;
    req.set_payload(Payload::from(body.clone()));

    let origin = crate::context::RequestContext::new(req.request(), appstate).origin;
    let url = format!("{origin}{}", req.uri());
    let signed = SignedRequest {
        method: req.method().as_str(),
        body: &body,
    };
    let auth = crate::helpers::get_auth_headers_for_request(req.headers(), &url, Some(signed))
        .map_err(as_unauthorized)?
        .ok_or_else(|| AtomicServerError::from(AtomicError::unauthorized(REQUIRES_V2.into())))?;
    let signature = atomic_lib::agents::decode_base64(&auth.signature)
        .map_err(|e| as_unauthorized(e.into()))?;
    let timestamp = auth.timestamp;

    let agent = atomic_lib::authentication::get_agent_from_auth_values_and_check(
        Some(auth),
        &appstate.store,
    )
    .await
    .map_err(|e| as_unauthorized(e.into()))?;

    appstate
        .replay_cache
        .record(&signature, timestamp, atomic_lib::utils::now())
        .map_err(|refusal| AtomicServerError {
            message: refusal.to_string(),
            error_type: match refusal {
                crate::replay_cache::Refusal::Replayed => AppErrorType::Unauthorized,
                crate::replay_cache::Refusal::Full => AppErrorType::TooManyRequests,
            },
            error_resource: None,
        })?;
    Ok(agent)
}

/// The whole body, up to what the server accepts at all. The handler still
/// applies its own, usually smaller, limit when it parses it.
async fn read_body(req: &mut ServiceRequest) -> AtomicServerResult<web::Bytes> {
    let mut payload = req.take_payload();
    let mut body = web::BytesMut::new();
    while let Some(chunk) = payload.next().await {
        let chunk = chunk.map_err(|e| {
            AtomicServerError::bad_request(format!("could not read the request body: {e}"))
        })?;
        if body.len() + chunk.len() > crate::serve::PAYLOAD_MAX {
            return Err(AtomicServerError::bad_request(format!(
                "the request body is larger than {} bytes",
                crate::serve::PAYLOAD_MAX
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body.freeze())
}

fn as_unauthorized(error: AtomicServerError) -> AtomicServerError {
    AtomicServerError {
        error_type: AppErrorType::Unauthorized,
        ..error
    }
}
