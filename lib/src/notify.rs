//! The server notifier: who is told what, delivered into their Inbox.
//!
//! The person's own apps record chat, comment and reply Notifications
//! (`host::notifications`), but only while one of them is open and only for
//! what that app happens to see. This module is the server side of
//! `planning/notifications.md`: the node that holds the data decides who is
//! told, writes the Notification into the recipient's Inbox (which syncs to
//! every device like any other resource), and hands each delivery to the
//! channels that reach someone whose apps are closed: push and e-mail. Those
//! channels are the caller's (`atomic-server`'s `notifier`), so this module
//! sends nothing over the network.
//!
//! What a person hears about is data in their own private drive, next to the
//! Inbox:
//!
//! - **`Follow`** (a child of the Inbox): `about` a resource, folder or drive,
//!   with a `followLevel` (`everything`, `newItems` or `muted`) and optionally
//!   `followClasses` / `followProperties` to narrow it ("only meetings", "only
//!   when the date changes"). A follow covers everything below `about`; the
//!   nearest one wins, so a muted folder inside a followed drive is quiet.
//! - **Preferences on the Inbox**: `notifyEmail` (the address, for servers that
//!   do not know it from an account), `emailFrequency` (`instant`, `daily` or
//!   `off`), `mutedNotificationKinds`, `notifyLanguage`.
//! - **`PushRegistration`** (a child of the Inbox): one per device, with the
//!   `pushEndpoint` URL its push distributor gave it.
//!
//! An **`Announcement`** is the explicit kind: someone who may write next to a
//! resource tells chosen `recipients` about it ("the new version of this
//! document is up", "action needed"), whether or not they follow anything.
//!
//! Rules that hold for every kind:
//!
//! - Nobody hears about their own changes.
//! - A recipient is only told about what they can read now
//!   ([`hierarchy::check_read`]), so a title never leaks.
//! - The owner of an Inbox is the one agent that may read and write the
//!   drive it is in; Inboxes in a shared drive are ignored, so nobody can
//!   sign someone else up, and nobody else reads their Notifications.
//! - Edits are batched: changes to one resource for one recipient wait until
//!   it has been quiet for [`Notifier::quiet_ms`] (at most
//!   [`Notifier::max_wait_ms`] after the first) and become one Notification
//!   ("3 changes"). An unread Notification about the same thing and kind is
//!   updated instead of joined by a second one.
//!
//! The notifier reads each followed drive's event stream
//! (`db::drive_events`) with its own checkpoint, so a restart neither repeats
//! nor loses an event; its queue lives in `Tree::PluginMeta` too.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::{
    Db, Resource, Storelike, Subject, Value,
    agents::ForAgent,
    db::{drive_events::DriveEvent, trees::Tree},
    errors::AtomicResult,
    hierarchy,
    host::notifications::{
        ACTOR, INBOX, NOTIFICATION, NOTIFICATION_KIND, NOTIFICATION_SOURCE, OCCURRED_AT, READ_AT,
    },
    storelike::Query,
    urls,
};

pub const INBOX_CLASS: &str = "https://atomicdata.dev/classes/Inbox";
pub const FOLLOW: &str = "https://atomicdata.dev/classes/Follow";
pub const FOLLOW_LEVEL: &str = "https://atomicdata.dev/properties/followLevel";
pub const FOLLOW_CLASSES: &str = "https://atomicdata.dev/properties/followClasses";
pub const FOLLOW_PROPERTIES: &str = "https://atomicdata.dev/properties/followProperties";
pub const ANNOUNCEMENT: &str = "https://atomicdata.dev/classes/Announcement";
pub const RECIPIENTS: &str = "https://atomicdata.dev/properties/recipients";
pub const ACTION_REQUIRED: &str = "https://atomicdata.dev/properties/actionRequired";
pub const NOTIFICATION_COUNT: &str = "https://atomicdata.dev/properties/notificationCount";
pub const CHANGED_PROPERTIES: &str = "https://atomicdata.dev/properties/changedProperties";
pub const NOTIFY_EMAIL: &str = "https://atomicdata.dev/properties/notifyEmail";
pub const EMAIL_FREQUENCY: &str = "https://atomicdata.dev/properties/emailFrequency";
pub const MUTED_KINDS: &str = "https://atomicdata.dev/properties/mutedNotificationKinds";
pub const NOTIFY_LANGUAGE: &str = "https://atomicdata.dev/properties/notifyLanguage";
pub const PUSH_REGISTRATION: &str = "https://atomicdata.dev/classes/PushRegistration";
pub const PUSH_ENDPOINT: &str = "https://atomicdata.dev/properties/pushEndpoint";

/// The notifier's name as a consumer of drive events.
pub const CONSUMER: &str = "notifier";

/// Classes whose changes never notify: the notifier's own bookkeeping and
/// the person's settings.
const QUIET_CLASSES: [&str; 6] = [
    INBOX_CLASS,
    NOTIFICATION,
    FOLLOW,
    PUSH_REGISTRATION,
    ANNOUNCEMENT,
    urls::COMMIT,
];

const QUEUE_PREFIX: &str = "notify-queue/v1/";
const DIGEST_PREFIX: &str = "notify-digest/v1/";
const SENT_PREFIX: &str = "notify-sent/v1/";
const DIGEST_DAY_KEY: &str = "notify-digest-day/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Everything,
    NewItems,
    Muted,
}

impl Level {
    fn parse(s: &str) -> Level {
        match s {
            "newItems" | "new-items" | "new" => Level::NewItems,
            "muted" | "none" => Level::Muted,
            _ => Level::Everything,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Frequency {
    Instant,
    Daily,
    Off,
}

/// How an Inbox's owner wants to be reached.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Prefs {
    pub email: Option<String>,
    pub email_frequency: Frequency,
    pub muted_kinds: Vec<String>,
    pub push_endpoints: Vec<String>,
    /// `nl` or `en`; texts the notifier writes itself.
    pub language: String,
}

/// An Inbox the notifier may deliver to, and whose it is.
#[derive(Debug, Clone)]
pub struct Owner {
    pub agent: String,
    pub inbox: String,
    pub prefs: Prefs,
}

#[derive(Debug, Clone)]
struct FollowRow {
    agent: String,
    about: String,
    level: Level,
    classes: Vec<String>,
    properties: Vec<String>,
}

/// One event waiting to be delivered, merged with the ones after it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Queued {
    agent: String,
    about: String,
    kind: String,
    first_at: i64,
    last_at: i64,
    count: i64,
    actors: Vec<String>,
    props: BTreeSet<String>,
    /// For announcements: the Announcement.
    source: Option<String>,
    action_required: bool,
    title: Option<String>,
    body: Option<String>,
}

/// One Notification written, for the push and e-mail channels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Delivery {
    pub agent: String,
    /// The Notification in the Inbox (empty for a digest).
    pub notification: String,
    /// `created`, `changed`, `announcement` or `digest`.
    pub kind: String,
    pub title: String,
    pub body: String,
    /// What to open.
    pub about: String,
    pub action_required: bool,
    pub count: i64,
    /// Where the owner wants it pushed.
    pub push_endpoints: Vec<String>,
    /// The address to mail now; None when not wanted now (off, daily, unknown).
    pub email: Option<String>,
    pub language: String,
}

/// The rules, over one store. Holds no state between [`Notifier::tick`]s
/// other than what is in the store.
pub struct Notifier {
    pub store: Db,
    /// Changes wait until the resource has been quiet this long.
    pub quiet_ms: i64,
    /// But never longer than this after the first change.
    pub max_wait_ms: i64,
    /// The UTC hour at which daily digests go out.
    pub digest_hour_utc: u32,
}

fn text(r: &Resource, prop: &str) -> Option<String> {
    let s = r.get(prop).ok()?.to_string();
    (!s.is_empty()).then_some(s)
}

fn subjects(r: &Resource, prop: &str) -> Vec<String> {
    r.get(prop)
        .ok()
        .and_then(|v| v.to_subjects(None).ok())
        .unwrap_or_default()
}

fn pure(s: &str) -> String {
    Subject::from(s.to_string()).pure_id()
}

fn classes_of(r: &Resource) -> Vec<String> {
    subjects(r, urls::IS_A)
}

fn strings(r: &Resource, prop: &str) -> Vec<String> {
    match r.get(prop) {
        Ok(Value::Json(serde_json::Value::Array(items))) => items
            .iter()
            .filter_map(|i| i.as_str().map(str::to_string))
            .collect(),
        Ok(Value::ResourceArray(_)) => subjects(r, prop),
        Ok(v) => v
            .to_string()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// The agent that signed the last commit on `resource`, when the store keeps
/// that commit.
pub async fn last_signer(store: &Db, resource: &Resource) -> Option<String> {
    let commit = resource.get(urls::LAST_COMMIT).ok()?.to_string();
    let commit = store.get_resource(&Subject::from(commit)).await.ok()?;
    text(&commit, urls::SIGNER)
}

/// The top of `resource`'s parent chain: its drive.
async fn drive_of(store: &Db, resource: &Resource) -> Option<String> {
    if let Some(d) = resource.get_drive() {
        return Some(d.pure_id());
    }
    let parent = text(resource, urls::PARENT);
    match store.event_ancestors(parent.as_deref()).await {
        Some(mut chain) => chain
            .pop()
            .or_else(|| Some(pure(&resource.get_subject().to_string()))),
        None => None,
    }
}

async fn can_read(store: &Db, resource: &Resource, agent: &str) -> bool {
    hierarchy::check_read(
        store,
        resource,
        &ForAgent::AgentSubject(Subject::from(agent.to_string())),
    )
    .await
    .is_ok()
}

fn name_of(r: &Resource) -> String {
    text(r, urls::NAME)
        .or_else(|| text(r, urls::SHORTNAME))
        .or_else(|| text(r, urls::DESCRIPTION).map(|d| d.chars().take(60).collect()))
        .unwrap_or_else(|| r.get_subject().to_string())
}

impl Notifier {
    pub fn new(store: Db) -> Self {
        Notifier {
            store,
            quiet_ms: 10 * 60 * 1000,
            max_wait_ms: 60 * 60 * 1000,
            digest_hour_utc: 6,
        }
    }

    async fn query_class(&self, class: &str) -> Vec<Resource> {
        let mut q = Query::new_class(class);
        q.include_nested = true;
        q.for_agent = ForAgent::Sudo;
        let Ok(found) = self.store.query(&q).await else {
            return Vec::new();
        };
        let mut out = found.resources;
        if out.is_empty() {
            for s in found.subjects {
                if let Ok(r) = self.store.get_resource(&s).await {
                    out.push(r);
                }
            }
        }
        out
    }

    /// Every Inbox this store holds that has one clear owner, by Inbox.
    pub async fn owners(&self) -> HashMap<String, Owner> {
        let mut out = HashMap::new();
        for inbox in self.query_class(INBOX_CLASS).await {
            let Some(agent) = self.owner_of(&inbox).await else {
                continue;
            };
            let subject = pure(&inbox.get_subject().to_string());
            let email = text(&inbox, NOTIFY_EMAIL);
            let email_frequency = match text(&inbox, EMAIL_FREQUENCY).as_deref() {
                Some("daily") => Frequency::Daily,
                Some("off") => Frequency::Off,
                _ => Frequency::Instant,
            };
            out.insert(
                subject.clone(),
                Owner {
                    agent,
                    inbox: subject,
                    prefs: Prefs {
                        email,
                        email_frequency,
                        muted_kinds: strings(&inbox, MUTED_KINDS),
                        push_endpoints: Vec::new(),
                        language: text(&inbox, NOTIFY_LANGUAGE).unwrap_or_else(|| "en".into()),
                    },
                },
            );
        }
        for reg in self.query_class(PUSH_REGISTRATION).await {
            let Some(parent) = text(&reg, urls::PARENT) else {
                continue;
            };
            if let (Some(owner), Some(endpoint)) =
                (out.get_mut(&pure(&parent)), text(&reg, PUSH_ENDPOINT))
            {
                if !owner.prefs.push_endpoints.contains(&endpoint) {
                    owner.prefs.push_endpoints.push(endpoint);
                }
            }
        }
        out
    }

    /// The one agent that may read and write the drive `inbox` is in. A drive
    /// that others read or write is not anyone's private drive.
    async fn owner_of(&self, inbox: &Resource) -> Option<String> {
        let drive = drive_of(&self.store, inbox).await?;
        let drive = self.store.get_resource(&Subject::from(drive)).await.ok()?;
        let writers = subjects(&drive, urls::WRITE);
        let readers = subjects(&drive, urls::READ);
        match writers.as_slice() {
            // Private: nobody else reads it either, or they would read the
            // Notifications (titles of what this person can open).
            [one]
                if (Subject::from(one.clone()).is_agent_did() || one.contains("/agents/"))
                    && readers.iter().all(|r| r == one) =>
            {
                Some(one.clone())
            }
            _ => None,
        }
    }

    async fn follows(&self, owners: &HashMap<String, Owner>) -> Vec<FollowRow> {
        let mut out = Vec::new();
        for f in self.query_class(FOLLOW).await {
            let Some(owner) = text(&f, urls::PARENT).and_then(|p| owners.get(&pure(&p))) else {
                continue;
            };
            let Some(about) = text(&f, urls::ABOUT) else {
                continue;
            };
            out.push(FollowRow {
                agent: owner.agent.clone(),
                about: pure(&about),
                level: Level::parse(&text(&f, FOLLOW_LEVEL).unwrap_or_default()),
                classes: subjects(&f, FOLLOW_CLASSES),
                properties: subjects(&f, FOLLOW_PROPERTIES),
            });
        }
        out
    }

    /// One round: read new events and announcements, queue what concerns
    /// someone, and deliver what is due. Returns the deliveries, for the
    /// channels.
    pub async fn tick(&self, now: i64) -> AtomicResult<Vec<Delivery>> {
        let owners = self.owners().await;
        let by_agent: HashMap<String, Owner> = owners
            .values()
            .map(|o| (o.agent.clone(), o.clone()))
            .collect();
        let follows = self.follows(&owners).await;

        // The drives to watch: those holding something followed.
        let mut drives: BTreeSet<String> = BTreeSet::new();
        for f in &follows {
            if let Ok(r) = self
                .store
                .get_resource(&Subject::from(f.about.clone()))
                .await
            {
                if let Some(d) = drive_of(&self.store, &r).await {
                    drives.insert(d);
                }
            }
        }
        for drive in &drives {
            if !self.store.drive_events_enabled(drive) {
                self.store.enable_drive_events(drive)?;
                // Start from now: what happened before anyone followed is old.
                let last = self.store.last_event_seq(drive);
                self.store.ack_events(drive, CONSUMER, last)?;
            }
            loop {
                let from = self.store.event_checkpoint(drive, CONSUMER);
                let batch = self.store.drive_events(drive, from, 200);
                let Some(last) = batch.last().map(|e| e.seq) else {
                    break;
                };
                for event in &batch {
                    self.handle_event(event, &follows, &by_agent).await?;
                }
                self.store.ack_events(drive, CONSUMER, last)?;
                if batch.len() < 200 {
                    break;
                }
            }
        }

        self.queue_announcements(now, &by_agent).await?;
        self.deliver_due(now, &by_agent).await
    }

    async fn handle_event(
        &self,
        event: &DriveEvent,
        follows: &[FollowRow],
        owners: &HashMap<String, Owner>,
    ) -> AtomicResult<()> {
        if event.destroyed
            || event
                .classes
                .iter()
                .any(|c| QUIET_CLASSES.contains(&c.as_str()))
        {
            return Ok(());
        }
        let subject = pure(&event.subject);
        let ancestors = self
            .store
            .event_ancestors(event.parent.as_deref())
            .await
            .unwrap_or_default();
        // Nearest first: the resource itself, then its parents.
        let chain: Vec<&String> = std::iter::once(&subject).chain(ancestors.iter()).collect();
        let created = event.props.contains(urls::IS_A) || event.props.contains(urls::PARENT);

        // Per agent, the nearest follows: several at the same level can each
        // say what they are about ("meetings", "documents").
        let mut nearest: HashMap<&str, (usize, Vec<&FollowRow>)> = HashMap::new();
        for f in follows {
            if let Some(depth) = chain.iter().position(|c| **c == f.about) {
                let entry = nearest
                    .entry(f.agent.as_str())
                    .or_insert((depth, Vec::new()));
                if depth < entry.0 {
                    *entry = (depth, Vec::new());
                }
                if depth == entry.0 {
                    entry.1.push(f);
                }
            }
        }
        if nearest.is_empty() {
            return Ok(());
        }
        let Ok(resource) = self
            .store
            .get_resource(&Subject::from(subject.clone()))
            .await
        else {
            return Ok(());
        };
        let actor = last_signer(&self.store, &resource).await;
        let server_agent = self
            .store
            .get_default_agent()
            .ok()
            .map(|a| a.subject.to_string());

        for (agent, (depth, rows)) in nearest {
            if actor.as_deref() == Some(agent) || (actor.is_some() && actor == server_agent) {
                continue;
            }
            // Muted here silences the rest at this level and everything above.
            if rows.iter().any(|f| f.level == Level::Muted) {
                continue;
            }
            let matches = |f: &&FollowRow| -> Option<&'static str> {
                let kind = match (f.level, created) {
                    (Level::Muted, _) => return None,
                    (_, true) => "created",
                    (Level::NewItems, false) => return None,
                    (Level::Everything, false) => "changed",
                };
                // A follow on the thing itself is not about "new items" in it.
                if kind == "created" && depth == 0 {
                    return None;
                }
                if !f.classes.is_empty() && !event.classes.iter().any(|c| f.classes.contains(c)) {
                    return None;
                }
                if kind == "changed"
                    && !f.properties.is_empty()
                    && !event.props.iter().any(|p| f.properties.contains(p))
                {
                    return None;
                }
                Some(kind)
            };
            let Some(kind) = rows.iter().find_map(|f| matches(f)) else {
                continue;
            };
            let Some(owner) = owners.get(agent) else {
                continue;
            };
            if owner.prefs.muted_kinds.iter().any(|k| k == kind) {
                continue;
            }
            if !can_read(&self.store, &resource, agent).await {
                continue;
            }
            self.enqueue(Queued {
                agent: agent.to_string(),
                about: subject.clone(),
                kind: kind.into(),
                first_at: event.at_ms,
                last_at: event.at_ms,
                count: 1,
                actors: actor.clone().into_iter().collect(),
                props: event.props.clone(),
                source: None,
                action_required: false,
                title: None,
                body: None,
            })?;
        }
        Ok(())
    }

    fn queue_key(agent: &str, about: &str, kind: &str) -> Vec<u8> {
        format!("{QUEUE_PREFIX}{agent}\u{1f}{about}\u{1f}{kind}").into_bytes()
    }

    fn enqueue(&self, item: Queued) -> AtomicResult<()> {
        let key = Self::queue_key(&item.agent, &item.about, &item.kind);
        let merged = match self.store.kv.get(Tree::PluginMeta, &key)? {
            Some(bytes) => match serde_json::from_slice::<Queued>(&bytes) {
                Ok(mut q) => {
                    q.last_at = q.last_at.max(item.last_at);
                    q.first_at = q.first_at.min(item.first_at);
                    q.count += item.count;
                    for a in item.actors {
                        q.actors.retain(|x| x != &a);
                        q.actors.push(a);
                    }
                    q.props.extend(item.props);
                    q
                }
                Err(_) => item,
            },
            None => item,
        };
        self.store
            .kv
            .insert(Tree::PluginMeta, &key, &serde_json::to_vec(&merged)?)?;
        Ok(())
    }

    /// Announcements not yet delivered: each recipient that can read it and
    /// what it is about is told once.
    async fn queue_announcements(
        &self,
        now: i64,
        owners: &HashMap<String, Owner>,
    ) -> AtomicResult<()> {
        for a in self.query_class(ANNOUNCEMENT).await {
            let subject = pure(&a.get_subject().to_string());
            let sent_key = format!("{SENT_PREFIX}{subject}").into_bytes();
            if self.store.kv.get(Tree::PluginMeta, &sent_key)?.is_some() {
                continue;
            }
            let actor = last_signer(&self.store, &a).await;
            let about = text(&a, urls::ABOUT).map(|s| pure(&s));
            let about_resource = match &about {
                Some(s) => self
                    .store
                    .get_resource(&Subject::from(s.clone()))
                    .await
                    .ok(),
                None => None,
            };
            // Only someone who may write where the announcement is, may send it.
            if let Some(actor) = &actor {
                let ok = hierarchy::check_write(
                    &self.store,
                    &a,
                    &ForAgent::AgentSubject(Subject::from(actor.clone())),
                )
                .await
                .is_ok();
                if !ok {
                    self.store
                        .kv
                        .insert(Tree::PluginMeta, &sent_key, b"refused")?;
                    continue;
                }
            }
            let action_required = a
                .get(ACTION_REQUIRED)
                .ok()
                .and_then(|v| v.to_bool().ok())
                .unwrap_or(false);
            for agent in subjects(&a, RECIPIENTS) {
                if actor.as_deref() == Some(agent.as_str()) || !owners.contains_key(&agent) {
                    continue;
                }
                if owners[&agent]
                    .prefs
                    .muted_kinds
                    .iter()
                    .any(|k| k == "announcement")
                {
                    continue;
                }
                if !can_read(&self.store, &a, &agent).await {
                    continue;
                }
                if let Some(r) = &about_resource {
                    if !can_read(&self.store, r, &agent).await {
                        continue;
                    }
                }
                let item = Queued {
                    agent: agent.clone(),
                    about: about.clone().unwrap_or_else(|| subject.clone()),
                    kind: "announcement".into(),
                    first_at: now,
                    // Announcements are not batched: due right away.
                    last_at: now - self.quiet_ms,
                    count: 1,
                    actors: actor.clone().into_iter().collect(),
                    props: BTreeSet::new(),
                    source: Some(subject.clone()),
                    action_required,
                    title: text(&a, urls::NAME),
                    body: text(&a, urls::DESCRIPTION),
                };
                // One per announcement, never merged with another.
                let key = format!("{QUEUE_PREFIX}{agent}\u{1f}{subject}\u{1f}announcement");
                self.store.kv.insert(
                    Tree::PluginMeta,
                    key.as_bytes(),
                    &serde_json::to_vec(&item)?,
                )?;
            }
            self.store.kv.insert(Tree::PluginMeta, &sent_key, b"1")?;
        }
        Ok(())
    }

    async fn deliver_due(
        &self,
        now: i64,
        owners: &HashMap<String, Owner>,
    ) -> AtomicResult<Vec<Delivery>> {
        let mut due = Vec::new();
        for row in self
            .store
            .kv
            .scan_prefix(Tree::PluginMeta, QUEUE_PREFIX.as_bytes())
        {
            let (key, val) = row?;
            let Ok(q) = serde_json::from_slice::<Queued>(&val) else {
                self.store.kv.remove(Tree::PluginMeta, &key)?;
                continue;
            };
            if now - q.last_at >= self.quiet_ms || now - q.first_at >= self.max_wait_ms {
                due.push((key, q));
            }
        }
        let mut out = Vec::new();
        for (key, q) in due {
            self.store.kv.remove(Tree::PluginMeta, &key)?;
            let Some(owner) = owners.get(&q.agent) else {
                continue;
            };
            if let Some(d) = self.write_notification(owner, &q, now).await? {
                out.push(d);
            }
        }
        out.extend(self.digests(now, owners).await?);
        Ok(out)
    }

    async fn label(&self, subject: &str) -> String {
        match self
            .store
            .get_resource(&Subject::from(subject.to_string()))
            .await
        {
            Ok(r) => name_of(&r),
            Err(_) => subject.to_string(),
        }
    }

    async fn texts(&self, owner: &Owner, q: &Queued) -> (String, String) {
        let nl = owner.prefs.language.starts_with("nl");
        let mut names = Vec::new();
        for a in q.actors.iter().rev().take(2) {
            names.push(self.label(a).await);
        }
        let who = match names.len() {
            0 => String::new(),
            1 => names[0].clone(),
            _ => format!(
                "{} {} {}",
                names[0],
                if nl { "en" } else { "and" },
                names[1]
            ),
        };
        let what = self.label(&q.about).await;
        let title = match q.kind.as_str() {
            "announcement" => {
                let t = q.title.clone().unwrap_or_else(|| what.clone());
                if q.action_required {
                    format!("{}: {t}", if nl { "Actie nodig" } else { "Action needed" })
                } else {
                    t
                }
            }
            "created" if nl => format!("Nieuw: {what}"),
            "created" => format!("New: {what}"),
            _ if nl => format!("Gewijzigd: {what}"),
            _ => format!("Changed: {what}"),
        };
        let body = match q.kind.as_str() {
            "announcement" => {
                let mut b = q.body.clone().unwrap_or_default();
                if !who.is_empty() {
                    let by = if nl { "Van" } else { "From" };
                    b = if b.is_empty() {
                        format!("{by} {who}")
                    } else {
                        format!("{b}\n\n{by} {who}")
                    };
                }
                b
            }
            "created" => {
                if who.is_empty() {
                    String::new()
                } else if nl {
                    format!("Toegevoegd door {who}")
                } else {
                    format!("Added by {who}")
                }
            }
            _ => {
                let mut labels = Vec::new();
                for p in &q.props {
                    if [urls::LAST_COMMIT, urls::LORO_UPDATE].contains(&p.as_str()) {
                        continue;
                    }
                    labels.push(self.label(p).await);
                }
                let changes = if q.count == 1 {
                    if nl {
                        "1 wijziging".to_string()
                    } else {
                        "1 change".to_string()
                    }
                } else if nl {
                    format!("{} wijzigingen", q.count)
                } else {
                    format!("{} changes", q.count)
                };
                let mut b = if who.is_empty() {
                    changes
                } else if nl {
                    format!("{changes} door {who}")
                } else {
                    format!("{changes} by {who}")
                };
                if !labels.is_empty() {
                    b.push_str(&format!(" ({})", labels.join(", ")));
                }
                b
            }
        };
        (title, body)
    }

    /// The unread Notification in this Inbox about the same thing and kind.
    async fn unread_for(&self, inbox: &str, about: &str, kind: &str) -> Option<Resource> {
        let members = self
            .store
            .query(&Query::new_prop_val(urls::PARENT, inbox))
            .await
            .ok()?;
        for s in members.subjects {
            let Ok(n) = self.store.get_resource(&s).await else {
                continue;
            };
            if classes_of(&n).iter().any(|c| c == NOTIFICATION)
                && n.get(READ_AT).is_err()
                && text(&n, urls::ABOUT).map(|a| pure(&a)).as_deref() == Some(about)
                && text(&n, NOTIFICATION_KIND).as_deref() == Some(kind)
            {
                return Some(n);
            }
        }
        None
    }

    async fn write_notification(
        &self,
        owner: &Owner,
        q: &Queued,
        now: i64,
    ) -> AtomicResult<Option<Delivery>> {
        // Rights can change while it waits.
        if let Ok(r) = self
            .store
            .get_resource(&Subject::from(q.about.clone()))
            .await
        {
            if !can_read(&self.store, &r, &owner.agent).await {
                return Ok(None);
            }
        }
        let existing = if q.kind == "announcement" {
            None
        } else {
            self.unread_for(&owner.inbox, &q.about, &q.kind).await
        };
        let mut q = q.clone();
        if let Some(n) = &existing {
            let before = n
                .get(NOTIFICATION_COUNT)
                .ok()
                .and_then(|v| v.to_int().ok())
                .unwrap_or(1);
            q.count += before;
            q.props.extend(subjects(n, CHANGED_PROPERTIES));
            let mut actors = vec![];
            if let Some(a) = text(n, ACTOR) {
                actors.push(a);
            }
            for a in &q.actors {
                if !actors.contains(a) {
                    actors.push(a.clone());
                }
            }
            q.actors = actors;
        }
        let (title, body) = self.texts(owner, &q).await;
        let mut props: Vec<(&str, Value)> = vec![
            (urls::DESCRIPTION, Value::String(body.clone())),
            (urls::ABOUT, Value::AtomicUrl(q.about.clone().into())),
            (NOTIFICATION_KIND, Value::String(q.kind.clone())),
            (OCCURRED_AT, Value::Timestamp(q.last_at.max(q.first_at))),
            (NOTIFICATION_COUNT, Value::Integer(q.count)),
        ];
        if let Some(a) = q.actors.last() {
            props.push((ACTOR, Value::AtomicUrl(a.clone().into())));
        }
        if q.action_required {
            props.push((ACTION_REQUIRED, Value::Boolean(true)));
        }
        let changed: Vec<String> = q
            .props
            .iter()
            .filter(|p| ![urls::LAST_COMMIT, urls::LORO_UPDATE].contains(&p.as_str()))
            .cloned()
            .collect();
        if !changed.is_empty() {
            props.push((
                CHANGED_PROPERTIES,
                Value::ResourceArray(changed.iter().map(|p| p.clone().into()).collect()),
            ));
        }
        let subject = match existing {
            Some(mut n) => {
                n.set_unsafe(urls::NAME.into(), Value::String(title.clone()))?;
                for (p, v) in props {
                    n.set_unsafe(p.into(), v)?;
                }
                n.save_locally(&self.store).await?;
                n.get_subject().to_string()
            }
            None => {
                let source = q
                    .source
                    .clone()
                    .unwrap_or_else(|| format!("{}#{}-{}", q.about, q.kind, q.first_at));
                props.push((NOTIFICATION_SOURCE, Value::AtomicUrl(source.into())));
                self.store
                    .create_resource(NOTIFICATION, &owner.inbox, &title, Some(props))
                    .await?
            }
        };

        let email = match owner.prefs.email_frequency {
            Frequency::Instant => owner.prefs.email.clone(),
            Frequency::Daily => {
                let key = format!("{DIGEST_PREFIX}{}\u{1f}{subject}", owner.agent);
                self.store
                    .kv
                    .insert(Tree::PluginMeta, key.as_bytes(), b"1")?;
                None
            }
            Frequency::Off => None,
        };
        let _ = now;
        Ok(Some(Delivery {
            agent: owner.agent.clone(),
            notification: subject,
            kind: q.kind.clone(),
            title,
            body,
            about: q.about.clone(),
            action_required: q.action_required,
            count: q.count,
            push_endpoints: owner.prefs.push_endpoints.clone(),
            email,
            language: owner.prefs.language.clone(),
        }))
    }

    /// Once a day after [`Self::digest_hour_utc`]: one mail per person with
    /// daily mail, listing what is still unread.
    async fn digests(
        &self,
        now: i64,
        owners: &HashMap<String, Owner>,
    ) -> AtomicResult<Vec<Delivery>> {
        let day = now / 86_400_000;
        let hour = ((now % 86_400_000) / 3_600_000) as u32;
        let last_day: i64 = self
            .store
            .kv
            .get(Tree::PluginMeta, DIGEST_DAY_KEY.as_bytes())?
            .and_then(|b| String::from_utf8(b).ok()?.parse().ok())
            .unwrap_or(-1);
        if hour < self.digest_hour_utc || last_day >= day {
            return Ok(Vec::new());
        }
        self.store.kv.insert(
            Tree::PluginMeta,
            DIGEST_DAY_KEY.as_bytes(),
            day.to_string().as_bytes(),
        )?;

        let mut per_agent: HashMap<String, Vec<String>> = HashMap::new();
        let mut keys = Vec::new();
        for row in self
            .store
            .kv
            .scan_prefix(Tree::PluginMeta, DIGEST_PREFIX.as_bytes())
        {
            let (key, _) = row?;
            let rest = String::from_utf8_lossy(&key[DIGEST_PREFIX.len()..]).to_string();
            if let Some((agent, n)) = rest.split_once('\u{1f}') {
                per_agent.entry(agent.into()).or_default().push(n.into());
            }
            keys.push(key);
        }
        for key in keys {
            self.store.kv.remove(Tree::PluginMeta, &key)?;
        }
        let mut out = Vec::new();
        for (agent, notifications) in per_agent {
            let Some(owner) = owners.get(&agent) else {
                continue;
            };
            let Some(email) = owner.prefs.email.clone() else {
                continue;
            };
            let mut lines = Vec::new();
            let mut seen = HashSet::new();
            for n in notifications {
                let Ok(r) = self.store.get_resource(&Subject::from(n.clone())).await else {
                    continue;
                };
                if r.get(READ_AT).is_ok() || !seen.insert(n) {
                    continue;
                }
                lines.push(format!(
                    "- {}{}",
                    name_of(&r),
                    text(&r, urls::DESCRIPTION)
                        .map(|d| format!(": {d}"))
                        .unwrap_or_default()
                ));
            }
            if lines.is_empty() {
                continue;
            }
            let nl = owner.prefs.language.starts_with("nl");
            out.push(Delivery {
                agent: agent.clone(),
                notification: String::new(),
                kind: "digest".into(),
                title: if nl {
                    format!("{} nieuwe meldingen", lines.len())
                } else {
                    format!("{} new notifications", lines.len())
                },
                body: lines.join("\n"),
                about: owner.inbox.clone(),
                action_required: false,
                count: lines.len() as i64,
                push_endpoints: Vec::new(),
                email: Some(email),
                language: owner.prefs.language.clone(),
            });
        }
        Ok(out)
    }
}

/// The Inbox of the private drive `drive`, created when missing (as the web
/// app's `getOrCreateInbox` does), for tests and for clients that call in.
pub async fn ensure_inbox(store: &Db, drive: &str) -> AtomicResult<String> {
    let mut d = store
        .get_resource(&Subject::from(drive.to_string()))
        .await?;
    if let Some(inbox) = subjects(&d, INBOX).into_iter().next() {
        return Ok(inbox);
    }
    let inbox = store
        .create_resource(INBOX_CLASS, drive, "Inbox", None)
        .await?;
    d.set_unsafe(INBOX.into(), Value::AtomicUrl(inbox.clone().into()))?;
    d.save_locally(store).await?;
    Ok(inbox)
}

#[cfg(test)]
mod tests;
