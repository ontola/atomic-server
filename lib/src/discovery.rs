//! Peer discovery via pkarr relay.
//!
//! Publishes and resolves Iroh NodeIDs for drives using the pkarr relay network.
//! Works through any NAT — uses HTTP, not raw UDP like mainline DHT.
//!
//! The key insight: pkarr records are keyed by ed25519 public key.
//! Our agent's ed25519 key is the same type. We publish a TXT record
//! under the agent's key containing the NodeIDs of all devices for a drive.
//! Any device that knows the agent (from the shared secret) can look it up.
//!
//! Addressing (relay URL, direct addresses) is handled by Iroh's `discovery_n0()`.
//! Pkarr only maps: agent → [NodeID, NodeID, ...].

use crate::agents::Agent;
use crate::errors::AtomicResult;

/// The pkarr relay URL to use for publishing and resolving.
const RELAY_URL: &str = "https://dns.iroh.link/pkarr";

/// Publish an Iroh NodeID for a drive via the pkarr relay.
/// The record is keyed by the agent's public key.
/// Multiple NodeIDs (one per device) are stored as a JSON array in a TXT record.
pub async fn publish_node_id(
    agent: &Agent,
    _drive_did: &str,
    iroh_node_id: &str,
) -> AtomicResult<()> {
    let keypair = agent_to_pkarr_keypair(agent)?;

    // Resolve existing record to merge NodeIDs
    let client = build_client()?;
    let existing_node_ids = resolve_node_ids_raw(&client, &keypair.public_key()).await;

    let mut node_ids = existing_node_ids;
    if !node_ids.iter().any(|id| id == iroh_node_id) {
        node_ids.push(iroh_node_id.to_string());
    }

    let value = serde_json::to_string(&node_ids)
        .map_err(|e| format!("Failed to serialize NodeID list: {e}"))?;

    let packet = pkarr::SignedPacket::builder()
        .txt("_atomic_nodes".try_into().unwrap(), value.as_str().try_into().unwrap(), 300)
        .build(&keypair)
        .map_err(|e| format!("Failed to build signed packet: {e}"))?;

    client
        .publish(&packet, None)
        .await
        .map_err(|e| format!("Failed to publish to pkarr relay: {e}"))?;

    tracing::info!(
        "Discovery: published NodeID {} (total: {} peers)",
        iroh_node_id,
        node_ids.len()
    );
    Ok(())
}

/// Resolve Iroh NodeIDs for a drive via the pkarr relay.
/// Returns the first NodeID that isn't our own.
pub async fn resolve_node_id(
    agent: &Agent,
    _drive_did: &str,
) -> AtomicResult<String> {
    #[cfg(feature = "iroh")]
    let my_node_id = crate::sync::peer::get_node_id().map(|s| s.to_string());
    #[cfg(not(feature = "iroh"))]
    let my_node_id: Option<String> = None;

    resolve_node_id_filtered(agent, _drive_did, my_node_id.as_deref()).await
}

/// Resolve Iroh NodeIDs, filtering out `exclude_node_id` if provided.
pub async fn resolve_node_id_filtered(
    agent: &Agent,
    _drive_did: &str,
    exclude_node_id: Option<&str>,
) -> AtomicResult<String> {
    let keypair = agent_to_pkarr_keypair(agent)?;
    let client = build_client()?;
    let node_ids = resolve_node_ids_raw(&client, &keypair.public_key()).await;

    if node_ids.is_empty() {
        return Err("No peers found (no pkarr record for this agent)".into());
    }

    let peer = node_ids
        .iter()
        .find(|id| {
            if let Some(exclude) = exclude_node_id {
                id.as_str() != exclude
            } else {
                true
            }
        })
        .ok_or_else(|| {
            format!(
                "Found {} NodeID(s) but all are ours ({})",
                node_ids.len(),
                exclude_node_id.unwrap_or("?")
            )
        })?;

    tracing::info!("Discovery: resolved peer {} for agent", &peer[..peer.len().min(16)]);
    Ok(peer.clone())
}

/// Resolve all NodeIDs from the pkarr relay for a given public key.
async fn resolve_node_ids_raw(
    client: &pkarr::Client,
    public_key: &pkarr::PublicKey,
) -> Vec<String> {
    match client.resolve(public_key).await {
        Some(packet) => {
            for record in packet.all_resource_records() {
                if !record.name.to_string().contains("_atomic_nodes") {
                    continue;
                }
                let raw = format!("{:?}", record.rdata);
                if let Some(data_start) = raw.find("data: \"") {
                    let after = &raw[data_start + 7..];
                    if let Some(data_end) = after.find("\" }") {
                        let content = &after[..data_end];
                        let unescaped = content.replace("\\\"", "\"");
                        if let Ok(ids) = serde_json::from_str::<Vec<String>>(&unescaped) {
                            return ids;
                        }
                    }
                }
            }
            vec![]
        }
        None => vec![],
    }
}

fn agent_to_pkarr_keypair(agent: &Agent) -> AtomicResult<pkarr::Keypair> {
    let private_key_b64 = agent
        .private_key
        .as_ref()
        .ok_or("Agent has no private key")?;
    let private_key_bytes = crate::agents::decode_base64(private_key_b64)?;
    let seed: [u8; 32] = private_key_bytes
        .try_into()
        .map_err(|_| "Private key must be 32 bytes")?;
    Ok(pkarr::Keypair::from_secret_key(&seed))
}

fn build_client() -> AtomicResult<pkarr::Client> {
    let mut builder = pkarr::Client::builder();
    builder.no_default_network();
    builder.relays(&[RELAY_URL]).map_err(|e| format!("Invalid relay URL: {e}"))?;
    let client = builder.build().map_err(|e| format!("Failed to build pkarr client: {e}"))?;
    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn publish_and_resolve_via_pkarr_relay() {
        let agent = crate::agents::Agent::new(Some("DiscoveryTest")).unwrap();
        let drive_did = "did:ad:test-discovery-2026";
        let node_id = "aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344";

        publish_node_id(&agent, drive_did, node_id)
            .await
            .expect("publish should succeed via pkarr relay");

        let resolved = resolve_node_id(&agent, drive_did)
            .await
            .expect("resolve should find the published NodeID");

        assert_eq!(resolved, node_id);
        println!("SUCCESS: pkarr relay publish + resolve works");
    }
}
