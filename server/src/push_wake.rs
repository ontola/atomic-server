//! Remote push wake helpers for Phase 5 (APNs / FCM / web-push).
//!
//! Hub fan-out must stay **wake-only**: payload carries `about` + `type`, never
//! a trusted summary/body. Clients sync, run `NotificationEngine`, and suppress
//! if the item is already read. See `planning/notifications.md` Phase 5 and
//! `social-apps.md` P2.3.
//!
//! This module is intentionally transport-free — no Firebase/APNs SDK yet.
//! `CommitMonitor` calls [`mention_wakes_for_resource`] and logs candidates;
//! provider send lands when DevicePushToken lookup + credentials are wired.

use atomic_lib::{urls, Resource, Storelike};
use serde_json::{json, Value};

/// Wake hint the push provider delivers to a device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushWakeHint {
    pub about: String,
    /// `mention` | `watch-membership` | `watch-content` | …
    pub notification_type: String,
}

impl PushWakeHint {
    pub fn new(about: impl Into<String>, notification_type: impl Into<String>) -> Self {
        Self {
            about: about.into(),
            notification_type: notification_type.into(),
        }
    }

    /// Serialize to the on-the-wire data payload (no alert body).
    pub fn to_data_payload(&self) -> Value {
        json!({
            "about": self.about,
            "type": self.notification_type,
        })
    }
}

/// One wake to schedule for a recipient agent (token lookup happens later).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPushWake {
    pub agent: String,
    pub hint: PushWakeHint,
}

/// Agents that should be woken for a mention commit: everyone in `mentions`
/// except the commit actor (self-mentions are not product alerts).
pub fn agents_to_wake_for_mentions(
    mentions: &[String],
    actor: Option<&str>,
) -> Vec<String> {
    mentions
        .iter()
        .filter(|agent| actor.map(|a| a != agent.as_str()).unwrap_or(true))
        .cloned()
        .collect()
}

/// True when a push wake should still surface after sync: the personal-drive
/// NotificationItem is missing or not yet marked read/dismissed. Callers pass
/// the flags they loaded after sync.
pub fn should_surface_after_sync(read: bool, dismissed: bool) -> bool {
    !read && !dismissed
}

/// Build wake-only mention hints from a committed resource (no provider send).
///
/// Reads `mentions` + commit actor (`signer` / `lastCommit` path is left to
/// the caller — pass `actor` from the commit when available).
pub fn mention_wakes_for_resource(
    resource: &Resource,
    actor: Option<&str>,
) -> Vec<PendingPushWake> {
    let Ok(mentions_val) = resource.get(urls::MENTIONS) else {
        return vec![];
    };
    let Ok(mentions) = mentions_val.to_subjects(None) else {
        return vec![];
    };
    if mentions.is_empty() {
        return vec![];
    }

    let about = resource.get_subject().to_string();
    let hint = PushWakeHint::new(about, "mention");

    agents_to_wake_for_mentions(&mentions, actor)
        .into_iter()
        .map(|agent| PendingPushWake {
            agent,
            hint: hint.clone(),
        })
        .collect()
}

/// Log wake candidates. Replace with DevicePushToken lookup + APNs/FCM send.
pub fn enqueue_push_wakes_stub(store: &impl Storelike, wakes: &[PendingPushWake]) {
    if wakes.is_empty() {
        return;
    }

    // Token registry query + provider send are Phase 5 remaining work.
    // Keep a visible trace so ops can confirm the match path without a
    // Firebase/APNs dependency in CI.
    let _ = store;
    for wake in wakes {
        tracing::debug!(
            agent = %wake.agent,
            about = %wake.hint.about,
            notification_type = %wake.hint.notification_type,
            payload = %wake.hint.to_data_payload(),
            "push_wake: mention candidate (provider send not wired)"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use atomic_lib::{values::Value, Resource};

    #[test]
    fn wake_payload_has_no_body() {
        let hint = PushWakeHint::new("did:ad:doc1", "mention");
        let payload = hint.to_data_payload();
        let obj = payload.as_object().unwrap();
        assert_eq!(obj.get("about").and_then(|v| v.as_str()), Some("did:ad:doc1"));
        assert_eq!(obj.get("type").and_then(|v| v.as_str()), Some("mention"));
        assert!(!obj.contains_key("body"));
        assert!(!obj.contains_key("summary"));
        assert!(!obj.contains_key("title"));
    }

    #[test]
    fn mention_wake_skips_actor() {
        let mentions = vec![
            "did:ad:agent:alice".into(),
            "did:ad:agent:bob".into(),
        ];
        let woken = agents_to_wake_for_mentions(&mentions, Some("did:ad:agent:alice"));
        assert_eq!(woken, vec!["did:ad:agent:bob".to_string()]);
    }

    #[test]
    fn suppress_if_already_read() {
        assert!(!should_surface_after_sync(true, false));
        assert!(!should_surface_after_sync(false, true));
        assert!(should_surface_after_sync(false, false));
    }

    #[test]
    fn mention_wakes_from_resource() {
        let mut resource = Resource::new("did:ad:doc1".into());
        resource
            .set_unsafe(
                urls::MENTIONS.into(),
                Value::ResourceArray(vec![
                    "did:ad:agent:alice".into(),
                    "did:ad:agent:bob".into(),
                ]),
            )
            .unwrap();

        let wakes = mention_wakes_for_resource(&resource, Some("did:ad:agent:alice"));
        assert_eq!(wakes.len(), 1);
        assert_eq!(wakes[0].agent, "did:ad:agent:bob");
        assert_eq!(wakes[0].hint.about, "did:ad:doc1");
        assert_eq!(wakes[0].hint.notification_type, "mention");
    }
}
