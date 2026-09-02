//! The pack format — Phase 1 of
//! `atomic-saas/planning/CLOUD_VAULT_ARCHITECTURE.md`.
//!
//! A pack is a batch of Loro *updates*, never snapshots. That distinction is
//! the whole economic argument for the vault: `export_updates_since` output
//! grows with the size of the edit, whereas a snapshot grows with the size of
//! the document. Backing up a one-word change to a large resource must cost one
//! word, not the resource.
//!
//! Packs are also why resource *counts* stay hidden: many resources ride in one
//! sealed object, so the operator sees one object of some size rather than a
//! per-resource object stream they could count and correlate.

use crate::errors::AtomicResult;
use serde::{Deserialize, Serialize};

/// Pack layout version, independent of the envelope's. The envelope governs how
/// bytes are encrypted; this governs what those bytes mean once open.
pub const PACK_FORMAT: u8 = 1;

/// One resource's worth of CRDT history in a pack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackEntry {
    /// The resource's `pure_id()` — the same key `Tree::LoroSnapshots` uses, so
    /// a restore does not have to reconstruct subjects from query params.
    pub subject: String,
    /// `AtomicLoroDoc::export_updates_since` output. Opaque here on purpose:
    /// the pack layer never interprets CRDT bytes.
    pub update: Vec<u8>,
}

/// A batch of updates plus the deletions that happened alongside them.
///
/// Tombstones travel *with* the updates rather than in a separate object
/// because a restore that applied updates without them would resurrect deleted
/// resources — a delete is not an absence of data, it is data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pack {
    pub format: u8,
    pub entries: Vec<PackEntry>,
    /// Subjects deleted in this segment, as `pure_id()` strings.
    pub tombstones: Vec<String>,
}

impl Pack {
    pub fn new(entries: Vec<PackEntry>, tombstones: Vec<String>) -> Self {
        Self {
            format: PACK_FORMAT,
            entries,
            tombstones,
        }
    }

    /// Nothing changed since the last segment — worth checking before sealing,
    /// so an idle device does not upload an object per backup tick.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty() && self.tombstones.is_empty()
    }

    /// MessagePack rather than JSON: these are byte payloads, and base64ing
    /// every CRDT update into JSON would inflate the one thing the format
    /// exists to keep small.
    pub fn encode(&self) -> AtomicResult<Vec<u8>> {
        rmp_serde::to_vec_named(self)
            .map_err(|e| format!("failed to encode vault pack: {e}").into())
    }

    pub fn decode(bytes: &[u8]) -> AtomicResult<Self> {
        let pack: Pack = rmp_serde::from_slice(bytes)
            .map_err(|e| format!("failed to decode vault pack: {e}"))?;
        if pack.format != PACK_FORMAT {
            return Err(format!(
                "unsupported vault pack format {}, this build understands {PACK_FORMAT}",
                pack.format
            )
            .into());
        }
        Ok(pack)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Pack {
        Pack::new(
            vec![
                PackEntry {
                    subject: "did:ad:drive/resource-a".to_string(),
                    update: vec![1, 2, 3, 4],
                },
                PackEntry {
                    subject: "did:ad:drive/resource-b".to_string(),
                    update: vec![5, 6],
                },
            ],
            vec!["did:ad:drive/deleted".to_string()],
        )
    }

    #[test]
    fn round_trips() {
        let pack = sample();
        let decoded = Pack::decode(&pack.encode().unwrap()).unwrap();
        assert_eq!(decoded, pack);
    }

    #[test]
    fn preserves_update_bytes_exactly() {
        // CRDT bytes must survive verbatim; a lossy encoding would corrupt
        // history in a way that only shows up at restore time.
        let update: Vec<u8> = (0u8..=255).collect();
        let pack = Pack::new(
            vec![PackEntry {
                subject: "s".into(),
                update: update.clone(),
            }],
            vec![],
        );
        let decoded = Pack::decode(&pack.encode().unwrap()).unwrap();
        assert_eq!(decoded.entries[0].update, update);
    }

    #[test]
    fn an_unknown_format_is_refused() {
        let mut pack = sample();
        pack.format = 99;
        let encoded = pack.encode().unwrap();
        let err = Pack::decode(&encoded).unwrap_err().to_string();
        assert!(err.contains("format"), "{err}");
    }

    #[test]
    fn garbage_errors_rather_than_panics() {
        assert!(Pack::decode(b"not a pack").is_err());
        assert!(Pack::decode(&[]).is_err());
    }

    #[test]
    fn empty_is_detected() {
        assert!(Pack::new(vec![], vec![]).is_empty());
        assert!(!sample().is_empty());
        // A pack carrying only deletions still has to be uploaded.
        assert!(!Pack::new(vec![], vec!["gone".into()]).is_empty());
    }
}
