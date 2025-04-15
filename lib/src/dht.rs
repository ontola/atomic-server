#[cfg(feature = "dht")]
use mainline::{Dht, Id};
#[cfg(feature = "dht")]
use sha1::{Digest, Sha1};
use std::net::SocketAddr;
#[cfg(feature = "dht")]
use std::net::SocketAddrV4;

use crate::errors::AtomicResult;
use crate::storelike::Storelike;
use crate::{Resource, Subject};

/// DhtService provides a wrapper around the Mainline DHT for Drive discovery.
#[derive(Clone)]
pub struct DhtService {
    #[cfg(feature = "dht")]
    dht: Dht,
}

impl DhtService {
    /// Starts a new DHT client.
    pub fn new() -> AtomicResult<Self> {
        #[cfg(feature = "dht")]
        {
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
        #[cfg(not(feature = "dht"))]
        Err("DHT feature not enabled".into())
    }

    /// Derives a 20-byte DHT ID from a Drive DID string.
    #[cfg(feature = "dht")]
    fn derive_id(drive_did: &str) -> Id {
        let mut hasher = Sha1::new();
        hasher.update(drive_did.as_bytes());
        let sha1_hash: [u8; 20] = hasher.finalize().into();
        Id::from(sha1_hash)
    }

    /// Announces a drive on the DHT using its DID.
    pub fn announce_drive(&self, _drive_did: &str, _port: u16) -> AtomicResult<()> {
        #[cfg(feature = "dht")]
        {
            let id = Self::derive_id(_drive_did);

            tracing::info!(
                "Announcing drive {} on DHT (ID: {:?}) on port {}",
                _drive_did,
                id,
                _port
            );

            self.dht
                .announce_peer(id, Some(_port))
                .map_err(|e| format!("Failed to announce drive on DHT: {}", e))?;

            Ok(())
        }
        #[cfg(not(feature = "dht"))]
        Err("DHT feature not enabled".into())
    }

    /// Searches for peers hosting a specific drive on the DHT.
    pub fn resolve_drive(&self, _drive_did: &str) -> AtomicResult<Vec<SocketAddr>> {
        #[cfg(feature = "dht")]
        {
            let id = Self::derive_id(_drive_did);

            let peers: Vec<SocketAddr> = self
                .dht
                .get_peers(id)
                .flat_map(|batch: Vec<SocketAddrV4>| batch.into_iter().map(SocketAddr::from))
                .collect();

            tracing::debug!(
                "DHT: get_peers for drive {} returned {} peer(s): {:?}",
                _drive_did,
                peers.len(),
                peers
            );

            Ok(peers)
        }
        #[cfg(not(feature = "dht"))]
        Err("DHT feature not enabled".into())
    }

    /// Resolves a `did:ad` subject by looking up peers on the DHT and fetching the resource.
    pub async fn resolve(
        &self,
        subject: &Subject,
        store: &impl Storelike,
    ) -> AtomicResult<Resource> {
        let did_str = subject.as_str();
        eprintln!("DHT: resolving {}", did_str);

        let drive_did = Self::extract_drive_did(did_str).ok_or_else(|| {
            eprintln!("DHT: no drive hint in {}", did_str);
            format!(
                "Cannot resolve DID via DHT — no drive routing hint found: {}",
                did_str
            )
        })?;
        eprintln!("DHT: drive hint found: {}", drive_did);

        let peers = self.resolve_drive(&drive_did)?;
        if peers.is_empty() {
            return Err(format!("No peers found for drive {} on DHT", drive_did).into());
        }

        let peer_count = peers.len();
        tracing::info!(
            "DHT: Found {} peer(s) for drive {}, resolving {}",
            peer_count,
            drive_did,
            did_str
        );

        let client = reqwest::Client::new();

        for peer in &peers {
            let url = format!("http://{}/{}", peer, did_str);

            tracing::info!(
                "DHT: Trying to resolve {} from peer {} ({})",
                did_str,
                peer,
                url
            );

            let result = client
                .get(&url)
                .header("Accept", crate::parse::JSON_AD_MIME)
                .send()
                .await;

            match result {
                Ok(resp) => {
                    if resp.status().is_success() {
                        let body = resp.text().await.map_err(|e| {
                            format!("Failed to read response body from peer {}: {}", peer, e)
                        })?;
                        let resources = crate::parse::parse_json_ad_string(
                            &body,
                            store,
                            &crate::parse::ParseOpts::default(),
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

    /// Extracts the drive DID from a `did:ad:{genesis}?drive={did}` DID URL.
    pub fn extract_drive_did(did_str: &str) -> Option<String> {
        if let Some(query_start) = did_str.find('?') {
            let query = &did_str[query_start + 1..];
            for pair in query.split('&') {
                if let Some((k, v)) = pair.split_once('=') {
                    if k == "drive" {
                        return Some(v.to_string());
                    }
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_drive_did_test() {
        let drive_did = "did:ad:drive-sig";
        let did = format!("did:ad:genesis-sig?drive={}", drive_did);
        let extracted = DhtService::extract_drive_did(&did);
        assert_eq!(extracted, Some(drive_did.to_string()));
    }

    #[test]
    fn extract_drive_did_none() {
        let did = "did:ad:genesis-sig";
        let extracted = DhtService::extract_drive_did(did);
        assert_eq!(extracted, None);
    }
}
