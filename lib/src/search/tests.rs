use std::collections::HashMap;

use crate::{client::search::SearchOpts, urls, Db, Resource, Storelike, Value};
use ntest::timeout;

use super::{index_resource, query, unindex_subject};

async fn setup_store(label: &str) -> (Db, String) {
    let store = Db::init_temp(&format!("fts_{label}_{}", crate::utils::random_string(6)))
        .await
        .unwrap();
    let (_agent, drive) = store.setup("Searcher").await.unwrap();
    (store, drive)
}

async fn note(store: &Db, parent: &str, name: &str) -> String {
    store
        .create_resource(urls::FOLDER, parent, name, None)
        .await
        .unwrap()
}

async fn note_with(store: &Db, parent: &str, name: &str, extra: Vec<(&str, Value)>) -> String {
    store
        .create_resource(urls::FOLDER, parent, name, Some(extra))
        .await
        .unwrap()
}

fn subjects(hits: &[super::SearchHit]) -> Vec<String> {
    hits.iter().map(|h| h.subject.to_string()).collect()
}

fn opts_parents(parent: &str) -> SearchOpts {
    SearchOpts {
        parents: Some(vec![parent.to_string()]),
        limit: Some(30),
        ..Default::default()
    }
}

#[tokio::test]
#[timeout(120000)]
async fn exact_title_match() {
    let (store, drive) = setup_store("exact").await;
    let id = note(&store, &drive, "AvocadoToastUnique").await;
    let hits = query(&store, "AvocadoToastUnique", &opts_parents(&drive)).unwrap();
    assert_eq!(subjects(&hits), vec![id]);
}

#[tokio::test]
#[timeout(120000)]
async fn prefix_typeahead() {
    let (store, drive) = setup_store("prefix").await;
    let id = note(&store, &drive, "AvocadoToastUnique").await;
    let hits = query(&store, "avo", &opts_parents(&drive)).unwrap();
    assert!(
        subjects(&hits).contains(&id),
        "prefix 'avo' should find AvocadoToastUnique, got {:?}",
        subjects(&hits)
    );
}

#[tokio::test]
#[timeout(120000)]
async fn one_edit_typo_finds_title() {
    let (store, drive) = setup_store("typo").await;
    let id = note(&store, &drive, "avocado").await;
    let hits = query(&store, "avacado", &opts_parents(&drive)).unwrap();
    assert!(
        subjects(&hits).contains(&id),
        "typo 'avacado' should find avocado, got {:?}",
        subjects(&hits)
    );
}

#[tokio::test]
#[timeout(120000)]
async fn title_ranks_above_description() {
    let (store, drive) = setup_store("rank").await;
    let in_title = note(&store, &drive, "xylophone").await;
    let in_desc = note_with(
        &store,
        &drive,
        "other-note",
        vec![(
            urls::DESCRIPTION,
            Value::Markdown("mentions xylophone in the body copy".into()),
        )],
    )
    .await;
    let hits = query(&store, "xylophone", &opts_parents(&drive)).unwrap();
    let ids = subjects(&hits);
    let title_pos = ids.iter().position(|s| s == &in_title);
    let desc_pos = ids.iter().position(|s| s == &in_desc);
    assert!(title_pos.is_some(), "title hit missing: {ids:?}");
    assert!(desc_pos.is_some(), "description hit missing: {ids:?}");
    assert!(
        title_pos.unwrap() < desc_pos.unwrap(),
        "title should rank above description: {ids:?}"
    );
}

#[tokio::test]
#[timeout(120000)]
async fn parent_scope_excludes_siblings() {
    let (store, drive) = setup_store("scope").await;
    let folder_a = note(&store, &drive, "FolderA").await;
    let folder_b = note(&store, &drive, "FolderB").await;
    let child_a = note(&store, &folder_a, "SharedNameXyz").await;
    let child_b = note(&store, &folder_b, "SharedNameXyz").await;

    let hits_a = query(&store, "SharedNameXyz", &opts_parents(&folder_a)).unwrap();
    let ids_a = subjects(&hits_a);
    assert!(
        ids_a.contains(&child_a),
        "folder A child missing: {ids_a:?}"
    );
    assert!(
        !ids_a.contains(&child_b),
        "folder B child leaked into folder A search: {ids_a:?}"
    );

    let hits_drive = query(&store, "SharedNameXyz", &opts_parents(&drive)).unwrap();
    let ids_drive = subjects(&hits_drive);
    assert!(ids_drive.contains(&child_a));
    assert!(ids_drive.contains(&child_b));
}

#[tokio::test]
#[timeout(120000)]
async fn indexes_loro_document_body() {
    let (store, drive) = setup_store("body").await;
    let doc = crate::loro::AtomicLoroDoc::new();
    doc.doc()
        .get_text("documentContent")
        .insert(0, "xylophonebodytoken")
        .unwrap();
    doc.doc().commit();
    let snapshot = doc.export_snapshot();
    let reimported = crate::loro::AtomicLoroDoc::from_snapshot(&snapshot).unwrap();
    let extracted = reimported.extract_document_plain_text();
    assert_eq!(
        extracted, "xylophonebodytoken",
        "snapshot should round-trip documentContent, got {extracted:?}"
    );

    let mut resource = Resource::new("did:ad:fts-body-doc".into());
    resource
        .set_unsafe(urls::NAME.into(), Value::String("PlainTitle".into()))
        .unwrap();
    resource
        .set_unsafe(urls::PARENT.into(), Value::AtomicUrl(drive.clone().into()))
        .unwrap();
    resource
        .set_unsafe(
            urls::DRIVE_PROP.into(),
            Value::AtomicUrl(drive.clone().into()),
        )
        .unwrap();
    resource.insert_propval_raw(urls::LORO_UPDATE.into(), Value::LoroDoc(snapshot));
    let mut tx = crate::db::trees::Transaction::new();
    index_resource(&store, &resource, &mut tx).unwrap();
    store.apply_transaction(&mut tx).unwrap();

    let hits = query(&store, "xylophonebodytoken", &opts_parents(&drive)).unwrap();
    assert!(
        subjects(&hits).iter().any(|s| s.contains("fts-body-doc")),
        "body text should be searchable, got {:?}",
        subjects(&hits)
    );
}

#[tokio::test]
#[timeout(120000)]
async fn skips_commit_subjects() {
    let (store, drive) = setup_store("commit").await;
    let _id = note(&store, &drive, "CommitSkipUnique").await;
    let hits = query(&store, "CommitSkipUnique", &opts_parents(&drive)).unwrap();
    for hit in &hits {
        assert!(
            !hit.subject.is_commit_did(),
            "commit subject leaked into search: {}",
            hit.subject
        );
        assert!(
            !hit.subject.as_str().contains("/commits/"),
            "commit URL leaked into search: {}",
            hit.subject
        );
    }
    assert!(!hits.is_empty());
}

#[tokio::test]
#[timeout(120000)]
async fn update_replaces_old_title() {
    let (store, drive) = setup_store("update").await;
    let id = note(&store, &drive, "OldTitleUnique").await;
    let mut resource = store.get_resource(&id.as_str().into()).await.unwrap();
    resource
        .set_string(urls::NAME.into(), "NewTitleUnique", &store)
        .await
        .unwrap();
    resource.save_locally(&store).await.unwrap();

    let old = query(&store, "OldTitleUnique", &opts_parents(&drive)).unwrap();
    assert!(
        !subjects(&old).contains(&id),
        "old title should disappear after rename"
    );
    let new = query(&store, "NewTitleUnique", &opts_parents(&drive)).unwrap();
    assert!(subjects(&new).contains(&id), "new title should be indexed");
}

#[tokio::test]
#[timeout(120000)]
async fn delete_removes_from_index() {
    let (store, drive) = setup_store("delete").await;
    let id = note(&store, &drive, "DeleteMeUnique").await;
    assert!(!query(&store, "DeleteMeUnique", &opts_parents(&drive))
        .unwrap()
        .is_empty());
    store.remove_resource(&id.as_str().into()).await.unwrap();
    let hits = query(&store, "DeleteMeUnique", &opts_parents(&drive)).unwrap();
    assert!(
        !subjects(&hits).contains(&id),
        "deleted resource still searchable: {:?}",
        subjects(&hits)
    );
}

#[tokio::test]
#[timeout(120000)]
async fn unindex_is_idempotent() {
    let (store, drive) = setup_store("unindex").await;
    let id = note(&store, &drive, "IdempotentUnique").await;
    let mut tx = crate::db::trees::Transaction::new();
    unindex_subject(&store, &id, &mut tx).unwrap();
    store.apply_transaction(&mut tx).unwrap();
    let mut tx = crate::db::trees::Transaction::new();
    unindex_subject(&store, &id, &mut tx).unwrap();
    store.apply_transaction(&mut tx).unwrap();
    let hits = query(&store, "IdempotentUnique", &opts_parents(&drive)).unwrap();
    assert!(!subjects(&hits).contains(&id));
}

#[tokio::test]
#[timeout(120000)]
async fn empty_query_returns_nothing() {
    let (store, drive) = setup_store("empty").await;
    let _ = note(&store, &drive, "Something").await;
    let hits = query(&store, "   ", &opts_parents(&drive)).unwrap();
    assert!(hits.is_empty());
}

fn opts_filter(parent: &str, prop: &str, val: &str) -> SearchOpts {
    let mut filters = HashMap::new();
    filters.insert(prop.to_string(), val.to_string());
    SearchOpts {
        parents: Some(vec![parent.to_string()]),
        filters: Some(filters),
        limit: Some(30),
        ..Default::default()
    }
}

async fn add_classed(store: &Db, parent: &str, subject: &str, class: &str, name: &str) -> String {
    let mut resource = Resource::new(subject.into());
    resource
        .set_unsafe(urls::IS_A.into(), Value::ResourceArray(vec![class.into()]))
        .unwrap();
    resource
        .set_unsafe(urls::NAME.into(), Value::String(name.into()))
        .unwrap();
    resource
        .set_unsafe(urls::PARENT.into(), Value::AtomicUrl(parent.into()))
        .unwrap();
    resource
        .set_unsafe(urls::DRIVE_PROP.into(), Value::AtomicUrl(parent.into()))
        .unwrap();
    if class == urls::FILE {
        resource
            .set_unsafe(
                urls::DOWNLOAD_URL.into(),
                Value::AtomicUrl("https://example.com/fts-file".into()),
            )
            .unwrap();
    }
    store.add_resource(&resource).await.unwrap();
    subject.to_string()
}

#[tokio::test]
#[timeout(120000)]
async fn empty_query_with_isa_filter() {
    let (store, drive) = setup_store("empty_isa").await;
    let folder = note(&store, &drive, "FilterOnlyFolder").await;
    let hits = query(&store, "", &opts_filter(&drive, urls::IS_A, urls::FOLDER)).unwrap();
    assert!(
        subjects(&hits).contains(&folder),
        "empty q + isA:Folder should find the folder, got {:?}",
        subjects(&hits)
    );
}

#[tokio::test]
#[timeout(120000)]
async fn text_and_isa_filter() {
    let (store, drive) = setup_store("text_isa").await;
    let folder = note(&store, &drive, "avocado").await;
    let file = add_classed(
        &store,
        &drive,
        "did:ad:fts-avocado-file",
        urls::FILE,
        "avocado",
    )
    .await;
    let files = query(
        &store,
        "avocado",
        &opts_filter(&drive, urls::IS_A, urls::FILE),
    )
    .unwrap();
    let ids = subjects(&files);
    assert!(ids.contains(&file), "isA:File missed the file: {ids:?}");
    assert!(
        !ids.contains(&folder),
        "isA:File leaked the folder: {ids:?}"
    );

    let folders = query(
        &store,
        "avocado",
        &opts_filter(&drive, urls::IS_A, urls::FOLDER),
    )
    .unwrap();
    let folder_ids = subjects(&folders);
    assert!(
        folder_ids.contains(&folder),
        "isA:Folder missed the folder: {folder_ids:?}"
    );
    assert!(
        !folder_ids.contains(&file),
        "isA:Folder leaked the file: {folder_ids:?}"
    );
}

#[tokio::test]
#[timeout(120000)]
async fn filter_respects_parent_scope() {
    let (store, drive) = setup_store("filter_scope").await;
    let folder_a = note(&store, &drive, "FolderA").await;
    let folder_b = note(&store, &drive, "FolderB").await;
    let child_a = add_classed(
        &store,
        &folder_a,
        "did:ad:fts-file-a",
        urls::FILE,
        "ScopedFileA",
    )
    .await;
    let child_b = add_classed(
        &store,
        &folder_b,
        "did:ad:fts-file-b",
        urls::FILE,
        "ScopedFileB",
    )
    .await;

    let hits = query(&store, "", &opts_filter(&folder_a, urls::IS_A, urls::FILE)).unwrap();
    let ids = subjects(&hits);
    assert!(ids.contains(&child_a), "folder A file missing: {ids:?}");
    assert!(
        !ids.contains(&child_b),
        "folder B file leaked into folder A: {ids:?}"
    );
}

#[test]
fn parse_search_filters_exact_pairs() {
    let isa = r#"https://atomicdata.dev/properties/isA:"https://atomicdata.dev/classes/File""#;
    let pairs = super::parse_search_filters(isa);
    assert_eq!(
        pairs,
        vec![(
            "https://atomicdata.dev/properties/isA".into(),
            "https://atomicdata.dev/classes/File".into()
        )]
    );

    let anded = r#"age:"10" AND name:"John""#;
    let mut parsed = super::parse_search_filters(anded);
    parsed.sort();
    assert_eq!(
        parsed,
        vec![("age".into(), "10".into()), ("name".into(), "John".into())]
    );
}

/// Direct index of a resource that never went through apply_commit, so the
/// test does not depend on FOLDER class validation.
#[tokio::test]
#[timeout(120000)]
async fn index_resource_roundtrip() {
    let (store, drive) = setup_store("roundtrip").await;
    let mut resource = Resource::new("did:ad:fts-roundtrip".into());
    resource
        .set_unsafe(urls::NAME.into(), Value::String("RoundtripName".into()))
        .unwrap();
    resource
        .set_unsafe(urls::PARENT.into(), Value::AtomicUrl(drive.clone().into()))
        .unwrap();
    resource
        .set_unsafe(
            urls::DRIVE_PROP.into(),
            Value::AtomicUrl(drive.clone().into()),
        )
        .unwrap();
    let mut tx = crate::db::trees::Transaction::new();
    index_resource(&store, &resource, &mut tx).unwrap();
    store.apply_transaction(&mut tx).unwrap();
    let hits = query(&store, "RoundtripName", &opts_parents(&drive)).unwrap();
    assert_eq!(subjects(&hits), vec!["did:ad:fts-roundtrip".to_string()]);
}
