//! WebSocket Protocol v2: binary-first, unified messages.
//!
//! Frame format: `[type: u8] [payload...]`
//! All frames are binary WebSocket frames. No base64, no JSON for Loro bytes.
//!
//! **Canonical wire-format spec:** `docs/src/websockets.md`. This module is
//! the Rust source of truth for tag bytes, flag bits, and encode/decode of
//! every frame; when you change anything here, update that doc and the
//! TypeScript counterpart (`browser/lib/src/ws-v2.ts`) in the same change.
//!
//! Used by:
//! - `server/src/handlers/web_sockets.rs` — browser-facing WS handler
//! - `lib/src/sync/engine.rs` — transport-agnostic drive sync (SYNC*)
//! - `lib/src/sync/peer.rs` — Iroh QUIC peer transport (adds HELLO)
//! - `lib/src/client/ws.rs` — Rust WS client

/// Message type tags
#[allow(dead_code)]
pub mod tag {
    pub const AUTH: u8 = 0x01;
    pub const AUTH_OK: u8 = 0x02;
    pub const ERROR: u8 = 0x03;
    pub const GET: u8 = 0x10;
    pub const UPDATE: u8 = 0x11;
    pub const DESTROY: u8 = 0x12;
    pub const COMMIT: u8 = 0x13;
    pub const COMMIT_OK: u8 = 0x14;
    pub const SUB: u8 = 0x20;
    pub const UNSUB: u8 = 0x21;
    pub const SYNC: u8 = 0x30;
    pub const SYNC_OK: u8 = 0x31;
    pub const SYNC_DIFF: u8 = 0x32;
    pub const SYNC_PUSH: u8 = 0x33;
    pub const BLOB_REQUEST: u8 = 0x34;
    pub const BLOB_RESPONSE: u8 = 0x35;
    /// Reserved (do not reuse). Previously `QUERY_UPDATE` — retired in
    /// `planning/drop-query-update.md`. Drive-wide and resource-level
    /// commits now travel exclusively as `UPDATE` (0x11) and `DESTROY`
    /// (0x12) frames carrying the full snapshot + commit_id.
    pub const QUERY_UPDATE_RESERVED: u8 = 0x36;
    /// Self-reported display name swap on peer-sync streams. Sent by both
    /// sides after `AUTH_OK`, before `SYNC_VV`. Display only; never used for
    /// authorization (the authenticated agent + Iroh NodeId are).
    pub const HELLO: u8 = 0x37;
    pub const EPHEMERAL: u8 = 0x40;
}

/// HELLO display name cap. Counted in Unicode scalar values, not bytes, so
/// "🚀 prod-eu-3" doesn't get split mid-character on the wire. Anything
/// longer is rejected by `decode_hello` rather than silently truncated —
/// truncation hides config typos that would otherwise scream at the user.
pub const HELLO_MAX_CHARS: usize = 64;

/// UPDATE flags (bitfield)
pub mod flags {
    /// Loro snapshot (1) vs delta (0)
    pub const SNAPSHOT: u8 = 0b0001;
    /// A commit ID follows the subject
    pub const HAS_COMMIT_ID: u8 = 0b0010;
    /// Server→client subscription push (not a GET response)
    pub const PUSH: u8 = 0b0100;
}

/// SYNC_PUSH flags (bitfield)
pub mod sync_push_flags {
    /// This is the final chunk of a SYNC_PUSH run. Receivers loop reading
    /// SYNC_PUSH frames until they see one with this bit set.
    pub const LAST: u8 = 0b0001;
}

/// Chunking thresholds for `encode_sync_push_chunks`. A chunk closes when
/// either threshold is hit, whichever comes first.
pub const SYNC_PUSH_MAX_ENTRIES: usize = 100;
pub const SYNC_PUSH_MAX_BYTES: usize = 1_048_576; // 1 MB

// ---- Encoding ----

/// Encode an AUTH frame: [0x01] [json AuthValues]
/// The agent signs `requested_subject timestamp` with its private key.
pub fn encode_auth(
    agent: &crate::agents::Agent,
    requested_subject: &str,
) -> crate::errors::AtomicResult<Vec<u8>> {
    let timestamp = crate::utils::now();
    let message = format!("{} {}", requested_subject, timestamp);
    let signature = crate::agents::sign_message(
        message.as_bytes(),
        agent
            .private_key
            .as_ref()
            .ok_or("Agent has no private key")?,
    )?;

    let auth = serde_json::json!({
        "https://atomicdata.dev/properties/auth/publicKey": agent.public_key,
        "https://atomicdata.dev/properties/auth/timestamp": timestamp,
        "https://atomicdata.dev/properties/auth/signature": signature,
        "https://atomicdata.dev/properties/auth/requestedSubject": requested_subject,
        "https://atomicdata.dev/properties/auth/agent": agent.subject.to_string(),
    });

    let json_bytes =
        serde_json::to_vec(&auth).map_err(|e| format!("Failed to encode auth: {e}"))?;
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

    // Capacity layout:
    // - 1 byte for UPDATE type tag
    // - 1 byte for flag bits
    // - 2 bytes for request_id (u16)
    // - 2 bytes for subject_len (u16)
    // - subject_bytes.len()
    // - commit_len (optional 2 bytes len + commit_id bytes)
    // - loro_bytes.len()
    let mut buf =
        Vec::with_capacity(1 + 1 + 2 + 2 + subject_bytes.len() + commit_len + loro_bytes.len());

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

/// Encode a GET message.
pub fn encode_get(request_id: u16, subject: &str) -> Vec<u8> {
    let subject_bytes = subject.as_bytes();
    let mut buf = Vec::with_capacity(3 + subject_bytes.len());
    buf.push(tag::GET);
    buf.extend_from_slice(&request_id.to_be_bytes());
    buf.extend_from_slice(subject_bytes);
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

/// Encode a COMMIT message.
///
/// Format: `[0x13] [request_id: u16] [commit_json_utf8]`.
pub fn encode_commit(request_id: u16, commit_json: &str) -> Vec<u8> {
    let mut buf = Vec::with_capacity(3 + commit_json.len());
    buf.push(tag::COMMIT);
    buf.extend_from_slice(&request_id.to_be_bytes());
    buf.extend_from_slice(commit_json.as_bytes());
    buf
}

/// Encode a COMMIT_OK message.
///
/// Format: `[0x14] [request_id: u16] [server_commit_json_utf8]`.
pub fn encode_commit_ok(request_id: u16, commit_json: &str) -> Vec<u8> {
    let mut buf = Vec::with_capacity(3 + commit_json.len());
    buf.push(tag::COMMIT_OK);
    buf.extend_from_slice(&request_id.to_be_bytes());
    buf.extend_from_slice(commit_json.as_bytes());
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

/// Encode SUB: subscribe to drive-scoped updates (server pushes QUERY_UPDATE + UPDATE).
pub fn encode_sub(drive_subject: &str) -> Vec<u8> {
    let drive_bytes = drive_subject.as_bytes();
    let mut buf = Vec::with_capacity(1 + drive_bytes.len());
    buf.push(tag::SUB);
    buf.extend_from_slice(drive_bytes);
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

/// Encode SYNC_DIFF: [0x32] [drive_len: u16] [drive] [json{pull, push, remove?}]
pub fn encode_sync_diff(
    drive: &str,
    pull: &[String],
    push: &[String],
    remove: &[String],
    pull_from: &std::collections::HashMap<String, std::collections::HashMap<String, i32>>,
) -> Vec<u8> {
    let drive_bytes = drive.as_bytes();
    let diff = serde_json::json!({
        "pull": pull,
        "push": push,
        "remove": remove,
        "pullFrom": pull_from,
    });
    let diff_bytes = serde_json::to_vec(&diff).unwrap_or_default();

    let mut buf = Vec::with_capacity(3 + drive_bytes.len() + diff_bytes.len());
    buf.push(tag::SYNC_DIFF);
    buf.extend_from_slice(&(drive_bytes.len() as u16).to_be_bytes());
    buf.extend_from_slice(drive_bytes);
    buf.extend_from_slice(&diff_bytes);
    buf
}

/// Encode a single SYNC_PUSH chunk:
/// `[0x33] [drive_len: u16] [drive] [flags: u8] [count: u16]
///  [subject_len: u16] [subject] [bytes_len: u32] [loro_bytes] ...`
///
/// Set `last = true` to signal the final chunk of a run; receivers loop
/// reading SYNC_PUSH until they see one with the LAST flag set. Use
/// `encode_sync_push_chunks` for the common case where you have a flat
/// `entries` list and want it split + flagged automatically.
pub fn encode_sync_push(drive: &str, entries: &[(&str, &[u8])], last: bool) -> Vec<u8> {
    let drive_bytes = drive.as_bytes();
    let total_entry_size: usize = entries.iter().map(|(s, b)| 2 + s.len() + 4 + b.len()).sum();

    let mut buf = Vec::with_capacity(1 + 2 + drive_bytes.len() + 1 + 2 + total_entry_size);
    buf.push(tag::SYNC_PUSH);
    buf.extend_from_slice(&(drive_bytes.len() as u16).to_be_bytes());
    buf.extend_from_slice(drive_bytes);
    buf.push(if last { sync_push_flags::LAST } else { 0 });
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

/// Split `entries` into one or more SYNC_PUSH frames bounded by
/// [`SYNC_PUSH_MAX_ENTRIES`] and [`SYNC_PUSH_MAX_BYTES`]; the last frame
/// has the [`sync_push_flags::LAST`] bit set. Always returns at least one
/// frame, even when `entries` is empty (the empty terminator).
///
/// Receivers must loop reading SYNC_PUSH frames until the LAST bit fires
/// — otherwise they'll terminate the read early or hang waiting for data
/// that's not coming.
pub fn encode_sync_push_chunks(drive: &str, entries: &[(&str, &[u8])]) -> Vec<Vec<u8>> {
    if entries.is_empty() {
        return vec![encode_sync_push(drive, &[], true)];
    }

    let mut chunks: Vec<Vec<u8>> = Vec::new();
    let mut start = 0;
    while start < entries.len() {
        let mut end = start;
        let mut bytes_acc: usize = 0;
        while end < entries.len() && end - start < SYNC_PUSH_MAX_ENTRIES {
            let (s, b) = entries[end];
            let entry_size = 2 + s.len() + 4 + b.len();
            // Always include at least one entry per chunk, even if it alone
            // exceeds the byte budget — chunking past a single oversized
            // entry isn't possible without subdividing the loro_bytes.
            if end > start && bytes_acc + entry_size > SYNC_PUSH_MAX_BYTES {
                break;
            }
            bytes_acc += entry_size;
            end += 1;
        }
        let last = end == entries.len();
        chunks.push(encode_sync_push(drive, &entries[start..end], last));
        start = end;
    }
    chunks
}

/// Encode a HELLO frame: `[0x37] [name_len: u16] [name_utf8]`.
///
/// `name` is the sender's self-reported display name. Pass an empty string
/// if you don't have one — the receiver still decodes it; the UI just shows
/// "Unknown device". This frame is purely informational; downstream auth
/// decisions must use the authenticated agent or Iroh NodeId.
pub fn encode_hello(name: &str) -> Vec<u8> {
    let name_bytes = name.as_bytes();
    // u16 length prefix bounds the wire size at ~64 KB even if the caller
    // hands us a giant string. `decode_hello` enforces the real display cap.
    let len = name_bytes.len().min(u16::MAX as usize);
    let mut buf = Vec::with_capacity(3 + len);
    buf.push(tag::HELLO);
    buf.extend_from_slice(&(len as u16).to_be_bytes());
    buf.extend_from_slice(&name_bytes[..len]);
    buf
}

/// Decode the payload of a HELLO frame (slice *after* the tag byte).
///
/// Returns `None` if the frame is malformed (truncated, invalid UTF-8, or
/// the decoded name exceeds [`HELLO_MAX_CHARS`] scalar values). Control
/// characters are stripped so a hostile peer can't smuggle line breaks
/// into log output.
pub fn decode_hello(data: &[u8]) -> Option<String> {
    if data.len() < 2 {
        return None;
    }
    let len = u16::from_be_bytes([data[0], data[1]]) as usize;
    if data.len() < 2 + len {
        return None;
    }
    let raw = std::str::from_utf8(&data[2..2 + len]).ok()?;
    // Strip control chars; we display the name in HTML/logs as-is.
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
    if cleaned.chars().count() > HELLO_MAX_CHARS {
        return None;
    }
    Some(cleaned)
}

/// Encode a BLOB_REQUEST message: [0x34] [hash: [u8; 32]]
pub fn encode_blob_request(hash: &[u8; 32]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + 32);
    buf.push(tag::BLOB_REQUEST);
    buf.extend_from_slice(hash);
    buf
}

/// Encode a BLOB_RESPONSE message: [0x35] [hash: [u8; 32]] [bytes...]
pub fn encode_blob_response(hash: &[u8; 32], bytes: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + 32 + bytes.len());
    buf.push(tag::BLOB_RESPONSE);
    buf.extend_from_slice(hash);
    buf.extend_from_slice(bytes);
    buf
}

/// Decoded UPDATE message.
///
/// Authoritative source of truth for the wire format: [docs/src/websockets.md](file:///Users/joep/dev/atomic-server/docs/src/websockets.md)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedUpdate {
    pub flag_bits: u8,
    pub request_id: u16,
    pub subject: String,
    pub commit_id: Option<String>,
    pub loro_bytes: Vec<u8>,
}

/// Decode an UPDATE message (after the type tag).
///
/// Authoritative source of truth for the wire format: [docs/src/websockets.md](file:///Users/joep/dev/atomic-server/docs/src/websockets.md)
pub fn decode_update(payload: &[u8]) -> Option<DecodedUpdate> {
    if payload.len() < 5 {
        return None;
    }
    let flag_bits = payload[0];
    let request_id = u16::from_be_bytes([payload[1], payload[2]]);
    let subject_len = u16::from_be_bytes([payload[3], payload[4]]) as usize;
    let mut cursor = 5;
    if payload.len() < cursor + subject_len {
        return None;
    }
    let subject = std::str::from_utf8(&payload[cursor..cursor + subject_len])
        .ok()?
        .to_string();
    cursor += subject_len;

    let mut commit_id = None;
    if flag_bits & flags::HAS_COMMIT_ID != 0 {
        if payload.len() < cursor + 2 {
            return None;
        }
        let cid_len = u16::from_be_bytes([payload[cursor], payload[cursor + 1]]) as usize;
        cursor += 2;
        if payload.len() < cursor + cid_len {
            return None;
        }
        commit_id = Some(
            std::str::from_utf8(&payload[cursor..cursor + cid_len])
                .ok()?
                .to_string(),
        );
        cursor += cid_len;
    }

    let loro_bytes = payload[cursor..].to_vec();

    Some(DecodedUpdate {
        flag_bits,
        request_id,
        subject,
        commit_id,
        loro_bytes,
    })
}

// ---- Decoding (used by binary frame handler) ----

/// Decoded GET message.
pub struct DecodedGet<'a> {
    pub request_id: u16,
    pub subject: &'a str,
}

/// Decoded COMMIT / COMMIT_OK message.
pub struct DecodedCommit<'a> {
    pub request_id: u16,
    pub commit_json: &'a str,
}

/// Decode a GET message (after the type tag).
pub fn decode_get(data: &[u8]) -> Option<DecodedGet<'_>> {
    if data.len() < 2 {
        return None;
    }

    let request_id = u16::from_be_bytes([data[0], data[1]]);
    let subject = std::str::from_utf8(&data[2..]).ok()?;
    Some(DecodedGet {
        request_id,
        subject,
    })
}

/// Decode a COMMIT or COMMIT_OK message (after the type tag).
pub fn decode_commit(data: &[u8]) -> Option<DecodedCommit<'_>> {
    if data.len() < 2 {
        return None;
    }

    let request_id = u16::from_be_bytes([data[0], data[1]]);
    let commit_json = std::str::from_utf8(&data[2..]).ok()?;
    Some(DecodedCommit {
        request_id,
        commit_json,
    })
}

/// Decode a BLOB_REQUEST message (after the type tag).
pub fn decode_blob_request(data: &[u8]) -> Option<[u8; 32]> {
    if data.len() < 32 {
        return None;
    }
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&data[0..32]);
    Some(hash)
}

/// Decoded BLOB_RESPONSE message.
pub struct DecodedBlobResponse {
    pub hash: [u8; 32],
    pub bytes: Vec<u8>,
}

/// Decode a BLOB_RESPONSE message (after the type tag).
pub fn decode_blob_response(data: &[u8]) -> Option<DecodedBlobResponse> {
    if data.len() < 32 {
        return None;
    }
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&data[0..32]);
    let bytes = data[32..].to_vec();
    Some(DecodedBlobResponse { hash, bytes })
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

    let mut buf =
        Vec::with_capacity(1 + 2 + drive_bytes.len() + 2 + hash_bytes.len() + json_bytes.len());
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
    /// Subjects the client should delete (destroyed on the server).
    pub remove: Vec<String>,
    /// Server oplog VV per `pull` subject — client exports updates since this.
    pub pull_from: std::collections::HashMap<String, std::collections::HashMap<String, i32>>,
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
        #[serde(default)]
        remove: Vec<String>,
        #[serde(default, rename = "pullFrom")]
        pull_from: std::collections::HashMap<String, std::collections::HashMap<String, i32>>,
    }

    let parsed: DiffJson = serde_json::from_slice(json_bytes).ok()?;

    Some(DecodedSyncDiff {
        drive: drive.to_string(),
        pull: parsed.pull,
        push: parsed.push,
        remove: parsed.remove,
        pull_from: parsed.pull_from,
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
    /// True iff this is the final chunk of a SYNC_PUSH run. Receivers loop
    /// reading SYNC_PUSH frames until they see one with `last == true`.
    pub last: bool,
}

/// Decode a SYNC_PUSH message (after the type tag).
pub fn decode_sync_push(data: &[u8]) -> Option<DecodedSyncPush> {
    if data.len() < 4 {
        return None;
    }
    let drive_len = u16::from_be_bytes([data[0], data[1]]) as usize;
    let drive = std::str::from_utf8(data.get(2..2 + drive_len)?).ok()?;
    let rest = data.get(2 + drive_len..)?;

    // [flags: u8] [count: u16] [entries...]
    if rest.len() < 3 {
        return None;
    }
    let flag_bits = rest[0];
    let last = flag_bits & sync_push_flags::LAST != 0;
    let count = u16::from_be_bytes([rest[1], rest[2]]) as usize;
    let mut pos = 3;
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
        last,
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
        let decoded = decode_update(&encoded[1..]).expect("Should decode");
        assert_eq!(decoded.flag_bits, flag_bits);
        assert_eq!(decoded.request_id, 42);
        assert_eq!(decoded.subject, "did:ad:test");
        assert_eq!(decoded.commit_id.as_deref(), Some("did:ad:commit:abc"));
        assert_eq!(decoded.loro_bytes, b"loro-snapshot-bytes");
    }

    #[test]
    fn legacy_update_decoder_bug_regression() {
        let flag_bits = flags::HAS_COMMIT_ID;
        let original_loro = b"loro-payload";
        let commit_id = "did:ad:commit:123";
        let subject = "did:ad:test";

        let encoded = encode_update(
            flag_bits,
            1,
            subject,
            Some(commit_id),
            original_loro,
        );

        // Simulate legacy peer.rs slicing behavior:
        let payload = &encoded[1..];
        let subject_len = u16::from_be_bytes([payload[3], payload[4]]) as usize;
        let legacy_loro_bytes = &payload[5 + subject_len..];

        // The legacy parser slices starting at 5 + subject_len.
        // Since HAS_COMMIT_ID is set, the payload at 5 + subject_len contains 
        // 2 bytes of commit_id length, then the commit_id, then the original loro bytes.
        // Therefore, legacy_loro_bytes starts with the commit ID data, not original_loro!
        assert_ne!(legacy_loro_bytes, original_loro);

        // The new unified decoder should parse it correctly.
        let decoded = decode_update(&encoded[1..]).unwrap();
        assert_eq!(decoded.loro_bytes, original_loro);
        assert_eq!(decoded.commit_id.as_deref(), Some(commit_id));
        assert_eq!(decoded.subject, subject);
        assert_eq!(decoded.flag_bits, flag_bits);
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
    fn hello_round_trip() {
        let encoded = encode_hello("Joe's Laptop");
        assert_eq!(encoded[0], tag::HELLO);
        let decoded = decode_hello(&encoded[1..]).unwrap();
        assert_eq!(decoded, "Joe's Laptop");
    }

    #[test]
    fn hello_empty_name() {
        let encoded = encode_hello("");
        let decoded = decode_hello(&encoded[1..]).unwrap();
        assert_eq!(decoded, "");
    }

    #[test]
    fn hello_strips_control_chars() {
        // A peer trying to smuggle newlines into our logs gets them stripped.
        let encoded = encode_hello("OK\nFAKE-LINE");
        let decoded = decode_hello(&encoded[1..]).unwrap();
        assert_eq!(decoded, "OKFAKE-LINE");
    }

    #[test]
    fn hello_rejects_oversize_name() {
        // 65 ASCII chars > HELLO_MAX_CHARS (64) → reject.
        let name = "x".repeat(HELLO_MAX_CHARS + 1);
        let encoded = encode_hello(&name);
        assert!(decode_hello(&encoded[1..]).is_none());
    }

    #[test]
    fn hello_counts_unicode_scalars_not_bytes() {
        // 64 emoji = 64 chars (well under the byte limit). Must decode.
        let name = "🚀".repeat(HELLO_MAX_CHARS);
        let encoded = encode_hello(&name);
        assert_eq!(decode_hello(&encoded[1..]).unwrap(), name);
    }

    #[test]
    fn hello_truncated_payload_returns_none() {
        let mut encoded = encode_hello("hello");
        encoded.truncate(encoded.len() - 2);
        assert!(decode_hello(&encoded[1..]).is_none());
    }

    #[test]
    fn commit_round_trip() {
        let json = r#"{"https://atomicdata.dev/properties/subject":"did:ad:test"}"#;
        let encoded = encode_commit(42, json);
        assert_eq!(encoded[0], tag::COMMIT);
        let decoded = decode_commit(&encoded[1..]).unwrap();
        assert_eq!(decoded.request_id, 42);
        assert_eq!(decoded.commit_json, json);
    }

    #[test]
    fn commit_ok_round_trip() {
        let json = r#"{"@id":"did:ad:commit:test"}"#;
        let encoded = encode_commit_ok(43, json);
        assert_eq!(encoded[0], tag::COMMIT_OK);
        let decoded = decode_commit(&encoded[1..]).unwrap();
        assert_eq!(decoded.request_id, 43);
        assert_eq!(decoded.commit_json, json);
    }

    #[test]
    fn sync_push_structure() {
        let entries: Vec<(&str, &[u8])> =
            vec![("did:ad:r1", b"snapshot1"), ("did:ad:r2", b"delta2")];
        let encoded = encode_sync_push("did:ad:drive", &entries, true);
        assert_eq!(encoded[0], tag::SYNC_PUSH);
        let decoded = decode_sync_push(&encoded[1..]).unwrap();
        assert_eq!(decoded.drive, "did:ad:drive");
        assert_eq!(decoded.entries.len(), 2);
        assert!(decoded.last, "single-frame push must set LAST");
    }

    #[test]
    fn sync_push_chunking() {
        // 250 entries of ~5 bytes each → at least 3 chunks at 100 entries
        // per chunk. Only the final chunk should be marked LAST.
        let small_blob = vec![0u8; 4];
        let owned: Vec<(String, Vec<u8>)> = (0..250)
            .map(|i| (format!("did:ad:r{i}"), small_blob.clone()))
            .collect();
        let entries: Vec<(&str, &[u8])> = owned
            .iter()
            .map(|(s, b)| (s.as_str(), b.as_slice()))
            .collect();

        let chunks = encode_sync_push_chunks("did:ad:drive", &entries);
        assert!(
            chunks.len() >= 3,
            "expected ≥3 chunks, got {}",
            chunks.len()
        );

        let mut total_entries = 0;
        for (i, chunk) in chunks.iter().enumerate() {
            let decoded = decode_sync_push(&chunk[1..]).expect("decode chunk");
            total_entries += decoded.entries.len();
            let is_last = i == chunks.len() - 1;
            assert_eq!(
                decoded.last, is_last,
                "chunk {} LAST flag wrong (is_last={})",
                i, is_last
            );
        }
        assert_eq!(total_entries, 250);
    }

    #[test]
    fn sync_push_empty_terminator() {
        // Empty entries still produces one frame with LAST set, so
        // receivers don't hang waiting for a terminator.
        let chunks = encode_sync_push_chunks("did:ad:drive", &[]);
        assert_eq!(chunks.len(), 1);
        let decoded = decode_sync_push(&chunks[0][1..]).unwrap();
        assert_eq!(decoded.entries.len(), 0);
        assert!(decoded.last);
    }

    #[test]
    fn error_encoding() {
        let encoded = encode_error(99, "Not found");
        assert_eq!(encoded[0], tag::ERROR);
        let request_id = u16::from_be_bytes([encoded[1], encoded[2]]);
        assert_eq!(request_id, 99);
        assert_eq!(&encoded[3..], b"Not found");
    }

    #[test]
    fn encode_sub_frame() {
        let encoded = encode_sub("did:ad:drive:abc");
        assert_eq!(encoded[0], tag::SUB);
        assert_eq!(&encoded[1..], b"did:ad:drive:abc");
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
