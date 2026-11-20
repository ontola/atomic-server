//! A push gateway from plain HTTP to Firebase Cloud Messaging.
//!
//! The notifier ([`crate::notifier`]) POSTs each notification to whatever push
//! endpoint a device registered: a URL, as UnifiedPush expects. An app that
//! receives pushes through FCM (Android without a distributor app, iOS through
//! FCM's APNs bridge) registers `https://<this server>/push/fcm/<token>`
//! instead, and this route hands the message to FCM.
//!
//! Only the app's publisher holds the Firebase service account, so this runs
//! on one server they operate (`--push-fcm-credentials`). Every other server,
//! self-hosted ones too, just POSTs to that URL and needs no keys.
//!
//! The JSON body becomes the FCM message's `data` (FCM wants string values).
//! When it carries a `title`, the message also gets a visible notification;
//! otherwise it is a high priority data message the app turns into one.

use std::sync::OnceLock;

use actix_web::{web, HttpResponse};
use base64::Engine;
use ring::signature::{RsaKeyPair, RSA_PKCS1_SHA256};
use serde::Deserialize;
use tokio::sync::Mutex;

const SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
/// FCM allows 4 KB of data.
const MAX_BODY: usize = 4096;

/// The fields of a Firebase service account JSON that matter here.
#[derive(Deserialize)]
struct ServiceAccount {
    project_id: String,
    client_email: String,
    private_key: String,
    #[serde(default = "default_token_uri")]
    token_uri: String,
}

fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".into()
}

pub struct FcmGateway {
    account: ServiceAccount,
    key: RsaKeyPair,
    client: reqwest::Client,
    /// The access token and when it expires (unix seconds).
    token: Mutex<Option<(String, u64)>>,
}

static GATEWAY: OnceLock<FcmGateway> = OnceLock::new();

/// Reads the service account. Called once at start when
/// `--push-fcm-credentials` is set; the route answers 404 without it.
pub fn init(path: &std::path::Path) -> Result<(), String> {
    let json =
        std::fs::read_to_string(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let gateway = FcmGateway::new(&json)?;
    tracing::info!(
        "push gateway: FCM for project {} on /push/fcm/{{token}}",
        gateway.account.project_id
    );
    let _ = GATEWAY.set(gateway);
    Ok(())
}

fn pem_to_der(pem: &str) -> Result<Vec<u8>, String> {
    let b64: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .concat();
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("private_key: {e}"))
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

/// The FCM message for one push body (see the module docs).
fn fcm_message(token: &str, body: &serde_json::Value) -> serde_json::Value {
    let mut data = serde_json::Map::new();
    if let Some(obj) = body.as_object() {
        for (k, v) in obj {
            let s = match v {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Null => continue,
                other => other.to_string(),
            };
            data.insert(k.clone(), serde_json::Value::String(s));
        }
    }
    let title = body.get("title").and_then(|t| t.as_str());
    let mut message = serde_json::json!({
        "token": token,
        "data": data,
        "android": { "priority": "high" },
    });
    match title {
        Some(title) => {
            message["notification"] = serde_json::json!({
                "title": title,
                "body": body.get("body").and_then(|b| b.as_str()).unwrap_or_default(),
            });
        }
        None => {
            // Wakes the iOS app in the background to show its own text.
            message["apns"] = serde_json::json!({
                "headers": { "apns-priority": "5", "apns-push-type": "background" },
                "payload": { "aps": { "content-available": 1 } },
            });
        }
    }
    serde_json::json!({ "message": message })
}

impl FcmGateway {
    fn new(json: &str) -> Result<Self, String> {
        let account: ServiceAccount =
            serde_json::from_str(json).map_err(|e| format!("service account: {e}"))?;
        let key = RsaKeyPair::from_pkcs8(&pem_to_der(&account.private_key)?)
            .map_err(|e| format!("private_key: {e}"))?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            account,
            key,
            client,
            token: Mutex::new(None),
        })
    }

    /// A signed JWT that Google trades for an access token.
    fn assertion(&self, now: u64) -> Result<String, String> {
        let header = b64url(br#"{"alg":"RS256","typ":"JWT"}"#);
        let claims = b64url(
            serde_json::json!({
                "iss": self.account.client_email,
                "scope": SCOPE,
                "aud": self.account.token_uri,
                "iat": now,
                "exp": now + 3600,
            })
            .to_string()
            .as_bytes(),
        );
        let input = format!("{header}.{claims}");
        let mut sig = vec![0; self.key.public().modulus_len()];
        self.key
            .sign(
                &RSA_PKCS1_SHA256,
                &ring::rand::SystemRandom::new(),
                input.as_bytes(),
                &mut sig,
            )
            .map_err(|e| format!("signing: {e}"))?;
        Ok(format!("{input}.{}", b64url(&sig)))
    }

    async fn access_token(&self) -> Result<String, String> {
        let mut cached = self.token.lock().await;
        let now = now_secs();
        if let Some((token, until)) = cached.as_ref() {
            if *until > now + 60 {
                return Ok(token.clone());
            }
        }
        let form = format!(
            "grant_type={}&assertion={}",
            urlencoding::encode("urn:ietf:params:oauth:grant-type:jwt-bearer"),
            self.assertion(now)?
        );
        let res: serde_json::Value = self
            .client
            .post(&self.account.token_uri)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(form)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        let token = res["access_token"]
            .as_str()
            .ok_or_else(|| format!("no access token: {res}"))?
            .to_string();
        let ttl = res["expires_in"].as_u64().unwrap_or(3600);
        *cached = Some((token.clone(), now + ttl));
        Ok(token)
    }

    async fn send(&self, token: &str, body: &serde_json::Value) -> Result<u16, String> {
        let access = self.access_token().await?;
        let url = format!(
            "https://fcm.googleapis.com/v1/projects/{}/messages:send",
            self.account.project_id
        );
        let res = self
            .client
            .post(url)
            .bearer_auth(access)
            .json(&fcm_message(token, body))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        if status >= 400 && status != 404 {
            let text = res.text().await.unwrap_or_default();
            tracing::warn!("push gateway: FCM answered {status}: {text}");
        }
        Ok(status)
    }
}

/// `POST /push/fcm/{token}`: forwards the JSON body to that FCM token. Answers
/// 410 when FCM no longer knows the token, so a sender can drop it.
pub async fn handle(token: web::Path<String>, body: web::Bytes) -> HttpResponse {
    let Some(gateway) = GATEWAY.get() else {
        return HttpResponse::NotFound().finish();
    };
    if body.len() > MAX_BODY {
        return HttpResponse::PayloadTooLarge().finish();
    }
    let json: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v @ serde_json::Value::Object(_)) => v,
        _ => return HttpResponse::BadRequest().body("expected a JSON object"),
    };
    match gateway.send(&token, &json).await {
        Ok(s) if s < 300 => HttpResponse::Created().finish(),
        Ok(404) => HttpResponse::Gone().finish(),
        Ok(400) => HttpResponse::BadRequest().body("FCM rejected the message"),
        Ok(_) | Err(_) => HttpResponse::BadGateway().finish(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_values_become_strings_and_titles_become_notifications() {
        let quiet = fcm_message(
            "t",
            &serde_json::json!({"kind": "changed", "actionRequired": false, "count": 2}),
        );
        let m = &quiet["message"];
        assert_eq!(m["token"], "t");
        assert_eq!(m["data"]["actionRequired"], "false");
        assert_eq!(m["data"]["count"], "2");
        assert!(m.get("notification").is_none());
        assert_eq!(m["apns"]["payload"]["aps"]["content-available"], 1);

        let loud = fcm_message("t", &serde_json::json!({"title": "Hoi", "body": "x"}));
        assert_eq!(loud["message"]["notification"]["title"], "Hoi");
        assert!(loud["message"].get("apns").is_none());
    }
}
