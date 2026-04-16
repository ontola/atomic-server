//! WebSocket Protocol v2: binary-first, unified messages.
//!
//! Frame format: `[type: u8] [payload...]`
//! All frames are binary WebSocket frames. No base64, no JSON for Loro bytes.

/// Message type tags
#[allow(dead_code)]
pub mod tag {
    pub const AUTH: u8 = 0x01;
    pub const AUTH_OK: u8 = 0x02;
    pub const ERROR: u8 = 0x03;
    pub const GET: u8 = 0x10;
    pub const UPDATE: u8 = 0x11;
    pub const DESTROY: u8 = 0x12;
    pub const SUB: u8 = 0x20;
    pub const UNSUB: u8 = 0x21;
    pub const SYNC: u8 = 0x30;
    pub const SYNC_OK: u8 = 0x31;
    pub const SYNC_DIFF: u8 = 0x32;
    pub const SYNC_PUSH: u8 = 0x33;
    pub const EPHEMERAL: u8 = 0x40;
}

/// UPDATE flags (bitfield)
pub mod flags {
    /// Loro snapshot (1) vs delta (0)
    pub const SNAPSHOT: u8 = 0b0001;
    /// A commit ID follows the subject
    pub const HAS_COMMIT_ID: u8 = 0b0010;
    /// Server→client subscription push (not a GET response)
    pub const PUSH: u8 = 0b0100;
}

// ---- Encoding ----

/// Encode an AUTH frame: [0x01] [json AuthValues]
/// The agent signs `requested_subject timestamp` with its private key.
pub fn encode_auth(agent: &crate::agents::Agent, requested_subject: &str) -> crate::errors::AtomicResult<Vec<u8>> {
    let timestamp = crate::utils::now();
    let message = format!("{} {}", requested_subject, timestamp);
    let signature = crate::agents::sign_message(message.as_bytes(), agent.private_key.as_ref().ok_or("Agent has no private key")?)?;

    let auth = serde_json::json!({
        "https://atomicdata.dev/properties/auth/publicKey": agent.public_key,
        "https://atomicdata.dev/properties/auth/timestamp": timestamp,
        "https://atomicdata.dev/properties/auth/signature": signature,
        "https://atomicdata.dev/properties/auth/requestedSubject": requested_subject,
        "https://atomicdata.dev/properties/auth/agent": agent.subject.to_string(),
    });

    let json_bytes = serde_json::to_vec(&auth).map_err(|e| format!("Failed to encode auth: {e}"))?;
    let mut buf = Vec::with_capacity(1 + json_bytes.len());
    buf.push(tag::AUTH);
    buf.extend_from_slice(&json_bytes);
    Ok(buf)
}

/// Encode an UPDATE message.
pub fn encode_update(
    flag_bits: u8,
    request_id: u16,
    subject: &str,
    commit_id: Option<&str>,
    loro_bytes: &[u8],
) -> Vec<u8> {
    let subject_bytes = subject.as_bytes();
    let commit_id_bytes = commit_id.map(|s| s.as_bytes());
    let commit_len = commit_id_bytes.map(|b| 2 + b.len()).unwrap_or(0);

    let mut buf = Vec::with_capacity(
        1 + 1 + 2 + 2 + subject_bytes.len() + commit_len + loro_bytes.len(),
    );

    buf.push(tag::UPDATE);
    buf.push(flag_bits);
    buf.extend_from_slice(&request_id.to_be_bytes());
    buf.extend_from_slice(&(subject_bytes.len() as u16).to_be_bytes());
    buf.extend_from_slice(subject_bytes);

    if let Some(cid) = commit_id_bytes {
        buf.extend_from_slice(&(cid.len() as u16).to_be_bytes());
        buf.extend_from_slice(cid);
    }

    buf.extend_from_slice(loro_bytes);
    buf
}

/// Encode a DESTROY message.
pub fn encode_destroy(request_id: u16, subject: &str) -> Vec<u8> {
    let mut buf = Vec::with_capacity(3 + subject.len());
    buf.push(tag::DESTROY);
    buf.extend_from_slice(&request_id.to_be_bytes());
    buf.extend_from_slice(subject.as_bytes());
    buf
}

/// Encode an ERROR message.
pub fn encode_error(request_id: u16, message: &str) -> Vec<u8> {
    let mut buf = Vec::with_capacity(3 + message.len());
    buf.push(tag::ERROR);
    buf.extend_from_slice(&request_id.to_be_bytes());
    buf.extend_from_slice(message.as_bytes());
    buf
}

/// Encode AUTH_OK.
pub fn encode_auth_ok() -> Vec<u8> {
    vec![tag::AUTH_OK]
}

/// Encode SYNC_OK.
pub fn encode_sync_ok(drive: &str) -> Vec<u8> {
    let drive_bytes = drive.as_bytes();
    let mut buf = Vec::with_capacity(3 + drive_bytes.len());
    buf.push(tag::SYNC_OK);
    buf.extend_from_slice(&(drive_bytes.len() as u16).to_be_bytes());
    buf.extend_from_slice(drive_bytes);
    buf
}

/// Encode SYNC_DIFF: [0x32] [drive_len: u16] [drive] [json{pull, push}]
pub fn encode_sync_diff(drive: &str, pull: &[String], push: &[String]) -> Vec<u8> {
    let drive_bytes = drive.as_bytes();
    let diff = serde_json::json!({ "pull": pull, "push": push });
    let diff_bytes = serde_json::to_vec(&diff).unwrap_or_default();

    let mut buf = Vec::with_capacity(3 + drive_bytes.len() + diff_bytes.len());
    buf.push(tag::SYNC_DIFF);
    buf.extend_from_slice(&(drive_bytes.len() as u16).to_be_bytes());
    buf.extend_from_slice(drive_bytes);
    buf.extend_from_slice(&diff_bytes);
    buf
}

/// Encode SYNC_PUSH: [0x33] [drive_len: u16] [drive] [count: u16]
///   [subject_len: u16] [subject] [bytes_len: u32] [loro_bytes] ...
pub fn encode_sync_push(drive: &str, entries: &[(&str, &[u8])]) -> Vec<u8> {
    let drive_bytes = drive.as_bytes();
    let total_entry_size: usize = entries
        .iter()
        .map(|(s, b)| 2 + s.len() + 4 + b.len())
        .sum();

    let mut buf = Vec::with_capacity(3 + drive_bytes.len() + 2 + total_entry_size);
    buf.push(tag::SYNC_PUSH);
    buf.extend_from_slice(&(drive_bytes.len() as u16).to_be_bytes());
    buf.extend_from_slice(drive_bytes);
    buf.extend_from_slice(&(entries.len() as u16).to_be_bytes());

    for (subject, loro_bytes) in entries {
        let s = subject.as_bytes();
        buf.extend_from_slice(&(s.len() as u16).to_be_bytes());
        buf.extend_from_slice(s);
        buf.extend_from_slice(&(loro_bytes.len() as u32).to_be_bytes());
        buf.extend_from_slice(loro_bytes);
    }

    buf
}

// ---- Decoding (used by binary frame handler) ----

/// Decoded GET message.
pub struct DecodedGet<'a> {
    pub request_id: u16,
    pub subject: &'a str,
}

/// Decode a GET message (after the type tag).
pub fn decode_get(data: &[u8]) -> Option<DecodedGet<'_>> {
    if data.len() < 2 {
        return None;
    }

    let request_id = u16::from_be_bytes([data[0], data[1]]);
    let subject = std::str::from_utf8(&data[2..]).ok()?;
    Some(DecodedGet { request_id, subject })
}

/// Encode SYNC (client → server): [0x30] [drive_len: u16] [drive] [hash_len: u16] [hash] [json{peers, resources}]
pub fn encode_sync(
    drive: &str,
    drive_hash: &str,
    peers: &[String],
    resources: &std::collections::HashMap<String, Vec<i32>>,
) -> Vec<u8> {
    let drive_bytes = drive.as_bytes();
    let hash_bytes = drive_hash.as_bytes();
    let json = serde_json::json!({ "peers": peers, "resources": resources });
    let json_bytes = serde_json::to_vec(&json).unwrap_or_default();

    let mut buf = Vec::with_capacity(
        1 + 2 + drive_bytes.len() + 2 + hash_bytes.len() + json_bytes.len(),
    );
    buf.push(tag::SYNC);
    buf.extend_from_slice(&(drive_bytes.len() as u16).to_be_bytes());
    buf.extend_from_slice(drive_bytes);
    buf.extend_from_slice(&(hash_bytes.len() as u16).to_be_bytes());
    buf.extend_from_slice(hash_bytes);
    buf.extend_from_slice(&json_bytes);
    buf
}

/// Decoded SYNC message.
pub struct DecodedSync {
    pub drive: String,
    pub drive_hash: String,
    pub peers: Vec<String>,
    pub resources: std::collections::HashMap<String, Vec<i32>>,
}

/// Decode a SYNC message (after the type tag).
pub fn decode_sync(data: &[u8]) -> Option<DecodedSync> {
    if data.len() < 4 {
        return None;
    }
    let drive_len = u16::from_be_bytes([data[0], data[1]]) as usize;
    let drive = std::str::from_utf8(data.get(2..2 + drive_len)?).ok()?;
    let rest = data.get(2 + drive_len..)?;

    if rest.len() < 2 {
        return None;
    }
    let hash_len = u16::from_be_bytes([rest[0], rest[1]]) as usize;
    let hash = std::str::from_utf8(rest.get(2..2 + hash_len)?).ok()?;
    let json_bytes = rest.get(2 + hash_len..)?;

    #[derive(serde::Deserialize)]
    struct SyncJson {
        peers: Vec<String>,
        resources: std::collections::HashMap<String, Vec<i32>>,
    }

    let parsed: SyncJson = serde_json::from_slice(json_bytes).ok()?;

    Some(DecodedSync {
        drive: drive.to_string(),
        drive_hash: hash.to_string(),
        peers: parsed.peers,
        resources: parsed.resources,
    })
}

/// Decoded SYNC_DIFF message.
pub struct DecodedSyncDiff {
    pub drive: String,
    pub pull: Vec<String>,
    pub push: Vec<String>,
}

/// Decode a SYNC_DIFF message (after the type tag).
pub fn decode_sync_diff(data: &[u8]) -> Option<DecodedSyncDiff> {
    if data.len() < 2 {
        return None;
    }
    let drive_len = u16::from_be_bytes([data[0], data[1]]) as usize;
    let drive = std::str::from_utf8(data.get(2..2 + drive_len)?).ok()?;
    let json_bytes = data.get(2 + drive_len..)?;

    #[derive(serde::Deserialize)]
    struct DiffJson {
        pull: Vec<String>,
        push: Vec<String>,
    }

    let parsed: DiffJson = serde_json::from_slice(json_bytes).ok()?;

    Some(DecodedSyncDiff {
        drive: drive.to_string(),
        pull: parsed.pull,
        push: parsed.push,
    })
}

/// A single entry in a SYNC_PUSH message.
pub struct SyncPushEntry {
    pub subject: String,
    pub loro_bytes: Vec<u8>,
}

/// Decoded SYNC_PUSH message.
pub struct DecodedSyncPush {
    pub drive: String,
    pub entries: Vec<SyncPushEntry>,
}

/// Decode a SYNC_PUSH message (after the type tag).
pub fn decode_sync_push(data: &[u8]) -> Option<DecodedSyncPush> {
    if data.len() < 4 {
        return None;
    }
    let drive_len = u16::from_be_bytes([data[0], data[1]]) as usize;
    let drive = std::str::from_utf8(data.get(2..2 + drive_len)?).ok()?;
    let rest = data.get(2 + drive_len..)?;

    if rest.len() < 2 {
        return None;
    }
    let count = u16::from_be_bytes([rest[0], rest[1]]) as usize;
    let mut pos = 2;
    let mut entries = Vec::with_capacity(count);

    for _ in 0..count {
        if pos + 2 > rest.len() {
            break;
        }
        let subj_len = u16::from_be_bytes([rest[pos], rest[pos + 1]]) as usize;
        pos += 2;
        let subject = std::str::from_utf8(rest.get(pos..pos + subj_len)?).ok()?;
        pos += subj_len;

        if pos + 4 > rest.len() {
            break;
        }
        let bytes_len =
            u32::from_be_bytes([rest[pos], rest[pos + 1], rest[pos + 2], rest[pos + 3]]) as usize;
        pos += 4;
        let loro_bytes = rest.get(pos..pos + bytes_len)?.to_vec();
        pos += bytes_len;

        entries.push(SyncPushEntry {
            subject: subject.to_string(),
            loro_bytes,
        });
    }

    Some(DecodedSyncPush {
        drive: drive.to_string(),
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_round_trip() {
        let flag_bits = flags::SNAPSHOT | flags::HAS_COMMIT_ID | flags::PUSH;
        let encoded = encode_update(
            flag_bits,
            42,
            "did:ad:test",
            Some("did:ad:commit:abc"),
            b"loro-snapshot-bytes",
        );

        assert_eq!(encoded[0], tag::UPDATE);
        // Verify structure: tag(1) + flags(1) + rid(2) + subj_len(2) + subj + cid_len(2) + cid + bytes
        let flags_byte = encoded[1];
        assert_eq!(flags_byte, flag_bits);
        let rid = u16::from_be_bytes([encoded[2], encoded[3]]);
        assert_eq!(rid, 42);
    }

    #[test]
    fn get_round_trip() {
        let encoded = encode_get(7, "did:ad:agent:alice");
        assert_eq!(encoded[0], tag::GET);
        let decoded = decode_get(&encoded[1..]).unwrap();
        assert_eq!(decoded.request_id, 7);
        assert_eq!(decoded.subject, "did:ad:agent:alice");
    }

    #[test]
    fn sync_push_structure() {
        let entries: Vec<(&str, &[u8])> = vec![
            ("did:ad:r1", b"snapshot1"),
            ("did:ad:r2", b"delta2"),
        ];
        let encoded = encode_sync_push("did:ad:drive", &entries);
        assert_eq!(encoded[0], tag::SYNC_PUSH);
        // Just verify it doesn't panic and has reasonable size
        assert!(encoded.len() > 20);
    }

    #[test]
    fn error_encoding() {
        let encoded = encode_error(99, "Not found");
        assert_eq!(encoded[0], tag::ERROR);
        let request_id = u16::from_be_bytes([encoded[1], encoded[2]]);
        assert_eq!(request_id, 99);
        assert_eq!(&encoded[3..], b"Not found");
    }

    // Keep encode_get available for tests even though the server doesn't use it yet
    fn encode_get(request_id: u16, subject: &str) -> Vec<u8> {
        let mut buf = Vec::with_capacity(3 + subject.len());
        buf.push(tag::GET);
        buf.extend_from_slice(&request_id.to_be_bytes());
        buf.extend_from_slice(subject.as_bytes());
        buf
    }
}
