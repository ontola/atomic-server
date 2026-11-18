//! Same-origin relay for the browser's Sentry reports and feedback.
//!
//! Tracking protection and ad blockers refuse requests to `sentry.io`, so the
//! "Send feedback" dialog failed for those users. With `--sentry-dsn-browser`
//! set, the front-end sends its envelopes here instead (Sentry's `tunnel`
//! option) and the server forwards them. Nothing is relayed without a
//! configured DSN, and only envelopes addressed to that exact DSN.

use actix_web::{web, HttpResponse};

use crate::appstate::AppState;

/// Path the front-end posts envelopes to. Injected into the page next to the DSN.
pub const TUNNEL_PATH: &str = "/api/client-reports";

/// Feedback may carry a screenshot-sized payload, but never more than this.
const MAX_ENVELOPE_BYTES: usize = 1_000_000;

/// The ingest endpoint for `dsn`, e.g. `https://o1.ingest.sentry.io/api/42/envelope/`.
fn ingest_url(dsn: &str) -> Option<String> {
    let url = url::Url::parse(dsn.trim()).ok()?;
    let host = url.host_str()?;
    let project = url.path().trim_matches('/');

    if project.is_empty() || project.contains('/') {
        return None;
    }

    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();

    Some(format!(
        "{}://{}{}/api/{}/envelope/",
        url.scheme(),
        host,
        port,
        project
    ))
}

/// The DSN an envelope claims to be for: the first line is a JSON header.
fn envelope_dsn(body: &[u8]) -> Option<String> {
    let line = body.split(|b| *b == b'\n').next()?;
    let header: serde_json::Value = serde_json::from_slice(line).ok()?;

    header.get("dsn")?.as_str().map(str::to_string)
}

pub async fn relay(appstate: web::Data<AppState>, body: web::Bytes) -> HttpResponse {
    let Some(dsn) = appstate
        .config
        .opts
        .sentry_dsn_browser
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    else {
        return HttpResponse::NotFound().finish();
    };

    if body.len() > MAX_ENVELOPE_BYTES {
        return HttpResponse::PayloadTooLarge().finish();
    }

    // Only relay what is addressed to our own DSN: this is not an open proxy.
    if envelope_dsn(&body).as_deref() != Some(dsn) {
        return HttpResponse::BadRequest().finish();
    }

    let Some(target) = ingest_url(dsn) else {
        return HttpResponse::NotFound().finish();
    };

    let sent = reqwest::Client::new()
        .post(target)
        .header("Content-Type", "application/x-sentry-envelope")
        .body(body.to_vec())
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;

    match sent {
        Ok(resp) if resp.status().is_success() => HttpResponse::Ok().finish(),
        Ok(resp) => {
            tracing::warn!(status = %resp.status(), "Sentry refused a relayed browser report");
            HttpResponse::BadGateway().finish()
        }
        Err(e) => {
            tracing::warn!(error = %e, "Could not relay a browser report to Sentry");
            HttpResponse::BadGateway().finish()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_ingest_url() {
        assert_eq!(
            ingest_url("https://key@o1.ingest.sentry.io/42").as_deref(),
            Some("https://o1.ingest.sentry.io/api/42/envelope/")
        );
        assert_eq!(ingest_url("https://key@o1.ingest.sentry.io/"), None);
    }

    #[test]
    fn reads_dsn_from_envelope_header() {
        let body =
            b"{\"dsn\":\"https://k@o.io/1\",\"event_id\":\"x\"}\n{\"type\":\"feedback\"}\n{}";
        assert_eq!(envelope_dsn(body).as_deref(), Some("https://k@o.io/1"));
        assert_eq!(envelope_dsn(b"not json"), None);
    }
}
