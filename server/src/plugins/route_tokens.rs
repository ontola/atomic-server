//! Bearer tokens a plugin issues through the host, and the consent that can
//! precede them (#1718; design `server-plugin-routes.md` in atomic-plugins,
//! sections 2.2 `tokens`, 2.5 `auth: bearer`, D6).
//!
//! A release declares `http.tokens` (for example `storage`, the tokens a
//! remoteStorage plugin hands to apps). The host keeps them per
//! Installation, **hashed**: SHA-256 of the token, which is 256 random bits,
//! so a fast hash is the right one. The plaintext exists once, in the answer
//! to `ctx.tokens.issue`. Tokens are never resources: resources sync, and
//! drives get shared.
//!
//! - `ctx.tokens.issue({ name, scopes, client, expiresIn })` or
//!   `ctx.tokens.issue({ code })`, after a person approved on the consent page;
//! - `ctx.tokens.verify(token)`: the token's id, name, scopes and client;
//! - `ctx.tokens.revoke(id)`;
//! - `ctx.tokens.requestConsent({ name, scopes, client, redirect, state })`:
//!   the URL of the host's consent page (below).
//!
//! A route with `auth: bearer` gets `request.caller = { token: { id, name,
//! scopes, client } }`; a request without a valid token gets `401` and the
//! sandbox never starts. People manage tokens through `/plugin-route-tokens`
//! (list, revoke): never their value, which is not stored.
//!
//! **Consent (D6).** The plugin never serves a login or consent form. It
//! asks the host for a consent request, redirects the browser to the host's
//! page on the API origin (`/app/route-consent?request=<id>`), and a person
//! who may manage the Installation approves or denies it there. The host then
//! redirects back to the route the plugin named, with a one-time `code` (or
//! `error=access_denied`) and the plugin's `state`. The route redeems the
//! code with `ctx.tokens.issue({ code })`, which issues a token with exactly
//! the approved scopes. Requests and codes live in memory: they are minutes
//! old at most, and a restart only means asking again.

use std::{collections::HashMap, sync::Mutex};

use atomic_lib::{db::trees::Tree, Db, Subject};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// `Tree::PluginMeta`: `route-token:<installation pure id>\0<sha-256 hex>`.
const TOKEN_PREFIX: &str = "route-token:";
/// Tokens start with this, so a leaked one is recognisable in a scan.
pub const TOKEN_TEXT_PREFIX: &str = "atr_";
/// Live tokens per installation.
pub const MAX_TOKENS: usize = 10_000;
pub const MAX_SCOPES: usize = 32;
/// How long a consent request waits for a person, and a code for its route.
pub const CONSENT_TTL_MS: i64 = 10 * 60 * 1000;
pub const CODE_TTL_MS: i64 = 5 * 60 * 1000;
/// Consent requests waiting per installation.
pub const MAX_PENDING: usize = 100;

fn pure(subject: &str) -> String {
    Subject::from(subject).pure_id()
}

fn random() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    B64URL.encode(bytes)
}

fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn prefix(installation: &str) -> Vec<u8> {
    format!("{TOKEN_PREFIX}{}\0", pure(installation)).into_bytes()
}

fn key(installation: &str, token: &str) -> Vec<u8> {
    let mut key = prefix(installation);
    key.extend_from_slice(hash(token).as_bytes());
    key
}

/// What is stored per token, and what may be said about one. Never the
/// token, never its hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenInfo {
    pub id: String,
    /// The declared token store (`http.tokens[].name`).
    pub name: String,
    pub scopes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    pub issued_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    /// The agent who approved it on the consent page, if one did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_by: Option<String>,
}

pub fn check_scopes(scopes: &[String]) -> Result<(), String> {
    if scopes.len() > MAX_SCOPES {
        return Err(format!("at most {MAX_SCOPES} scopes"));
    }
    for scope in scopes {
        if scope.is_empty()
            || scope.len() > 128
            || !scope.bytes().all(|b| (0x21..0x7f).contains(&b))
        {
            return Err(format!(
                "scope `{scope}` must be 1 to 128 printable ASCII characters without spaces"
            ));
        }
    }
    Ok(())
}

fn check_client(client: &Option<String>) -> Result<(), String> {
    match client {
        Some(c) if c.is_empty() || c.len() > 512 || c.chars().any(char::is_control) => {
            Err("client must be 1 to 512 characters".into())
        }
        _ => Ok(()),
    }
}

/// What to issue.
pub struct Issue {
    pub name: String,
    pub scopes: Vec<String>,
    pub client: Option<String>,
    pub expires_at: Option<i64>,
    pub approved_by: Option<String>,
}

/// Issues a token. Returns the token, once, and what is stored about it.
pub fn issue(
    db: &Db,
    installation: &str,
    issue: Issue,
    now: i64,
) -> Result<(String, TokenInfo), String> {
    check_scopes(&issue.scopes)?;
    check_client(&issue.client)?;
    if issue.expires_at.is_some_and(|at| at <= now) {
        return Err("a token must expire in the future".into());
    }
    let live = db
        .kv
        .scan_prefix(Tree::PluginMeta, &prefix(installation))
        .count();
    if live >= MAX_TOKENS {
        return Err(format!(
            "this installation already has {MAX_TOKENS} tokens; revoke some first"
        ));
    }
    let token = format!("{TOKEN_TEXT_PREFIX}{}", random());
    let info = TokenInfo {
        id: format!("tok_{}", ulid::Ulid::new().to_string().to_lowercase()),
        name: issue.name,
        scopes: issue.scopes,
        client: issue.client,
        issued_at: now,
        expires_at: issue.expires_at,
        approved_by: issue.approved_by,
    };
    let bytes = serde_json::to_vec(&info).map_err(|e| e.to_string())?;
    db.kv
        .insert(Tree::PluginMeta, &key(installation, &token), &bytes)
        .map_err(|e| e.to_string())?;
    Ok((token, info))
}

/// The token's record, if it is this installation's and not expired.
pub fn verify(db: &Db, installation: &str, token: &str, now: i64) -> Option<TokenInfo> {
    if !token.starts_with(TOKEN_TEXT_PREFIX) || token.len() > 128 {
        return None;
    }
    let bytes = db
        .kv
        .get(Tree::PluginMeta, &key(installation, token))
        .ok()??;
    let info: TokenInfo = serde_json::from_slice(&bytes).ok()?;
    if info.expires_at.is_some_and(|at| at <= now) {
        return None;
    }
    Some(info)
}

fn entries(db: &Db, installation: &str) -> Vec<(Vec<u8>, TokenInfo)> {
    db.kv
        .scan_prefix(Tree::PluginMeta, &prefix(installation))
        .flatten()
        .filter_map(|(k, v)| Some((k.to_vec(), serde_json::from_slice(&v).ok()?)))
        .collect()
}

/// Every token of the installation, newest first. Metadata only.
pub fn list(db: &Db, installation: &str) -> Vec<TokenInfo> {
    let mut out: Vec<TokenInfo> = entries(db, installation)
        .into_iter()
        .map(|(_, info)| info)
        .collect();
    out.sort_by(|a, b| b.issued_at.cmp(&a.issued_at).then(b.id.cmp(&a.id)));
    out
}

/// Revokes the token with this id. `false` if there is none.
pub fn revoke(db: &Db, installation: &str, id: &str) -> Result<bool, String> {
    let Some((key, _)) = entries(db, installation)
        .into_iter()
        .find(|(_, info)| info.id == id)
    else {
        return Ok(false);
    };
    db.kv
        .remove(Tree::PluginMeta, &key)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Erases every token of the installation (on revocation and destruction).
pub fn erase(db: &Db, installation: &str) -> usize {
    let all = entries(db, installation);
    for (key, _) in &all {
        let _ = db.kv.remove(Tree::PluginMeta, key);
    }
    all.len()
}

// -- consent ------------------------------------------------------------------

/// A consent request, waiting for a person.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub installation: String,
    pub name: String,
    pub scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    /// The route URL the answer goes to.
    pub redirect: String,
    #[serde(skip)]
    pub state: Option<String>,
    pub expires_at: i64,
}

/// An approved consent, until its code is redeemed.
#[derive(Debug, Clone)]
struct Granted {
    installation: String,
    name: String,
    scopes: Vec<String>,
    client: Option<String>,
    approved_by: String,
    expires_at: i64,
}

/// What a redeemed code grants.
pub struct Redeemed {
    pub name: String,
    pub scopes: Vec<String>,
    pub client: Option<String>,
    pub approved_by: String,
}

/// Consent requests and codes, in memory. One per [`super::route_exec::RouteExecutor`].
#[derive(Default)]
pub struct Consents {
    pending: Mutex<HashMap<String, Pending>>,
    /// By the SHA-256 of the code.
    codes: Mutex<HashMap<String, Granted>>,
}

impl Consents {
    /// Records a request; returns its id for the consent page's URL.
    pub fn request(&self, pending: Pending, now: i64) -> Result<String, String> {
        check_scopes(&pending.scopes)?;
        check_client(&pending.client)?;
        if pending.state.as_ref().is_some_and(|s| s.len() > 512) {
            return Err("state is at most 512 characters".into());
        }
        let mut all = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        all.retain(|_, p| p.expires_at > now);
        let waiting = all
            .values()
            .filter(|p| p.installation == pending.installation)
            .count();
        if waiting >= MAX_PENDING {
            return Err("too many consent requests are waiting; try again later".into());
        }
        let id = random();
        all.insert(id.clone(), pending);
        Ok(id)
    }

    pub fn get(&self, id: &str, now: i64) -> Option<Pending> {
        let all = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        all.get(id).filter(|p| p.expires_at > now).cloned()
    }

    /// A person's answer. Consumes the request; returns where to send the
    /// browser: the route, with `code` and `state`, or `error=access_denied`.
    pub fn decide(&self, id: &str, approved_by: Option<&str>, now: i64) -> Result<String, String> {
        let pending = {
            let mut all = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            all.remove(id)
        }
        .filter(|p| p.expires_at > now)
        .ok_or("this consent request is unknown, answered or expired")?;
        let mut url = url::Url::parse(&pending.redirect).map_err(|e| e.to_string())?;
        {
            let mut query = url.query_pairs_mut();
            match approved_by {
                Some(agent) => {
                    let code = random();
                    let mut codes = self.codes.lock().unwrap_or_else(|e| e.into_inner());
                    codes.retain(|_, g| g.expires_at > now);
                    codes.insert(
                        hash(&code),
                        Granted {
                            installation: pending.installation.clone(),
                            name: pending.name.clone(),
                            scopes: pending.scopes.clone(),
                            client: pending.client.clone(),
                            approved_by: agent.to_string(),
                            expires_at: now + CODE_TTL_MS,
                        },
                    );
                    query.append_pair("code", &code);
                }
                None => {
                    query.append_pair("error", "access_denied");
                }
            }
            if let Some(state) = &pending.state {
                query.append_pair("state", state);
            }
        }
        Ok(url.to_string())
    }

    /// Redeems a code, once, for the installation it was granted to.
    pub fn redeem(&self, installation: &str, code: &str, now: i64) -> Result<Redeemed, String> {
        let mut codes = self.codes.lock().unwrap_or_else(|e| e.into_inner());
        let key = hash(code);
        match codes.get(&key) {
            Some(g) if g.expires_at > now && pure(&g.installation) == pure(installation) => {}
            _ => return Err("this code is unknown, used or expired".into()),
        }
        let g = codes.remove(&key).expect("checked above");
        Ok(Redeemed {
            name: g.name,
            scopes: g.scopes,
            client: g.client,
            approved_by: g.approved_by,
        })
    }

    /// Drops what an installation had waiting (on revocation).
    pub fn forget(&self, installation: &str) {
        let installation = pure(installation);
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, p| pure(&p.installation) != installation);
        self.codes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, g| pure(&g.installation) != installation);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "did:ad:installationA";
    const B: &str = "did:ad:installationB";

    #[tokio::test]
    async fn tokens_are_issued_hashed_verified_and_revoked() {
        let db = Db::init_temp("route_tokens").await.unwrap();
        let (token, info) = issue(
            &db,
            A,
            Issue {
                name: "storage".into(),
                scopes: vec!["notes:rw".into()],
                client: Some("https://app.example".into()),
                expires_at: Some(10_000),
                approved_by: None,
            },
            1_000,
        )
        .unwrap();
        assert!(token.starts_with(TOKEN_TEXT_PREFIX));
        // Stored hashed: neither the token nor a part of it is on disk.
        let secret = token.trim_start_matches(TOKEN_TEXT_PREFIX);
        for (k, v) in db
            .kv
            .scan_prefix(Tree::PluginMeta, TOKEN_PREFIX.as_bytes())
            .flatten()
        {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&k),
                String::from_utf8_lossy(&v)
            );
            assert!(
                !text.contains(secret) && !text.contains(&secret[..12]),
                "{text}"
            );
            assert!(text.contains(&hash(&token)));
        }
        assert_eq!(verify(&db, A, &token, 2_000), Some(info.clone()));
        // Not another installation's, not after expiry, not a changed token.
        assert_eq!(verify(&db, B, &token, 2_000), None);
        assert_eq!(verify(&db, A, &token, 10_000), None);
        assert_eq!(verify(&db, A, &format!("{token}x"), 2_000), None);
        assert_eq!(list(&db, A), vec![info.clone()]);
        assert!(list(&db, B).is_empty());
        // Revoking needs the id, and only this installation's.
        assert!(!revoke(&db, B, &info.id).unwrap());
        assert!(revoke(&db, A, &info.id).unwrap());
        assert_eq!(verify(&db, A, &token, 2_000), None);
        assert!(!revoke(&db, A, &info.id).unwrap());
        // Bad scopes and clients.
        for scopes in [
            vec!["".to_string()],
            vec!["a b".into()],
            vec!["x".repeat(129)],
        ] {
            assert!(issue(
                &db,
                A,
                Issue {
                    name: "storage".into(),
                    scopes,
                    client: None,
                    expires_at: None,
                    approved_by: None
                },
                1
            )
            .is_err());
        }
        // Erase takes everything.
        for _ in 0..3 {
            issue(
                &db,
                A,
                Issue {
                    name: "storage".into(),
                    scopes: vec![],
                    client: None,
                    expires_at: None,
                    approved_by: None,
                },
                1,
            )
            .unwrap();
        }
        assert_eq!(erase(&db, A), 3);
        assert!(list(&db, A).is_empty());
    }

    fn pending(installation: &str) -> Pending {
        Pending {
            installation: installation.into(),
            name: "storage".into(),
            scopes: vec!["notes:rw".into()],
            client: Some("https://app.example".into()),
            redirect: "https://api.example/_routes/abc/oauth/callback?x=1".into(),
            state: Some("s t".into()),
            expires_at: 1_000 + CONSENT_TTL_MS,
        }
    }

    #[test]
    fn a_code_is_given_once_for_an_approved_request_and_redeemed_once() {
        let consents = Consents::default();
        let id = consents.request(pending(A), 1_000).unwrap();
        assert_eq!(consents.get(&id, 2_000).unwrap().scopes, vec!["notes:rw"]);
        let redirect = consents
            .decide(&id, Some("did:ad:agent:owner"), 2_000)
            .unwrap();
        let url = url::Url::parse(&redirect).unwrap();
        assert!(redirect.starts_with("https://api.example/_routes/abc/oauth/callback?x=1&code="));
        let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
        assert_eq!(q["state"], "s t");
        let code = &q["code"];
        // Answered once.
        assert!(consents
            .decide(&id, Some("did:ad:agent:owner"), 2_000)
            .is_err());
        assert!(consents.get(&id, 2_000).is_none());
        // Not for another installation, and only once.
        assert!(consents.redeem(B, code, 3_000).is_err());
        let redeemed = consents.redeem(A, code, 3_000).unwrap();
        assert_eq!(redeemed.scopes, vec!["notes:rw"]);
        assert_eq!(redeemed.approved_by, "did:ad:agent:owner");
        assert!(consents.redeem(A, code, 3_000).is_err());
    }

    #[test]
    fn a_denied_or_expired_request_gives_no_code() {
        let consents = Consents::default();
        let id = consents.request(pending(A), 1_000).unwrap();
        let redirect = consents.decide(&id, None, 2_000).unwrap();
        assert!(redirect.contains("error=access_denied") && !redirect.contains("code="));
        let id = consents.request(pending(A), 1_000).unwrap();
        assert!(consents.get(&id, 1_000 + CONSENT_TTL_MS).is_none());
        assert!(consents
            .decide(&id, Some("did:ad:agent:owner"), 1_000 + CONSENT_TTL_MS)
            .is_err());
        // An approved code expires too.
        let id = consents.request(pending(A), 1_000).unwrap();
        let redirect = consents.decide(&id, Some("x"), 2_000).unwrap();
        let code = url::Url::parse(&redirect)
            .unwrap()
            .query_pairs()
            .find(|(k, _)| k == "code")
            .unwrap()
            .1
            .into_owned();
        assert!(consents.redeem(A, &code, 2_000 + CODE_TTL_MS).is_err());
        // Revocation forgets what was waiting.
        let id = consents.request(pending(A), 1_000).unwrap();
        consents.forget(A);
        assert!(consents.get(&id, 2_000).is_none());
    }
}
