use atomic_lib::{errors::AtomicResult, urls, Db, Resource, Storelike, Value};
use base64::{engine::general_purpose, Engine};
use serde::{Deserialize, Serialize};

/// A stateless invite token that is signed by the user.
/// It is a base64-encoded JSON-AD representation of a "virtual" Invite resource.
#[derive(Debug, Serialize, Deserialize)]
pub struct InviteToken {
    pub target: String,
    pub write: bool,
    pub expires_at: i64,
    pub signer: String,
    pub signature: String,
}

impl InviteToken {
    /// Creates a new signed InviteToken
    pub fn new(
        target: String,
        write: bool,
        expires_at: i64,
        signer_agent: &atomic_lib::agents::Agent,
    ) -> AtomicResult<Self> {
        let mut signable_json = serde_json::Map::new();
        signable_json.insert(
            urls::TARGET.into(),
            serde_json::Value::String(target.clone()),
        );
        signable_json.insert(urls::WRITE_BOOL.into(), serde_json::Value::Bool(write));
        signable_json.insert(
            urls::EXPIRES_AT.into(),
            serde_json::Value::Number(expires_at.into()),
        );
        signable_json.insert(
            urls::SIGNER.into(),
            serde_json::Value::String(signer_agent.subject.clone()),
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
            target,
            write,
            expires_at,
            signer: signer_agent.subject.clone(),
            signature,
        })
    }
    /// Encodes the InviteToken into a base64 string.
    pub fn encode(&self) -> AtomicResult<String> {
        let mut map = serde_json::Map::new();
        map.insert(
            urls::TARGET.into(),
            serde_json::Value::String(self.target.clone()),
        );
        map.insert(urls::WRITE_BOOL.into(), serde_json::Value::Bool(self.write));
        map.insert(
            urls::EXPIRES_AT.into(),
            serde_json::Value::Number(self.expires_at.into()),
        );
        map.insert(
            urls::SIGNER.into(),
            serde_json::Value::String(self.signer.clone()),
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

        let signer = json
            .get(urls::SIGNER)
            .ok_or("Missing signer in invite token")?
            .as_str()
            .ok_or("Signer must be a string")?
            .to_string();

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
        // 1. Check expiration
        let now = atomic_lib::utils::now();
        if self.expires_at < now {
            return Err("Invite token has expired".into());
        }

        // 2. Verify signature
        // We construct a temporary resource to use atomic_lib's validation logic
        let mut resource = Resource::new("local:invite".into());
        resource.set_unsafe(
            urls::TARGET.into(),
            Value::AtomicUrl(self.target.clone().into()),
        );
        resource.set_unsafe(urls::WRITE_BOOL.into(), Value::Boolean(self.write));
        resource.set_unsafe(urls::EXPIRES_AT.into(), Value::Timestamp(self.expires_at));
        resource.set_unsafe(
            urls::SIGNER.into(),
            Value::AtomicUrl(self.signer.clone().into()),
        );
        resource.set_unsafe(
            urls::SIGNATURE.into(),
            Value::String(self.signature.clone()),
        );

        // We need to verify that the signer signed this data.
        // atomic_lib::commit::Commit::validate_signature uses a similar logic.
        // But here we are not validating a Commit, but a signed virtual resource.

        // Let's manually verify the signature for now, using the signer's public key.
        let signer_resource = store
            .get_resource(&self.signer.clone().into())
            .await
            .map_err(|e| format!("Could not fetch invite issuer ({}): {}", self.signer, e))?;

        let public_key = signer_resource.get(urls::PUBLIC_KEY)?.to_string();
        let pubkey_bytes = atomic_lib::agents::decode_base64(&public_key)?;

        // The data that was signed is the JSON-AD without the signature.
        let mut signable_json = serde_json::Map::new();
        signable_json.insert(
            urls::TARGET.into(),
            serde_json::Value::String(self.target.clone()),
        );
        signable_json.insert(urls::WRITE_BOOL.into(), serde_json::Value::Bool(self.write));
        signable_json.insert(
            urls::EXPIRES_AT.into(),
            serde_json::Value::Number(self.expires_at.into()),
        );
        signable_json.insert(
            urls::SIGNER.into(),
            serde_json::Value::String(self.signer.clone()),
        );

        let serialized = serde_jcs::to_string(&signable_json)
            .map_err(|e| format!("Failed to serialize invite data for verification: {}", e))?;

        let signature_bytes = atomic_lib::agents::decode_base64(&self.signature)?;

        let peer_public_key =
            ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, pubkey_bytes);
        peer_public_key
            .verify(serialized.as_bytes(), &signature_bytes)
            .map_err(|_| "Invalid signature in invite token")?;

        // 3. Check signer's rights to the target
        let target_resource = store
            .get_resource(&self.target.clone().into())
            .await
            .map_err(|_| format!("Target resource not found: {}", self.target))?;

        atomic_lib::hierarchy::check_write(store, &target_resource, &self.signer.clone().into()).await
            .map_err(|_| format!("Invite issuer ( { } ) no longer has write rights to the target resource ( { } )", self.signer, self.target))?;

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
            serde_json::Value::String(agent.subject.clone()),
        );

        let serialized = serde_jcs::to_string(&signable_json).unwrap();
        let signature = atomic_lib::commit::sign_message(
            &serialized,
            agent.private_key.as_ref().unwrap(),
            &agent.public_key,
        )
        .unwrap();

        let token = InviteToken {
            target: target.clone(),
            write: true,
            expires_at,
            signer: agent.subject.clone(),
            signature,
        };

        let encoded = token.encode().expect("Failed to encode");
        let decoded = InviteToken::decode(&encoded).expect("Failed to decode");

        assert_eq!(decoded.target, target);
        assert_eq!(decoded.write, true);
        assert_eq!(decoded.expires_at, expires_at);
        assert_eq!(decoded.signer, agent.subject);

        decoded.verify(&store).await.expect("Verification failed");
    }

    #[tokio::test]
    async fn test_invite_token_expired() {
        let store = atomic_lib::Db::init_temp("test_invite_token_expired")
            .await
            .expect("Could not init db");
        let agent = store.get_default_agent().expect("Could not get agent");

        let target = urls::PROPERTIES.to_string();
        let expires_at = atomic_lib::utils::now() - 10000; // Expired

        let token = InviteToken {
            target,
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
