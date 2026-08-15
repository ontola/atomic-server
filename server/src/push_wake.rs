//! Remote push helpers for Phase 5 (APNs / FCM).
//!
//! Data bag stays **wake-only** (`about` + `type`, never a trusted summary).
//! The OS banner uses generic title/body so a killed iOS/Android app still
//! shows a lock-screen notification. Clients sync, run `NotificationEngine`,
//! and suppress/cancel if the item is already read.
//!
//! `CommitMonitor` builds mention + watch wake candidates, looks up
//! `DevicePushToken`s, and delivers via [`PushSender`] (default:
//! [`LoggingPushSender`]). Swap in an FCM/APNs sender when credentials exist.

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
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

    /// Serialize to the on-the-wire **data** bag (no trusted document body).
    /// Visible APNs/FCM banners use [`visible_title`] / [`visible_body`] instead.
    pub fn to_data_payload(&self) -> JsonValue {
        json!({
            "about": self.about,
            "type": self.notification_type,
        })
    }

    /// Generic lock-screen title. Never includes resource content.
    pub fn visible_title(&self) -> &'static str {
        "Atomic"
    }

    /// Generic lock-screen body keyed only by `notification_type`.
    /// iOS drops silent (`content-available`) pushes when the app is killed;
    /// a visible alert is required for true app notifications.
    pub fn visible_body(&self) -> &'static str {
        visible_body_for_type(&self.notification_type)
    }
}

/// Generic OS-banner copy. Keep in sync with `@tomic/lib` `visiblePushCopy`.
pub fn visible_body_for_type(notification_type: &str) -> &'static str {
    match notification_type {
        "mention" => "Someone mentioned you",
        "message" => "You have a new message",
        "access-request" => "Someone requested access",
        "watch-membership" => "A list you follow changed",
        "watch-content" => "Something you follow was updated",
        _ => "You have a new notification",
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

/// Sends a wake-only payload to one device token.
#[async_trait]
pub trait PushSender: Send + Sync {
    async fn send_wake(
        &self,
        token: &DevicePushTokenRow,
        hint: &PushWakeHint,
    ) -> Result<(), String>;
}

/// Default sender: logs at info. Replace with FCM/APNs when secrets are wired.
pub struct LoggingPushSender;

#[async_trait]
impl PushSender for LoggingPushSender {
    async fn send_wake(
        &self,
        token: &DevicePushTokenRow,
        hint: &PushWakeHint,
    ) -> Result<(), String> {
        tracing::info!(
            token_subject = %token.subject,
            platform = %token.platform,
            // Never log the raw push token — only a short prefix for ops.
            token_prefix = %token.token.chars().take(8).collect::<String>(),
            about = %hint.about,
            notification_type = %hint.notification_type,
            payload = %hint.to_data_payload(),
            "push_wake: would send (LoggingPushSender — no provider)"
        );
        Ok(())
    }
}

static PUSH_SENDER: OnceLock<Arc<dyn PushSender>> = OnceLock::new();

/// Install the process-wide push sender (call once at server boot). Defaults to
/// [`LoggingPushSender`] if never set.
pub fn set_push_sender(sender: Arc<dyn PushSender>) {
    let _ = PUSH_SENDER.set(sender);
}

fn push_sender() -> Arc<dyn PushSender> {
    PUSH_SENDER
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(LoggingPushSender) as Arc<dyn PushSender>)
}

/// Agents that should be woken for a mention commit: everyone in `mentions`
/// except the commit actor (self-mentions are not product alerts).
pub fn agents_to_wake_for_mentions(mentions: &[String], actor: Option<&str>) -> Vec<String> {
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

/// Owner agent of a WatchSubscription (`createdBy`, else first `write` agent).
pub fn watch_owner_agent(watch: &Resource) -> Option<String> {
    if let Ok(v) = watch.get(urls::CREATED_BY) {
        if let Ok(subs) = v.to_subjects(None) {
            if let Some(s) = subs.into_iter().next() {
                return Some(s);
            }
        }
    }

    if let Ok(v) = watch.get(urls::WRITE) {
        if let Ok(subs) = v.to_subjects(None) {
            for s in subs {
                if s.starts_with("did:ad:agent:") {
                    return Some(s);
                }
            }
        }
    }

    None
}

fn watch_is_active(watch: &Resource, now_ms: i64) -> bool {
    if let Ok(Value::Boolean(false)) = watch.get(urls::NOTIFICATION_ENABLED) {
        return false;
    }

    if let Ok(Value::Timestamp(muted)) = watch.get(urls::MUTED_UNTIL) {
        if *muted > now_ms {
            return false;
        }
    }
    // Integer mutedUntil (JS stores Date.now() number)
    if let Ok(Value::Integer(muted)) = watch.get(urls::MUTED_UNTIL) {
        if *muted > now_ms {
            return false;
        }
    }

    true
}

fn watch_kind(watch: &Resource) -> &'static str {
    match watch.get(urls::WATCH_KIND) {
        Ok(Value::String(s)) => match s.as_str() {
            "content" => "content",
            "both" => "both",
            _ => "membership",
        },
        _ => "membership",
    }
}

/// Collect watch wakes for a committed resource: subscriptions whose
/// `watchTarget` is the resource itself (content) or its parent (membership).
pub async fn watch_wakes_for_resource(
    store: &impl Storelike,
    resource: &Resource,
    actor: Option<&str>,
) -> Vec<PendingPushWake> {
    let about = resource.get_subject().to_string();
    let parent = resource
        .get(urls::PARENT)
        .ok()
        .and_then(|v| v.to_subjects(None).ok())
        .and_then(|mut s| s.pop());

    let mut targets = vec![about.clone()];
    if let Some(p) = parent {
        if p != about {
            targets.push(p);
        }
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let mut wakes = Vec::new();

    for target in targets {
        let mut q = Query::new_prop_val(urls::WATCH_TARGET, &target);
        q.limit = Some(50);
        q.include_nested = true;

        let Ok(result) = store.query(&q).await else {
            continue;
        };

        for watch in result.resources {
            // Ensure it's a WatchSubscription when isA is present.
            if let Ok(is_a) = watch.get(urls::IS_A) {
                if let Ok(classes) = is_a.to_subjects(None) {
                    if !classes.is_empty() && !classes.iter().any(|c| c == urls::WATCH_SUBSCRIPTION)
                    {
                        continue;
                    }
                }
            }

            if !watch_is_active(&watch, now_ms) {
                continue;
            }

            let Some(owner) = watch_owner_agent(&watch) else {
                continue;
            };

            if actor.map(|a| a == owner.as_str()).unwrap_or(false) {
                continue;
            }

            let watch_target = watch
                .get(urls::WATCH_TARGET)
                .ok()
                .and_then(|v| v.to_subjects(None).ok())
                .and_then(|mut s| s.pop())
                .unwrap_or_else(|| target.clone());

            let is_target_self = about == watch_target;
            let kind = watch_kind(&watch);

            if kind == "membership" && is_target_self {
                continue;
            }

            let notification_type = if is_target_self || kind == "content" {
                "watch-content"
            } else {
                "watch-membership"
            };

            wakes.push(PendingPushWake {
                agent: owner,
                hint: PushWakeHint::new(about.clone(), notification_type),
            });
        }
    }

    wakes
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

/// Look up tokens for each wake and deliver via [`push_sender`].
pub async fn enqueue_push_wakes(store: &impl Storelike, wakes: &[PendingPushWake]) {
    if wakes.is_empty() {
        return;
    }

    let sender = push_sender();

    for wake in wakes {
        let tokens = lookup_device_push_tokens(store, &wake.agent).await;

        if tokens.is_empty() {
            tracing::debug!(
                agent = %wake.agent,
                about = %wake.hint.about,
                notification_type = %wake.hint.notification_type,
                "push_wake: no DevicePushToken for agent"
            );
            continue;
        }

        for token in &tokens {
            if let Err(e) = sender.send_wake(token, &wake.hint).await {
                tracing::warn!(
                    agent = %wake.agent,
                    platform = %token.platform,
                    error = %e,
                    "push_wake: send failed"
                );
            }
        }
    }
}

/// Collect mention + watch wakes for a newly committed resource.
pub async fn wakes_for_committed_resource(
    store: &impl Storelike,
    resource: &Resource,
    actor: Option<&str>,
) -> Vec<PendingPushWake> {
    let mut wakes = mention_wakes_for_resource(resource, actor);
    wakes.extend(watch_wakes_for_resource(store, resource, actor).await);
    wakes
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
        assert_eq!(
            obj.get("about").and_then(|v| v.as_str()),
            Some("did:ad:doc1")
        );
        assert_eq!(obj.get("type").and_then(|v| v.as_str()), Some("mention"));
        assert!(!obj.contains_key("body"));
        assert!(!obj.contains_key("summary"));
        assert!(!obj.contains_key("title"));
    }

    #[test]
    fn visible_copy_is_generic_per_type() {
        let mention = PushWakeHint::new("did:ad:secret-doc", "mention");
        assert_eq!(mention.visible_title(), "Atomic");
        assert_eq!(mention.visible_body(), "Someone mentioned you");
        assert!(!mention.visible_body().contains("secret-doc"));

        assert_eq!(
            PushWakeHint::new("did:ad:x", "message").visible_body(),
            "You have a new message"
        );
        assert_eq!(
            PushWakeHint::new("did:ad:x", "access-request").visible_body(),
            "Someone requested access"
        );
        assert_eq!(
            PushWakeHint::new("did:ad:x", "watch-membership").visible_body(),
            "A list you follow changed"
        );
        assert_eq!(
            PushWakeHint::new("did:ad:x", "watch-content").visible_body(),
            "Something you follow was updated"
        );
    }

    #[test]
    fn mention_wake_skips_actor() {
        let mentions = vec!["did:ad:agent:alice".into(), "did:ad:agent:bob".into()];
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
                Value::ResourceArray(vec!["did:ad:agent:alice".into(), "did:ad:agent:bob".into()]),
            )
            .unwrap();

        let wakes = mention_wakes_for_resource(&resource, Some("did:ad:agent:alice"));
        assert_eq!(wakes.len(), 1);
        assert_eq!(wakes[0].agent, "did:ad:agent:bob");
        assert_eq!(wakes[0].hint.about, "did:ad:doc1");
        assert_eq!(wakes[0].hint.notification_type, "mention");
    }

    #[test]
    fn watch_owner_prefers_created_by() {
        let mut watch = Resource::new("did:ad:watch1".into());
        watch
            .set_unsafe(
                urls::CREATED_BY.into(),
                Value::AtomicUrl("did:ad:agent:bob".into()),
            )
            .unwrap();
        assert_eq!(
            watch_owner_agent(&watch).as_deref(),
            Some("did:ad:agent:bob")
        );
    }

    #[test]
    fn watch_inactive_when_disabled() {
        let mut watch = Resource::new("did:ad:watch1".into());
        watch
            .set_unsafe(urls::NOTIFICATION_ENABLED.into(), Value::Boolean(false))
            .unwrap();
        assert!(!watch_is_active(&watch, 1_000));
    }

    #[test]
    fn watch_inactive_when_muted() {
        let mut watch = Resource::new("did:ad:watch1".into());
        watch
            .set_unsafe(urls::MUTED_UNTIL.into(), Value::Integer(5_000))
            .unwrap();
        assert!(!watch_is_active(&watch, 1_000));
        assert!(watch_is_active(&watch, 6_000));
    }
}
