//! Host-held Willow'25 authorisation for plugin routes (atomic-plugins#167,
//! section 7: "Meadowcap validation and authority-scoped signing of exact
//! Entry bytes").
//!
//! A release declares an Ed25519 key with a `willow` binding (see
//! [`super::manifest_http::WillowBinding`]). That key's public half is the
//! installation's Willow subspace id. `ctx.willow.authorise` hands the host
//! the exact `encode_entry` bytes the plugin wants signed, and the Atomic
//! source revision they were made from. The host signs only when:
//!
//! - the bytes are a canonical Willow'25 Entry (decoded, re-encoded, equal),
//!   within the Willow'25 path limits;
//! - its namespace is the bound one, and communal (the last byte of the id is
//!   even), so the capability is the communal write capability of this
//!   subspace, with no delegations: the only Meadowcap capability the host
//!   issues;
//! - its subspace is this key's public key, and its path starts with the
//!   bound prefix;
//! - the route's principal can read the source resource, and its current
//!   `lastCommit` is the one the plugin says it read: a stale source is
//!   refused, not signed;
//! - its timestamp is that commit's `createdAt`, read as the data model
//!   recommends (microseconds of TAI since J2000, see [`willow_time`]), and
//!   so never more than [`MAX_FUTURE_US`] ahead of this node's clock. The
//!   plugin learns it from `ctx.willow.source`: commits are not always
//!   readable resources, but the host keeps each resource's signed commit
//!   envelopes ([`atomic_lib::envelopes`]);
//! - it is not older than the entry this installation last authorised at the
//!   same namespace, subspace and path (Willow's newer-than order: timestamp,
//!   then payload digest, then payload length).
//!
//! Every authorised entry is persisted (`Tree::PluginMeta`, one record per
//! namespace, subspace and path), with its signature, source subject and
//! commit, so asking again for the same bytes answers the same signature and
//! the plugin can list what it authorised. Owned namespaces, delegations,
//! payload storage and prefix pruning of the records are not implemented.
//!
//! The payload digest is the plugin's claim: the host signs the digest it is
//! given and does not recompute WILLIAM3 over the payload. What binds the
//! entry to Atomic data is the source subject and commit, checked above and
//! recorded with the signature.

use atomic_lib::{agents::ForAgent, db::trees::Tree, urls, Db, Storelike, Subject};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};

use super::{manifest::Manifest, manifest_http::config_key, route_keys};

/// Willow'25 limits: bytes per component, components, bytes per path.
pub const MAX_COMPONENT_LENGTH: usize = 4096;
pub const MAX_COMPONENT_COUNT: usize = 4096;
pub const MAX_PATH_LENGTH: usize = 4096;
/// How far ahead of this node's clock an entry's timestamp may be: 10 minutes.
pub const MAX_FUTURE_US: u64 = 600_000_000;
/// Entries one `ctx.willow.list` answers at most.
pub const MAX_LISTED: usize = 256;

/// `Tree::PluginMeta`: `willow-entry:<installation pure id>\0<namespace>
/// <subspace><encode_path>` → [`Record`].
const RECORD_PREFIX: &str = "willow-entry:";

/// A decoded Willow'25 Entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub namespace: [u8; 32],
    pub subspace: [u8; 32],
    pub path: Vec<Vec<u8>>,
    pub timestamp: u64,
    pub payload_length: u64,
    pub payload_digest: [u8; 32],
}

// -- the Willow encodings (https://willowprotocol.org/specs/encodings/) --------

/// The tag of a compact U64 in `width` bits.
fn tag(value: u64, width: u32) -> u8 {
    let max = (1u64 << width) - 1;
    if value < max - 3 {
        value as u8
    } else if value < 1 << 8 {
        (max - 3) as u8
    } else if value < 1 << 16 {
        (max - 2) as u8
    } else if value < 1 << 32 {
        (max - 1) as u8
    } else {
        max as u8
    }
}

/// The bytes after a compact U64's `width`-bit tag.
fn trailing(value: u64, width: u32) -> Vec<u8> {
    let max = (1u64 << width) - 1;
    let size = match max - u64::from(tag(value, width)) {
        3 => 1,
        2 => 2,
        1 => 4,
        0 => 8,
        _ => 0,
    };
    value.to_be_bytes()[8 - size..].to_vec()
}

fn compact(value: u64) -> Vec<u8> {
    let mut out = vec![tag(value, 8)];
    out.extend(trailing(value, 8));
    out
}

/// `encode_path`.
pub fn encode_path(path: &[Vec<u8>]) -> Vec<u8> {
    let length = path.iter().map(Vec::len).sum::<usize>() as u64;
    let count = path.len() as u64;
    let mut out = vec![(tag(length, 4) << 4) | tag(count, 4)];
    out.extend(trailing(length, 4));
    out.extend(trailing(count, 4));
    for (i, component) in path.iter().enumerate() {
        if i + 1 < path.len() {
            out.extend(compact(component.len() as u64));
        }
        out.extend(component);
    }
    out
}

/// `encode_entry`: the bytes an authorisation token's signature covers.
pub fn encode_entry(entry: &Entry) -> Vec<u8> {
    let mut out = Vec::with_capacity(160);
    out.extend(entry.namespace);
    out.extend(entry.subspace);
    out.extend(encode_path(&entry.path));
    out.extend(compact(entry.timestamp));
    out.extend(compact(entry.payload_length));
    out.extend(entry.payload_digest);
    out
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self
            .at
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len())
            .ok_or("the Entry encoding is truncated")?;
        let out = &self.bytes[self.at..end];
        self.at = end;
        Ok(out)
    }

    fn byte(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn array(&mut self) -> Result<[u8; 32], String> {
        Ok(self.take(32)?.try_into().expect("32 bytes"))
    }

    /// A compact U64 whose `width`-bit tag is `tag`.
    fn compact(&mut self, tag: u8, width: u32) -> Result<u64, String> {
        let max = (1u64 << width) - 1;
        let size = match max - u64::from(tag) {
            3 => 1,
            2 => 2,
            1 => 4,
            0 => 8,
            _ => return Ok(u64::from(tag)),
        };
        Ok(self
            .take(size)?
            .iter()
            .fold(0u64, |n, b| (n << 8) | u64::from(*b)))
    }
}

fn limit(value: u64, max: usize, what: &str) -> Result<usize, String> {
    usize::try_from(value)
        .ok()
        .filter(|v| *v <= max)
        .ok_or_else(|| format!("{what} exceeds the Willow'25 limit of {max}"))
}

/// Decodes canonical `encode_entry` bytes. Anything else (truncation,
/// trailing bytes, non-minimal tags, paths over the Willow'25 limits) is
/// refused.
pub fn decode_entry(bytes: &[u8]) -> Result<Entry, String> {
    let mut reader = Reader { bytes, at: 0 };
    let namespace = reader.array()?;
    let subspace = reader.array()?;
    let header = reader.byte()?;
    let total = limit(
        reader.compact(header >> 4, 4)?,
        MAX_PATH_LENGTH,
        "the path length",
    )?;
    let count = limit(
        reader.compact(header & 0x0f, 4)?,
        MAX_COMPONENT_COUNT,
        "the path's component count",
    )?;
    if count == 0 && total != 0 {
        return Err("an empty path claims bytes".into());
    }
    let mut path = Vec::with_capacity(count);
    let mut remaining = total;
    for i in 0..count {
        let length = if i + 1 == count {
            remaining
        } else {
            let tag = reader.byte()?;
            limit(
                reader.compact(tag, 8)?,
                MAX_COMPONENT_LENGTH,
                "a path component",
            )?
        };
        if length > remaining || length > MAX_COMPONENT_LENGTH {
            return Err("a path component exceeds the path's length".into());
        }
        remaining -= length;
        path.push(reader.take(length)?.to_vec());
    }
    let tag = reader.byte()?;
    let timestamp = reader.compact(tag, 8)?;
    let tag = reader.byte()?;
    let payload_length = reader.compact(tag, 8)?;
    let payload_digest = reader.array()?;
    if reader.at != bytes.len() {
        return Err("there are bytes after the Entry".into());
    }
    let entry = Entry {
        namespace,
        subspace,
        path,
        timestamp,
        payload_length,
        payload_digest,
    };
    if encode_entry(&entry) != bytes {
        return Err("the Entry is not canonically encoded".into());
    }
    Ok(entry)
}

/// Meadowcap with Willow'25: a namespace whose id ends in an even byte is
/// communal; odd is owned.
pub fn is_communal(namespace: &[u8; 32]) -> bool {
    namespace[31].is_multiple_of(2)
}

// -- time -------------------------------------------------------------------

/// J2000 (2000-01-01 12:00:00 TT = 11:59:27.816 TAI) as a TAI clock reading
/// in microseconds since 1970-01-01 00:00 on that clock. The same constant as
/// atomic-plugins `integrations/willow-drop/mapping.ts`.
const J2000_TAI_US: i128 = 946_727_967_816_000;
/// TAI − UTC from each UTC instant on (IERS Bulletin C), newest first.
const LEAP_SECONDS: [(i128, i128); 6] = [
    (1_483_228_800_000_000, 37), // 2017-01-01
    (1_435_708_800_000_000, 36), // 2015-07-01
    (1_341_100_800_000_000, 35), // 2012-07-01
    (1_230_768_000_000_000, 34), // 2009-01-01
    (1_136_073_600_000_000, 33), // 2006-01-01
    (0, 32),                     // from 1999-01-01, which covers J2000
];

/// A Unix time in microseconds as the Willow data model's recommended
/// timestamp: microseconds of TAI since J2000. Not willow25 0.7.9's reading,
/// which goes through hifitime's `J2000_REF_EPOCH` (2000-01-02 12:00 TAI) and
/// comes out 86,432.184 s earlier for the same instant (reported upstream as
/// worm-blossom/willow_rs#62). `None` before J2000.
pub fn willow_time(unix_us: i128) -> Option<u64> {
    let (_, offset) = LEAP_SECONDS
        .iter()
        .find(|(start, _)| unix_us >= *start)
        .copied()
        .unwrap_or((0, 32));
    u64::try_from(unix_us + offset * 1_000_000 - J2000_TAI_US).ok()
}

/// This node's clock, as [`willow_time`].
pub fn willow_now() -> u64 {
    let unix_us = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i128)
        .unwrap_or(0);
    willow_time(unix_us).unwrap_or(0)
}

// -- the host call ------------------------------------------------------------

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(value: &str, what: &str) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(2) || !value.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("{what} must be hexadecimal bytes"));
    }
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

/// The namespace and path prefix a key's binding resolves to under the
/// Installation's config.
fn resolve_binding(
    manifest: &Manifest,
    key: &str,
    config: &Json,
) -> Result<([u8; 32], Vec<Vec<u8>>), String> {
    let binding = manifest
        .http
        .as_ref()
        .and_then(|h| h.keys.iter().find(|k| k.name == key))
        .and_then(|k| k.willow.as_ref())
        .ok_or_else(|| format!("this plugin declares no Willow subspace key named `{key}`"))?;
    let namespace = match config_key(&binding.namespace) {
        Some(field) => config[field]
            .as_str()
            .ok_or_else(|| format!("the config has no `{field}` (the Willow namespace)"))?
            .to_string(),
        None => binding.namespace.clone(),
    };
    let namespace: [u8; 32] = unhex(&namespace, "the Willow namespace")?
        .try_into()
        .map_err(|_| "the Willow namespace must be 32 bytes".to_string())?;
    let prefix = match config_key(&binding.path_prefix) {
        Some(field) => config[field]
            .as_array()
            .ok_or_else(|| {
                format!("the config's `{field}` (the Willow path prefix) must be a list of hex components")
            })?
            .iter()
            .map(|c| {
                c.as_str()
                    .ok_or_else(|| "a Willow path prefix component must be hex text".to_string())
                    .and_then(|c| unhex(c, "a Willow path prefix component"))
            })
            .collect::<Result<Vec<_>, _>>()?,
        None if binding.path_prefix.is_empty() => Vec::new(),
        None => binding
            .path_prefix
            .split('/')
            .map(|c| unhex(c, "a Willow path prefix component"))
            .collect::<Result<Vec<_>, _>>()?,
    };
    Ok((namespace, prefix))
}

/// What the host keeps per authorised entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub key: String,
    /// `encode_entry`, hex.
    pub entry: String,
    /// Ed25519 over `entry`, hex.
    pub signature: String,
    pub source: String,
    pub commit: String,
    pub authorised_at: i64,
}

fn installation_prefix(installation: &str) -> Vec<u8> {
    format!("{RECORD_PREFIX}{}\0", Subject::from(installation).pure_id()).into_bytes()
}

fn record_key(installation: &str, entry: &Entry) -> Vec<u8> {
    let mut key = installation_prefix(installation);
    key.extend(entry.namespace);
    key.extend(entry.subspace);
    key.extend(encode_path(&entry.path));
    key
}

fn read_record(db: &Db, key: &[u8]) -> Result<Option<Record>, String> {
    db.kv
        .get(Tree::PluginMeta, key)
        .map_err(|e| e.to_string())?
        .map(|bytes| {
            serde_json::from_slice(&bytes)
                .map_err(|e| format!("a Willow record is unreadable: {e}"))
        })
        .transpose()
}

/// Willow's order: `a` is newer than `b` (timestamp, then digest, then
/// payload length).
fn newer(a: &Entry, b: &Entry) -> bool {
    (a.timestamp, a.payload_digest, a.payload_length)
        > (b.timestamp, b.payload_digest, b.payload_length)
}

/// Erases the installation's records (on revocation and destruction, with
/// its keys). Returns how many.
pub fn erase(db: &Db, installation: &str) -> usize {
    let keys: Vec<Vec<u8>> = db
        .kv
        .scan_prefix(Tree::PluginMeta, &installation_prefix(installation))
        .flatten()
        .map(|(k, _)| k.to_vec())
        .collect();
    for key in &keys {
        let _ = db.kv.remove(Tree::PluginMeta, key);
    }
    keys.len()
}

/// `ctx.willow.authorise({ key, entry, source: { subject, commit } })`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthoriseRequest {
    pub key: String,
    /// `encode_entry`, hex.
    pub entry: String,
    pub source: Source,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub subject: String,
    pub commit: String,
}

/// A source resource's current revision.
struct Revision {
    commit: String,
    committed_at: i64,
    timestamp: u64,
}

/// What a route's Willow host calls need.
pub struct WillowHost<'a> {
    pub db: &'a Db,
    pub installation: &'a str,
    pub manifest: &'a Manifest,
    pub config: &'a Json,
    /// Whom the route reads as: the source must be readable by it.
    pub reader: &'a ForAgent,
    pub now_ms: i64,
    pub willow_now: u64,
}

impl WillowHost<'_> {
    /// `ctx.willow.subspace({ key })`: the key's subspace id and its bound
    /// namespace and prefix, all hex.
    pub fn subspace(&self, key: &str) -> Result<Json, String> {
        let (namespace, prefix) = resolve_binding(self.manifest, key, self.config)?;
        let subspace = route_keys::willow_public(self.db, self.installation, self.manifest, key)?;
        Ok(json!({
            "key": key,
            "subspace": hex(&subspace),
            "namespace": hex(&namespace),
            "communal": is_communal(&namespace),
            "pathPrefix": prefix.iter().map(|c| hex(c)).collect::<Vec<_>>(),
        }))
    }

    /// Checks the request as the module documentation says, then signs,
    /// records and answers `{ entry, signature, capability, status }`, and a
    /// line for the run log.
    pub async fn authorise(&self, request: &AuthoriseRequest) -> Result<(Json, String), String> {
        let (namespace, prefix) = resolve_binding(self.manifest, &request.key, self.config)?;
        let bytes = unhex(&request.entry, "entry")?;
        let entry = decode_entry(&bytes)?;
        if entry.namespace != namespace {
            return Err("the Entry is not in the namespace this key is bound to".into());
        }
        if !is_communal(&namespace) {
            return Err(
                "the bound namespace is owned (its id ends in an odd byte); this host only issues communal capabilities"
                    .into(),
            );
        }
        let subspace =
            route_keys::willow_public(self.db, self.installation, self.manifest, &request.key)?;
        if entry.subspace != subspace {
            return Err(format!(
                "the Entry's subspace is not key `{}`'s public key",
                request.key
            ));
        }
        if !entry.path.starts_with(&prefix) {
            return Err("the Entry's path is outside the bound path prefix".into());
        }
        if entry.timestamp > self.willow_now.saturating_add(MAX_FUTURE_US) {
            return Err(
                "the Entry's timestamp is more than 10 minutes ahead of this server's clock (microseconds of TAI since J2000)"
                    .into(),
            );
        }
        let revision = self.revision(&request.source.subject).await?;
        if revision.commit != request.source.commit {
            return Err(format!(
                "the source changed since it was read (its last commit is now `{}`); read it again",
                revision.commit
            ));
        }
        if entry.timestamp != revision.timestamp {
            return Err(format!(
                "the Entry's timestamp must be its source's last commit time, {} (microseconds of TAI since J2000)",
                revision.timestamp
            ));
        }

        let key = record_key(self.installation, &entry);
        if let Some(existing) = read_record(self.db, &key)? {
            let previous = decode_entry(&unhex(&existing.entry, "a stored entry")?)?;
            if previous == entry {
                return Ok((
                    answer(&existing, &namespace, &subspace, "unchanged"),
                    String::new(),
                ));
            }
            if newer(&previous, &entry) {
                return Err(
                    "this installation already authorised a newer Entry at this path; a stale source cannot replace it"
                        .into(),
                );
            }
        }
        let (_, signature) = route_keys::sign_willow(
            self.db,
            self.installation,
            self.manifest,
            &request.key,
            &bytes,
        )?;
        let record = Record {
            key: request.key.clone(),
            entry: hex(&bytes),
            signature: hex(&signature),
            source: request.source.subject.clone(),
            commit: request.source.commit.clone(),
            authorised_at: self.now_ms,
        };
        self.db
            .kv
            .insert(
                Tree::PluginMeta,
                &key,
                &serde_json::to_vec(&record).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        tracing::info!(
            installation = self.installation,
            key = request.key,
            source = request.source.subject,
            "plugin route key authorised a Willow entry"
        );
        let line = format!(
            "authorised a Willow entry with key `{}` for {} at {}",
            request.key, request.source.subject, request.source.commit
        );
        Ok((answer(&record, &namespace, &subspace, "authorised"), line))
    }

    /// The source's current revision, as the route's principal may see it:
    /// its `lastCommit`, and that commit's time from the retained envelope.
    async fn revision(&self, subject: &str) -> Result<Revision, String> {
        let parsed = Subject::from_raw(subject, self.db.get_base_domain().as_deref());
        if !parsed.is_local() {
            return Err("the source must be a resource on this server".into());
        }
        let resource = match self
            .db
            .get_resource_extended(&parsed, true, self.reader)
            .await
        {
            Ok(response) => response.to_single(),
            Err(_) => {
                return Err(
                    "the source cannot be read by this route's principal, so it is not signed"
                        .into(),
                )
            }
        };
        let commit = resource
            .get(urls::LAST_COMMIT)
            .map(|v| v.to_string())
            .unwrap_or_default();
        let signature = commit.rsplit(':').next().unwrap_or_default();
        if commit.is_empty() || signature.is_empty() {
            return Err("the source has no last commit".into());
        }
        // Envelopes are keyed by the subject as the commit named it: the
        // subject the plugin asked for, or the stored resource's own form.
        let envelope = [subject.to_string(), resource.get_subject().to_string()]
            .iter()
            .flat_map(|s| atomic_lib::envelopes::envelopes(self.db, s).into_iter().rev())
            .find(|e| e.signature == signature)
            .ok_or("this server kept no signed envelope of the source's last commit, so its time is unknown")?;
        let timestamp = willow_time(i128::from(envelope.created_at) * 1000)
            .ok_or("the source's last commit is older than J2000")?;
        Ok(Revision {
            commit,
            committed_at: envelope.created_at,
            timestamp,
        })
    }

    /// `ctx.willow.source({ key, subject })`: the source's `commit`, its
    /// `committedAt` (Unix milliseconds) and `timestamp` (the Willow reading,
    /// decimal text). The entry to authorise must carry that timestamp.
    pub async fn source(&self, key: &str, subject: &str) -> Result<Json, String> {
        resolve_binding(self.manifest, key, self.config)?;
        let revision = self.revision(subject).await?;
        Ok(json!({
            "subject": subject,
            "commit": revision.commit,
            "committedAt": revision.committed_at,
            "timestamp": revision.timestamp.to_string(),
        }))
    }

    /// `ctx.willow.list({ key })`: the entries this installation authorised
    /// with that key, oldest path first, at most [`MAX_LISTED`].
    pub fn list(&self, key: &str) -> Result<Json, String> {
        let mut out = Vec::new();
        for item in self
            .db
            .kv
            .scan_prefix(Tree::PluginMeta, &installation_prefix(self.installation))
        {
            let (_, value) = item.map_err(|e| e.to_string())?;
            let record: Record = serde_json::from_slice(&value)
                .map_err(|e| format!("a Willow record is unreadable: {e}"))?;
            if record.key == key {
                out.push(json!({
                    "entry": record.entry,
                    "signature": record.signature,
                    "source": record.source,
                    "commit": record.commit,
                    "authorisedAt": record.authorised_at,
                }));
                if out.len() >= MAX_LISTED {
                    break;
                }
            }
        }
        Ok(json!(out))
    }
}

fn answer(record: &Record, namespace: &[u8; 32], subspace: &[u8; 32], status: &str) -> Json {
    json!({
        "entry": record.entry,
        "signature": record.signature,
        "capability": {
            "kind": "communal",
            "namespace": hex(namespace),
            "receiver": hex(subspace),
            "delegations": [],
        },
        "status": status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::manifest::Manifest;

    const INSTALLATION: &str = "did:ad:installationW";
    /// A communal namespace (last byte even) and an owned one.
    const COMMUNAL: &str = "934e6021339e1f013ba94900edc25d8d74c0b4e573768910ae0f507d8c817318";
    const OWNED: &str = "934e6021339e1f013ba94900edc25d8d74c0b4e573768910ae0f507d8c817319";

    fn manifest() -> Manifest {
        Manifest::parse(json!({
            "schemaVersion": 3,
            "http": {
                "mount": "drive-prefix",
                "routes": [{ "id": "drop", "path": "/drop", "methods": ["GET"] }],
                "keys": [
                    { "name": "willow", "alg": "ed25519",
                      "willow": { "namespace": "config:namespace", "pathPrefix": "config:pathPrefix" } },
                    { "name": "fixed", "alg": "ed25519",
                      "willow": { "namespace": COMMUNAL, "pathPrefix": "61746f6d6963" } },
                    { "name": "http", "alg": "ed25519" }
                ]
            }
        }))
        .unwrap()
        .unwrap()
    }

    /// Upstream Willow'25 `encode_entry` vectors
    /// (`testdata/willow/encode_entry.json`, worm-blossom/willow_test_vectors
    /// at the commit recorded there): every accepted one decodes and
    /// re-encodes byte for byte, every refused one is refused.
    #[test]
    fn upstream_encode_entry_vectors() {
        let fixture: Json =
            serde_json::from_str(include_str!("../../../testdata/willow/encode_entry.json"))
                .unwrap();
        let vectors = fixture["vectors"].as_array().unwrap();
        assert!(vectors.len() > 100);
        for vector in vectors {
            let bytes = unhex(vector["hex"].as_str().unwrap(), "vector").unwrap();
            let id = vector["id"].as_str().unwrap();
            match vector["kind"].as_str().unwrap() {
                "yay" => {
                    let entry = decode_entry(&bytes).unwrap_or_else(|e| panic!("{id}: {e}"));
                    assert_eq!(encode_entry(&entry), bytes, "{id}");
                }
                _ => assert!(decode_entry(&bytes).is_err(), "{id} must be refused"),
            }
        }
    }

    #[test]
    fn decoding_refuses_non_canonical_truncated_and_trailing_bytes() {
        let entry = Entry {
            namespace: [2; 32],
            subspace: [3; 32],
            path: vec![b"atomic".to_vec(), vec![], vec![0xff; 300]],
            timestamp: 70_000,
            payload_length: 5,
            payload_digest: [9; 32],
        };
        let bytes = encode_entry(&entry);
        assert_eq!(decode_entry(&bytes).unwrap(), entry);
        assert!(decode_entry(&bytes[..bytes.len() - 1]).is_err());
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(decode_entry(&trailing).is_err());
        // Timestamp 70,000 as an 8-byte compact integer instead of 4: the
        // same Entry, but not the signing encoding.
        let mut loose = Vec::new();
        loose.extend(entry.namespace);
        loose.extend(entry.subspace);
        loose.extend(encode_path(&entry.path));
        loose.push(0xff);
        loose.extend(70_000u64.to_be_bytes());
        loose.extend(compact(5));
        loose.extend(entry.payload_digest);
        assert!(decode_entry(&loose)
            .unwrap_err()
            .contains("not canonically encoded"));
        // Over the Willow'25 path length.
        let long = Entry {
            path: vec![vec![1; 4096], vec![1]],
            ..entry
        };
        assert!(decode_entry(&encode_entry(&long)).is_err());
    }

    #[test]
    fn compact_integers_use_minimal_tags() {
        assert_eq!(compact(0), vec![0]);
        assert_eq!(compact(251), vec![251]);
        assert_eq!(compact(252), vec![252, 252]);
        assert_eq!(compact(256), vec![253, 1, 0]);
        assert_eq!(compact(65_536), vec![254, 0, 1, 0, 0]);
        assert_eq!(compact(u64::MAX), [vec![255], vec![255; 8]].concat());
        // Four-bit tags inline 0..=11.
        assert_eq!(encode_path(&[]), vec![0]);
        assert_eq!(encode_path(&[b"ab".to_vec()]), vec![0x21, b'a', b'b']);
    }

    /// The data model's reading, and its fixed distance from willow25
    /// 0.7.9's hifitime reading of the same instant. The first entry of
    /// atomic-plugins `integrations/willow-drop/fixtures/communal.drop`,
    /// written by willow25, has timestamp 843480069184000, which willow25
    /// reports as Unix milliseconds 1790294432184 (`expected.json`); the data
    /// model reads it as 1790208000000 (2026-09-24T00:00:00Z).
    #[test]
    fn timestamps_follow_the_data_model_not_hifitime() {
        // J2000 itself: 2000-01-01T11:58:55.816Z.
        assert_eq!(willow_time(946_727_935_816_000), Some(0));
        assert_eq!(willow_time(946_727_935_815_999), None);
        assert_eq!(
            willow_time(1_790_208_000_000_000),
            Some(843_480_069_184_000)
        );
        let hifitime = willow_time(1_790_294_432_184_000).unwrap();
        assert_eq!(hifitime - 843_480_069_184_000, 86_432_184_000);
        // A leap second: 2016-12-31T23:59:59Z and 2017-01-01T00:00:00Z are
        // two seconds apart on TAI.
        assert_eq!(
            willow_time(1_483_228_800_000_000).unwrap()
                - willow_time(1_483_228_799_000_000).unwrap(),
            2_000_000
        );
        assert!(willow_now() > 843_480_069_184_000);
    }

    fn config() -> Json {
        json!({ "namespace": COMMUNAL, "pathPrefix": ["61746f6d6963"] })
    }

    fn entry_for(subspace: [u8; 32], path: Vec<Vec<u8>>, timestamp: u64) -> Entry {
        Entry {
            namespace: unhex(COMMUNAL, "").unwrap().try_into().unwrap(),
            subspace,
            path,
            timestamp,
            payload_length: 3,
            payload_digest: [7; 32],
        }
    }

    /// Two invented commits: 2026-09-24T00:00:00Z and one minute later.
    const T1_MS: i64 = 1_790_208_000_000;
    const T2_MS: i64 = 1_790_208_060_000;

    /// Puts the resource at the commit with this signature, and keeps that
    /// commit's envelope the way `envelopes::record_ops` keys it.
    async fn at_commit(db: &Db, subject: &str, signature: &str, created_at: i64) -> String {
        use atomic_lib::{Resource, Value};
        let commit = atomic_lib::identifiers::commit_subject(signature);
        let mut resource = Resource::new(subject.to_string());
        resource
            .set_unsafe(urls::NAME.into(), Value::String("note".into()))
            .unwrap();
        resource
            .set_unsafe(
                urls::LAST_COMMIT.into(),
                Value::AtomicUrl(commit.clone().into()),
            )
            .unwrap();
        db.add_resource(&resource).await.unwrap();
        let mut key = Subject::from_raw(subject, None).pure_id().into_bytes();
        key.push(0);
        key.extend_from_slice(&(created_at as u64).to_be_bytes());
        key.push(0);
        key.extend_from_slice(signature.as_bytes());
        db.kv.insert(Tree::Envelopes, &key, b"{}").unwrap();
        commit
    }

    #[tokio::test]
    async fn authorises_only_bound_current_communal_entries_and_records_them() {
        let db = Db::init_temp("willow_authorise").await.unwrap();
        let base = db.get_server_url().to_string();
        let subject = format!("{base}/notes/hello");
        let commit1 = at_commit(&db, &subject, "sigone", T1_MS).await;
        let t1 = willow_time(i128::from(T1_MS) * 1000).unwrap();
        let t2 = willow_time(i128::from(T2_MS) * 1000).unwrap();
        let m = manifest();
        let config = config();
        let host = WillowHost {
            db: &db,
            installation: INSTALLATION,
            manifest: &m,
            config: &config,
            reader: &ForAgent::Sudo,
            now_ms: 1,
            willow_now: willow_now(),
        };
        let info = host.subspace("willow").unwrap();
        let subspace: [u8; 32] = unhex(info["subspace"].as_str().unwrap(), "")
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(info["pathPrefix"], json!(["61746f6d6963"]));
        let source = host.source("willow", &subject).await.unwrap();
        assert_eq!(source["commit"], commit1);
        assert_eq!(source["committedAt"], T1_MS);
        assert_eq!(source["timestamp"], t1.to_string());

        let path = vec![b"atomic".to_vec(), subject.as_bytes().to_vec()];
        let request = |entry: &Entry, commit: &str| AuthoriseRequest {
            key: "willow".into(),
            entry: hex(&encode_entry(entry)),
            source: Source {
                subject: subject.clone(),
                commit: commit.into(),
            },
        };
        let entry = entry_for(subspace, path.clone(), t1);
        let (signed, line) = host.authorise(&request(&entry, &commit1)).await.unwrap();
        assert_eq!(signed["status"], "authorised");
        assert!(line.contains("willow") && line.contains(&subject));
        assert_eq!(signed["capability"]["receiver"], hex(&subspace));
        // An independent check: ed25519-dalek's strict verification (what
        // willow25 uses) accepts the signature over the exact Entry bytes.
        let signature: [u8; 64] = unhex(signed["signature"].as_str().unwrap(), "")
            .unwrap()
            .try_into()
            .unwrap();
        ed25519_dalek::VerifyingKey::from_bytes(&subspace)
            .unwrap()
            .verify_strict(
                &encode_entry(&entry),
                &ed25519_dalek::Signature::from_bytes(&signature),
            )
            .expect("the signature verifies strictly");

        // The same bytes again: the recorded signature, nothing new.
        let (again, line) = host.authorise(&request(&entry, &commit1)).await.unwrap();
        assert_eq!(again["status"], "unchanged");
        assert_eq!(again["signature"], signed["signature"]);
        assert!(line.is_empty());

        // Refusals, each naming its reason, with nothing signed.
        let moved = "atomic:commit:elsewhere".to_string();
        for (entry, commit, expected) in [
            (
                entry_for(subspace, path.clone(), t1 + 1),
                &commit1,
                "last commit time",
            ),
            (
                entry_for(subspace, path.clone(), t1),
                &moved,
                "source changed",
            ),
            (entry_for([1; 32], path.clone(), t1), &commit1, "subspace"),
            (
                entry_for(subspace, vec![b"other".to_vec()], t1),
                &commit1,
                "prefix",
            ),
            (
                entry_for(subspace, path.clone(), willow_now() + 3_600_000_000),
                &commit1,
                "ahead",
            ),
            (
                Entry {
                    namespace: [4; 32],
                    ..entry_for(subspace, path.clone(), t1)
                },
                &commit1,
                "namespace",
            ),
        ] {
            let error = host.authorise(&request(&entry, commit)).await.unwrap_err();
            assert!(error.contains(expected), "{expected}: {error}");
        }
        assert_eq!(host.list("willow").unwrap().as_array().unwrap().len(), 1);

        // An edit: a newer commit, a newer entry, which replaces the record.
        let commit2 = at_commit(&db, &subject, "sigtwo", T2_MS).await;
        let (newer, _) = host
            .authorise(&request(&entry_for(subspace, path.clone(), t2), &commit2))
            .await
            .unwrap();
        assert_eq!(newer["status"], "authorised");
        let listed = host.list("willow").unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["commit"], commit2);
        // The resource back at the older commit (a stale replica): the older
        // entry is refused, since a newer one was authorised at that path.
        at_commit(&db, &subject, "sigone", T1_MS).await;
        assert!(host
            .authorise(&request(&entry_for(subspace, path.clone(), t1), &commit1))
            .await
            .unwrap_err()
            .contains("newer Entry"));

        // Keys without a binding never sign entries, and a Willow key never
        // signs HTTP requests.
        assert!(host.subspace("http").is_err());
        let fixed = host.subspace("fixed").unwrap();
        assert_ne!(fixed["subspace"], info["subspace"]);
        let http_sign = route_keys::SignRequest {
            key: "willow".into(),
            key_id: "https://a.example/k".into(),
            operation: "x".into(),
            request: route_keys::OutboundRequest {
                method: "GET".into(),
                url: "https://a.example/".into(),
                body: None,
            },
            format: None,
            tag: None,
        };
        assert!(route_keys::sign(
            &db,
            INSTALLATION,
            &m,
            &http_sign,
            std::time::SystemTime::now()
        )
        .unwrap_err()
        .contains("only signs Willow entries"));

        // Owned namespaces are refused: this host issues no owned capability.
        let owned = json!({ "namespace": OWNED, "pathPrefix": ["61746f6d6963"] });
        let owned_host = WillowHost {
            config: &owned,
            ..host
        };
        let owned_entry = Entry {
            namespace: unhex(OWNED, "").unwrap().try_into().unwrap(),
            ..entry_for(subspace, path.clone(), t1)
        };
        assert!(owned_host
            .authorise(&request(&owned_entry, &commit1))
            .await
            .unwrap_err()
            .contains("owned"));

        // Unreadable for the principal (no rights for the public): not
        // signed, and its revision is not disclosed.
        let public_host = WillowHost {
            reader: &ForAgent::Public,
            ..host
        };
        assert!(public_host.source("willow", &subject).await.is_err());
        assert!(public_host
            .authorise(&request(&entry_for(subspace, path.clone(), t1), &commit1))
            .await
            .unwrap_err()
            .contains("cannot be read"));

        assert_eq!(erase(&db, INSTALLATION), 1);
        assert!(host.list("willow").unwrap().as_array().unwrap().is_empty());
    }
}
