//! Per-installation keypairs for plugin routes (#1718; design
//! `server-plugin-routes.md` in atomic-plugins, sections 2.2 `keys`, 2.7
//! "Key misuse", 2.9, D3, D8).
//!
//! A release declares `http.keys` (`rsa-sha256` or `ed25519`). The host
//! generates each one when the Installation is activated on the node that
//! serves its routes, and keeps it in `Tree::PluginSecret`, wrapped with the
//! node key like the plugin's other secrets. Keys belong to the Installation,
//! not the release, so an upgrade keeps them; revoking or destroying the
//! Installation erases them.
//!
//! The private half never leaves this module: not into the sandbox, the run
//! log, a response or a log line. A plugin gets two host calls:
//!
//! - `ctx.keys.publicKey(name, { keyId })`: the SPKI PEM, for an ActivityPub
//!   actor's `publicKeyPem`.
//! - `ctx.keys.sign({ key, keyId, operation, request })`: the host signs an
//!   outbound request (draft-cavage-12 for `rsa-sha256`, RFC 9421 for
//!   `ed25519`) and returns the headers to send. Only declared key names,
//!   only for a declared operation with that method, and every signature is
//!   logged with its operation id.
//!
//! A `keyId` inside the installation's own route space (its slug host or its
//! `/_routes/<slug>/` prefix) is recorded when the plugin publishes or signs
//! with it, so this node verifies its own installations' signatures without
//! fetching its own URLs (which the egress guard would refuse on a private
//! network anyway).

use atomic_lib::{db::trees::Tree, Db, Subject};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rsa::{
    pkcs8::{DecodePrivateKey, EncodePrivateKey},
    signature::{RandomizedSigner, SignatureEncoding},
    RsaPrivateKey,
};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use super::{
    http_signatures::{self, Algorithm, Outbound, PublicKey, Signer},
    manifest::Manifest,
    manifest_http::{Key, KeyAlg},
};

/// `Tree::PluginSecret`: `route-key:<installation pure id>\0<name>`.
const SECRET_PREFIX: &str = "route-key:";
/// `Tree::PluginMeta`: `route-key-id:<keyId>` → the installation and key.
const KEY_ID_PREFIX: &str = "route-key-id:";
/// Bound `keyId`s per key.
const MAX_KEY_IDS: usize = 16;
pub const RSA_BITS: usize = 2048;
/// How a signature's run-log line starts; such runs are always logged.
pub const SIGNED_LOG_PREFIX: &str = "signed a ";

fn pure(subject: &str) -> String {
    Subject::from(subject).pure_id()
}

fn installation_prefix(installation: &str) -> Vec<u8> {
    format!("{SECRET_PREFIX}{}\0", pure(installation)).into_bytes()
}

fn secret_key(installation: &str, name: &str) -> Vec<u8> {
    let mut key = installation_prefix(installation);
    key.extend_from_slice(name.as_bytes());
    key
}

/// What is stored per key. `private` is wrapped with the node key.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    alg: KeyAlg,
    /// PKCS #8 DER (RSA) or the 32-byte seed (Ed25519), base64, then
    /// wrapped by [`Db::wrap_node_secret`].
    private: String,
    public_pem: String,
    created_at: i64,
    #[serde(default)]
    key_ids: Vec<String>,
}

impl std::fmt::Debug for Stored {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Stored")
            .field("alg", &self.alg)
            .field("private", &"[redacted]")
            .field("created_at", &self.created_at)
            .field("key_ids", &self.key_ids)
            .finish()
    }
}

fn read(db: &Db, installation: &str, name: &str) -> Result<Option<Stored>, String> {
    let Some(bytes) = db
        .kv
        .get(Tree::PluginSecret, &secret_key(installation, name))
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| format!("the stored key `{name}` is unreadable: {e}"))
}

fn write(db: &Db, installation: &str, name: &str, stored: &Stored) -> Result<(), String> {
    let bytes = serde_json::to_vec(stored).map_err(|e| e.to_string())?;
    db.kv
        .insert(Tree::PluginSecret, &secret_key(installation, name), &bytes)
        .map_err(|e| e.to_string())
}

/// A private key, loaded for one signature. No `Debug`, no `Serialize`.
pub struct InstallationKey {
    private: Private,
}

enum Private {
    Rsa(Box<RsaPrivateKey>),
    Ed25519(Box<ed25519_dalek::SigningKey>),
}

impl std::fmt::Debug for InstallationKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("InstallationKey([redacted])")
    }
}

impl Signer for InstallationKey {
    fn algorithm(&self) -> Algorithm {
        match self.private {
            Private::Rsa(_) => Algorithm::RsaV15Sha256,
            Private::Ed25519(_) => Algorithm::Ed25519,
        }
    }

    fn sign(&self, data: &[u8]) -> Vec<u8> {
        match &self.private {
            // Blinded: `sign_with_rng` randomizes the private operation.
            Private::Rsa(key) => rsa::pkcs1v15::SigningKey::<Sha256>::new((**key).clone())
                .sign_with_rng(&mut rand::rngs::OsRng, data)
                .to_vec(),
            Private::Ed25519(key) => {
                use ed25519_dalek::Signer as _;
                key.sign(data).to_bytes().to_vec()
            }
        }
    }
}

fn generate(alg: KeyAlg, now: i64, db: &Db) -> Result<Stored, String> {
    let (private, public) = match alg {
        KeyAlg::RsaSha256 => {
            let key = RsaPrivateKey::new(&mut rand::rngs::OsRng, RSA_BITS)
                .map_err(|e| format!("could not generate an RSA key: {e}"))?;
            let der = key
                .to_pkcs8_der()
                .map_err(|e| format!("could not encode an RSA key: {e}"))?;
            (
                B64.encode(der.as_bytes()),
                PublicKey::Rsa(key.to_public_key()),
            )
        }
        KeyAlg::Ed25519 => {
            let key = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
            (
                B64.encode(key.to_bytes()),
                PublicKey::Ed25519(key.verifying_key()),
            )
        }
    };
    Ok(Stored {
        alg,
        private: db.wrap_node_secret(&private).map_err(|e| e.to_string())?,
        public_pem: public.to_pem(),
        created_at: now,
        key_ids: Vec::new(),
    })
}

/// Generates every declared key the installation does not have yet (on
/// activation). A key whose declared algorithm changed is replaced. Keys the
/// release no longer declares are kept: they belong to the Installation, and
/// a later release may declare them again.
pub fn ensure(db: &Db, installation: &str, keys: &[Key]) -> Result<Vec<String>, String> {
    let now = atomic_lib::utils::now();
    let mut generated = Vec::new();
    for key in keys {
        match read(db, installation, &key.name)? {
            Some(stored) if stored.alg == key.alg => continue,
            Some(stored) => {
                tracing::warn!(
                    installation,
                    key = key.name,
                    "the release declares key `{}` with another algorithm; replacing it",
                    key.name
                );
                forget_key_ids(db, &stored.key_ids);
            }
            None => {}
        }
        write(db, installation, &key.name, &generate(key.alg, now, db)?)?;
        generated.push(key.name.clone());
    }
    Ok(generated)
}

/// The public half of a key, as `ctx.keys.publicKey` returns it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicInfo {
    pub name: String,
    pub alg: KeyAlg,
    pub public_key_pem: String,
    pub created_at: i64,
}

fn declared<'a>(manifest: &'a Manifest, name: &str) -> Result<&'a Key, String> {
    manifest
        .http
        .as_ref()
        .and_then(|h| h.keys.iter().find(|k| k.name == name))
        .ok_or_else(|| format!("this plugin declares no key named `{name}`"))
}

/// A declared key's public half, generating the key if activation did not.
pub fn public(
    db: &Db,
    installation: &str,
    manifest: &Manifest,
    name: &str,
) -> Result<PublicInfo, String> {
    let key = declared(manifest, name)?;
    ensure(db, installation, std::slice::from_ref(key))?;
    let stored = read(db, installation, name)?.ok_or("the key was not stored")?;
    Ok(PublicInfo {
        name: name.to_string(),
        alg: stored.alg,
        public_key_pem: stored.public_pem,
        created_at: stored.created_at,
    })
}

fn load(db: &Db, installation: &str, name: &str) -> Result<InstallationKey, String> {
    let stored = read(db, installation, name)?.ok_or("the key was not stored")?;
    let encoded = db
        .unwrap_node_secret(&stored.private)
        .map_err(|_| format!("the key `{name}` cannot be opened on this node"))?;
    let raw = B64
        .decode(encoded)
        .map_err(|_| format!("the key `{name}` is damaged"))?;
    let private = match stored.alg {
        KeyAlg::RsaSha256 => Private::Rsa(Box::new(
            RsaPrivateKey::from_pkcs8_der(&raw)
                .map_err(|_| format!("the key `{name}` is damaged"))?,
        )),
        KeyAlg::Ed25519 => Private::Ed25519(Box::new(ed25519_dalek::SigningKey::from_bytes(
            &raw.try_into()
                .map_err(|_| format!("the key `{name}` is damaged"))?,
        ))),
    };
    Ok(InstallationKey { private })
}

/// Records that `key_id` names this installation's key `name`, so inbound
/// signatures with it verify locally. Only for a `keyId` in the
/// installation's own route space; the caller checks that.
pub fn bind_key_id(db: &Db, installation: &str, name: &str, key_id: &str) -> Result<(), String> {
    let index = format!("{KEY_ID_PREFIX}{key_id}");
    let entry = serde_json::json!({ "installation": pure(installation), "key": name });
    if let Some(existing) = db
        .kv
        .get(Tree::PluginMeta, index.as_bytes())
        .map_err(|e| e.to_string())?
    {
        if serde_json::from_slice::<serde_json::Value>(&existing).ok() == Some(entry.clone()) {
            return Ok(());
        }
    }
    let mut stored = read(db, installation, name)?.ok_or("the key was not stored")?;
    if !stored.key_ids.iter().any(|k| k == key_id) {
        if stored.key_ids.len() >= MAX_KEY_IDS {
            return Err(format!(
                "the key `{name}` already has {MAX_KEY_IDS} keyIds; use one of them"
            ));
        }
        stored.key_ids.push(key_id.to_string());
        write(db, installation, name, &stored)?;
    }
    db.kv
        .insert(
            Tree::PluginMeta,
            index.as_bytes(),
            entry.to_string().as_bytes(),
        )
        .map_err(|e| e.to_string())
}

fn forget_key_ids(db: &Db, key_ids: &[String]) {
    for key_id in key_ids {
        let _ = db.kv.remove(
            Tree::PluginMeta,
            format!("{KEY_ID_PREFIX}{key_id}").as_bytes(),
        );
    }
}

/// The public key a local installation published under `key_id`, and that
/// installation.
pub fn local_key(db: &Db, key_id: &str) -> Option<(String, PublicKey)> {
    let bytes = db
        .kv
        .get(
            Tree::PluginMeta,
            format!("{KEY_ID_PREFIX}{key_id}").as_bytes(),
        )
        .ok()??;
    let entry: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let installation = entry["installation"].as_str()?;
    let stored = read(db, installation, entry["key"].as_str()?).ok()??;
    stored
        .key_ids
        .iter()
        .any(|k| k == key_id)
        .then(|| PublicKey::from_pem(&stored.public_pem).ok())
        .flatten()
        .map(|key| (installation.to_string(), key))
}

/// Erases every key of the installation and its `keyId` bindings (on
/// revocation and destruction). Returns how many keys were erased.
pub fn erase(db: &Db, installation: &str) -> usize {
    let prefix = installation_prefix(installation);
    let entries: Vec<(Vec<u8>, Vec<u8>)> = db
        .kv
        .scan_prefix(Tree::PluginSecret, &prefix)
        .flatten()
        .map(|(k, v)| (k.to_vec(), v.to_vec()))
        .collect();
    for (key, value) in &entries {
        if let Ok(stored) = serde_json::from_slice::<Stored>(value) {
            forget_key_ids(db, &stored.key_ids);
        }
        if let Err(e) = db.kv.remove(Tree::PluginSecret, key) {
            tracing::warn!(installation, "could not erase a plugin route key: {e}");
        }
    }
    entries.len()
}

/// `ctx.keys.sign`: what the plugin asks the host to sign.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignRequest {
    pub key: String,
    pub key_id: String,
    pub operation: String,
    pub request: OutboundRequest,
    /// `draft-cavage-12` or `rfc9421`. Defaults to cavage for `rsa-sha256`
    /// (what the fediverse verifies) and RFC 9421 for `ed25519`.
    #[serde(default)]
    pub format: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutboundRequest {
    #[serde(default = "get")]
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub body: Option<String>,
}

fn get() -> String {
    "GET".into()
}

/// Signs an outbound request with a declared key, for a declared operation.
/// Returns the headers to send, and a line for the run log. The request is
/// not sent here: sending goes through the egress guard (and, for writes,
/// the delivery queue).
pub fn sign(
    db: &Db,
    installation: &str,
    manifest: &Manifest,
    request: &SignRequest,
    now: std::time::SystemTime,
) -> Result<(serde_json::Value, String), String> {
    let key = declared(manifest, &request.key)?;
    let method = request.request.method.to_ascii_uppercase();
    let operation = manifest
        .operations
        .iter()
        .find(|o| o.id == request.operation)
        .ok_or_else(|| format!("this plugin declares no operation `{}`", request.operation))?;
    if !operation.method.eq_ignore_ascii_case(&method) {
        return Err(format!(
            "operation `{}` is a {}, not a {method}",
            operation.id, operation.method
        ));
    }
    let url = url::Url::parse(&request.request.url).map_err(|e| format!("not a URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("only HTTP and HTTPS requests are signed".into());
    }
    if request.key_id.is_empty() || request.key_id.len() > 2048 {
        return Err("keyId must be given, and at most 2048 characters".into());
    }
    ensure(db, installation, std::slice::from_ref(key))?;
    let signer = load(db, installation, &request.key)?;
    let outbound = Outbound {
        method: &method,
        url: &url,
        body: request.request.body.as_deref().map(str::as_bytes),
    };
    let format = match request.format.as_deref() {
        Some("draft-cavage-12") => http_signatures::Scheme::Cavage,
        Some("rfc9421") => http_signatures::Scheme::Rfc9421,
        None if key.alg == KeyAlg::RsaSha256 => http_signatures::Scheme::Cavage,
        None => http_signatures::Scheme::Rfc9421,
        Some(other) => return Err(format!("unknown signature format `{other}`")),
    };
    let headers = match format {
        http_signatures::Scheme::Cavage => {
            http_signatures::sign_cavage(&signer, &request.key_id, &outbound, now)
        }
        http_signatures::Scheme::Rfc9421 => {
            http_signatures::sign_rfc9421(&signer, &request.key_id, &outbound, now)
        }
    };
    let host = url.host_str().unwrap_or_default().to_string();
    tracing::info!(
        installation,
        key = request.key,
        operation = request.operation,
        key_id = request.key_id,
        host,
        "plugin route key signed a request"
    );
    let log = format!(
        "{SIGNED_LOG_PREFIX}{method} to {host} with key `{}` for operation `{}`",
        request.key, request.operation
    );
    Ok((
        serde_json::json!({
            "headers": headers.into_iter().map(|(n, v)| (n, serde_json::Value::String(v))).collect::<serde_json::Map<_, _>>(),
            "keyId": request.key_id,
            "alg": signer.algorithm().rfc9421_name(),
            "format": format.as_str(),
        }),
        log,
    ))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The stored private key's base64, for tests that check it never shows
    /// up anywhere. Test-only by construction.
    pub(crate) fn private_base64(db: &Db, installation: &str, name: &str) -> String {
        let stored = read(db, installation, name).unwrap().unwrap();
        db.unwrap_node_secret(&stored.private).unwrap()
    }

    fn manifest() -> Manifest {
        Manifest::parse(serde_json::json!({
            "schemaVersion": 3,
            "operations": [
                { "id": "deliver", "method": "POST", "url": "https://*/inbox", "effect": "write" }
            ],
            "http": {
                "mount": "drive-prefix",
                "routes": [{
                    "id": "outbox", "path": "/outbox", "methods": ["POST"],
                    "principal": "anonymous", "auth": "none", "enqueues": ["deliver"]
                }],
                "keys": [
                    { "name": "actor-key", "alg": "rsa-sha256" },
                    { "name": "ed-key", "alg": "ed25519" }
                ]
            }
        }))
        .unwrap()
        .unwrap()
    }

    const INSTALLATION: &str = "did:ad:installationK";

    #[tokio::test]
    async fn keys_are_generated_once_signed_with_and_erased() {
        let db = Db::init_temp("route_keys_lifecycle").await.unwrap();
        let m = manifest();
        let keys = &m.http.as_ref().unwrap().keys;
        assert_eq!(ensure(&db, INSTALLATION, keys).unwrap().len(), 2);
        // Kept across an upgrade (the same declaration): nothing new.
        assert!(ensure(&db, INSTALLATION, keys).unwrap().is_empty());
        let rsa = public(&db, INSTALLATION, &m, "actor-key").unwrap();
        assert!(rsa.public_key_pem.starts_with("-----BEGIN PUBLIC KEY-----"));
        let rsa_key = PublicKey::from_pem(&rsa.public_key_pem).unwrap();
        rsa_key.check_strength().unwrap();
        assert!(public(&db, INSTALLATION, &m, "undeclared").is_err());

        // The host signs; the signature verifies with nothing but the
        // published public key, through an independent RSA check of the
        // cavage signing string.
        let request = SignRequest {
            key: "actor-key".into(),
            key_id: "https://a.example/actor#main-key".into(),
            operation: "deliver".into(),
            request: OutboundRequest {
                method: "post".into(),
                url: "https://b.example/inbox".into(),
                body: Some("{\"type\":\"Follow\"}".into()),
            },
            format: None,
        };
        let (signed, log) = sign(
            &db,
            INSTALLATION,
            &m,
            &request,
            std::time::SystemTime::now(),
        )
        .unwrap();
        assert!(
            log.contains("deliver") && log.contains("actor-key"),
            "{log}"
        );
        let headers = signed["headers"].as_object().unwrap();
        let signature = headers["signature"].as_str().unwrap();
        assert!(signature.contains("keyId=\"https://a.example/actor#main-key\""));
        assert!(signature.contains("headers=\"(request-target) host date digest\""));
        let value = signature
            .split("signature=\"")
            .nth(1)
            .unwrap()
            .trim_end_matches('"');
        let string = format!(
            "(request-target): post /inbox\nhost: b.example\ndate: {}\ndigest: {}",
            headers["date"].as_str().unwrap(),
            headers["digest"].as_str().unwrap()
        );
        let PublicKey::Rsa(rsa_public) = &rsa_key else {
            panic!()
        };
        use rsa::signature::Verifier;
        rsa::pkcs1v15::VerifyingKey::<Sha256>::new(rsa_public.clone())
            .verify(
                string.as_bytes(),
                &rsa::pkcs1v15::Signature::try_from(&B64.decode(value).unwrap()[..]).unwrap(),
            )
            .expect("an independent RSA check accepts the host's signature");

        // Ed25519 signs RFC 9421 by default.
        let (signed, _) = sign(
            &db,
            INSTALLATION,
            &m,
            &SignRequest {
                key: "ed-key".into(),
                ..request
            },
            std::time::SystemTime::now(),
        )
        .unwrap();
        assert_eq!(signed["format"], "rfc9421");
        assert!(signed["headers"]["signature-input"]
            .as_str()
            .unwrap()
            .starts_with("sig1=(\"@method\" \"@target-uri\" \"content-digest\")"));

        // Undeclared keys and operations, and a method the operation is not.
        for (key, operation, method) in [
            ("nope", "deliver", "POST"),
            ("actor-key", "nope", "POST"),
            ("actor-key", "deliver", "GET"),
        ] {
            let bad = SignRequest {
                key: key.into(),
                key_id: "k".into(),
                operation: operation.into(),
                request: OutboundRequest {
                    method: method.into(),
                    url: "https://b.example/inbox".into(),
                    body: None,
                },
                format: None,
            };
            assert!(sign(&db, INSTALLATION, &m, &bad, std::time::SystemTime::now()).is_err());
        }

        // A bound keyId resolves locally, until the keys are erased.
        bind_key_id(
            &db,
            INSTALLATION,
            "actor-key",
            "https://a.example/actor#main-key",
        )
        .unwrap();
        let (owner, local) = local_key(&db, "https://a.example/actor#main-key").unwrap();
        assert_eq!(owner, pure(INSTALLATION));
        assert_eq!(local, rsa_key);
        assert_eq!(erase(&db, INSTALLATION), 2);
        assert!(local_key(&db, "https://a.example/actor#main-key").is_none());
        assert!(read(&db, INSTALLATION, "actor-key").unwrap().is_none());
    }

    #[tokio::test]
    async fn private_keys_are_wrapped_at_rest_and_redacted_in_debug() {
        let db = Db::init_temp("route_keys_at_rest").await.unwrap();
        db.set_node_key([7; atomic_lib::vault::keys::KEK_LEN]);
        let m = manifest();
        ensure(&db, INSTALLATION, &m.http.as_ref().unwrap().keys).unwrap();
        let private = private_base64(&db, INSTALLATION, "ed-key");
        let on_disk = db
            .kv
            .get(Tree::PluginSecret, &secret_key(INSTALLATION, "ed-key"))
            .unwrap()
            .unwrap();
        assert!(!String::from_utf8_lossy(&on_disk).contains(&private));
        let stored = read(&db, INSTALLATION, "ed-key").unwrap().unwrap();
        assert!(!format!("{stored:?}").contains(&stored.private));
        let loaded = load(&db, INSTALLATION, "ed-key").unwrap();
        assert_eq!(format!("{loaded:?}"), "InstallationKey([redacted])");
    }
}
