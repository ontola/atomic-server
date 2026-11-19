//! Authenticated, resource-authorized evidence for stored attachment bytes.
use actix_web::{web, HttpResponse};
use atomic_lib::{agents::ForAgent, sync::attachment_receipts::resource_attachment_evidence};
use serde::Deserialize;

use crate::{
    appstate::AppState,
    context::RequestContext,
    errors::{AppErrorType, AtomicServerError, AtomicServerResult},
    helpers::{enforce_write_rate_limit, get_client_agent_for_request},
};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EvidenceRequest {
    subjects: Vec<String>,
}

#[tracing::instrument(skip_all)]
pub async fn attachment_evidence(
    appstate: web::Data<AppState>,
    req: actix_web::HttpRequest,
    raw: web::Bytes,
    context: RequestContext,
) -> AtomicServerResult<HttpResponse> {
    if req
        .headers()
        .get("x-atomic-signature-version")
        .and_then(|value| value.to_str().ok())
        != Some("2")
    {
        return Err(AtomicServerError {
            message: "Sign the attachment evidence method and body with version 2".into(),
            error_type: AppErrorType::Unauthorized,
            error_resource: None,
        });
    }
    let subject = context.signed_subject(&req)?;
    let agent = get_client_agent_for_request(&req, &raw, &appstate, &subject).await?;
    if agent == ForAgent::Public {
        return Err(AtomicServerError {
            message: "Attachment confirmations require a signed request".into(),
            error_type: AppErrorType::Unauthorized,
            error_resource: None,
        });
    }
    // Byte verification can read large objects. Use the existing authenticated
    // operation budget before touching storage, even though this is a read.
    enforce_write_rate_limit(&appstate, &req, &agent)?;
    let body: EvidenceRequest = serde_json::from_slice(&raw)
        .map_err(|_| AtomicServerError::bad_request("Invalid attachment evidence request"))?;
    if body.subjects.len() > 128 || body.subjects.iter().any(|subject| subject.len() > 4096) {
        return Err(AtomicServerError::bad_request(
            "Attachment evidence batch is too large",
        ));
    }
    // A configured object store may stall within one HEAD/GET await. Bound the
    // whole request as well as the verifier's cooperative CPU/byte budgets.
    let evidence = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        resource_attachment_evidence(&appstate.store, &agent, &body.subjects),
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => body
            .subjects
            .into_iter()
            .map(
                |subject| atomic_lib::sync::attachment_receipts::ResourceAttachmentEvidence {
                    subject,
                    state: "unknown",
                    version: None,
                    manifest: None,
                    confirmed_at: None,
                },
            )
            .collect(),
    };
    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .json(evidence))
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test, App};
    use atomic_lib::{agents::Agent, urls, Value};
    use clap::Parser;
    use serde_json::json;

    fn request(
        state: &AppState,
        agent: Option<&Agent>,
        signed: &str,
        sent: &str,
    ) -> test::TestRequest {
        let mut request = test::TestRequest::post()
            .uri("/attachment-evidence")
            .insert_header(("Content-Type", "application/json"))
            .set_payload(sent.to_string());
        if let Some(agent) = agent {
            for (name, value) in atomic_lib::client::get_authentication_headers_v2(
                "POST",
                &format!("{}/attachment-evidence", state.config.get_origin()),
                signed.as_bytes(),
                agent,
            )
            .unwrap()
            {
                request = request.insert_header((name, value));
            }
        }
        request
    }

    #[actix_rt::test]
    async fn signed_byte_evidence_is_authorized_and_requires_actual_contents() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_str().unwrap();
        let opts = crate::config::Opts::parse_from([
            "atomic-server",
            "--initialize",
            "--data-dir",
            root,
            "--config-dir",
            root,
        ]);
        let mut config = crate::config::build_config(opts).unwrap();
        config.search_index_path = directory.path().join("search");
        config.vector_search_index_path = directory.path().join("vectors");
        let state = AppState::init(config).await.unwrap();
        let (owner, drive) = state.store.setup("Attachment owner").await.unwrap();
        let bytes = b"actual contents, distinct from the file record";
        let hash = blake3::hash(bytes);
        let file = state
            .store
            .create_resource(
                urls::FILE,
                &drive,
                "attachment.txt",
                Some(vec![
                    (
                        urls::BLOB,
                        Value::AtomicUrl(format!("atomic:blob:{}", hash.to_hex()).into()),
                    ),
                    (urls::INTERNAL_ID, Value::String(hash.to_hex().to_string())),
                ]),
            )
            .await
            .unwrap();
        let app = test::init_service(
            App::new().app_data(web::Data::new(state.clone())).service(
                web::resource("/attachment-evidence")
                    .app_data(web::PayloadConfig::new(64 * 1024))
                    .route(web::post().to(attachment_evidence)),
            ),
        )
        .await;
        let body = json!({"subjects": [file]}).to_string();
        let response =
            test::call_service(&app, request(&state, None, &body, &body).to_request()).await;
        assert_eq!(response.status(), 401);
        let mut legacy = request(&state, None, &body, &body);
        for (name, value) in atomic_lib::client::get_authentication_headers(
            &format!("{}/attachment-evidence", state.config.get_origin()),
            &owner,
        )
        .unwrap()
        {
            legacy = legacy.insert_header((name, value));
        }
        let response = test::call_service(&app, legacy.to_request()).await;
        assert_eq!(response.status(), 401);
        let response = test::call_service(
            &app,
            request(&state, Some(&owner), &body, "{\"subjects\":[]}").to_request(),
        )
        .await;
        assert_eq!(response.status(), 401);

        let missing: serde_json::Value = test::call_and_read_body_json(
            &app,
            request(&state, Some(&owner), &body, &body).to_request(),
        )
        .await;
        assert_eq!(missing[0]["state"], "unknown");
        state.store.put_blob(hash.as_bytes(), bytes).await.unwrap();
        let response = test::call_service(
            &app,
            request(&state, Some(&owner), &body, &body).to_request(),
        )
        .await;
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers().get("Cache-Control").unwrap(), "no-store");
        let confirmed: serde_json::Value = test::read_body_json(response).await;
        assert_eq!(confirmed[0]["state"], "confirmed");
        assert_eq!(
            confirmed[0]["manifest"]["files"][0]["hash"],
            hash.to_hex().as_str()
        );

        let stranger = Agent::new(Some("Other agent")).unwrap();
        let denied: serde_json::Value = test::call_and_read_body_json(
            &app,
            request(&state, Some(&stranger), &body, &body).to_request(),
        )
        .await;
        assert_eq!(denied[0]["state"], "unknown");
        assert!(denied[0].get("manifest").is_none());
        let oversized = json!({"subjects": vec![file; 129]}).to_string();
        let response = test::call_service(
            &app,
            request(&state, Some(&owner), &oversized, &oversized).to_request(),
        )
        .await;
        assert_eq!(response.status(), 400);
    }
}
