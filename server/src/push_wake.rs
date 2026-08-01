//! Remote push wake helpers for Phase 5 (APNs / FCM / web-push).
//!
//! Hub fan-out must stay **wake-only**: payload carries `about` + `type`, never
//! a trusted summary/body. Clients sync, run `NotificationEngine`, and suppress
//! if the item is already read. See `planning/notifications.md` Phase 5 and
//! `social-apps.md` P2.3.
//!
//! This module is intentionally transport-free — no Firebase/APNs SDK yet.
//! `CommitMonitor` will call these matchers once device-token lookup and a
//! sender are wired.

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
