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
    let pubkey_bytes: [u8; 32] = agent_pubkey
        .try_into()
        .map_err(|_| "Ed25519 public key must be 32 bytes")?;
    let verifying_key = ed25519_dalek::VerifyingKey::from_bytes(&pubkey_bytes)
        .map_err(|e| format!("Invalid public key: {}", e))?;
    let signature_bytes = decode_base64(&auth_header.signature)?;
    let sig_bytes: [u8; 64] = signature_bytes
        .try_into()
        .map_err(|_| "Ed25519 signature must be 64 bytes")?;
    let sig = ed25519_dalek::Signature::from_bytes(&sig_bytes);
    use ed25519_dalek::Verifier;

    let result = verifying_key.verify(message.as_bytes(), &sig);

    if result.is_err() {
        // In multi-tenant environments, the client might sign the full URL or just the path.
        // If it's a full URL, try checking just the path (with and without query params) as well.
        if let Ok(url) = url::Url::parse(subject) {
            let path = url.path();
            let query = url.query().map(|q| format!("?{}", q)).unwrap_or_default();

            // Try path+query (e.g. /setup?reset=true)
            let path_and_query = format!("{}{}", path, query);
            if path_and_query != subject {
                let message_path = format!("{} {}", path_and_query, &auth_header.timestamp);
                if verifying_key.verify(message_path.as_bytes(), &sig).is_ok() {
                    return Ok(());
                }
            }

            // Try full URL without query params (e.g. client signed http://host/setup but URL has ?params)
            if url.query().is_some() {
                let mut url_no_query = url.clone();
                url_no_query.set_query(None);
                let message_no_query = format!("{} {}", url_no_query, &auth_header.timestamp);
                if verifying_key
                    .verify(message_no_query.as_bytes(), &sig)
                    .is_ok()
                {
                    return Ok(());
                }
                // Also try path-only without query params
                let message_path_no_query = format!("{} {}", path, &auth_header.timestamp);
                if verifying_key
                    .verify(message_path_no_query.as_bytes(), &sig)
                    .is_ok()
                {
                    return Ok(());
                }
            }
        }

        // If we haven't returned Ok, return the original error.
        return Err(format!(
            "Incorrect signature for auth headers. This could be due to an error during signing or serialization of the commit. Compare this to the serialized message in the client: {}",
            message,
        )
        .into());
    }

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
        let agent_subject = crate::Subject::from_raw(auth_vals.agent_subject.trim(), None);
        let public_key_trimmed = auth_vals.public_key.trim();

        if agent_subject.is_did() {
            if agent_subject.as_str().ends_with(public_key_trimmed) {
                return Ok(ForAgent::AgentSubject(agent_subject));
            } else {
                return Err(format!(
                    "The public key in the auth headers '{}' does not match the DID subject '{}'",
                    public_key_trimmed, auth_vals.agent_subject
                )
                .into());
            }
        }

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
