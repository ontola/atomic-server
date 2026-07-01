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
use std::time::{Duration, Instant};

/// Admission + quota decisions for incoming drive sync. A [`crate::Db`] consults
/// its installed policy before admitting a write to a drive (SYNC_PUSH, commit,
/// blob, or realtime update).
pub trait SyncPolicy: Send + Sync {
    /// Whether this process may import data for `drive_subject` at all.
    fn drive_is_allowed(&self, drive_subject: &str) -> bool;

    /// Whether `drive_subject` is under its storage quota. Only meaningful when
    /// the drive is allowed.
    fn drive_within_quota(&self, drive_subject: &str) -> bool;

    /// Whether a write to `drive_subject` should be admitted right now. The
    /// default is a pure allowlist+quota check; a policy may additionally grant a
    /// bootstrap grace so a freshly-created drive can sync while its enrollment
    /// is still propagating (see [`AllowlistPolicy`]).
    ///
    /// Callers must only pass **drive** subjects — never agent (`did:ad:agent:…`)
    /// or other non-drive subjects, which are outside the enrollment model.
    fn admit_drive_write(&self, drive_subject: &str) -> bool {
        self.drive_is_allowed(drive_subject) && self.drive_within_quota(drive_subject)
    }
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

/// Default bootstrap grace: how long a not-yet-allowlisted drive may keep syncing
/// after its first write on this node, so onboarding / first-backup can complete
/// while the enrollment propagates to the allowlist.
const DEFAULT_GRACE: Duration = Duration::from_secs(600);

struct AllowlistState {
    allowed: HashMap<String, DrivePolicy>,
    usage: HashMap<String, u64>,
    /// First time a *non-allowlisted* drive attempted a write on this node.
    first_seen: HashMap<String, Instant>,
    grace: Duration,
}

impl Default for AllowlistState {
    fn default() -> Self {
        Self {
            allowed: HashMap::new(),
            usage: HashMap::new(),
            first_seen: HashMap::new(),
            grace: DEFAULT_GRACE,
        }
    }
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

    /// The drive subjects currently allowed (i.e. the drives this node hosts).
    /// Used to scope the control-plane usage report to hosted drives.
    pub fn allowed_drive_subjects(&self) -> Vec<String> {
        self.inner
            .read()
            .map(|guard| guard.allowed.keys().cloned().collect())
            .unwrap_or_default()
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

    /// Set the bootstrap grace window (how long a not-yet-allowlisted drive may
    /// keep syncing after its first write here). `Duration::ZERO` disables grace.
    pub fn set_grace(&self, grace: Duration) {
        if let Ok(mut guard) = self.inner.write() {
            guard.grace = grace;
        }
    }

    /// Admission decision at a given instant (testable core of
    /// [`SyncPolicy::admit_drive_write`]). Allowlisted drives are admitted iff
    /// within quota; a non-allowlisted drive is admitted only while inside its
    /// bootstrap grace, measured from its first write here.
    fn admit_at(&self, drive_subject: &str, now: Instant) -> bool {
        if self.drive_is_allowed(drive_subject) {
            return self.drive_within_quota(drive_subject);
        }

        let Ok(mut guard) = self.inner.write() else {
            return false;
        };
        let grace = guard.grace;
        let first = *guard
            .first_seen
            .entry(drive_subject.to_string())
            .or_insert(now);

        now.saturating_duration_since(first) < grace
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

    fn admit_drive_write(&self, drive_subject: &str) -> bool {
        self.admit_at(drive_subject, Instant::now())
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

    #[test]
    fn open_policy_admits_every_write() {
        assert!(OpenPolicy.admit_drive_write("did:ad:anything"));
    }

    #[test]
    fn admits_allowlisted_drive_and_rejects_over_quota() {
        let p = AllowlistPolicy::new();
        p.set_drive_policies([("did:ad:a".to_string(), Some(100u64))]);
        assert!(p.admit_drive_write("did:ad:a"));

        p.record_drive_usage([("did:ad:a".to_string(), 100u64)]);
        assert!(!p.admit_drive_write("did:ad:a")); // over quota
    }

    #[test]
    fn grace_admits_new_drive_then_rejects_after_window() {
        let p = AllowlistPolicy::new();
        p.set_grace(Duration::from_secs(600));

        let t0 = Instant::now();
        // First write to an un-enrolled drive: admitted (records first-seen).
        assert!(p.admit_at("did:ad:new", t0));
        // Still within grace 5 min later.
        assert!(p.admit_at("did:ad:new", t0 + Duration::from_secs(300)));
        // Past the grace window: rejected.
        assert!(!p.admit_at("did:ad:new", t0 + Duration::from_secs(601)));
    }

    #[test]
    fn zero_grace_rejects_unenrolled_immediately() {
        let p = AllowlistPolicy::new();
        p.set_grace(Duration::ZERO);
        assert!(!p.admit_at("did:ad:new", Instant::now()));
    }

    #[test]
    fn enrolling_during_grace_makes_admission_permanent() {
        let p = AllowlistPolicy::new();
        p.set_grace(Duration::from_secs(600));
        let t0 = Instant::now();

        assert!(p.admit_at("did:ad:d", t0)); // grace
        p.set_drive_policies([("did:ad:d".to_string(), None)]); // enrollment lands
        // Long after grace would have expired, still admitted because allowlisted.
        assert!(p.admit_at("did:ad:d", t0 + Duration::from_secs(10_000)));
    }
}
