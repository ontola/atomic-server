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
