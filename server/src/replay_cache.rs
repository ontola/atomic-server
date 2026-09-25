//! Each version 2 request signature is accepted once (#1700, answer 7).
//!
//! A v2 proof is bound to its method, full URL and body, but on its own it
//! stays valid for its whole freshness window: from
//! [`AUTH_MAX_AGE_MS`] after its timestamp back to a few seconds before it.
//! Whoever captured a request (a log, a proxy, a browser extension) could
//! send it again, byte for byte, within that window, and a `POST
//! /plugin-secret` or `/plugin-run` would happen twice.
//!
//! This cache remembers, per node and in memory, the digest of every v2
//! signature it accepted until that signature could no longer be fresh, and
//! refuses a second use. It lives in memory on purpose: a restart forgets it,
//! which re-opens at most one window for proofs captured before the restart,
//! and a node never has to write for a read-only check.
//!
//! Keyed on the SHA-256 of the decoded signature bytes. v2 verification is
//! strict Ed25519, so the same message cannot be signed into a second valid
//! encoding, and re-encoding the same bytes in the other base64 alphabet gives
//! the same key.
//!
//! Bounded: when it holds [`ReplayCache::DEFAULT_CAPACITY`] live entries it
//! forgets the one closest to its expiry to make room. Refusing instead would
//! let anyone with a stream of throwaway keys fill it and lock every client
//! out of every v2 route. Forgetting reopens at most the rest of that one
//! proof's window, and only under a flood; version 1 signatures, still
//! accepted on the same routes, are replayable for their whole window anyway.

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

use atomic_lib::authentication::AUTH_MAX_AGE_MS;

type Digest = [u8; 32];

/// Why [`ReplayCache::record`] refused a signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// This signature was accepted before, and it is still within its window.
    Replayed,
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refusal::Replayed => write!(
                f,
                "This request signature was already used. A version 2 request signature is accepted once; sign the request again."
            ),
        }
    }
}

#[derive(Default)]
struct Entries {
    /// Digest to the last millisecond its signature can still be fresh.
    expiry_of: HashMap<Digest, i64>,
    /// The same entries in expiry order, so aging out is cheap.
    by_expiry: BTreeSet<(i64, Digest)>,
}

impl Entries {
    fn forget_expired(&mut self, now: i64) {
        while let Some(&(expiry, digest)) = self.by_expiry.first() {
            if expiry >= now {
                break;
            }
            self.by_expiry.pop_first();
            self.expiry_of.remove(&digest);
        }
    }
}

pub struct ReplayCache {
    entries: Mutex<Entries>,
    capacity: usize,
}

impl Default for ReplayCache {
    fn default() -> Self {
        Self::new(Self::DEFAULT_CAPACITY)
    }
}

impl ReplayCache {
    /// About 10 MB at most.
    pub const DEFAULT_CAPACITY: usize = 100_000;

    pub fn new(capacity: usize) -> Self {
        ReplayCache {
            entries: Mutex::new(Entries::default()),
            capacity,
        }
    }

    /// Accepts `signature` (the decoded signature bytes), signed at
    /// `timestamp`, if it was not accepted before, and remembers it until it
    /// can no longer be fresh. `now` is Unix ms.
    ///
    /// Call it only for a signature that verified and is fresh: a forged one
    /// must not take a slot.
    pub fn record(&self, signature: &[u8], timestamp: i64, now: i64) -> Result<(), Refusal> {
        let mut digest: Digest = [0; 32];
        hex::decode_to_slice(
            atomic_lib::authentication::sha256_hex(signature),
            &mut digest,
        )
        .expect("a SHA-256 hex digest is 32 bytes");
        // Fresh while `now <= timestamp + AUTH_MAX_AGE_MS`; see
        // `atomic_lib::utils::check_timestamp_fresh`.
        let expiry = timestamp.saturating_add(AUTH_MAX_AGE_MS);

        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        entries.forget_expired(now);
        if entries.expiry_of.contains_key(&digest) {
            return Err(Refusal::Replayed);
        }
        while entries.expiry_of.len() >= self.capacity {
            let Some((_, oldest)) = entries.by_expiry.pop_first() else {
                break;
            };
            entries.expiry_of.remove(&oldest);
        }
        entries.expiry_of.insert(digest, expiry);
        entries.by_expiry.insert((expiry, digest));
        Ok(())
    }

    /// How many signatures are remembered, including any that aged out since
    /// the last [`ReplayCache::record`].
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.lock().unwrap().expiry_of.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 1_800_000_000_000;

    #[test]
    fn a_signature_is_accepted_once() {
        let cache = ReplayCache::default();
        assert_eq!(cache.record(b"sig-a", T, T), Ok(()));
        assert_eq!(cache.record(b"sig-a", T, T + 1), Err(Refusal::Replayed));
        // Another signature is not affected.
        assert_eq!(cache.record(b"sig-b", T, T + 1), Ok(()));
    }

    #[test]
    fn a_replay_is_refused_for_the_whole_window_and_forgotten_after_it() {
        let cache = ReplayCache::default();
        assert_eq!(cache.record(b"sig", T, T), Ok(()));
        // Up to and including the last millisecond the proof is fresh.
        assert_eq!(
            cache.record(b"sig", T, T + AUTH_MAX_AGE_MS),
            Err(Refusal::Replayed)
        );
        // After that the signature check refuses it as too old anyway, so the
        // cache lets go of it.
        assert_eq!(cache.record(b"other", T, T + AUTH_MAX_AGE_MS + 1), Ok(()));
        assert_eq!(cache.len(), 1, "the expired entry is forgotten");
        assert_eq!(cache.record(b"sig", T, T + AUTH_MAX_AGE_MS + 1), Ok(()));
    }

    #[test]
    fn a_proof_signed_ahead_of_this_clock_is_kept_until_its_own_window_ends() {
        let cache = ReplayCache::default();
        let ahead = T + 9_000;
        assert_eq!(cache.record(b"sig", ahead, T), Ok(()));
        assert_eq!(
            cache.record(b"sig", ahead, T + AUTH_MAX_AGE_MS + 1),
            Err(Refusal::Replayed)
        );
    }

    #[test]
    fn a_full_cache_forgets_the_proof_closest_to_expiry_instead_of_refusing() {
        let cache = ReplayCache::new(2);
        assert_eq!(cache.record(b"one", T, T), Ok(()));
        assert_eq!(cache.record(b"two", T + 1_000, T), Ok(()));
        // Full: a new proof still gets in, so a flood cannot lock clients out.
        assert_eq!(cache.record(b"three", T + 2_000, T), Ok(()));
        assert_eq!(cache.len(), 2);
        // The later ones are still remembered, so still refused.
        assert_eq!(cache.record(b"two", T + 1_000, T), Err(Refusal::Replayed));
        assert_eq!(cache.record(b"three", T + 2_000, T), Err(Refusal::Replayed));
    }
}
