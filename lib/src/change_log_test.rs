//! Tests for the per-table change list (#1850).

use std::time::Duration;

use super::*;
use crate::{agents::ForAgent, urls, Db, Resource, Storelike, Subject, Value};

async fn store(id: &str) -> Db {
    let store = Db::init_temp(id).await.unwrap();
    crate::test_utils::setup_test_env(&store).await.unwrap();
    store
}

/// A class for rows, created locally so validation never goes looking for it.
async fn row_class(store: &Db, shortname: &str) -> String {
    let mut class = Resource::new_generate_subject(store).unwrap();
    class
        .set(
            urls::IS_A.into(),
            Value::ResourceArray(vec![urls::CLASS.into()]),
            store,
        )
        .await
        .unwrap();
    class
        .set(urls::SHORTNAME.into(), Value::Slug(shortname.into()), store)
        .await
        .unwrap();
    class
        .set(
            urls::DESCRIPTION.into(),
            Value::Markdown("rows".into()),
            store,
        )
        .await
        .unwrap();
    class.save(store).await.unwrap();
    class.get_subject().pure_id()
}

async fn table(store: &Db, class: &str) -> String {
    let mut table = Resource::new_generate_subject(store).unwrap();
    table
        .set(
            urls::IS_A.into(),
            Value::ResourceArray(vec![urls::TABLE.into()]),
            store,
        )
        .await
        .unwrap();
    table
        .set(
            urls::CLASSTYPE_PROP.into(),
            Value::AtomicUrl(class.into()),
            store,
        )
        .await
        .unwrap();
    table
        .set(urls::NAME.into(), Value::String("Tasks".into()), store)
        .await
        .unwrap();
    table.save(store).await.unwrap();
    table.get_subject().pure_id()
}

async fn row(store: &Db, table: &str, class: &str, name: &str) -> Resource {
    let mut row = Resource::new_generate_subject(store).unwrap();
    row.set(
        urls::IS_A.into(),
        Value::ResourceArray(vec![class.into()]),
        store,
    )
    .await
    .unwrap();
    row.set(urls::PARENT.into(), Value::AtomicUrl(table.into()), store)
        .await
        .unwrap();
    row.set(urls::NAME.into(), Value::String(name.into()), store)
        .await
        .unwrap();
    row.save(store).await.unwrap();
    row
}

async fn rename(store: &Db, subject: &str, name: &str) {
    let mut r = store.get_resource(&Subject::from(subject)).await.unwrap();
    r.set(urls::NAME.into(), Value::String(name.into()), store)
        .await
        .unwrap();
    r.save(store).await.unwrap();
}

async fn move_to(store: &Db, subject: &str, parent: &str) {
    let mut r = store.get_resource(&Subject::from(subject)).await.unwrap();
    r.set(urls::PARENT.into(), Value::AtomicUrl(parent.into()), store)
        .await
        .unwrap();
    r.save(store).await.unwrap();
}

async fn destroy(store: &Db, subject: &str) {
    let mut r = store.get_resource(&Subject::from(subject)).await.unwrap();
    r.destroy(store).await.unwrap();
}

async fn changes(store: &Db, table: &str, since: Option<&str>) -> ChangePage {
    table_changes(
        store,
        &Subject::from(table),
        since,
        Some(MAX_PAGE_SIZE),
        &ForAgent::Sudo,
    )
    .await
    .unwrap()
}

fn kinds(page: &ChangePage) -> Vec<(String, ChangeKind)> {
    page.changes
        .iter()
        .map(|c| (c.subject.clone(), c.kind))
        .collect()
}

#[tokio::test]
async fn create_update_move_destroy_are_listed_with_kinds() {
    let store = store("change_log_kinds").await;
    let class = row_class(&store, "task").await;
    let t1 = table(&store, &class).await;
    let t2 = table(&store, &class).await;

    // First read: backfill of an empty table, a cursor to start from.
    let start = changes(&store, &t1, None).await;
    assert!(start.changes.is_empty());
    assert!(!start.has_more);
    let c0 = start.cursor;

    let a = row(&store, &t1, &class, "a").await.get_subject().pure_id();
    let b = row(&store, &t1, &class, "b").await.get_subject().pure_id();
    let c = row(&store, &t1, &class, "c").await.get_subject().pure_id();

    let page = changes(&store, &t1, Some(&c0)).await;
    assert_eq!(
        kinds(&page),
        vec![
            (a.clone(), ChangeKind::Created),
            (b.clone(), ChangeKind::Created),
            (c.clone(), ChangeKind::Created),
        ]
    );
    let c1 = page.cursor;

    // Update a, move b out to t2, destroy c.
    rename(&store, &a, "a2").await;
    move_to(&store, &b, &t2).await;
    destroy(&store, &c).await;

    let page = changes(&store, &t1, Some(&c1)).await;
    assert_eq!(
        kinds(&page),
        vec![
            (a.clone(), ChangeKind::Updated),
            (b.clone(), ChangeKind::Deleted),
            (c.clone(), ChangeKind::Deleted),
        ]
    );
    let c2 = page.cursor;

    // b arrived in t2; t2's first read is its backfill plus that entry.
    let t2_page = changes(&store, &t2, None).await;
    assert_eq!(kinds(&t2_page), vec![(b.clone(), ChangeKind::Created)]);

    // Move b back in.
    move_to(&store, &b, &t1).await;
    let page = changes(&store, &t1, Some(&c2)).await;
    assert_eq!(kinds(&page), vec![(b.clone(), ChangeKind::Created)]);
    let t2_page = changes(&store, &t2, Some(&t2_page.cursor)).await;
    assert_eq!(kinds(&t2_page), vec![(b.clone(), ChangeKind::Deleted)]);

    // Nothing new: an empty page and the same position.
    let again = changes(&store, &t1, Some(&page.cursor)).await;
    assert!(again.changes.is_empty());
    assert_eq!(again.cursor, page.cursor);
}

#[tokio::test]
async fn only_the_latest_entry_per_row_is_kept() {
    let store = store("change_log_compact").await;
    let class = row_class(&store, "task").await;
    let t = table(&store, &class).await;
    let c0 = changes(&store, &t, None).await.cursor;
    let a = row(&store, &t, &class, "a").await.get_subject().pure_id();
    for i in 0..5 {
        rename(&store, &a, &format!("a{i}")).await;
    }
    let page = changes(&store, &t, Some(&c0)).await;
    assert_eq!(kinds(&page), vec![(a.clone(), ChangeKind::Updated)]);
    let entries = store
        .kv
        .scan_prefix(Tree::TableChanges, &entry_prefix(&t))
        .count();
    assert_eq!(entries, 1, "one stored entry per row");
}

#[tokio::test]
async fn each_entry_carries_the_rows_loro_version() {
    let store = store("change_log_version").await;
    let class = row_class(&store, "task").await;
    let t = table(&store, &class).await;
    let c0 = changes(&store, &t, None).await.cursor;
    let a = row(&store, &t, &class, "a").await.get_subject().pure_id();

    let first = changes(&store, &t, Some(&c0)).await;
    let v1 = first.changes[0].version.clone().expect("version present");
    assert!(!v1.is_empty());
    // It is the version of the stored snapshot.
    assert_eq!(Some(v1.clone()), store.stored_version(&a));

    rename(&store, &a, "a2").await;
    let second = changes(&store, &t, Some(&first.cursor)).await;
    let v2 = second.changes[0].version.clone().expect("version present");
    assert_ne!(v1, v2, "the version moves with the edit");
    let total = |v: &VersionMap| v.values().map(|c| *c as i64).sum::<i64>();
    assert!(total(&v2) > total(&v1));

    // A tombstone carries the last version this node held.
    destroy(&store, &a).await;
    let third = changes(&store, &t, Some(&second.cursor)).await;
    assert_eq!(third.changes[0].kind, ChangeKind::Deleted);
    assert_eq!(third.changes[0].version, Some(v2));
}

#[tokio::test]
async fn pages_are_bounded_and_complete() {
    let store = store("change_log_pages").await;
    let class = row_class(&store, "task").await;
    let t = table(&store, &class).await;
    let mut cursor = changes(&store, &t, None).await.cursor;
    let mut created = Vec::new();
    for i in 0..5 {
        created.push(
            row(&store, &t, &class, &format!("r{i}"))
                .await
                .get_subject()
                .pure_id(),
        );
    }

    let mut seen = Vec::new();
    let mut pages = 0;
    loop {
        let page = table_changes(
            &store,
            &Subject::from(t.as_str()),
            Some(&cursor),
            Some(2),
            &ForAgent::Sudo,
        )
        .await
        .unwrap();
        pages += 1;
        assert!(page.changes.len() <= 2);
        seen.extend(page.changes.iter().map(|c| c.subject.clone()));
        cursor = page.cursor;
        if !page.has_more {
            break;
        }
    }
    assert_eq!(pages, 3);
    assert_eq!(seen, created);

    // Oversized limits are clamped.
    let page = table_changes(
        &store,
        &Subject::from(t.as_str()),
        None,
        Some(10_000),
        &ForAgent::Sudo,
    )
    .await
    .unwrap();
    assert_eq!(page.changes.len(), 5);
}

#[tokio::test]
async fn a_row_edited_between_pages_is_not_missed() {
    let store = store("change_log_edit_between_pages").await;
    let class = row_class(&store, "task").await;
    let t = table(&store, &class).await;
    let c0 = changes(&store, &t, None).await.cursor;
    let a = row(&store, &t, &class, "a").await.get_subject().pure_id();
    let b = row(&store, &t, &class, "b").await.get_subject().pure_id();

    let first = table_changes(
        &store,
        &Subject::from(t.as_str()),
        Some(&c0),
        Some(1),
        &ForAgent::Sudo,
    )
    .await
    .unwrap();
    assert_eq!(kinds(&first), vec![(a.clone(), ChangeKind::Created)]);
    assert!(first.has_more);

    // b (not yet returned) and a (already returned) change mid-listing.
    rename(&store, &b, "b2").await;
    rename(&store, &a, "a2").await;

    let rest = changes(&store, &t, Some(&first.cursor)).await;
    assert_eq!(
        kinds(&rest),
        vec![
            (b.clone(), ChangeKind::Updated),
            (a.clone(), ChangeKind::Updated),
        ]
    );
}

#[tokio::test]
async fn cursor_expires_when_a_tombstone_it_needed_was_pruned() {
    let store = store("change_log_expiry").await;
    let class = row_class(&store, "task").await;
    let t = table(&store, &class).await;
    let a = row(&store, &t, &class, "a").await.get_subject().pure_id();
    let b = row(&store, &t, &class, "b").await.get_subject().pure_id();
    let before_delete = changes(&store, &t, None).await.cursor;

    store.set_table_change_retention(Duration::ZERO);
    destroy(&store, &a).await;

    let err = table_changes(
        &store,
        &Subject::from(t.as_str()),
        Some(&before_delete),
        None,
        &ForAgent::Sudo,
    )
    .await
    .unwrap_err();
    assert!(matches!(err, ChangeListError::CursorExpired), "{err}");
    assert_eq!(err.code(), "CURSOR_EXPIRED");

    // Resync from scratch works and yields a usable cursor.
    let full = changes(&store, &t, None).await;
    assert_eq!(kinds(&full), vec![(b.clone(), ChangeKind::Created)]);
    rename(&store, &b, "b2").await;
    let next = changes(&store, &t, Some(&full.cursor)).await;
    assert_eq!(kinds(&next), vec![(b, ChangeKind::Updated)]);
}

#[tokio::test]
async fn tombstones_are_kept_within_retention() {
    let store = store("change_log_retention").await;
    let class = row_class(&store, "task").await;
    let t = table(&store, &class).await;
    let a = row(&store, &t, &class, "a").await.get_subject().pure_id();
    let c0 = changes(&store, &t, None).await.cursor;
    destroy(&store, &a).await;
    // Default retention (30 days): the tombstone survives reads.
    assert_eq!(store.table_change_retention(), DEFAULT_TOMBSTONE_RETENTION);
    let _ = changes(&store, &t, None).await;
    let page = changes(&store, &t, Some(&c0)).await;
    assert_eq!(kinds(&page), vec![(a, ChangeKind::Deleted)]);
}

#[tokio::test]
async fn invalid_and_foreign_cursors_are_refused() {
    let store = store("change_log_bad_cursor").await;
    let class = row_class(&store, "task").await;
    let t1 = table(&store, &class).await;
    let t2 = table(&store, &class).await;
    let c1 = changes(&store, &t1, None).await.cursor;

    let foreign = table_changes(
        &store,
        &Subject::from(t2.as_str()),
        Some(&c1),
        None,
        &ForAgent::Sudo,
    )
    .await
    .unwrap_err();
    assert!(matches!(foreign, ChangeListError::InvalidCursor(_)));

    let garbage = table_changes(
        &store,
        &Subject::from(t1.as_str()),
        Some("not a cursor!"),
        None,
        &ForAgent::Sudo,
    )
    .await
    .unwrap_err();
    assert!(matches!(garbage, ChangeListError::InvalidCursor(_)));

    // Not a table.
    let not_table = table_changes(
        &store,
        &Subject::from(class.as_str()),
        None,
        None,
        &ForAgent::Sudo,
    )
    .await
    .unwrap_err();
    assert!(matches!(not_table, ChangeListError::NotATable));
}

#[tokio::test]
async fn changing_the_classtype_expires_cursors_and_rebuilds() {
    let store = store("change_log_reset").await;
    let task = row_class(&store, "task").await;
    let note = row_class(&store, "note").await;
    let t = table(&store, &task).await;
    let a = row(&store, &t, &task, "a").await.get_subject().pure_id();
    let n = row(&store, &t, &note, "n").await.get_subject().pure_id();
    let page = changes(&store, &t, None).await;
    assert_eq!(kinds(&page), vec![(a.clone(), ChangeKind::Created)]);

    let mut table_res = store
        .get_resource(&Subject::from(t.as_str()))
        .await
        .unwrap();
    table_res
        .set(
            urls::CLASSTYPE_PROP.into(),
            Value::AtomicUrl(note.clone().into()),
            &store,
        )
        .await
        .unwrap();
    table_res.save(&store).await.unwrap();

    let err = table_changes(
        &store,
        &Subject::from(t.as_str()),
        Some(&page.cursor),
        None,
        &ForAgent::Sudo,
    )
    .await
    .unwrap_err();
    assert!(matches!(err, ChangeListError::CursorExpired));
    let rebuilt = changes(&store, &t, None).await;
    assert_eq!(kinds(&rebuilt), vec![(n, ChangeKind::Created)]);
}

#[tokio::test]
async fn backfill_lists_rows_that_predate_the_log() {
    let store = store("change_log_backfill").await;
    let class = row_class(&store, "task").await;
    let t = table(&store, &class).await;
    let a = row(&store, &t, &class, "a").await.get_subject().pure_id();
    let b = row(&store, &t, &class, "b").await.get_subject().pure_id();
    // A non-row child (a View of the table): never listed.
    let mut view = Resource::new_generate_subject(&store).unwrap();
    view.set(
        urls::PARENT.into(),
        Value::AtomicUrl(t.clone().into()),
        &store,
    )
    .await
    .unwrap();
    view.set(urls::NAME.into(), Value::String("view".into()), &store)
        .await
        .unwrap();
    view.save(&store).await.unwrap();

    // Simulate a store written before the log existed: drop every entry.
    store.kv.clear_tree(Tree::TableChanges).unwrap();

    let page = changes(&store, &t, None).await;
    let mut got = kinds(&page);
    got.sort();
    let mut want = vec![(a, ChangeKind::Created), (b.clone(), ChangeKind::Created)];
    want.sort();
    assert_eq!(got, want);

    // Backfill runs once; later reads only see real changes.
    rename(&store, &b, "b2").await;
    let next = changes(&store, &t, Some(&page.cursor)).await;
    assert_eq!(kinds(&next), vec![(b, ChangeKind::Updated)]);
}

#[tokio::test]
async fn replicated_and_sync_removed_rows_are_logged() {
    let store = store("change_log_replicated").await;
    let class = row_class(&store, "task").await;
    let t = table(&store, &class).await;
    let c0 = changes(&store, &t, None).await.cursor;

    // A row arriving from a peer, not through `apply_commit`.
    let subject = format!("{}/remote-row", "https://localhost");
    let mut remote = Resource::new(subject.clone());
    remote
        .set_unsafe(
            urls::IS_A.into(),
            Value::ResourceArray(vec![class.clone().into()]),
        )
        .unwrap();
    remote
        .set_unsafe(urls::PARENT.into(), Value::AtomicUrl(t.clone().into()))
        .unwrap();
    remote
        .set_unsafe(urls::NAME.into(), Value::String("from a peer".into()))
        .unwrap();
    store.persist_replicated_resource(&remote).await.unwrap();

    let pure = store.canonical_id(&subject);
    let page = changes(&store, &t, Some(&c0)).await;
    assert_eq!(kinds(&page), vec![(pure.clone(), ChangeKind::Created)]);
    assert!(page.changes[0].version.is_some());

    // A sync-applied removal (no commit on this node).
    store
        .remove_resource(&Subject::from(pure.as_str()))
        .await
        .unwrap();
    let page = changes(&store, &t, Some(&page.cursor)).await;
    assert_eq!(kinds(&page), vec![(pure, ChangeKind::Deleted)]);
}

#[tokio::test]
async fn destroying_a_table_drops_its_log() {
    let store = store("change_log_drop_table").await;
    let class = row_class(&store, "task").await;
    let t = table(&store, &class).await;
    row(&store, &t, &class, "a").await;
    let _ = changes(&store, &t, None).await;
    destroy(&store, &t).await;
    let left = store
        .kv
        .scan_prefix(Tree::TableChanges, b"")
        .flatten()
        .filter(|(k, _)| {
            let k = String::from_utf8_lossy(k);
            k.contains(t.as_str())
        })
        .count();
    assert_eq!(left, 0, "nothing of the destroyed table's log remains");
}

#[tokio::test]
async fn readers_without_rights_learn_nothing() {
    let store = store("change_log_rights").await;
    let class = row_class(&store, "task").await;
    let reader = store.create_agent(None).await.unwrap();
    let stranger = store.create_agent(None).await.unwrap();

    // A table only `reader` may read.
    let t = table(&store, &class).await;
    let mut table_res = store
        .get_resource(&Subject::from(t.as_str()))
        .await
        .unwrap();
    table_res
        .set(
            urls::READ.into(),
            Value::ResourceArray(vec![reader.subject.clone().into()]),
            &store,
        )
        .await
        .unwrap();
    table_res.save(&store).await.unwrap();

    // One row explicitly shared with the stranger: still not the table.
    let shared = row(&store, &t, &class, "shared").await;
    let mut shared_res = store.get_resource(shared.get_subject()).await.unwrap();
    shared_res
        .set(
            urls::READ.into(),
            Value::ResourceArray(vec![stranger.subject.clone().into()]),
            &store,
        )
        .await
        .unwrap();
    shared_res.save(&store).await.unwrap();

    let as_stranger = table_changes(
        &store,
        &Subject::from(t.as_str()),
        None,
        None,
        &ForAgent::AgentSubject(stranger.subject.clone()),
    )
    .await
    .unwrap_err();
    assert!(
        matches!(as_stranger, ChangeListError::Atomic(_)),
        "refused: {as_stranger}"
    );
    assert!(
        !as_stranger
            .to_string()
            .contains(&shared.get_subject().pure_id()),
        "the refusal names no row"
    );

    let as_reader = table_changes(
        &store,
        &Subject::from(t.as_str()),
        None,
        None,
        &ForAgent::AgentSubject(reader.subject.clone()),
    )
    .await
    .unwrap();
    assert_eq!(as_reader.changes.len(), 1);
}

#[tokio::test]
async fn rows_hidden_from_the_reader_are_skipped_but_passed() {
    // Rights in Atomic are inherited from the parent, so today every row of
    // a readable table is readable. This drives the per-row filter directly
    // with a row whose resource is gone but whose live entry remains (as a
    // reader racing a removal would see): it is skipped, not an error, and
    // the cursor moves past it.
    let store = store("change_log_row_filter").await;
    let class = row_class(&store, "task").await;
    let t = table(&store, &class).await;
    let c0 = changes(&store, &t, None).await.cursor;
    let a = row(&store, &t, &class, "a").await.get_subject().pure_id();
    let b = row(&store, &t, &class, "b").await.get_subject().pure_id();
    // Remove `a`'s row without going through the log.
    let (key, _) = store.get_propvals_canonical(&a).unwrap();
    store.kv.remove(Tree::Resources, key.as_bytes()).unwrap();

    let page = changes(&store, &t, Some(&c0)).await;
    assert_eq!(kinds(&page), vec![(b, ChangeKind::Created)]);
    let again = changes(&store, &t, Some(&page.cursor)).await;
    assert!(again.changes.is_empty());
}

#[tokio::test]
async fn the_log_survives_a_restart() {
    let id = "change_log_restart";
    let db_path = std::path::PathBuf::from(format!(".temp/db/{id}"));
    let uploads = std::path::PathBuf::from(format!(".temp/db/{id}/uploads"));
    let (t, a, cursor) = {
        let store = store(id).await;
        let class = row_class(&store, "task").await;
        let t = table(&store, &class).await;
        let a = row(&store, &t, &class, "a").await.get_subject().pure_id();
        let cursor = changes(&store, &t, None).await.cursor;
        rename(&store, &a, "a2").await;
        store.flush().unwrap();
        (t, a, cursor)
    };

    let store = Db::init_redb_file(&db_path, Some("https://localhost".into()), &uploads)
        .await
        .unwrap();
    let page = changes(&store, &t, Some(&cursor)).await;
    assert_eq!(kinds(&page), vec![(a, ChangeKind::Updated)]);
}
