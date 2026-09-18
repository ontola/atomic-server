//! Env-configured remote push providers (FCM HTTP v1 + APNs HTTP/2).
//!
//! Credentials are **never** committed. Operators set env vars (see
//! `planning/notifications.md` Phase 5 enablement). Without them,
//! [`install_from_env`] installs [`super::LoggingPushSender`].
//!
//! Visible lock-screen banners (alert / `notification`) plus a wake-only data
//! bag. Silent APNs is not delivered to a killed iOS app.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use crate::push_credentials::{
    mint_apns_jwt, mint_google_jwt, now_unix, parse_service_account_json, read_file_trim,
    ServiceAccount,
};
use crate::push_wake::{
    set_push_sender, DevicePushTokenRow, LoggingPushSender, PushSender, PushWakeHint,
};

const ENV_FCM_PROJECT: &str = "ATOMIC_FCM_PROJECT_ID";
const ENV_FCM_BEARER: &str = "ATOMIC_FCM_BEARER_TOKEN";
const ENV_FCM_SA_FILE: &str = "ATOMIC_FCM_SERVICE_ACCOUNT_FILE";
const ENV_FCM_SA_JSON: &str = "ATOMIC_FCM_SERVICE_ACCOUNT_JSON";
const ENV_APNS_TOPIC: &str = "ATOMIC_APNS_TOPIC";
const ENV_APNS_BEARER: &str = "ATOMIC_APNS_BEARER_TOKEN";
const ENV_APNS_KEY_FILE: &str = "ATOMIC_APNS_KEY_FILE";
const ENV_APNS_KEY_ID: &str = "ATOMIC_APNS_KEY_ID";
const ENV_APNS_TEAM_ID: &str = "ATOMIC_APNS_TEAM_ID";
const ENV_APNS_HOST: &str = "ATOMIC_APNS_HOST";
const ENV_APNS_SANDBOX: &str = "ATOMIC_APNS_SANDBOX";

const FCM_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_GRANT: &str = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/// Routes by `DevicePushTokenRow.platform` to FCM and/or APNs when configured.
pub struct EnvPushSender {
    fcm: Option<FcmConfig>,
    apns: Option<ApnsConfig>,
    fallback: LoggingPushSender,
}

struct CachedBearer {
    token: String,
    valid_until: Instant,
}

struct FcmConfig {
    project_id: String,
    auth: FcmAuth,
}

enum FcmAuth {
    Static(String),
    ServiceAccount {
        account: ServiceAccount,
        cache: Mutex<Option<CachedBearer>>,
    },
}

struct ApnsConfig {
    topic: String,
    host: String,
    auth: ApnsAuth,
}

enum ApnsAuth {
    Static(String),
    Key {
        key_id: String,
        team_id: String,
        pem: String,
        cache: Mutex<Option<CachedBearer>>,
    },
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.is_empty())
}

fn apns_host_from_env() -> String {
    if let Some(host) = env_nonempty(ENV_APNS_HOST) {
        return host;
    }
    match env_nonempty(ENV_APNS_SANDBOX).as_deref() {
        Some("1") | Some("true") | Some("TRUE") | Some("yes") => {
            "api.sandbox.push.apple.com".into()
        }
        _ => "api.push.apple.com".into(),
    }
}

fn load_fcm_from_env() -> Option<FcmConfig> {
    if let Some(account) = load_service_account() {
        let project_id =
            env_nonempty(ENV_FCM_PROJECT).unwrap_or_else(|| account.project_id.clone());
        return Some(FcmConfig {
            project_id,
            auth: FcmAuth::ServiceAccount {
                account,
                cache: Mutex::new(None),
            },
        });
    }

    match (env_nonempty(ENV_FCM_PROJECT), env_nonempty(ENV_FCM_BEARER)) {
        (Some(project_id), Some(bearer)) => Some(FcmConfig {
            project_id,
            auth: FcmAuth::Static(bearer),
        }),
        _ => None,
    }
}

fn load_service_account() -> Option<ServiceAccount> {
    if let Some(raw) = env_nonempty(ENV_FCM_SA_JSON) {
        return parse_service_account_json(&raw)
            .map_err(|e| tracing::warn!(error = %e, "push_wake: FCM service-account JSON ignored"))
            .ok();
    }
    if let Some(path) = env_nonempty(ENV_FCM_SA_FILE) {
        return read_file_trim(&path)
            .and_then(|raw| parse_service_account_json(&raw))
            .map_err(|e| tracing::warn!(error = %e, "push_wake: FCM service-account file ignored"))
            .ok();
    }
    None
}

fn load_apns_from_env() -> Option<ApnsConfig> {
    let topic = env_nonempty(ENV_APNS_TOPIC)?;
    let host = apns_host_from_env();

    if let (Some(key_file), Some(key_id), Some(team_id)) = (
        env_nonempty(ENV_APNS_KEY_FILE),
        env_nonempty(ENV_APNS_KEY_ID),
        env_nonempty(ENV_APNS_TEAM_ID),
    ) {
        match read_file_trim(&key_file) {
            Ok(pem) => {
                return Some(ApnsConfig {
                    topic,
                    host,
                    auth: ApnsAuth::Key {
                        key_id,
                        team_id,
                        pem,
                        cache: Mutex::new(None),
                    },
                });
            }
            Err(e) => {
                tracing::warn!(error = %e, "push_wake: APNs key file ignored");
            }
        }
    }

    env_nonempty(ENV_APNS_BEARER).map(|bearer| ApnsConfig {
        topic,
        host,
        auth: ApnsAuth::Static(bearer),
    })
}

impl EnvPushSender {
    /// Build from process env. Missing halves simply fall through to logging
    /// for that platform.
    pub fn from_env() -> Self {
        Self {
            fcm: load_fcm_from_env(),
            apns: load_apns_from_env(),
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
                    return send_fcm_notification(cfg, token, hint).await;
                }
            }
            "ios" => {
                if let Some(cfg) = &self.apns {
                    return send_apns_alert(cfg, token, hint).await;
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

/// FCM HTTP v1 message: visible `notification` + data bag for tap/sync.
pub fn fcm_message_body(device_token: &str, hint: &PushWakeHint) -> JsonValue {
    json!({
        "message": {
            "token": device_token,
            "notification": {
                "title": hint.visible_title(),
                "body": hint.visible_body(),
            },
            "data": {
                "about": hint.about,
                "type": hint.notification_type,
            },
            "android": {
                "priority": "HIGH",
                "notification": {
                    "channel_id": "atomic_notifications",
                    "notification_priority": "PRIORITY_HIGH",
                }
            },
            "apns": {
                "headers": {
                    "apns-priority": "10",
                    "apns-push-type": "alert",
                },
                "payload": {
                    "aps": {
                        "sound": "default",
                    }
                }
            }
        }
    })
}

/// APNs alert payload. `about` / `type` stay custom keys (not inside `aps`).
pub fn apns_alert_body(hint: &PushWakeHint) -> JsonValue {
    json!({
        "aps": {
            "alert": {
                "title": hint.visible_title(),
                "body": hint.visible_body(),
            },
            "sound": "default",
            "content-available": 1
        },
        "about": hint.about,
        "type": hint.notification_type,
    })
}

async fn fcm_bearer(cfg: &FcmConfig) -> Result<String, String> {
    match &cfg.auth {
        FcmAuth::Static(b) => Ok(b.clone()),
        FcmAuth::ServiceAccount { account, cache } => {
            if let Some(cached) = cache.lock().ok().and_then(|g| {
                g.as_ref()
                    .filter(|c| c.valid_until > Instant::now())
                    .map(|c| c.token.clone())
            }) {
                return Ok(cached);
            }
            let assertion = mint_google_jwt(
                &account.private_key_pem,
                &account.client_email,
                now_unix(),
                3600,
            )?;
            let client = reqwest::Client::new();
            let res = client
                .post(FCM_TOKEN_URL)
                .form(&[
                    ("grant_type", GOOGLE_GRANT),
                    ("assertion", assertion.as_str()),
                ])
                .send()
                .await
                .map_err(|e| format!("FCM OAuth request failed: {e}"))?;
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(format!("FCM OAuth HTTP {status}: {text}"));
            }
            let v: JsonValue =
                serde_json::from_str(&text).map_err(|e| format!("FCM OAuth JSON: {e}"))?;
            let token = v
                .get("access_token")
                .and_then(|x| x.as_str())
                .ok_or_else(|| "FCM OAuth missing access_token".to_string())?
                .to_string();
            let expires_in = v.get("expires_in").and_then(|x| x.as_u64()).unwrap_or(3600);
            let ttl = expires_in.saturating_sub(300).max(60);
            if let Ok(mut g) = cache.lock() {
                *g = Some(CachedBearer {
                    token: token.clone(),
                    valid_until: Instant::now() + std::time::Duration::from_secs(ttl),
                });
            }
            Ok(token)
        }
    }
}

async fn apns_bearer(cfg: &ApnsConfig) -> Result<String, String> {
    match &cfg.auth {
        ApnsAuth::Static(b) => Ok(b.clone()),
        ApnsAuth::Key {
            key_id,
            team_id,
            pem,
            cache,
        } => {
            if let Some(cached) = cache.lock().ok().and_then(|g| {
                g.as_ref()
                    .filter(|c| c.valid_until > Instant::now())
                    .map(|c| c.token.clone())
            }) {
                return Ok(cached);
            }
            let token = mint_apns_jwt(pem, key_id, team_id, now_unix())?;
            if let Ok(mut g) = cache.lock() {
                *g = Some(CachedBearer {
                    token: token.clone(),
                    valid_until: Instant::now() + std::time::Duration::from_secs(50 * 60),
                });
            }
            Ok(token)
        }
    }
}

async fn send_fcm_notification(
    cfg: &FcmConfig,
    token: &DevicePushTokenRow,
    hint: &PushWakeHint,
) -> Result<(), String> {
    let url = format!(
        "https://fcm.googleapis.com/v1/projects/{}/messages:send",
        cfg.project_id
    );
    let bearer = fcm_bearer(cfg).await?;
    let body = fcm_message_body(&token.token, hint);

    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .bearer_auth(&bearer)
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
        "push_wake: FCM notification accepted"
    );
    Ok(())
}

async fn send_apns_alert(
    cfg: &ApnsConfig,
    token: &DevicePushTokenRow,
    hint: &PushWakeHint,
) -> Result<(), String> {
    let url = format!("https://{}/3/device/{}", cfg.host, token.token);
    let bearer = apns_bearer(cfg).await?;
    let body = apns_alert_body(hint);

    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .bearer_auth(&bearer)
        .header("apns-topic", &cfg.topic)
        .header("apns-push-type", "alert")
        .header("apns-priority", "10")
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
        "push_wake: APNs alert accepted"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clear_push_env() {
        for key in [
            ENV_FCM_PROJECT,
            ENV_FCM_BEARER,
            ENV_FCM_SA_FILE,
            ENV_FCM_SA_JSON,
            ENV_APNS_TOPIC,
            ENV_APNS_BEARER,
            ENV_APNS_KEY_FILE,
            ENV_APNS_KEY_ID,
            ENV_APNS_TEAM_ID,
            ENV_APNS_HOST,
            ENV_APNS_SANDBOX,
        ] {
            std::env::remove_var(key);
        }
    }

    #[test]
    fn from_env_without_secrets_has_no_providers() {
        clear_push_env();
        let sender = EnvPushSender::from_env();
        assert!(!sender.has_fcm());
        assert!(!sender.has_apns());
    }

    #[test]
    fn from_env_partial_fcm_ignored() {
        clear_push_env();
        std::env::set_var(ENV_FCM_PROJECT, "demo-project");
        let sender = EnvPushSender::from_env();
        assert!(!sender.has_fcm());
        std::env::remove_var(ENV_FCM_PROJECT);
    }

    #[test]
    fn from_env_fcm_when_both_set() {
        clear_push_env();
        std::env::set_var(ENV_FCM_PROJECT, "demo-project");
        std::env::set_var(ENV_FCM_BEARER, "ya29.test");
        let sender = EnvPushSender::from_env();
        assert!(sender.has_fcm());
        clear_push_env();
    }

    #[test]
    fn from_env_apns_from_p8_file() {
        clear_push_env();
        let dir = std::env::temp_dir().join(format!("apns-key-{}.p8", std::process::id()));
        std::fs::write(
            &dir,
            "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgMB6ERah5AET3bfW2\nGqb8F6Rv8D0XRuQ9T9DbJ0u0RGihRANCAASMdplxryNIFYYvS4a/UdEXnQW+HTJl\nEW09t4dYq/lKMzvHOCuLp+ToaV+HPfeX6tqBsPG0HqKYr6dNM6iJ/Nmt\n-----END PRIVATE KEY-----\n",
        )
        .unwrap();
        std::env::set_var(ENV_APNS_TOPIC, "com.atomicdata.dev");
        std::env::set_var(ENV_APNS_KEY_FILE, dir.to_string_lossy().as_ref());
        std::env::set_var(ENV_APNS_KEY_ID, "KEYID123");
        std::env::set_var(ENV_APNS_TEAM_ID, "TEAMID123");
        let sender = EnvPushSender::from_env();
        assert!(sender.has_apns());
        let _ = std::fs::remove_file(&dir);
        clear_push_env();
    }

    #[test]
    fn fcm_payload_is_visible_notification_plus_data() {
        let hint = PushWakeHint::new("did:ad:doc1", "mention");
        let body = fcm_message_body("device-token", &hint);
        let message = body.get("message").unwrap();
        let notification = message.get("notification").unwrap();
        assert_eq!(
            notification.get("title").and_then(|v| v.as_str()),
            Some("Atomic")
        );
        assert_eq!(
            notification.get("body").and_then(|v| v.as_str()),
            Some("Someone mentioned you")
        );
        let data = message.get("data").unwrap();
        assert_eq!(
            data.get("about").and_then(|v| v.as_str()),
            Some("did:ad:doc1")
        );
        assert_eq!(data.get("type").and_then(|v| v.as_str()), Some("mention"));
        assert!(data.get("body").is_none());
        assert!(data.get("summary").is_none());
    }

    #[test]
    fn apns_payload_is_alert_not_silent() {
        let hint = PushWakeHint::new("did:ad:doc1", "message");
        let body = apns_alert_body(&hint);
        let alert = body
            .get("aps")
            .and_then(|a| a.get("alert"))
            .expect("aps.alert");
        assert_eq!(alert.get("title").and_then(|v| v.as_str()), Some("Atomic"));
        assert_eq!(
            alert.get("body").and_then(|v| v.as_str()),
            Some("You have a new message")
        );
        assert_eq!(
            body.get("about").and_then(|v| v.as_str()),
            Some("did:ad:doc1")
        );
        assert_eq!(body.get("type").and_then(|v| v.as_str()), Some("message"));
    }
}
