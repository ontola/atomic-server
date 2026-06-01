//! Logic for Agents
//! Agents are actors (such as users) that can edit content.
//! https://docs.atomicdata.dev/commits/concepts.html

use base64::{engine::general_purpose, Engine};
use serde::{Deserialize, Serialize};

use crate::{errors::AtomicResult, urls, Resource, Value};

#[derive(Serialize, Deserialize)]
struct DecodedSecret {
    #[serde(rename = "privateKey")]
    private_key: String,
    subject: crate::Subject,
    #[serde(skip_serializing_if = "Option::is_none")]
    initial_drive: Option<crate::Subject>,
}

/// None represents no right checks will be performed, effectively SUDO mode.
#[derive(Clone, Debug, PartialEq)]
pub enum ForAgent {
    /// The Subject URL/DID agent that is performing the action.
    AgentSubject(crate::Subject),
    /// Allows all checks to pass.
    /// See [urls::SUDO_AGENT]
    Sudo,
    /// Public Agent, most strict.
    /// See [urls::PUBLIC_AGENT]
    Public,
}

impl std::fmt::Display for ForAgent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ForAgent::AgentSubject(subject) => write!(f, "{}", subject),
            ForAgent::Sudo => write!(f, "{}", urls::SUDO_AGENT),
            ForAgent::Public => write!(f, "{}", urls::PUBLIC_AGENT),
        }
    }
}

impl<T: Into<String>> From<T> for ForAgent {
    fn from(subject: T) -> Self {
        let subject_str = subject.into();
        if subject_str == urls::SUDO_AGENT {
            ForAgent::Sudo
        } else if subject_str == urls::PUBLIC_AGENT {
            ForAgent::Public
        } else {
            ForAgent::AgentSubject(crate::Subject::from_raw(&subject_str, None))
        }
    }
}

/// An Agent can be thought of as a User. Agents are used for authentication and authorization.
/// The private key of the Agent is used to sign [crate::Commit]s.
#[derive(Clone, Debug)]
pub struct Agent {
    /// Private key for signing commits
    pub private_key: Option<String>,
    /// Used for validating commit signatures and for the username.
    pub public_key: String,
    /// URL / DID of the Agent
    pub subject: crate::Subject,
    pub created_at: i64,
    pub name: Option<String>,
    /// The DID of the drive that should be opened by default for this agent.
    pub initial_drive: Option<crate::Subject>,
}

impl Agent {
    /// Converts Agent to Resource.
    /// Does not include private key, only public.
    pub fn to_resource(&self) -> AtomicResult<Resource> {
        let mut resource = Resource::new(self.subject.to_string());
        resource.set_class(urls::AGENT)?;
        resource.set_subject(self.subject.to_string());
        if let Some(name) = &self.name {
            resource.set_unsafe(crate::urls::NAME.into(), Value::String(name.into()))?;
        }
        resource.set_unsafe(
            crate::urls::PUBLIC_KEY.into(),
            Value::String(self.public_key.clone()),
        )?;
        // Agents must be read by anyone when validating their keys
        resource.push(crate::urls::READ, urls::PUBLIC_AGENT.into(), true)?;
        resource.set_unsafe(
            crate::urls::CREATED_AT.into(),
            Value::Timestamp(self.created_at),
        )?;
        if let Some(initial_drive) = &self.initial_drive {
            resource.set_unsafe(
                urls::DRIVES.into(),
                Value::ResourceArray(vec![crate::values::SubResource::Subject(
                    initial_drive.clone(),
                )]),
            )?;
            resource.set_unsafe(
                urls::PERSONAL_DRIVE.into(),
                Value::AtomicUrl(initial_drive.to_string().into()),
            )?;
        }
        Ok(resource)
    }

    /// Creates a new Agent, generates a new Keypair.
    pub fn new(name: Option<&str>) -> AtomicResult<Agent> {
        let keypair = generate_keypair()?;

        Agent::new_from_private_key(name, &keypair.private)
    }

    /// Creates a new Agent with a DID identifier.
    /// Derives the public key from the private key.
    pub fn new_from_private_key(name: Option<&str>, private_key: &str) -> AtomicResult<Agent> {
        let keypair = generate_public_key(private_key);
        let did_string = format!("did:ad:agent:{}", keypair.public);
        let subject = crate::Subject::from_raw(&did_string, None);

        Ok(Agent {
            private_key: Some(keypair.private),
            public_key: keypair.public.clone(),
            subject,
            name: name.map(|x| x.to_owned()),
            created_at: crate::utils::now(),
            initial_drive: None,
        })
    }

    /// Creates a new Agent with a DID identifier from a public key.
    /// This will not be able to write, because there is no private key.
    pub fn new_from_public_key(public_key: &str) -> AtomicResult<Agent> {
        verify_public_key(public_key)?;
        let did_string = format!("did:ad:agent:{}", public_key);
        let subject = crate::Subject::from_raw(&did_string, None);

        Ok(Agent {
            private_key: None,
            public_key: public_key.into(),
            subject,
            name: None,
            created_at: crate::utils::now(),
            initial_drive: None,
        })
    }

    pub fn from_secret(secret_b64: &str) -> AtomicResult<Agent> {
        let agent_bytes = decode_base64(secret_b64)?;
        let decoded: DecodedSecret = serde_json::from_slice(&agent_bytes)?;
        // Migrate legacy HTTP agent subjects (https://server/agents/{pubkey}) to did:ad:agent:{pubkey}
        let subject = migrate_http_agent_subject(decoded.subject.as_str());
        let agent = Agent {
            private_key: Some(decoded.private_key.clone()),
            public_key: generate_public_key(&decoded.private_key).public,
            subject: crate::Subject::from_raw(&subject, None),
            name: None,
            created_at: crate::utils::now(),
            initial_drive: decoded.initial_drive,
        };
        Ok(agent)
    }

    pub fn from_private_key_and_subject(private_key: &str, subject: &str) -> AtomicResult<Agent> {
        let keypair = generate_public_key(private_key);

        Ok(Agent {
            private_key: Some(keypair.private),
            public_key: keypair.public.clone(),
            subject: subject.into(),
            name: None,
            created_at: crate::utils::now(),
            initial_drive: None,
        })
    }

    pub fn build_secret(&self) -> AtomicResult<String> {
        let decoded_secret = DecodedSecret {
            private_key: self.private_key.clone().ok_or("No private key on agent")?,
            subject: self.subject.clone(),
            initial_drive: self.initial_drive.clone(),
        };

        let vec = serde_json::to_vec(&decoded_secret)?;
        let encoded_secret = encode_base64(&vec);
        Ok(encoded_secret)
    }
}

/// keypair, serialized using base64
pub struct Pair {
    pub private: String,
    pub public: String,
}

/// Returns a new random keypair.
fn generate_keypair() -> AtomicResult<Pair> {
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    let signing_key = SigningKey::generate(&mut OsRng);
    let public_key = signing_key.verifying_key();
    Ok(Pair {
        private: encode_base64(signing_key.as_bytes()),
        public: encode_base64(public_key.as_bytes()),
    })
}

/// Returns a Key Pair (including public key) from a private key, base64 encoded.
pub fn generate_public_key(private_key: &str) -> Pair {
    use ed25519_dalek::SigningKey;

    let private_key_bytes = decode_base64(private_key).unwrap();
    let seed: [u8; 32] = private_key_bytes
        .try_into()
        .expect("Ed25519 private key must be 32 bytes");
    let signing_key = SigningKey::from_bytes(&seed);
    let public_key = signing_key.verifying_key();
    Pair {
        private: encode_base64(signing_key.as_bytes()),
        public: encode_base64(public_key.as_bytes()),
    }
}

/// Decodes base64 used throughout Atomic Data for keys, signatures and the
/// identifiers derived from them (`did:ad:…`).
///
/// Accepts BOTH the URL-safe alphabet (`-` `_`, the canonical encoding, see
/// [`encode_base64`]) and the legacy standard alphabet (`+` `/`), with or
/// without `=` padding. The leniency means data written before the switch to
/// URL-safe still decodes, so a mixed store doesn't hard-fail.
pub fn decode_base64(string: &str) -> AtomicResult<Vec<u8>> {
    // Normalise the URL-safe alphabet back to the standard one, then re-pad to
    // a multiple of 4 so a single `STANDARD` decoder handles every variant.
    let standard_alphabet: String = string
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    let trimmed = standard_alphabet.trim_end_matches('=');
    let pad = (4 - trimmed.len() % 4) % 4;
    let padded = format!("{}{}", trimmed, "=".repeat(pad));

    let vec = general_purpose::STANDARD
        .decode(padded)
        .map_err(|e| format!("Invalid key. Not valid Base64. {}", e))?;
    Ok(vec)
}

/// Encodes bytes as **URL-safe, unpadded** base64 (RFC 4648 §5 — alphabet
/// `A–Z a–z 0–9 - _`, no `=`). This is what makes `did:ad:…` identifiers safe to
/// drop into URLs verbatim: the standard alphabet's `+` (which form-decoders
/// turn into a space) and `/` would otherwise corrupt a subject on round-trip
/// through a query string. Used for keys, signatures and every derived
/// identifier; [`decode_base64`] still accepts the old standard encoding.
pub fn encode_base64(bytes: &[u8]) -> String {
    general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Signs a message using the private key.
pub fn sign_message(message: &[u8], private_key: &str) -> AtomicResult<String> {
    use ed25519_dalek::{Signer, SigningKey};

    let private_key_bytes = decode_base64(private_key)?;
    let seed: [u8; 32] = private_key_bytes
        .try_into()
        .map_err(|_| "Ed25519 private key must be 32 bytes")?;
    let signing_key = SigningKey::from_bytes(&seed);
    let signature = signing_key.sign(message);
    Ok(encode_base64(&signature.to_bytes()))
}

/// Checks if the public key is a valid ED25519 base64 key.
/// Not perfect - only checks byte length and parses base64.
pub fn verify_public_key(public_key: &str) -> AtomicResult<()> {
    let pubkey_bin = decode_base64(public_key)
        .map_err(|e| format!("Invalid public key. Not valid Base64. {}", e))?;
    if pubkey_bin.len() != 32 {
        return Err(format!(
            "Invalid public key, should be 32 bytes long instead of {}. Key: {}",
            pubkey_bin.len(),
            public_key
        )
        .into());
    }
    Ok(())
}

/// Migrates a legacy HTTP agent subject (`https://server/agents/{pubkey}`) to `did:ad:agent:{pubkey}`.
/// Returns the input unchanged if it doesn't match the legacy pattern.
pub fn migrate_http_agent_subject(subject: &str) -> String {
    if let Some(pubkey) = subject
        .strip_prefix("http://")
        .or_else(|| subject.strip_prefix("https://"))
        .and_then(|s| s.split_once('/'))
        .and_then(|(_, path)| path.strip_prefix("agents/"))
    {
        return format!("did:ad:agent:{}", pubkey);
    }
    subject.to_string()
}

impl From<Agent> for ForAgent {
    fn from(agent: Agent) -> Self {
        ForAgent::AgentSubject(agent.subject)
    }
}

impl<'a> From<&'a Agent> for ForAgent {
    fn from(agent: &'a Agent) -> Self {
        ForAgent::AgentSubject(agent.subject.clone())
    }
}

#[cfg(test)]
mod test {
    #[cfg(test)]
    use super::*;

    #[test]
    fn keypair() {
        let pair = generate_keypair().unwrap();
        let regenerated_pair = generate_public_key(&pair.private);
        assert_eq!(pair.public, regenerated_pair.public);
    }

    #[test]
    fn generate_from_private_key() {
        let private_key = "CapMWIhFUT+w7ANv9oCPqrHrwZpkP2JhzF9JnyT6WcI=";
        let public_key = "7LsjMW5gOfDdJzK/atgjQ1t20J/rw8MjVg6xwqm+h8U=";
        let regenerated_pair = generate_public_key(private_key);
        assert_eq!(public_key, regenerated_pair.public);
    }

    #[test]
    fn verifies_public_keys() {
        let valid_public_key = "7LsjMW5gOfDdJzK/atgjQ1t20J/rw8MjVg6xwqm+h8U=";
        let invalid_length = "7LsjMW5gOfDdJzK/atgjQ1t20J/rw8MjVg6xwm+h8U";
        let invalid_char = "7LsjMW5gOfDdJzK/atgjQ1t20^/rw8MjVg6xwqm+h8U=";
        verify_public_key(valid_public_key).unwrap();
        verify_public_key(invalid_length).unwrap_err();
        verify_public_key(invalid_char).unwrap_err();
    }

    #[test]
    fn creates_from_secret() {
        let secret = "eyJjbGllbnQiOnt9LCJzdWJqZWN0IjoiaHR0cDovL2xvY2FsaG9zdDo5ODgzL2FnZW50cy9ScVB3cGdIditQSzdQbnovZFZhYjhobUhqWW52VEwxWXJsVmE2TDlHOVpnPSIsInByaXZhdGVLZXkiOiJTTXl4UmdGN1FoaUM3QzUwNnFYU1VLZkUrU0tBdENkTkZ1NVhlVGp6YWRBPSIsInB1YmxpY0tleSI6IlJxUHdwZ0h2K1BLN1Buei9kVmFiOGhtSGpZbnZUTDFZcmxWYTZMOUc5Wmc9In0=";
        let agent = Agent::from_secret(secret).unwrap();
        assert_eq!(
            agent.private_key.unwrap(),
            "SMyxRgF7QhiC7C506qXSUKfE+SKAtCdNFu5XeTjzadA="
        );
        // Legacy HTTP subject is automatically migrated to did:ad:agent:
        assert_eq!(
            agent.subject,
            "did:ad:agent:RqPwpgHv+PK7Pnz/dVab8hmHjYnvTL1YrlVa6L9G9Zg="
        );
    }

    #[test]
    fn can_build_secret() {
        let og_secret = "eyJwcml2YXRlS2V5IjoiU015eFJnRjdRaGlDN0M1MDZxWFNVS2ZFK1NLQXRDZE5GdTVYZVRqemFkQT0iLCJzdWJqZWN0IjoiaHR0cDovL2xvY2FsaG9zdDo5ODgzL2FnZW50cy9ScVB3cGdIditQSzdQbnovZFZhYjhobUhqWW52VEwxWXJsVmE2TDlHOVpnPSJ9";
        let agent = Agent::from_secret(og_secret).unwrap();
        // Legacy HTTP subject should be migrated to did:ad:agent:
        assert_eq!(
            agent.subject.to_string(),
            "did:ad:agent:RqPwpgHv+PK7Pnz/dVab8hmHjYnvTL1YrlVa6L9G9Zg="
        );
        let secret = agent.build_secret().unwrap();
        let agent2 = Agent::from_secret(&secret).unwrap();
        assert_eq!(agent2.subject, agent.subject);
    }

    #[test]
    fn migrate_http_agent_subject_works() {
        assert_eq!(
            migrate_http_agent_subject(
                "http://localhost:9883/agents/RqPwpgHv+PK7Pnz/dVab8hmHjYnvTL1YrlVa6L9G9Zg="
            ),
            "did:ad:agent:RqPwpgHv+PK7Pnz/dVab8hmHjYnvTL1YrlVa6L9G9Zg="
        );
        assert_eq!(
            migrate_http_agent_subject("did:ad:agent:somepubkey"),
            "did:ad:agent:somepubkey"
        );
        assert_eq!(
            migrate_http_agent_subject("https://example.com/agents/pubkey123"),
            "did:ad:agent:pubkey123"
        );
    }
}
