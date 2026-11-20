use super::*;
use crate::{Commit, agents::Agent, commit::CommitBuilder};

const MEETING: &str = "https://example.test/classes/Meeting";
const START: &str = "https://example.test/properties/start";
const ROOM: &str = "https://example.test/properties/room";

struct World {
    store: Db,
    anna: Agent,
    bert: Agent,
    /// Anna's private drive, and its Inbox.
    anna_drive: String,
    inbox: String,
    /// Shared: Anna and Bert read, Bert writes.
    council: String,
}

async fn create_as(
    store: &Db,
    agent: &Agent,
    class: &str,
    parent: Option<&str>,
    name: &str,
    props: Vec<(&str, Value)>,
) -> String {
    let mut builder = CommitBuilder::new("placeholder".into());
    builder.set(urls::IS_A.into(), Value::ResourceArray(vec![class.into()]));
    builder.set(urls::NAME.into(), Value::String(name.into()));
    if let Some(p) = parent {
        builder.set(urls::PARENT.into(), Value::AtomicUrl(p.into()));
    }
    for (p, v) in props {
        builder.set(p.into(), v);
    }
    let commit = Commit::create_did(builder, agent, store).await.unwrap();
    let subject = commit.subject.to_string();
    let opts = crate::commit::CommitOpts {
        validate_signature: true,
        update_index: true,
        ..crate::commit::CommitOpts::no_validations_no_index()
    };
    store.apply_commit(commit, &opts).await.unwrap();
    subject
}

async fn edit_as(store: &Db, agent: &Agent, subject: &str, prop: &str, value: Value) {
    let mut r = store
        .get_resource(&Subject::from(subject.to_string()))
        .await
        .unwrap();
    r.set_unsafe(prop.into(), value).unwrap();
    r.save_as(agent, store).await.unwrap();
}

fn agents(list: &[&Agent]) -> Value {
    Value::ResourceArray(list.iter().map(|a| a.subject.to_string().into()).collect())
}

impl World {
    async fn new() -> World {
        let store = Db::init_redb(None).await.unwrap();
        store.setup("Server").await.unwrap();
        let anna = Agent::new(Some("Anna")).unwrap();
        let bert = Agent::new(Some("Bert")).unwrap();
        for a in [&anna, &bert] {
            store.add_resource(&a.to_resource().unwrap()).await.unwrap();
        }
        let anna_drive = create_as(
            &store,
            &anna,
            urls::DRIVE,
            None,
            "Anna's drive",
            vec![
                (urls::WRITE, agents(&[&anna])),
                (urls::READ, agents(&[&anna])),
            ],
        )
        .await;
        let inbox = create_as(
            &store,
            &anna,
            INBOX_CLASS,
            Some(&anna_drive),
            "Inbox",
            vec![(NOTIFY_EMAIL, Value::String("anna@example.test".into()))],
        )
        .await;
        let council = create_as(
            &store,
            &bert,
            urls::DRIVE,
            None,
            "Council",
            vec![
                (urls::WRITE, agents(&[&bert])),
                (urls::READ, agents(&[&anna, &bert])),
            ],
        )
        .await;
        World {
            store,
            anna,
            bert,
            anna_drive,
            inbox,
            council,
        }
    }

    async fn follow(&self, about: &str, level: &str, extra: Vec<(&str, Value)>) -> String {
        let mut props = vec![
            (urls::ABOUT, Value::AtomicUrl(about.into())),
            (FOLLOW_LEVEL, Value::String(level.into())),
        ];
        props.extend(extra);
        create_as(
            &self.store,
            &self.anna,
            FOLLOW,
            Some(&self.inbox),
            "Follow",
            props,
        )
        .await
    }

    fn notifier(&self) -> Notifier {
        let mut n = Notifier::new(self.store.clone());
        n.quiet_ms = 1_000;
        n.max_wait_ms = 10_000;
        // No digest in these tests unless asked.
        n.digest_hour_utc = 24;
        n
    }

    async fn inbox_items(&self) -> Vec<Resource> {
        let found = self
            .store
            .query(&Query::new_prop_val(urls::PARENT, &self.inbox))
            .await
            .unwrap();
        let mut out = Vec::new();
        for s in found.subjects {
            let r = self.store.get_resource(&s).await.unwrap();
            if classes_of(&r).iter().any(|c| c == NOTIFICATION) {
                out.push(r);
            }
        }
        out
    }
}

fn later() -> i64 {
    crate::utils::now() + 60_000
}

#[tokio::test]
async fn the_inbox_owner_is_the_only_writer_of_its_drive() {
    let w = World::new().await;
    let owners = w.notifier().owners().await;
    let owner = owners.get(&pure(&w.inbox)).expect("Anna's inbox is found");
    assert_eq!(owner.agent, w.anna.subject.to_string());
    assert_eq!(owner.prefs.email.as_deref(), Some("anna@example.test"));
    assert_eq!(owner.prefs.email_frequency, Frequency::Instant);

    // An Inbox in a drive that others read is nobody's.
    create_as(
        &w.store,
        &w.bert,
        INBOX_CLASS,
        Some(&w.council),
        "Fake",
        vec![],
    )
    .await;
    let owners = w.notifier().owners().await;
    assert_eq!(owners.len(), 1, "{owners:?}");
}

#[tokio::test]
async fn a_new_meeting_in_a_followed_drive_is_one_notification() {
    let w = World::new().await;
    w.follow(&w.council, "newItems", vec![]).await;
    let n = w.notifier();
    // The first round only starts watching.
    assert!(n.tick(crate::utils::now()).await.unwrap().is_empty());

    let meeting = create_as(
        &w.store,
        &w.bert,
        MEETING,
        Some(&w.council),
        "Raadsvergadering",
        vec![(START, Value::Timestamp(1_000))],
    )
    .await;

    let deliveries = n.tick(later()).await.unwrap();
    assert_eq!(deliveries.len(), 1, "{deliveries:?}");
    let d = &deliveries[0];
    assert_eq!(d.agent, w.anna.subject.to_string());
    assert_eq!(d.kind, "created");
    assert_eq!(pure(&d.about), pure(&meeting));
    assert_eq!(d.title, "New: Raadsvergadering");
    assert_eq!(d.email.as_deref(), Some("anna@example.test"));

    let items = w.inbox_items().await;
    assert_eq!(items.len(), 1);
    assert_eq!(
        text(&items[0], ACTOR).as_deref(),
        Some(w.bert.subject.to_string().as_str())
    );

    // Nothing more to say.
    assert!(n.tick(later()).await.unwrap().is_empty());
}

#[tokio::test]
async fn edits_are_batched_and_filtered_by_property() {
    let w = World::new().await;
    let meeting = create_as(
        &w.store,
        &w.bert,
        MEETING,
        Some(&w.council),
        "Commissie",
        vec![],
    )
    .await;
    w.follow(
        &w.council,
        "everything",
        vec![
            (FOLLOW_CLASSES, Value::ResourceArray(vec![MEETING.into()])),
            (FOLLOW_PROPERTIES, Value::ResourceArray(vec![START.into()])),
        ],
    )
    .await;
    let n = w.notifier();
    n.tick(crate::utils::now()).await.unwrap();

    edit_as(
        &w.store,
        &w.bert,
        &meeting,
        ROOM,
        Value::String("Zaal 2".into()),
    )
    .await;
    assert!(
        n.tick(later()).await.unwrap().is_empty(),
        "a room change is not a date change"
    );

    edit_as(&w.store, &w.bert, &meeting, START, Value::Timestamp(5)).await;
    edit_as(&w.store, &w.bert, &meeting, START, Value::Timestamp(6)).await;
    // Still busy: not yet.
    assert!(n.tick(crate::utils::now()).await.unwrap().is_empty());
    let deliveries = n.tick(later()).await.unwrap();
    assert_eq!(deliveries.len(), 1, "{deliveries:?}");
    assert_eq!(deliveries[0].kind, "changed");
    assert_eq!(deliveries[0].count, 2);

    // More while unread: the same Notification grows.
    edit_as(&w.store, &w.bert, &meeting, START, Value::Timestamp(7)).await;
    let again = n.tick(later() + 60_000).await.unwrap();
    assert_eq!(again.len(), 1);
    assert_eq!(again[0].notification, deliveries[0].notification);
    assert_eq!(again[0].count, 3);
    assert_eq!(w.inbox_items().await.len(), 1);
}

#[tokio::test]
async fn own_changes_muted_folders_and_unreadable_things_are_quiet() {
    let w = World::new().await;
    // Anna writes in her own drive, which she follows: nothing.
    w.follow(&w.anna_drive, "everything", vec![]).await;
    w.follow(&w.council, "newItems", vec![]).await;
    let secret = create_as(
        &w.store,
        &w.bert,
        urls::FOLDER,
        Some(&w.council),
        "Besloten",
        vec![],
    )
    .await;
    w.follow(&secret, "muted", vec![]).await;
    let closed = create_as(
        &w.store,
        &w.bert,
        urls::DRIVE,
        None,
        "Geheim",
        vec![
            (urls::WRITE, agents(&[&w.bert])),
            (urls::READ, agents(&[&w.bert])),
        ],
    )
    .await;
    w.follow(&closed, "newItems", vec![]).await;

    let n = w.notifier();
    n.tick(crate::utils::now()).await.unwrap();

    create_as(
        &w.store,
        &w.anna,
        urls::FOLDER,
        Some(&w.anna_drive),
        "Mine",
        vec![],
    )
    .await;
    create_as(
        &w.store,
        &w.bert,
        urls::FOLDER,
        Some(&secret),
        "Muted child",
        vec![],
    )
    .await;
    create_as(
        &w.store,
        &w.bert,
        urls::FOLDER,
        Some(&closed),
        "Unreadable",
        vec![],
    )
    .await;
    assert!(n.tick(later()).await.unwrap().is_empty());
    assert!(w.inbox_items().await.is_empty());
}

#[tokio::test]
async fn an_announcement_reaches_its_recipients_once() {
    let w = World::new().await;
    let doc = create_as(
        &w.store,
        &w.bert,
        urls::FOLDER,
        Some(&w.council),
        "Begroting",
        vec![],
    )
    .await;
    let n = w.notifier();
    create_as(
        &w.store,
        &w.bert,
        ANNOUNCEMENT,
        Some(&w.council),
        "Nieuwe versie begroting",
        vec![
            (urls::ABOUT, Value::AtomicUrl(doc.as_str().into())),
            (RECIPIENTS, agents(&[&w.anna, &w.bert])),
            (ACTION_REQUIRED, Value::Boolean(true)),
            (
                urls::DESCRIPTION,
                Value::String("Graag voor vrijdag lezen.".into()),
            ),
        ],
    )
    .await;
    let deliveries = n.tick(crate::utils::now()).await.unwrap();
    assert_eq!(deliveries.len(), 1, "only Anna; Bert sent it");
    assert_eq!(deliveries[0].kind, "announcement");
    assert!(deliveries[0].action_required);
    assert_eq!(
        deliveries[0].title,
        "Action needed: Nieuwe versie begroting"
    );
    assert!(deliveries[0].body.starts_with("Graag voor vrijdag lezen."));
    assert!(n.tick(later()).await.unwrap().is_empty(), "once");
}

#[tokio::test]
async fn daily_mail_collects_unread_notifications() {
    let w = World::new().await;
    edit_as(
        &w.store,
        &w.anna,
        &w.inbox,
        EMAIL_FREQUENCY,
        Value::String("daily".into()),
    )
    .await;
    edit_as(
        &w.store,
        &w.anna,
        &w.inbox,
        NOTIFY_LANGUAGE,
        Value::String("nl".into()),
    )
    .await;
    w.follow(&w.council, "newItems", vec![]).await;
    let mut n = w.notifier();
    n.digest_hour_utc = 0;
    n.tick(crate::utils::now()).await.unwrap();
    create_as(&w.store, &w.bert, MEETING, Some(&w.council), "Raad", vec![]).await;
    create_as(
        &w.store,
        &w.bert,
        MEETING,
        Some(&w.council),
        "Commissie",
        vec![],
    )
    .await;

    let deliveries = n.tick(later()).await.unwrap();
    let instant: Vec<_> = deliveries.iter().filter(|d| d.kind == "created").collect();
    assert_eq!(instant.len(), 2);
    assert!(instant.iter().all(|d| d.email.is_none()), "mail waits");
    assert!(instant.iter().any(|d| d.title == "Nieuw: Raad"));

    // Next day: one digest.
    let tomorrow = later() + 86_400_000;
    let digest: Vec<_> = n
        .tick(tomorrow)
        .await
        .unwrap()
        .into_iter()
        .filter(|d| d.kind == "digest")
        .collect();
    assert_eq!(digest.len(), 1, "{digest:?}");
    assert_eq!(digest[0].title, "2 nieuwe meldingen");
    assert_eq!(digest[0].email.as_deref(), Some("anna@example.test"));
}

#[tokio::test]
async fn push_registrations_are_listed_on_the_owner() {
    let w = World::new().await;
    create_as(
        &w.store,
        &w.anna,
        PUSH_REGISTRATION,
        Some(&w.inbox),
        "Tablet",
        vec![(
            PUSH_ENDPOINT,
            Value::String("https://push.example.test/up/abc".into()),
        )],
    )
    .await;
    let owners = w.notifier().owners().await;
    assert_eq!(
        owners[&pure(&w.inbox)].prefs.push_endpoints,
        vec!["https://push.example.test/up/abc".to_string()]
    );
}

#[tokio::test]
async fn two_follows_on_one_drive_each_narrow_their_own_kind() {
    let w = World::new().await;
    const DOC: &str = "https://example.test/classes/Doc";
    w.follow(
        &w.council,
        "everything",
        vec![
            (FOLLOW_CLASSES, Value::ResourceArray(vec![MEETING.into()])),
            (FOLLOW_PROPERTIES, Value::ResourceArray(vec![START.into()])),
        ],
    )
    .await;
    w.follow(
        &w.council,
        "everything",
        vec![(FOLLOW_CLASSES, Value::ResourceArray(vec![DOC.into()]))],
    )
    .await;
    let n = w.notifier();
    n.tick(crate::utils::now()).await.unwrap();
    let meeting = create_as(&w.store, &w.bert, MEETING, Some(&w.council), "Raad", vec![]).await;
    let doc = create_as(
        &w.store,
        &w.bert,
        DOC,
        Some(&w.council),
        "Begroting",
        vec![],
    )
    .await;
    assert_eq!(n.tick(later()).await.unwrap().len(), 2, "both are new");

    edit_as(
        &w.store,
        &w.bert,
        &meeting,
        ROOM,
        Value::String("Zaal".into()),
    )
    .await;
    edit_as(&w.store, &w.bert, &doc, ROOM, Value::String("v2".into())).await;
    let changed = n.tick(later() + 60_000).await.unwrap();
    assert_eq!(changed.len(), 1, "{changed:?}");
    assert_eq!(pure(&changed[0].about), pure(&doc));
}

#[tokio::test]
async fn the_changes_level_skips_new_items() {
    let w = World::new().await;
    w.follow(&w.council, "changes", vec![]).await;
    let n = w.notifier();
    n.tick(crate::utils::now()).await.unwrap();
    let m = create_as(&w.store, &w.bert, MEETING, Some(&w.council), "Raad", vec![]).await;
    assert!(n.tick(later()).await.unwrap().is_empty());
    edit_as(&w.store, &w.bert, &m, START, Value::Timestamp(9)).await;
    let d = n.tick(later() + 60_000).await.unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].kind, "changed");
}
