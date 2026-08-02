//! Remote push wake helpers for Phase 5 (APNs / FCM / web-push).
//!
//! Hub fan-out must stay **wake-only**: payload carries `about` + `type`, never
//! a trusted summary/body. Clients sync, run `NotificationEngine`, and suppress
//! if the item is already read. See `planning/notifications.md` Phase 5 and
//! `social-apps.md` P2.3.
//!
//! Transport-free: `CommitMonitor` builds wake candidates, looks up
//! `DevicePushToken`s, and logs them. Provider send lands when APNs/FCM
//! credentials are configured.

use atomic_lib::storelike::Query;
use atomic_lib::{urls, Resource, Storelike, Value};
use serde_json::{json, Value as JsonValue};

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
    pub fn to_data_payload(&self) -> JsonValue {
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

/// Registered device token row for an agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevicePushTokenRow {
    pub subject: String,
    pub token: String,
    pub platform: String,
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

/// Look up `DevicePushToken` resources whose `devicePushAgent` matches.
pub async fn lookup_device_push_tokens(
    store: &impl Storelike,
    agent: &str,
) -> Vec<DevicePushTokenRow> {
    let mut q = Query::new_prop_val(urls::DEVICE_PUSH_AGENT, agent);
    q.limit = Some(20);
    q.include_nested = true;

    let Ok(result) = store.query(&q).await else {
        return vec![];
    };

    let mut rows = Vec::new();

    for resource in result.resources {
        let token = match resource.get(urls::PUSH_TOKEN) {
            Ok(Value::String(s)) if !s.is_empty() => s.clone(),
            _ => continue,
        };
        let platform = match resource.get(urls::PUSH_PLATFORM) {
            Ok(Value::String(s)) => s.clone(),
            _ => "unknown".to_string(),
        };

        rows.push(DevicePushTokenRow {
            subject: resource.get_subject().to_string(),
            token,
            platform,
        });
    }

    rows
}

/// Look up tokens for each wake and log candidates. Replace the log with
/// APNs/FCM send when credentials are configured.
pub async fn enqueue_push_wakes(store: &impl Storelike, wakes: &[PendingPushWake]) {
    if wakes.is_empty() {
        return;
    }

    for wake in wakes {
        let tokens = lookup_device_push_tokens(store, &wake.agent).await;
        tracing::debug!(
            agent = %wake.agent,
            about = %wake.hint.about,
            notification_type = %wake.hint.notification_type,
            payload = %wake.hint.to_data_payload(),
            token_count = tokens.len(),
            platforms = ?tokens.iter().map(|t| t.platform.as_str()).collect::<Vec<_>>(),
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
