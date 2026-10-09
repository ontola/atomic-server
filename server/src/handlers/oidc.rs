//! Optional OIDC sign-in endpoints. See `crate::oidc` and
//! `planning/oidc-sign-in.md`.
//!
//! Every response is `no-store` and sends no referrer. Nothing here logs a
//! token, code, state, ticket or recovery blob: handlers skip their arguments.

use actix_web::{http::header, web, HttpRequest, HttpResponse};
use atomic_lib::agents::decode_base64;
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::Deserialize;
use serde_json::json;

use crate::{
    appstate::AppState,
    errors::{AppErrorType, AtomicServerError, AtomicServerResult},
    oidc::{links, Oidc, COOKIE_NAME},
};

fn oidc(appstate: &AppState) -> AtomicServerResult<&std::sync::Arc<Oidc>> {
    appstate.oidc.as_ref().ok_or_else(|| AtomicServerError {
        message: "OIDC sign-in is not enabled on this server".into(),
        error_type: AppErrorType::NotFound,
        error_resource: None,
    })
}

fn rate_limit(appstate: &AppState, req: &HttpRequest) -> AtomicServerResult<()> {
    appstate
        .write_rate_limiter
        .check(&format!("oidc:{}", crate::helpers::peer_ip(req)), true)
        .map_err(|limited| AtomicServerError {
            message: limited.to_string(),
            error_type: AppErrorType::TooManyRequests,
            error_resource: None,
        })
}

fn hardened(mut b: actix_web::HttpResponseBuilder) -> actix_web::HttpResponseBuilder {
    b.insert_header((header::CACHE_CONTROL, "no-store"));
    b.insert_header((header::REFERRER_POLICY, "no-referrer"));
    b
}

fn redirect(location: &str, cookie: Option<String>) -> HttpResponse {
    let mut b = hardened(HttpResponse::Found());
    b.insert_header((header::LOCATION, location));

    if let Some(c) = cookie {
        b.insert_header((header::SET_COOKIE, c));
    }

    b.finish()
}

#[derive(Deserialize)]
pub struct StartQuery {
    #[serde(rename = "return")]
    return_to: Option<String>,
}

#[tracing::instrument(skip_all)]
pub async fn start(
    appstate: web::Data<AppState>,
    query: web::Query<StartQuery>,
    req: HttpRequest,
) -> AtomicServerResult<HttpResponse> {
    let oidc = oidc(&appstate)?;
    rate_limit(&appstate, &req)?;

    let return_to = crate::oidc::sanitize_return(
        query.return_to.as_deref().unwrap_or("/"),
        &appstate.config.get_origin(),
    );

    match oidc.begin(return_to.clone()).await {
        Ok(begin) => Ok(redirect(
            &begin.location,
            Some(oidc.cookie_header(&begin.binding, false)),
        )),
        Err(f) => Ok(redirect(
            &format!("{return_to}#oidc_error={}", f.code()),
            None,
        )),
    }
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[tracing::instrument(skip_all)]
pub async fn callback(
    appstate: web::Data<AppState>,
    query: web::Query<CallbackQuery>,
    req: HttpRequest,
) -> AtomicServerResult<HttpResponse> {
    let oidc = oidc(&appstate)?;
    rate_limit(&appstate, &req)?;

    let cookie = req.cookie(COOKIE_NAME);
    let finished = oidc
        .finish(
            query.code.as_deref(),
            query.state.as_deref().unwrap_or(""),
            query.error.as_deref(),
            cookie.as_ref().map(|c| c.value()),
        )
        .await;

    let clear = oidc.cookie_header("", true);

    let Some(finished) = finished else {
        // Unknown, replayed or foreign state: no redirect to anywhere.
        let mut b = hardened(HttpResponse::BadRequest());
        b.insert_header((header::SET_COOKIE, clear));

        return Ok(b.body("This sign-in link has expired or was not started in this browser. Go back and try again."));
    };

    let location = match finished.result {
        // The fragment is never sent to any server, proxy or log.
        Ok(ticket) => format!("{}#oidc_ticket={ticket}", finished.return_to),
        Err(f) => format!("{}#oidc_error={}", finished.return_to, f.code()),
    };

    Ok(redirect(&location, Some(clear)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBody {
    ticket: String,
}

/// What the proof says about this identity: whether an agent is linked and,
/// if so, which one and its (still encrypted) recovery blob.
#[tracing::instrument(skip_all)]
pub async fn session(
    appstate: web::Data<AppState>,
    body: web::Json<SessionBody>,
    req: HttpRequest,
) -> AtomicServerResult<HttpResponse> {
    let oidc = oidc(&appstate)?;
    rate_limit(&appstate, &req)?;

    let proof = oidc
        .use_ticket(&body.ticket)
        .ok_or_else(|| AtomicServerError::bad_request("Sign-in expired. Start again."))?;

    let link = links::get(&appstate.store, &proof.issuer, &proof.sub)?;

    Ok(hardened(HttpResponse::Ok()).json(match link {
        Some(l) => json!({
            "linked": true,
            "name": oidc.settings.name,
            "agent": l.agent,
            "recovery": l.recovery,
        }),
        None => json!({ "linked": false, "name": oidc.settings.name }),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkBody {
    ticket: String,
    agent: String,
    /// Ed25519 signature (base64) by `agent` over [`Oidc::link_message`].
    signature: String,
    recovery: String,
    #[serde(default)]
    replace: bool,
}

fn verify_possession(agent: &str, message: &str, signature: &str) -> Result<(), &'static str> {
    let pubkey = atomic_lib::identifiers::agent_public_key(agent)
        .ok_or("agent must be a did:ad:agent: identifier")?;
    let key = decode_base64(pubkey).map_err(|_| "agent public key is not valid base64")?;
    let sig = decode_base64(signature).map_err(|_| "signature is not valid base64")?;

    if key.len() != 32 {
        return Err("agent public key must be 32 bytes");
    }

    UnparsedPublicKey::new(&ED25519, key)
        .verify(message.as_bytes(), &sig)
        .map_err(|_| "signature does not prove possession of the agent key")
}

/// Links an agent to the proven identity. The caller must hold the agent's
/// private key (a signature over the ticket) and brings the already-encrypted
/// recovery blob; this server never sees the key or the passphrase.
#[tracing::instrument(skip_all)]
pub async fn link(
    appstate: web::Data<AppState>,
    body: web::Json<LinkBody>,
    req: HttpRequest,
) -> AtomicServerResult<HttpResponse> {
    let oidc = oidc(&appstate)?;
    rate_limit(&appstate, &req)?;

    if body.recovery.is_empty()
        || body.recovery.len() > links::MAX_RECOVERY_BYTES
        || !body.recovery.is_ascii()
    {
        return Err(AtomicServerError::bad_request(
            "recovery must be a non-empty ASCII string of at most 4096 bytes",
        ));
    }

    let proof = oidc
        .use_ticket(&body.ticket)
        .ok_or_else(|| AtomicServerError::bad_request("Sign-in expired. Start again."))?;

    verify_possession(
        &body.agent,
        &Oidc::link_message(&body.ticket, &body.agent),
        &body.signature,
    )
    .map_err(AtomicServerError::bad_request)?;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let written = links::put(
        &appstate.store,
        &proof.issuer,
        &proof.sub,
        &body.agent,
        &body.recovery,
        body.replace,
        now_ms,
    )?;

    if !written {
        return Ok(hardened(HttpResponse::Conflict()).json(json!({
            "error": "already-linked",
            "message": "This account is already linked to an identity. Recover it, or link again explicitly to replace it.",
        })));
    }

    oidc.consume_ticket(&body.ticket);

    Ok(hardened(HttpResponse::Ok()).json(json!({ "linked": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlinkBody {
    ticket: String,
}

/// Removes the link. Needs a fresh sign-in (a ticket), not a stored session.
#[tracing::instrument(skip_all)]
pub async fn unlink(
    appstate: web::Data<AppState>,
    body: web::Json<UnlinkBody>,
    req: HttpRequest,
) -> AtomicServerResult<HttpResponse> {
    let oidc = oidc(&appstate)?;
    rate_limit(&appstate, &req)?;

    let proof = oidc
        .use_ticket(&body.ticket)
        .ok_or_else(|| AtomicServerError::bad_request("Sign-in expired. Start again."))?;
    let removed = links::delete(&appstate.store, &proof.issuer, &proof.sub)?;
    oidc.consume_ticket(&body.ticket);

    Ok(hardened(HttpResponse::Ok()).json(json!({ "removed": removed })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::{
        rand::SystemRandom,
        signature::{Ed25519KeyPair, KeyPair},
    };

    fn keypair() -> (Ed25519KeyPair, String) {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let kp = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let did = atomic_lib::identifiers::agent_subject(&atomic_lib::agents::encode_base64(
            kp.public_key().as_ref(),
        ));

        (kp, did)
    }

    #[test]
    fn possession_proof_binds_agent_and_ticket() {
        let (kp, did) = keypair();
        let msg = Oidc::link_message("ticket-1", &did);
        let sig = atomic_lib::agents::encode_base64(kp.sign(msg.as_bytes()).as_ref());

        assert!(verify_possession(&did, &msg, &sig).is_ok());
        // Another ticket, another agent, a garbage signature: all refused.
        assert!(verify_possession(&did, &Oidc::link_message("ticket-2", &did), &sig).is_err());
        let (_, other) = keypair();
        assert!(verify_possession(&other, &Oidc::link_message("ticket-1", &other), &sig).is_err());
        assert!(verify_possession(&did, &msg, "AAAA").is_err());
        assert!(verify_possession("did:ad:agent:", &msg, &sig).is_err());
        assert!(verify_possession("https://example.com/agent", &msg, &sig).is_err());
    }
}
