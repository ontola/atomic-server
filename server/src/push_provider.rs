//! Env-configured remote push providers (FCM HTTP v1 + APNs HTTP/2).
//!
//! Credentials are **never** committed. Operators set env vars (see
//! `planning/notifications.md` Phase 5 enablement). Without them,
//! [`install_from_env`] installs [`super::LoggingPushSender`].
//!
//! Bearer tokens are expected to be minted out-of-process (Google OAuth from a
//! service account; APNs JWT from a `.p8` key). That keeps JWT signing deps
//! out of the hub until we wire a dedicated credential helper.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;

use crate::push_wake::{
    set_push_sender, DevicePushTokenRow, LoggingPushSender, PushSender, PushWakeHint,
};

const ENV_FCM_PROJECT: &str = "ATOMIC_FCM_PROJECT_ID";
const ENV_FCM_BEARER: &str = "ATOMIC_FCM_BEARER_TOKEN";
const ENV_APNS_TOPIC: &str = "ATOMIC_APNS_TOPIC";
const ENV_APNS_BEARER: &str = "ATOMIC_APNS_BEARER_TOKEN";
const ENV_APNS_HOST: &str = "ATOMIC_APNS_HOST";

/// Routes by `DevicePushTokenRow.platform` to FCM and/or APNs when configured.
pub struct EnvPushSender {
    fcm: Option<FcmConfig>,
    apns: Option<ApnsConfig>,
    fallback: LoggingPushSender,
}

#[derive(Clone)]
struct FcmConfig {
    project_id: String,
    bearer: String,
}

#[derive(Clone)]
struct ApnsConfig {
    topic: String,
    bearer: String,
    host: String,
}

impl EnvPushSender {
    /// Build from process env. Missing halves simply fall through to logging
    /// for that platform.
    pub fn from_env() -> Self {
        let fcm = match (
            std::env::var(ENV_FCM_PROJECT).ok().filter(|s| !s.is_empty()),
            std::env::var(ENV_FCM_BEARER).ok().filter(|s| !s.is_empty()),
        ) {
            (Some(project_id), Some(bearer)) => Some(FcmConfig { project_id, bearer }),
            _ => None,
        };

        let apns = match (
            std::env::var(ENV_APNS_TOPIC).ok().filter(|s| !s.is_empty()),
            std::env::var(ENV_APNS_BEARER).ok().filter(|s| !s.is_empty()),
        ) {
            (Some(topic), Some(bearer)) => Some(ApnsConfig {
                topic,
                bearer,
                host: std::env::var(ENV_APNS_HOST)
                    .ok()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "api.push.apple.com".into()),
            }),
            _ => None,
        };

        Self {
            fcm,
            apns,
            fallback: LoggingPushSender,
        }
    }

    pub fn has_fcm(&self) -> bool {
        self.fcm.is_some()
    }

    pub fn has_apns(&self) -> bool {
        self.apns.is_some()
    }
}

#[async_trait]
impl PushSender for EnvPushSender {
    async fn send_wake(
        &self,
        token: &DevicePushTokenRow,
        hint: &PushWakeHint,
    ) -> Result<(), String> {
        match token.platform.as_str() {
            "android" | "web" => {
                if let Some(cfg) = &self.fcm {
                    return send_fcm_data(cfg, token, hint).await;
                }
            }
            "ios" => {
                if let Some(cfg) = &self.apns {
                    return send_apns_wake(cfg, token, hint).await;
                }
            }
            _ => {}
        }

        self.fallback.send_wake(token, hint).await
    }
}

/// Install [`EnvPushSender`] (or logging-only) as the process-wide sender.
/// Call once during server boot.
pub fn install_from_env() {
    let sender = EnvPushSender::from_env();
    tracing::info!(
        fcm = sender.has_fcm(),
        apns = sender.has_apns(),
        "push_wake: installed EnvPushSender (missing providers log only)"
    );
    set_push_sender(Arc::new(sender));
}

async fn send_fcm_data(
    cfg: &FcmConfig,
    token: &DevicePushTokenRow,
    hint: &PushWakeHint,
) -> Result<(), String> {
    let url = format!(
        "https://fcm.googleapis.com/v1/projects/{}/messages:send",
        cfg.project_id
    );
    // Wake-only: data payload, no notification title/body (client materializes).
    let body = json!({
        "message": {
            "token": token.token,
            "data": {
                "about": hint.about,
                "type": hint.notification_type,
            }
        }
    });

    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .bearer_auth(&cfg.bearer)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("FCM request failed: {e}"))?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("FCM HTTP {status}: {text}"));
    }

    tracing::info!(
        platform = %token.platform,
        about = %hint.about,
        "push_wake: FCM data message accepted"
    );
    Ok(())
}

async fn send_apns_wake(
    cfg: &ApnsConfig,
    token: &DevicePushTokenRow,
    hint: &PushWakeHint,
) -> Result<(), String> {
    // Device token is hex; APNs path uses the raw hex string.
    let url = format!("https://{}/3/device/{}", cfg.host, token.token);
    // Background / silent-ish wake: content-available. Client syncs then decides
    // whether to paint a local banner (suppress-if-read).
    let body = json!({
        "aps": {
            "content-available": 1
        },
        "about": hint.about,
        "type": hint.notification_type,
    });

    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .bearer_auth(&cfg.bearer)
        .header("apns-topic", &cfg.topic)
        .header("apns-push-type", "background")
        .header("apns-priority", "5")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("APNs request failed: {e}"))?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("APNs HTTP {status}: {text}"));
    }

    tracing::info!(
        about = %hint.about,
        "push_wake: APNs background wake accepted"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_env_without_secrets_has_no_providers() {
        // Clear relevant vars for this process (best-effort in unit tests).
        std::env::remove_var(ENV_FCM_PROJECT);
        std::env::remove_var(ENV_FCM_BEARER);
        std::env::remove_var(ENV_APNS_TOPIC);
        std::env::remove_var(ENV_APNS_BEARER);
        let sender = EnvPushSender::from_env();
        assert!(!sender.has_fcm());
        assert!(!sender.has_apns());
    }

    #[test]
    fn from_env_partial_fcm_ignored() {
        std::env::remove_var(ENV_FCM_BEARER);
        std::env::set_var(ENV_FCM_PROJECT, "demo-project");
        let sender = EnvPushSender::from_env();
        assert!(!sender.has_fcm());
        std::env::remove_var(ENV_FCM_PROJECT);
    }

    #[test]
    fn from_env_fcm_when_both_set() {
        std::env::set_var(ENV_FCM_PROJECT, "demo-project");
        std::env::set_var(ENV_FCM_BEARER, "ya29.test");
        let sender = EnvPushSender::from_env();
        assert!(sender.has_fcm());
        std::env::remove_var(ENV_FCM_PROJECT);
        std::env::remove_var(ENV_FCM_BEARER);
    }
}
