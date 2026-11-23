//! Runs [`atomic_lib::notify::Notifier`] and hands what it delivers to the
//! channels that reach someone whose apps are closed.
//!
//! The notifier itself only writes Notifications into Inboxes (they sync to
//! every device like any other resource). Each delivery then goes to:
//!
//! - **Push**: every `pushEndpoint` the person registered, as a JSON POST.
//!   That is what a UnifiedPush distributor (for example ntfy) expects, so a
//!   self-hosted server needs no account anywhere. The body says only what
//!   kind of notification it is, unless `--notify-push-content` (for a push
//!   service the operator runs) adds the title and text.
//! - **A sink** for e-mail and other channels. An embedder (a managed node)
//!   installs one with [`set_sink`] and sends the mail through its own account
//!   service. Without one, `--notify-webhook` POSTs each delivery as JSON to a
//!   URL of the operator's choice (a mail relay, a chat bridge). Without
//!   either, nothing is mailed.

use std::sync::{Arc, OnceLock};

use atomic_lib::notify::{Delivery, Notifier};

use crate::appstate::AppState;

/// Somewhere deliveries go besides push: e-mail, mostly.
pub trait NotifySink: Send + Sync {
    fn deliver(&self, delivery: &Delivery, link: Option<&str>);
}

static SINK: OnceLock<Arc<dyn NotifySink>> = OnceLock::new();

/// Installs the sink (once; later calls are ignored). For embedders, from the
/// `serve_with_hook` hook. The binary compiles this module too and never
/// calls it, hence the allow.
#[allow(dead_code)]
pub fn set_sink(sink: Arc<dyn NotifySink>) {
    let _ = SINK.set(sink);
}

/// What a push endpoint receives. Without `with_content` only the kind and
/// the Notification's subject: the push service in between (a public ntfy,
/// say) never sees titles. The app reads the rest from the synced Inbox.
fn push_body(d: &Delivery, with_content: bool) -> serde_json::Value {
    let mut body = serde_json::json!({
        "kind": d.kind,
        "notification": d.notification,
        "actionRequired": d.action_required,
    });
    if with_content {
        body["title"] = serde_json::json!(d.title);
        body["body"] = serde_json::json!(d.body);
        body["about"] = serde_json::json!(d.about);
    }
    body
}

/// `--notify-link`, with `{subject}` replaced by the (URL-encoded) subject.
fn link_for(template: Option<&str>, subject: &str) -> Option<String> {
    let t = template?;
    Some(t.replace("{subject}", &urlencoding::encode(subject)))
}

async fn send(client: &reqwest::Client, appstate: &AppState, d: &Delivery) {
    let link = link_for(appstate.config.opts.notify_link.as_deref(), &d.about);
    for endpoint in &d.push_endpoints {
        let request = atomic_lib::client::helpers::notification_post(
            endpoint,
            appstate.config.opts.notify_private_push_origin.as_ref(),
        );
        let Ok(request) = request else {
            tracing::warn!("notifier: rejected a push endpoint");
            continue;
        };
        let response = request
            .header("content-type", "application/json")
            .body(push_body(d, appstate.config.opts.notify_push_content).to_string())
            .send()
            .await;
        if !response.is_ok_and(|r| r.status().is_success()) {
            tracing::warn!("notifier: push delivery failed");
        }
    }
    if d.email.is_none() {
        return;
    }
    if let Some(sink) = SINK.get() {
        sink.deliver(d, link.as_deref());
    } else if let Some(hook) = &appstate.config.opts.notify_webhook {
        let mut body = serde_json::to_value(d).unwrap_or_default();
        body["link"] = serde_json::json!(link);
        if let Err(e) = client.post(hook).json(&body).send().await {
            tracing::warn!("notifier: webhook failed: {e}");
        }
    }
}

/// Starts the notifier loop. Cheap on a server without Inboxes or Follows:
/// one class query per round.
pub fn spawn(appstate: AppState) {
    if appstate.config.opts.notify_interval == 0 {
        return;
    }
    let every = std::time::Duration::from_secs(appstate.config.opts.notify_interval);
    actix_web::rt::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        let notifier = Notifier::new(appstate.store.clone());
        let mut tick = tokio::time::interval(every);
        loop {
            tick.tick().await;
            match notifier.tick(atomic_lib::utils::now()).await {
                Ok(deliveries) => {
                    for d in &deliveries {
                        send(&client, &appstate, d).await;
                    }
                }
                Err(e) => tracing::warn!("notifier: {e}"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_bodies_leave_out_titles_unless_asked() {
        let d = Delivery {
            agent: "a".into(),
            notification: "n".into(),
            kind: "changed".into(),
            title: "Besloten stuk".into(),
            body: "x".into(),
            about: "s".into(),
            action_required: false,
            count: 1,
            push_endpoints: vec![],
            email: None,
            language: "nl".into(),
        };
        assert!(push_body(&d, false).get("title").is_none());
        assert_eq!(push_body(&d, true)["title"], "Besloten stuk");
    }

    #[test]
    fn links_fill_in_the_subject() {
        assert_eq!(
            link_for(Some("https://app.test/open?s={subject}"), "did:ad:abc"),
            Some("https://app.test/open?s=did%3Aad%3Aabc".into())
        );
        assert_eq!(link_for(None, "x"), None);
    }
}
