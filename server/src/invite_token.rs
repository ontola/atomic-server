use atomic_lib::{errors::AtomicResult, urls, Db, Resource, Storelike, Value};
use base64::{engine::general_purpose, Engine};
use serde::{Deserialize, Serialize};

/// A stateless invite token that is signed by the user.
/// It is a base64-encoded JSON-AD representation of a "virtual" Invite resource.
#[derive(Debug, Serialize, Deserialize)]
pub struct InviteToken {
    pub target: atomic_lib::Subject,
    pub write: bool,
    pub expires_at: i64,
    pub signer: atomic_lib::Subject,
    pub signature: String,
}

impl InviteToken {
    /// Creates a new signed InviteToken
    #[cfg(test)]
    pub fn new(
        target: String,
        write: bool,
        expires_at: i64,
        signer_agent: &atomic_lib::agents::Agent,
    ) -> AtomicResult<Self> {
        // Normalize the target through Subject parsing so the signed string
        // matches what encode()/verify() will produce via self.target.as_str().
        let target_subject = atomic_lib::Subject::from(target);
        let target_normalized = target_subject.as_str().to_string();

        let mut signable_json = serde_json::Map::new();
        signable_json.insert(
            urls::TARGET.into(),
            serde_json::Value::String(target_normalized.clone()),
        );
        signable_json.insert(urls::WRITE_BOOL.into(), serde_json::Value::Bool(write));
        signable_json.insert(
            urls::EXPIRES_AT.into(),
            serde_json::Value::Number(expires_at.into()),
        );
        signable_json.insert(
            urls::SIGNER.into(),
            serde_json::Value::String(signer_agent.subject.as_str().to_string()),
        );

        let serialized = serde_jcs::to_string(&signable_json)
            .map_err(|e| format!("Failed to serialize invite data: {}", e))?;

        let signature = atomic_lib::commit::sign_message(
            &serialized,
            signer_agent
                .private_key
                .as_ref()
                .ok_or("Agent has no private key")?,
            &signer_agent.public_key,
        )?;

        Ok(Self {
            target: target_subject,
            write,
            expires_at,
            signer: signer_agent.subject.clone(),
            signature,
        })
    }
    /// Encodes the InviteToken into a base64 string.
    #[cfg(test)]
    pub fn encode(&self) -> AtomicResult<String> {
        let mut map = serde_json::Map::new();
        map.insert(
            urls::TARGET.into(),
            serde_json::Value::String(self.target.as_str().to_string()),
        );
        map.insert(urls::WRITE_BOOL.into(), serde_json::Value::Bool(self.write));
        map.insert(
            urls::EXPIRES_AT.into(),
            serde_json::Value::Number(self.expires_at.into()),
        );
        map.insert(
            urls::SIGNER.into(),
            serde_json::Value::String(self.signer.as_str().to_string()),
        );
        map.insert(
            urls::SIGNATURE.into(),
            serde_json::Value::String(self.signature.clone()),
        );

        let bytes = serde_json::to_vec(&map)
            .map_err(|e| format!("Failed to serialize invite token: {}", e))?;

        Ok(general_purpose::STANDARD.encode(bytes))
    }

    /// Decodes a base64 encoded JSON-AD token into an InviteToken.
    pub fn decode(token: &str) -> AtomicResult<Self> {
        let bytes = general_purpose::STANDARD
            .decode(token)
            .map_err(|e| format!("Invalid base64 in invite token: {}", e))?;

        let json: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("Invalid JSON in invite token: {}", e))?;

        let target = json
            .get(urls::TARGET)
            .ok_or("Missing target in invite token")?
            .as_str()
            .ok_or("Target must be a string")?
            .to_string();
        let target = atomic_lib::Subject::from(target);

        let write = json
            .get(urls::WRITE_BOOL)
            .ok_or("Missing write in invite token")?
            .as_bool()
            .ok_or("Write must be a boolean")?;

        let expires_at = json
            .get(urls::EXPIRES_AT)
            .ok_or("Missing expires_at in invite token")?
            .as_i64()
            .ok_or("Expires_at must be an integer")?;

        let signer_str = json
            .get(urls::SIGNER)
            .ok_or("Missing signer in invite token")?
            .as_str()
            .ok_or("Signer must be a string")?
            .to_string();
        let signer = atomic_lib::Subject::from(signer_str);

        let signature = json
            .get(urls::SIGNATURE)
            .ok_or("Missing signature in invite token")?
            .as_str()
            .ok_or("Signature must be a string")?
            .to_string();

        Ok(Self {
            target,
            write,
            expires_at,
            signer,
            signature,
        })
    }

    /// Verifies the token's signature and the signer's rights.
    pub async fn verify(&self, store: &Db) -> AtomicResult<()> {
        tracing::debug!(
            "Verifying invite token: signer={}, target={}, expires_at={}",
            self.signer,
            self.target,
            self.expires_at
        );

        // 1. Check expiration
        let now = atomic_lib::utils::now();
        if self.expires_at < now {
            return Err("Invite token has expired".into());
        }

        // 2. Verify signature
        // We construct a temporary resource to use atomic_lib's validation logic
        let mut resource = Resource::new("local:invite".into());
        resource.set_unsafe(urls::TARGET.into(), Value::AtomicUrl(self.target.clone()))?;
        resource.set_unsafe(urls::WRITE_BOOL.into(), Value::Boolean(self.write))?;
        resource.set_unsafe(urls::EXPIRES_AT.into(), Value::Timestamp(self.expires_at))?;
        resource.set_unsafe(urls::SIGNER.into(), Value::AtomicUrl(self.signer.clone()))?;
        resource.set_unsafe(
            urls::SIGNATURE.into(),
            Value::String(self.signature.clone()),
        )?;

        // We need to verify that the signer signed this data.
        // atomic_lib::commit::Commit::validate_signature uses a similar logic.
        // But here we are not validating a Commit, but a signed virtual resource.

        // Let's manually verify the signature for now, using the signer's public key.
        let signer_resource = store
            .get_resource(&self.signer)
            .await
            .map_err(|e| format!("Could not fetch invite issuer ({}): {}", self.signer, e))?;

        tracing::debug!(
            "Fetched signer resource, subject={}",
            signer_resource.get_subject()
        );

        let public_key = match signer_resource.get(urls::PUBLIC_KEY) {
            Ok(pk) => pk.to_string(),
            Err(e) => {
                if let Some(pk) = self
                    .signer
                    .as_str()
                    .strip_prefix(atomic_lib::subject::DID_AD_AGENT_PREFIX)
                {
                    pk.to_string()
                } else {
                    return Err(e);
                }
            }
        };
        tracing::debug!("Public key for verification: {}", public_key);
        let pubkey_bytes = atomic_lib::agents::decode_base64(&public_key)?;

        // The data that was signed is the JSON-AD without the signature.
        let mut signable_json = serde_json::Map::new();
        signable_json.insert(
            urls::TARGET.into(),
            serde_json::Value::String(self.target.as_str().to_string()),
        );
        signable_json.insert(urls::WRITE_BOOL.into(), serde_json::Value::Bool(self.write));
        signable_json.insert(
            urls::EXPIRES_AT.into(),
            serde_json::Value::Number(self.expires_at.into()),
        );
        signable_json.insert(
            urls::SIGNER.into(),
            serde_json::Value::String(self.signer.as_str().to_string()),
        );

        let serialized = serde_jcs::to_string(&signable_json)
            .map_err(|e| format!("Failed to serialize invite data for verification: {}", e))?;

        tracing::debug!("Serialized signable data for verification: {}", serialized);

        let signature_bytes = atomic_lib::agents::decode_base64(&self.signature)?;

        let peer_public_key =
            ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, pubkey_bytes);
        peer_public_key
            .verify(serialized.as_bytes(), &signature_bytes)
            .map_err(|_| format!(
                "Invalid signature in invite token. signer={}, public_key={}, signature={}, serialized_data={}",
                self.signer, public_key, self.signature, serialized
            ))?;

        // 3. Check signer's rights to the target
        let target_resource = store
            .get_resource(&self.target.clone())
            .await
            .map_err(|_| format!("Target resource not found: {}", self.target))?;

        atomic_lib::hierarchy::check_write(
            store,
            &target_resource,
            &atomic_lib::agents::ForAgent::AgentSubject(self.signer.clone()),
        )
        .await
        .map_err(|_| {
            format!(
                "Invite issuer ( { } ) no longer has write rights to the target resource ( { } )",
                self.signer, self.target
            )
        })?;

        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use atomic_lib::Storelike;

    #[tokio::test]
    async fn test_invite_token_cycle() {
        let store = atomic_lib::Db::init_temp("test_invite_token_cycle")
            .await
            .expect("Could not init db");
        atomic_lib::test_utils::setup_test_env(&store)
            .await
            .expect("Could not setup test env");
        let agent = store.get_default_agent().expect("Could not get agent");

        let target = urls::PROPERTIES.to_string();
        let expires_at = atomic_lib::utils::now() + 10000;

        // Construct the signable data manually for the test
        let mut signable_json = serde_json::Map::new();
        signable_json.insert(
            urls::TARGET.into(),
            serde_json::Value::String(target.clone()),
        );
        signable_json.insert(urls::WRITE_BOOL.into(), serde_json::Value::Bool(true));
        signable_json.insert(
            urls::EXPIRES_AT.into(),
            serde_json::Value::Number(expires_at.into()),
        );
        signable_json.insert(
            urls::SIGNER.into(),
            serde_json::Value::String(agent.subject.as_str().to_string()),
        );

        let serialized = serde_jcs::to_string(&signable_json).unwrap();
        let signature = atomic_lib::commit::sign_message(
            &serialized,
            agent.private_key.as_ref().unwrap(),
            &agent.public_key,
        )
        .unwrap();

        let token = InviteToken {
            target: atomic_lib::Subject::from(target.clone()),
            write: true,
            expires_at,
            signer: agent.subject.clone(),
            signature,
        };

        let encoded = token.encode().expect("Failed to encode");
        let decoded = InviteToken::decode(&encoded).expect("Failed to decode");

        assert_eq!(decoded.target, target);
        assert!(decoded.write);
        assert_eq!(decoded.expires_at, expires_at);
        assert_eq!(decoded.signer, agent.subject);

        decoded.verify(&store).await.expect("Verification failed");
    }

    #[tokio::test]
    async fn test_invite_token_new_roundtrip() {
        let store = atomic_lib::Db::init_temp("test_invite_token_new_roundtrip")
            .await
            .expect("Could not init db");
        atomic_lib::test_utils::setup_test_env(&store)
            .await
            .expect("Could not setup test env");
        let agent = store.get_default_agent().expect("Could not get agent");

        let target = urls::PROPERTIES.to_string();
        let expires_at = atomic_lib::utils::now() + 10000;

        // Use the production code path: InviteToken::new
        let token = InviteToken::new(target.clone(), true, expires_at, &agent)
            .expect("Failed to create invite token");

        let encoded = token.encode().expect("Failed to encode");
        let decoded = InviteToken::decode(&encoded).expect("Failed to decode");

        assert_eq!(decoded.target, target);
        assert!(decoded.write);
        assert_eq!(decoded.expires_at, expires_at);
        assert_eq!(decoded.signer, agent.subject);

        decoded
            .verify(&store)
            .await
            .expect("Verification failed for token created via InviteToken::new");
    }

    #[tokio::test]
    async fn test_invite_token_root_url_target() {
        // Regression test: root URLs like "http://localhost:9883" get a trailing
        // slash added by Url::parse ("http://localhost:9883/"). This caused a
        // mismatch between the string signed in new() and the string used in
        // encode()/verify(), resulting in "Invalid signature in invite token".
        let store = atomic_lib::Db::init_temp("test_invite_token_root_url")
            .await
            .expect("Could not init db");
        atomic_lib::test_utils::setup_test_env(&store)
            .await
            .expect("Could not setup test env");
        let agent = store.get_default_agent().expect("Could not get agent");

        // Use a root URL without trailing slash, like get_origin() produces
        let target = "https://atomicdata.dev".to_string();
        let expires_at = atomic_lib::utils::now() + 10000;

        let token = InviteToken::new(target.clone(), true, expires_at, &agent)
            .expect("Failed to create invite token");

        let encoded = token.encode().expect("Failed to encode");
        let decoded = InviteToken::decode(&encoded).expect("Failed to decode");

        // The target should be normalized consistently
        assert_eq!(decoded.target.as_str(), token.target.as_str());

        decoded
            .verify(&store)
            .await
            .expect("Verification failed for root URL target");
    }

    #[tokio::test]
    async fn test_invite_token_expired() {
        let store = atomic_lib::Db::init_temp("test_invite_token_expired")
            .await
            .expect("Could not init db");
        atomic_lib::test_utils::setup_test_env(&store)
            .await
            .expect("Could not setup test env");
        let agent = store.get_default_agent().expect("Could not get agent");

        let target = urls::PROPERTIES.to_string();
        let expires_at = atomic_lib::utils::now() - 10000; // Expired

        let token = InviteToken {
            target: atomic_lib::Subject::from(target),
            write: true,
            expires_at,
            signer: agent.subject.clone(),
            signature: "invalid".to_string(),
        };

        let result = token.verify(&store).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("expired"));
    }
}
