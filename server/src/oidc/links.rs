//! The persistent half of OIDC sign-in: which agent an OIDC identity belongs
//! to, and that agent's client-encrypted recovery blob.
//!
//! Lives in `Tree::PluginMeta` under the `oidc/v1/link/` prefix (the tree the
//! search index and vault sync already share by prefix), so it needs no new
//! `Tree` variant, no lib change and no migration. The key is a hash of
//! `(issuer, sub)`; the email claim is never stored or looked up.

use atomic_lib::{db::trees::Tree, errors::AtomicResult, Db};
use ring::digest;
use serde::{Deserialize, Serialize};

const PREFIX: &str = "oidc/v1/link/";

/// Opaque to the server: encrypted in the browser under a passphrase.
pub const MAX_RECOVERY_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    /// `did:ad:agent:{publicKey}`.
    pub agent: String,
    /// Ciphertext produced by the client. Never decrypted here.
    pub recovery: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn key(issuer: &str, sub: &str) -> Vec<u8> {
    let mut ctx = digest::Context::new(&digest::SHA256);
    ctx.update(issuer.as_bytes());
    ctx.update(&[0]);
    ctx.update(sub.as_bytes());
    let hash = ctx.finish();

    format!("{PREFIX}{}", hex::encode(hash.as_ref())).into_bytes()
}

pub fn get(store: &Db, issuer: &str, sub: &str) -> AtomicResult<Option<Link>> {
    let Some(bytes) = store.kv.get(Tree::PluginMeta, &key(issuer, sub))? else {
        return Ok(None);
    };

    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| format!("Corrupt OIDC link: {e}").into())
}

/// Writes the link. `replace` is the caller's explicit consent to overwrite.
/// Returns `false` (and writes nothing) when a link exists and `replace` is
/// not set.
pub fn put(
    store: &Db,
    issuer: &str,
    sub: &str,
    agent: &str,
    recovery: &str,
    replace: bool,
    now_ms: i64,
) -> AtomicResult<bool> {
    let existing = get(store, issuer, sub)?;

    if existing.is_some() && !replace {
        return Ok(false);
    }

    let link = Link {
        agent: agent.to_string(),
        recovery: recovery.to_string(),
        created_at: existing.map(|l| l.created_at).unwrap_or(now_ms),
        updated_at: now_ms,
    };

    store.kv.insert(
        Tree::PluginMeta,
        &key(issuer, sub),
        &serde_json::to_vec(&link).map_err(|e| e.to_string())?,
    )?;
    store.flush()?;

    Ok(true)
}

pub fn delete(store: &Db, issuer: &str, sub: &str) -> AtomicResult<bool> {
    let existed = get(store, issuer, sub)?.is_some();

    if existed {
        store.kv.remove(Tree::PluginMeta, &key(issuer, sub))?;
        store.flush()?;
    }

    Ok(existed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn link_is_keyed_on_issuer_and_sub_and_never_overwritten_silently() {
        let store = Db::init_temp("oidc_links").await.unwrap();
        let iss = "https://idp.example";

        assert!(get(&store, iss, "u1").unwrap().is_none());
        assert!(put(&store, iss, "u1", "did:ad:agent:AAA", "blob1", false, 10).unwrap());
        let l = get(&store, iss, "u1").unwrap().unwrap();
        assert_eq!(l.agent, "did:ad:agent:AAA");
        assert_eq!(l.created_at, 10);

        // No replace flag: refused, untouched.
        assert!(!put(&store, iss, "u1", "did:ad:agent:BBB", "blob2", false, 20).unwrap());
        assert_eq!(
            get(&store, iss, "u1").unwrap().unwrap().agent,
            "did:ad:agent:AAA"
        );

        // Explicit replace keeps created_at, bumps updated_at.
        assert!(put(&store, iss, "u1", "did:ad:agent:BBB", "blob2", true, 30).unwrap());
        let l = get(&store, iss, "u1").unwrap().unwrap();
        assert_eq!(
            (l.agent.as_str(), l.created_at, l.updated_at),
            ("did:ad:agent:BBB", 10, 30)
        );

        // Different sub or issuer is a different identity (no email involved).
        assert!(get(&store, iss, "u2").unwrap().is_none());
        assert!(get(&store, "https://other.example", "u1")
            .unwrap()
            .is_none());

        assert!(delete(&store, iss, "u1").unwrap());
        assert!(!delete(&store, iss, "u1").unwrap());
        assert!(get(&store, iss, "u1").unwrap().is_none());
    }
}
