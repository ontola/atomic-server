use atomic_lib::errors::AtomicResult;
use atomic_lib::storelike::Storelike;
use atomic_lib::{Resource, Subject};
use mainline::{Dht, Id};
use sha1::{Digest, Sha1};
use std::net::{SocketAddr, SocketAddrV4};
use url::Url;

/// DhtService provides a wrapper around the Mainline DHT for Drive discovery.
/// In `did:ad:{drive_hash}:...` the drive_hash is the SHA1 hash of the drive.
/// We link that to
#[derive(Clone)]
pub struct DhtService {
    dht: Dht,
}

impl DhtService {
    /// Starts a new DHT client.
    pub fn new() -> AtomicResult<Self> {
        let mut builder = Dht::builder();
        if let Ok(bootstrap) = std::env::var("ATOMIC_DHT_BOOTSTRAP") {
            let addrs: Vec<String> = bootstrap.split(',').map(|s| s.to_string()).collect();
            builder.bootstrap(&addrs);
        }
        let dht = builder
            .build()
            .map_err(|e| format!("Failed to start DHT: {}", e))?;
        Ok(Self { dht })
    }

    /// Announces a drive on the DHT.
    /// The drive_hash_hex is converted to a 20-byte SHA-1 ID.
    pub fn announce_drive(&self, drive_hash_hex: &str, port: u16) -> AtomicResult<()> {
        let drive_hash =
            hex::decode(drive_hash_hex).map_err(|e| format!("Invalid drive hash hex: {}", e))?;

        let mut hasher = Sha1::new();
        hasher.update(&drive_hash);
        let sha1_hash: [u8; 20] = hasher.finalize().into();
        let id = Id::from(sha1_hash);

        tracing::info!(
            "Announcing drive {} on DHT (ID: {:?}) on port {}",
            drive_hash_hex,
            id,
            port
        );

        self.dht
            .announce_peer(id, Some(port))
            .map_err(|e| format!("Failed to announce drive on DHT: {}", e))?;

        Ok(())
    }

    /// Searches for peers hosting a specific drive on the DHT.
    pub fn resolve_drive(&self, drive_hash_hex: &str) -> AtomicResult<Vec<SocketAddr>> {
        let drive_hash =
            hex::decode(drive_hash_hex).map_err(|e| format!("Invalid drive hash hex: {}", e))?;

        let mut hasher = Sha1::new();
        hasher.update(&drive_hash);
        let sha1_hash: [u8; 20] = hasher.finalize().into();
        let id = Id::from(sha1_hash);

        let peers: Vec<SocketAddr> = self
            .dht
            .get_peers(id)
            .flat_map(|batch: Vec<SocketAddrV4>| batch.into_iter().map(SocketAddr::from))
            .collect();

        tracing::debug!(
            "DHT: get_peers for drive {} returned {} peer(s): {:?}",
            drive_hash_hex,
            peers.len(),
            peers
        );

        Ok(peers)
    }

    /// Resolves a `did:ad` subject by looking up peers on the DHT and fetching the resource.
    ///
    /// 1. Extracts the drive hash from the DID.
    /// 2. Queries the DHT for peers hosting that drive.
    /// 3. Tries each peer in order, fetching the resource via the peer's normal HTTP API
    ///    (i.e. `http://{peer}/{did_subject}` with an `Accept: application/ad+json` header).
    /// 4. Parses the JSON-AD response and returns the matching resource.
    pub async fn resolve(
        &self,
        subject: &Subject,
        store: &impl Storelike,
    ) -> AtomicResult<Resource> {
        let did_str = subject.as_str();

        let drive_hash = Self::extract_drive_hash(did_str).ok_or_else(|| {
            format!(
                "Cannot resolve DID via DHT — not a drive resource DID: {}",
                did_str
            )
        })?;

        let peers = self.resolve_drive(&drive_hash)?;
        if peers.is_empty() {
            return Err(format!("No peers found for drive {} on DHT", drive_hash).into());
        }

        let peer_count = peers.len();
        tracing::info!(
            "DHT: Found {} peer(s) for drive {}, resolving {}",
            peer_count,
            drive_hash,
            did_str
        );

        let client = reqwest::Client::new();

        for peer in &peers {
            // Fetch from the peer's normal resource endpoint.
            // The DID goes in the URL path — the peer's catch-all GET handler
            // will parse it via Subject::from_raw and serve it from its local store.
            let url = format!("http://{}/{}", peer, did_str);

            tracing::info!(
                "DHT: Trying to resolve {} from peer {} ({})",
                did_str,
                peer,
                url
            );

            let result = client
                .get(&url)
                .header("Accept", atomic_lib::parse::JSON_AD_MIME)
                .send()
                .await;

            match result {
                Ok(resp) => {
                    if resp.status().is_success() {
                        let body = resp.text().await.map_err(|e| {
                            format!("Failed to read response body from peer {}: {}", peer, e)
                        })?;
                        let resources = atomic_lib::parse::parse_json_ad_string(
                            &body,
                            store,
                            &atomic_lib::parse::ParseOpts::default(),
                        )
                        .await
                        .map_err(|e| {
                            format!(
                                "Failed to parse JSON-AD from peer {} for {}: {}",
                                peer, did_str, e
                            )
                        })?;

                        let pure_did = subject.pure_id();
                        if let Some(resource) = resources
                            .into_iter()
                            .find(|r| r.get_subject().pure_id() == pure_did)
                        {
                            tracing::info!(
                                "DHT: Successfully resolved {} from peer {}",
                                did_str,
                                peer
                            );
                            return Ok(resource);
                        } else {
                            tracing::warn!(
                                "DHT: Peer {} returned success but response did not contain {}",
                                peer,
                                did_str
                            );
                        }
                    } else {
                        tracing::warn!(
                            "DHT: Peer {} returned status {} for {}",
                            peer,
                            resp.status(),
                            did_str
                        );
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        "DHT: Failed to connect to peer {} for {}: {}",
                        peer,
                        did_str,
                        e
                    );
                    continue;
                }
            }
        }

        Err(format!(
            "Could not resolve DID {} from any of the {} discovered peers",
            did_str, peer_count
        )
        .into())
    }

    /// Extracts the drive hash from a `did:ad:{genesis}?drive={hash}` DID URL.
    /// Returns None if the DID is not a drive resource DID (e.g. agent DIDs without routing hints).
    /// For backwards compatibility, it also attempts to extract from legacy format `did:ad:{drive_hash}:{path}`.
    pub fn extract_drive_hash(did_str: &str) -> Option<String> {
        // 1. Try to extract from standard W3C parameter `?drive=hash`
        if let Ok(url) = Url::parse(did_str) {
            for (k, v) in url.query_pairs() {
                if k == "drive" {
                    if hex::decode(v.as_ref()).is_ok() {
                        return Some(v.to_string());
                    }
                }
            }
        }

        // 2. Fallback for legacy format: did:ad:{hash}:path
        let stripped = did_str.strip_prefix("did:ad:")?;

        // Agent DIDs used to start with "agent:", keep that check for
        // backwards compatibility with any persisted data.
        if stripped.starts_with("agent:") {
            return None;
        }

        // The drive hash is the next component before any ':' or '?'
        let drive_hash = stripped.split(':').next()?.split('?').next()?;
        if drive_hash.is_empty() {
            return None;
        }

        // Drive hashes are hex-encoded strings.  Agent public keys are
        // base64-encoded and will contain characters like '/', '+', or '='
        // that are never valid hex.  Reject non-hex values so we don't
        // accidentally treat an agent DID as a drive hash.
        if hex::decode(drive_hash).is_err() {
            return None;
        }

        Some(drive_hash.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_drive_hash_resource_did() {
        // New query parameter syntax
        let did = "did:ad:genesis-sig-here?drive=4faf1b2e0a077e6a9d92fa051f256038";
        let hash = DhtService::extract_drive_hash(did);
        assert_eq!(hash, Some("4faf1b2e0a077e6a9d92fa051f256038".to_string()));

        // Legacy syntax
        let did_legacy = "did:ad:4faf1b2e0a077e6a9d92fa051f256038:documents/meeting-notes";
        let hash_legacy = DhtService::extract_drive_hash(did_legacy);
        assert_eq!(
            hash_legacy,
            Some("4faf1b2e0a077e6a9d92fa051f256038".to_string())
        );
    }

    #[test]
    fn extract_drive_hash_root_resource() {
        let did = "did:ad:4faf1b2e0a077e6a9d92fa051f256038";
        let hash = DhtService::extract_drive_hash(did);
        assert_eq!(hash, Some("4faf1b2e0a077e6a9d92fa051f256038".to_string()));
    }

    #[test]
    fn extract_drive_hash_agent_did_legacy() {
        // Legacy format with "agent:" prefix
        let did = "did:ad:agent:7LsjMW5gOfDdJzK/atgjQ1t20J/rw8MjVg6xwqm+h8U=";
        let hash = DhtService::extract_drive_hash(did);
        assert_eq!(hash, None);
    }

    #[test]
    fn extract_drive_hash_agent_did() {
        // New format: did:ad:<base64-pubkey> — not a valid hex drive hash
        let did = "did:ad:7LsjMW5gOfDdJzK/atgjQ1t20J/rw8MjVg6xwqm+h8U=";
        let hash = DhtService::extract_drive_hash(did);
        assert_eq!(hash, None);
    }

    #[test]
    fn extract_drive_hash_invalid() {
        assert_eq!(DhtService::extract_drive_hash("not-a-did"), None);
        assert_eq!(DhtService::extract_drive_hash("did:ad:"), None);
    }
}
