//! Peer discovery via pkarr relay (and the same keying model for Mainline).
//!
//! ## Agent-keyed records (zones / current)
//!
//! Per [`planning/zones.md`](../../planning/zones.md), pkarr/mainline records
//! find **nodes**, not data. One opt-in record per agent:
//!
//! - Key = the agent's own Ed25519 key (`did:ad:agent:{pubkey}` is already a
//!   valid pkarr key — no derivation trick).
//! - Value = NodeIDs (+ optional public zone DID).
//! - Zones resolve *after* dialing: SYNC the zone DID; admission decides.
//!
//! Only a holder of the agent private key can publish (self-certifying).
//!
//! ## Drive-keyed records (legacy)
//!
//! Older path keyed by drive DID via a publicly-derivable keypair from the
//! genesis signature (`drive_did_to_pkarr_keypair`). Kept so existing announces
//! and replicas that lack the owner key keep working during migration. Prefer
//! [`publish_agent_node_id`] / [`resolve_agent_node_id`] for new code.
//!
//! Works through any NAT — uses HTTP to the pkarr relay, not raw UDP Mainline.
//! Addressing (relay URL, direct addresses) is handled by Iroh's
//! `discovery_n0()`. Pkarr only maps: identity → [NodeID, ...].

use crate::errors::AtomicResult;

/// The pkarr relay URL to use for publishing and resolving.
const RELAY_URL: &str = "https://dns.iroh.link/pkarr";

/// TXT name for the NodeID list (shared by agent and legacy drive records).
const NODES_TXT: &str = "_atomic_nodes";

/// TXT name for the agent's optional public zone DID (agent records only).
const PUBLIC_ZONE_TXT: &str = "_atomic_public_zone";

/// Payload published under an agent pkarr key.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentDiscoveryRecord {
    pub node_ids: Vec<String>,
    /// Optional DID of the agent's public zone (shareable root).
    pub public_zone: Option<String>,
}

/// Publish this node's Iroh NodeID under the **agent's** pkarr key.
///
/// `agent_private_key` is the URL-safe/standard base64 Ed25519 seed (same as
/// `Agent.private_key`). Optionally set `public_zone` to announce a default
/// public zone DID alongside the NodeIDs.
pub async fn publish_agent_node_id(
    agent_private_key: &str,
    iroh_node_id: &str,
    public_zone: Option<&str>,
) -> AtomicResult<()> {
    let keypair = agent_private_key_to_pkarr(agent_private_key)?;
    let client = build_client()?;
    let mut record = resolve_agent_record_raw(&client, &keypair.public_key()).await;
    if !record.node_ids.iter().any(|id| id == iroh_node_id) {
        record.node_ids.push(iroh_node_id.to_string());
    }
    if let Some(zone) = public_zone {
        record.public_zone = Some(zone.to_string());
    }
    publish_agent_record(&client, &keypair, &record).await?;
    tracing::debug!(
        "Discovery: published NodeID {} for agent {} (total: {} peers, public_zone={:?})",
        iroh_node_id,
        keypair.public_key(),
        record.node_ids.len(),
        record.public_zone
    );
    Ok(())
}

/// Resolve NodeIDs (and optional public zone) for an agent DID via pkarr.
pub async fn resolve_agent_record(agent_did: &str) -> AtomicResult<AgentDiscoveryRecord> {
    let public_key = agent_did_to_pkarr_public_key(agent_did)?;
    let client = build_client()?;
    let record = resolve_agent_record_raw(&client, &public_key).await;
    if record.node_ids.is_empty() && record.public_zone.is_none() {
        return Err(format!("No discovery record found for agent {agent_did}").into());
    }
    Ok(record)
}

/// Resolve a peer NodeID for an agent, filtering out `exclude_node_id` if set.
pub async fn resolve_agent_node_id(
    agent_did: &str,
    exclude_node_id: Option<&str>,
) -> AtomicResult<String> {
    let record = resolve_agent_record(agent_did).await?;
    let peer = record
        .node_ids
        .iter()
        .find(|id| exclude_node_id.is_none_or(|ex| id.as_str() != ex))
        .ok_or_else(|| {
            format!(
                "Found {} NodeID(s) for {agent_did} but all are ours ({})",
                record.node_ids.len(),
                exclude_node_id.unwrap_or("?")
            )
        })?;
    tracing::debug!(
        "Discovery: resolved peer {} for agent {}",
        &peer[..peer.len().min(16)],
        agent_did
    );
    Ok(peer.clone())
}

/// Publish an Iroh NodeID for a drive via the pkarr relay (legacy).
/// The record is keyed by a pkarr keypair derived from the drive's DID.
/// Multiple NodeIDs (one per replica) are stored as a JSON array in a TXT record.
pub async fn publish_node_id(drive_did: &str, iroh_node_id: &str) -> AtomicResult<()> {
    let keypair = drive_did_to_pkarr_keypair(drive_did)?;

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
        .txt(
            NODES_TXT.try_into().unwrap(),
            value.as_str().try_into().unwrap(),
            300,
        )
        .build(&keypair)
        .map_err(|e| format!("Failed to build signed packet: {e}"))?;

    client
        .publish(&packet, None)
        .await
        .map_err(|e| format!("Failed to publish to pkarr relay: {e}"))?;

    tracing::debug!(
        "Discovery: published NodeID {} for drive {} (total: {} peers) [legacy drive-keyed]",
        iroh_node_id,
        drive_did,
        node_ids.len()
    );
    Ok(())
}

/// Resolve Iroh NodeIDs for a drive via the pkarr relay.
/// Returns the first NodeID that isn't our own.
pub async fn resolve_node_id(drive_did: &str) -> AtomicResult<String> {
    #[cfg(feature = "iroh")]
    let my_node_id = crate::sync::peer::get_node_id().map(|s| s.to_string());
    #[cfg(not(feature = "iroh"))]
    let my_node_id: Option<String> = None;

    resolve_node_id_filtered(drive_did, my_node_id.as_deref()).await
}

/// Resolve Iroh NodeIDs for a drive, filtering out `exclude_node_id` if provided.
pub async fn resolve_node_id_filtered(
    drive_did: &str,
    exclude_node_id: Option<&str>,
) -> AtomicResult<String> {
    let keypair = drive_did_to_pkarr_keypair(drive_did)?;
    let client = build_client()?;
    let node_ids = resolve_node_ids_raw(&client, &keypair.public_key()).await;

    if node_ids.is_empty() {
        return Err(format!("No peers found for drive {drive_did}").into());
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

    tracing::debug!(
        "Discovery: resolved peer {} for drive {}",
        &peer[..peer.len().min(16)],
        drive_did
    );
    Ok(peer.clone())
}

async fn publish_agent_record(
    client: &pkarr::Client,
    keypair: &pkarr::Keypair,
    record: &AgentDiscoveryRecord,
) -> AtomicResult<()> {
    let nodes_json = serde_json::to_string(&record.node_ids)
        .map_err(|e| format!("Failed to serialize NodeID list: {e}"))?;
    let mut builder = pkarr::SignedPacket::builder().txt(
        NODES_TXT.try_into().unwrap(),
        nodes_json.as_str().try_into().unwrap(),
        300,
    );
    if let Some(zone) = &record.public_zone {
        builder = builder.txt(
            PUBLIC_ZONE_TXT.try_into().unwrap(),
            zone.as_str().try_into().unwrap(),
            300,
        );
    }
    let packet = builder
        .build(keypair)
        .map_err(|e| format!("Failed to build signed packet: {e}"))?;
    client
        .publish(&packet, None)
        .await
        .map_err(|e| format!("Failed to publish to pkarr relay: {e}"))?;
    Ok(())
}

async fn resolve_agent_record_raw(
    client: &pkarr::Client,
    public_key: &pkarr::PublicKey,
) -> AgentDiscoveryRecord {
    let mut record = AgentDiscoveryRecord::default();
    let Some(packet) = client.resolve(public_key).await else {
        return record;
    };
    for resource_record in packet.all_resource_records() {
        let name = resource_record.name.to_string();
        let raw = format!("{:?}", resource_record.rdata);
        let Some(content) = extract_txt_data(&raw) else {
            continue;
        };
        if name.contains(NODES_TXT) {
            if let Ok(ids) = serde_json::from_str::<Vec<String>>(&content) {
                record.node_ids = ids;
            }
        } else if name.contains(PUBLIC_ZONE_TXT) {
            record.public_zone = Some(content);
        }
    }
    record
}

/// Resolve all NodeIDs from the pkarr relay for a given public key.
async fn resolve_node_ids_raw(
    client: &pkarr::Client,
    public_key: &pkarr::PublicKey,
) -> Vec<String> {
    match client.resolve(public_key).await {
        Some(packet) => {
            for record in packet.all_resource_records() {
                if !record.name.to_string().contains(NODES_TXT) {
                    continue;
                }
                let raw = format!("{:?}", record.rdata);
                if let Some(content) = extract_txt_data(&raw) {
                    if let Ok(ids) = serde_json::from_str::<Vec<String>>(&content) {
                        return ids;
                    }
                }
            }
            vec![]
        }
        None => vec![],
    }
}

fn extract_txt_data(raw: &str) -> Option<String> {
    let data_start = raw.find("data: \"")?;
    let after = &raw[data_start + 7..];
    let data_end = after.find("\" }")?;
    let content = &after[..data_end];
    Some(content.replace("\\\"", "\""))
}

/// Derive a pkarr keypair from an agent's private key (32-byte Ed25519 seed).
fn agent_private_key_to_pkarr(private_key: &str) -> AtomicResult<pkarr::Keypair> {
    let bytes = crate::agents::decode_base64(private_key)
        .map_err(|e| format!("Agent private key base64 decode failed: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!(
            "Expected 32-byte agent private key, got {} bytes",
            bytes.len()
        )
        .into());
    }
    let seed: [u8; 32] = bytes
        .try_into()
        .expect("length checked to be 32");
    Ok(pkarr::Keypair::from_secret_key(&seed))
}

/// Parse `did:ad:agent:{pubkey}` into a pkarr public key for resolve.
fn agent_did_to_pkarr_public_key(agent_did: &str) -> AtomicResult<pkarr::PublicKey> {
    let pubkey_b64 = agent_did
        .strip_prefix("did:ad:agent:")
        .ok_or_else(|| format!("Not an agent DID: {agent_did}"))?;
    let pubkey_b64 = pubkey_b64.split('?').next().unwrap_or(pubkey_b64);
    let bytes = crate::agents::decode_base64(pubkey_b64)
        .map_err(|e| format!("Agent pubkey base64 decode failed: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!(
            "Expected 32-byte agent public key, got {} bytes",
            bytes.len()
        )
        .into());
    }
    let arr: [u8; 32] = bytes.try_into().expect("length checked to be 32");
    let verifying_key = ed25519_dalek::VerifyingKey::from_bytes(&arr)
        .map_err(|e| format!("Invalid agent public key: {e}"))?;
    Ok(pkarr::PublicKey::from(verifying_key))
}

/// Derive a pkarr keypair from a drive DID (legacy).
///
/// A `did:ad:{genesis}` subject encodes the drive's 64-byte ed25519 genesis
/// signature as base64. We use the first 32 bytes of that signature as the
/// pkarr keypair seed. This is deterministic from the public DID string, so
/// any node (including replicas that don't hold the drive owner's key) can
/// derive the same keypair and publish records for the drive.
///
/// Accepts DID strings with an optional `?drive=...` routing hint, which is
/// stripped before decoding.
fn drive_did_to_pkarr_keypair(drive_did: &str) -> AtomicResult<pkarr::Keypair> {
    let raw = drive_did
        .strip_prefix("did:ad:")
        .ok_or_else(|| format!("Not a did:ad DID: {drive_did}"))?;
    // Agent DIDs and commit DIDs aren't drives; they have different payload
    // lengths and semantics. Reject early rather than silently producing a
    // meaningless keypair.
    if raw.starts_with("agent:") || raw.starts_with("commit:") {
        return Err(
            format!("drive_did_to_pkarr_keypair called with non-drive DID: {drive_did}").into(),
        );
    }
    let genesis_b64 = raw.split('?').next().unwrap_or(raw);
    let sig = crate::agents::decode_base64(genesis_b64)
        .map_err(|e| format!("DID genesis signature base64 decode failed: {e}"))?;
    if sig.len() != 64 {
        return Err(format!(
            "Expected 64-byte genesis signature, got {} bytes",
            sig.len()
        )
        .into());
    }
    let seed: [u8; 32] = sig[..32]
        .try_into()
        .expect("slice [..32] of 64-byte vec is always 32 bytes");
    Ok(pkarr::Keypair::from_secret_key(&seed))
}

fn build_client() -> AtomicResult<pkarr::Client> {
    let mut builder = pkarr::Client::builder();
    builder.no_default_network();
    builder
        .relays(&[RELAY_URL])
        .map_err(|e| format!("Invalid relay URL: {e}"))?;
    let client = builder
        .build()
        .map_err(|e| format!("Failed to build pkarr client: {e}"))?;
    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a `did:ad:{...}` whose base64 payload decodes to exactly
    /// 64 bytes, satisfying `drive_did_to_pkarr_keypair`'s shape check.
    fn fake_drive_did(seed_byte: u8) -> String {
        let sig = [seed_byte; 64];
        format!("did:ad:{}", crate::agents::encode_base64(&sig))
    }

    #[test]
    fn drive_did_to_keypair_roundtrip_is_deterministic() {
        let did = fake_drive_did(0x42);
        let k1 = drive_did_to_pkarr_keypair(&did).unwrap();
        let k2 = drive_did_to_pkarr_keypair(&did).unwrap();
        assert_eq!(k1.public_key().to_string(), k2.public_key().to_string());
    }

    #[test]
    fn rejects_non_drive_dids() {
        assert!(drive_did_to_pkarr_keypair("did:ad:agent:foo").is_err());
        assert!(drive_did_to_pkarr_keypair("did:ad:commit:foo").is_err());
        assert!(drive_did_to_pkarr_keypair("https://example.com/").is_err());
    }

    #[test]
    fn agent_keypair_matches_agent_did_public_key() {
        // Real-shaped seed from agents tests.
        let private_key = "CapMWIhFUT+w7ANv9oCPqrHrwZpkP2JhzF9JnyT6WcI=";
        let pair = crate::agents::generate_public_key(private_key);
        let keypair = agent_private_key_to_pkarr(private_key).unwrap();
        let agent_did = format!("did:ad:agent:{}", pair.public);
        let from_did = agent_did_to_pkarr_public_key(&agent_did).unwrap();
        assert_eq!(keypair.public_key().to_string(), from_did.to_string());
    }

    #[test]
    fn agent_did_rejects_non_agent() {
        assert!(agent_did_to_pkarr_public_key("did:ad:notanagent").is_err());
        assert!(agent_did_to_pkarr_public_key(&fake_drive_did(1)).is_err());
    }

    // Network test — requires outbound HTTPS to the pkarr relay. Ignored by
    // default; run explicitly with `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn publish_and_resolve_via_pkarr_relay() {
        let drive_did = fake_drive_did(0x17);
        let node_id = "aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344";

        publish_node_id(&drive_did, node_id)
            .await
            .expect("publish should succeed via pkarr relay");

        let resolved = resolve_node_id_filtered(&drive_did, None)
            .await
            .expect("resolve should find the published NodeID");

        assert_eq!(resolved, node_id);
        println!("SUCCESS: pkarr relay publish + resolve works");
    }

    #[tokio::test]
    #[ignore]
    async fn agent_publish_and_resolve_via_pkarr_relay() {
        let private_key = "CapMWIhFUT+w7ANv9oCPqrHrwZpkP2JhzF9JnyT6WcI=";
        let pair = crate::agents::generate_public_key(private_key);
        let agent_did = format!("did:ad:agent:{}", pair.public);
        let node_id = "bbccddee11223344bbccddee11223344bbccddee11223344bbccddee11223344";
        let public_zone = "did:ad:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

        publish_agent_node_id(private_key, node_id, Some(public_zone))
            .await
            .expect("agent publish should succeed");

        let record = resolve_agent_record(&agent_did)
            .await
            .expect("agent resolve should find the record");
        assert!(record.node_ids.iter().any(|id| id == node_id));
        assert_eq!(record.public_zone.as_deref(), Some(public_zone));
        println!("SUCCESS: agent-keyed pkarr publish + resolve works");
    }
}
