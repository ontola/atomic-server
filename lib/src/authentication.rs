//! Check signatures in authentication headers, find the correct agent. Authorization is done in Hierarchies

use crate::{
    agents::{decode_base64, ForAgent},
    errors::AtomicResult,
    urls,
    utils::check_timestamp_in_past,
    Storelike,
};

/// Set of values extracted from the request.
/// Most are coming from headers.
#[derive(serde::Deserialize)]
pub struct AuthValues {
    // x-atomic-public-key
    #[serde(rename = "https://atomicdata.dev/properties/auth/publicKey")]
    pub public_key: String,
    // x-atomic-timestamp
    #[serde(rename = "https://atomicdata.dev/properties/auth/timestamp")]
    pub timestamp: i64,
    // x-atomic-signature
    // Base64 encoded public key from `subject_url timestamp`
    #[serde(rename = "https://atomicdata.dev/properties/auth/signature")]
    pub signature: String,
    #[serde(rename = "https://atomicdata.dev/properties/auth/requestedSubject")]
    pub requested_subject: String,
    #[serde(rename = "https://atomicdata.dev/properties/auth/agent")]
    pub agent_subject: String,
}

/// Checks if the signature is valid for this timestamp.
/// Does not check if the agent has rights to access the subject.
#[tracing::instrument(skip_all)]
pub fn check_auth_signature(subject: &str, auth_header: &AuthValues) -> AtomicResult<()> {
    let agent_pubkey = decode_base64(&auth_header.public_key)?;
    let message = format!("{} {}", subject, &auth_header.timestamp);
    let peer_public_key =
        ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, agent_pubkey);
    let signature_bytes = decode_base64(&auth_header.signature)?;
    peer_public_key
                .verify(message.as_bytes(), &signature_bytes)
                .map_err(|_e| {
                    format!(
                        "Incorrect signature for auth headers. This could be due to an error during signing or serialization of the commit. Compare this to the serialized message in the client: {}",
                        message,
                    )
                })?;
    Ok(())
}

const ACCEPTABLE_TIME_DIFFERENCE: i64 = 10000;

/// Get the Agent's subject from [AuthValues]
/// Checks if the auth headers are correct, whether signature matches the public key, whether the timestamp is valid.
/// by default, returns the public agent
#[tracing::instrument(skip_all)]
pub async fn get_agent_from_auth_values_and_check(
    auth_header_values: Option<AuthValues>,
    store: &impl Storelike,
) -> AtomicResult<ForAgent> {
    if let Some(auth_vals) = auth_header_values {
        // If there are auth headers, check 'em, make sure they are valid.
        check_auth_signature(&auth_vals.requested_subject, &auth_vals)
            .map_err(|e| format!("Error checking authentication headers. {}", e))?;
        // check if the timestamp is valid
        check_timestamp_in_past(auth_vals.timestamp, ACCEPTABLE_TIME_DIFFERENCE)?;
        // check if the public key belongs to the agent
        // For DID subjects, we need to fetch the agent resource locally
        // unless it's a DID based on the public key, in which case we can verify it directly.
        let agent_subject_trimmed = auth_vals.agent_subject.trim();
        let public_key_trimmed = auth_vals.public_key.trim();

        if agent_subject_trimmed.starts_with("did:") {
            if agent_subject_trimmed.ends_with(public_key_trimmed) {
                return Ok(ForAgent::AgentSubject(crate::Subject::from_raw(
                    agent_subject_trimmed,
                    None,
                )));
            } else {
                return Err(format!(
                    "The public key in the auth headers '{}' does not match the DID subject '{}'",
                    public_key_trimmed, agent_subject_trimmed
                )
                .into());
            }
        }

        let agent_subject = crate::Subject::from_raw(agent_subject_trimmed, None);
        let agent_resource = store.get_resource(&agent_subject).await?;
        let found_public_key = agent_resource.get(urls::PUBLIC_KEY)?;
        if found_public_key.to_string().trim() != public_key_trimmed {
            Err(
                "The public key in the auth headers does not match the public key in the agent"
                    .to_string()
                    .into(),
            )
        } else {
            Ok(ForAgent::AgentSubject(agent_subject))
        }
    } else {
        Ok(ForAgent::Public)
    }
}

// fn get_agent_from_value_index() {
//     let map = store.get_prop_subject_map(&auth_vals.public_key)?;
//     let agents = map.get(crate::urls::PUBLIC_KEY).ok_or(format!(
//         "No agents for this public key: {}",
//         &auth_vals.public_key
//     ))?;
//     // TODO: This is unreliable, as this will break if multiple atoms with the same public key exist.
//     if agents.len() > 1 {
//         return Err("Multiple agents for this public key".into());
//     } else if let Some(found) = agents.iter().next() {
//         for_agent = Some(found.to_string());
//     }
// }
