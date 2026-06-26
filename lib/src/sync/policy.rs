//! Sync admission and quota policy.
//!
//! The default ([`OpenPolicy`]) is permissive, so local-first and self-hosted
//! peers keep their current behavior with no configuration at all. A managed
//! node installs a concrete policy on its [`crate::Db`] (see
//! `Db::set_sync_policy`); the engine consults it before importing a
//! `SYNC_PUSH`.
//!
//! The open core ships only the *mechanism* here (the trait + a generic
//! allowlist/quota impl). The control-plane client that *populates* a managed
//! policy at runtime lives outside the open core — see
//! `atomic-saas/planning/FOSS_SELF_HOST_GUARDRAILS.md`.

use std::collections::HashMap;
use std::sync::RwLock;

/// Admission + quota decisions for incoming drive sync. A [`crate::Db`] consults
/// its installed policy before importing a `SYNC_PUSH`.
pub trait SyncPolicy: Send + Sync {
    /// Whether this process may import data for `drive_subject` at all.
    fn drive_is_allowed(&self, drive_subject: &str) -> bool;

    /// Whether `drive_subject` is under its storage quota. Only meaningful when
    /// the drive is allowed.
    fn drive_within_quota(&self, drive_subject: &str) -> bool;
}

/// The default policy: every drive is allowed and there are no quotas. This is
/// what self-hosted and local-first nodes use, and is the [`crate::Db`] default
/// when nothing is installed.
#[derive(Debug, Default, Clone, Copy)]
pub struct OpenPolicy;

impl SyncPolicy for OpenPolicy {
    fn drive_is_allowed(&self, _drive_subject: &str) -> bool {
        true
    }

    fn drive_within_quota(&self, _drive_subject: &str) -> bool {
        true
    }
}

/// Per-drive quota configuration.
#[derive(Clone, Default)]
pub struct DrivePolicy {
    pub quota_bytes: Option<u64>,
}

/// A generic allowlist-plus-quota policy: only enrolled drives may sync, each
/// with an optional byte quota checked against the last reported usage.
///
/// This is a generic mechanism the open core ships; a control-plane client
/// (managed SaaS, or a self-hoster's own multi-tenant tooling) populates it at
/// runtime via [`set_drive_policies`](Self::set_drive_policies) and
/// [`record_drive_usage`](Self::record_drive_usage). It is interior-mutable so
/// it can be shared as `Arc<dyn SyncPolicy>` while being refreshed.
#[derive(Default)]
pub struct AllowlistPolicy {
    inner: RwLock<AllowlistState>,
}

#[derive(Default)]
struct AllowlistState {
    allowed: HashMap<String, DrivePolicy>,
    usage: HashMap<String, u64>,
}

impl AllowlistPolicy {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the allowlist (drive subject -> optional byte quota). Drives
    /// absent from the list are rejected by [`Self::drive_is_allowed`].
    pub fn set_drive_policies<I, S>(&self, drives: I)
    where
        I: IntoIterator<Item = (S, Option<u64>)>,
        S: Into<String>,
    {
        let map = drives
            .into_iter()
            .map(|(subject, quota_bytes)| (subject.into(), DrivePolicy { quota_bytes }))
            .collect();
        if let Ok(mut guard) = self.inner.write() {
            guard.allowed = map;
        }
    }

    /// Record the latest per-drive usage (bytes) for quota checks.
    pub fn record_drive_usage<I, S>(&self, usage: I)
    where
        I: IntoIterator<Item = (S, u64)>,
        S: Into<String>,
    {
        if let Ok(mut guard) = self.inner.write() {
            for (subject, bytes) in usage {
                guard.usage.insert(subject.into(), bytes);
            }
        }
    }
}

impl SyncPolicy for AllowlistPolicy {
    fn drive_is_allowed(&self, drive_subject: &str) -> bool {
        self.inner
            .read()
            .map(|guard| guard.allowed.contains_key(drive_subject))
            .unwrap_or(false)
    }

    fn drive_within_quota(&self, drive_subject: &str) -> bool {
        let Ok(guard) = self.inner.read() else {
            return false;
        };
        let Some(policy) = guard.allowed.get(drive_subject) else {
            return false; // not enrolled — rejected by the allowlist anyway
        };
        match policy.quota_bytes {
            Some(quota) => guard.usage.get(drive_subject).copied().unwrap_or(0) < quota,
            None => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_policy_allows_everything() {
        let p = OpenPolicy;
        assert!(p.drive_is_allowed("did:ad:anything"));
        assert!(p.drive_within_quota("did:ad:anything"));
    }

    #[test]
    fn allowlist_rejects_unenrolled_and_enforces_quota() {
        let p = AllowlistPolicy::new();
        // Empty allowlist: nothing is allowed.
        assert!(!p.drive_is_allowed("did:ad:a"));
        assert!(!p.drive_within_quota("did:ad:a"));

        // Enroll `a` with a 100-byte quota, `b` with no quota.
        p.set_drive_policies([
            ("did:ad:a".to_string(), Some(100u64)),
            ("did:ad:b".to_string(), None),
        ]);
        assert!(p.drive_is_allowed("did:ad:a"));
        assert!(p.drive_is_allowed("did:ad:b"));
        assert!(!p.drive_is_allowed("did:ad:c"));

        // Under quota.
        assert!(p.drive_within_quota("did:ad:a"));
        p.record_drive_usage([("did:ad:a".to_string(), 100u64)]);
        // At/over quota.
        assert!(!p.drive_within_quota("did:ad:a"));
        // No quota -> always within.
        assert!(p.drive_within_quota("did:ad:b"));
    }
}
