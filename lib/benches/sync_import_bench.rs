//! Initial sync through the native engine, including sender reconcile, signed
//! envelope import, final durable flush and complete title/body search checks.
//! Excludes fixture preparation, DB startup, network/TLS and browser/OPFS.
//! Prepare ONCE with BENCH_PREPARE=1 BENCH_N=1000 BENCH_DIR=/tmp/sync-fixture;
//! then run each build with BENCH_DIR and a unique BENCH_RUN directory.
//! `cargo bench -p atomic_lib --bench sync_import_bench --features db-redb
//! --profile e2e` builds the standalone executable. Its stdout is one JSON row.

use std::{collections::HashSet, path::Path, time::Instant};

use atomic_lib::{
    agents::ForAgent,
    client::search::SearchOpts,
    db::trees::Tree,
    envelopes,
    loro::AtomicLoroDoc,
    search,
    sync::{engine, protocol},
    urls, Db, Storelike, Subject,
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Fixture {
    drive: String,
    agent: String,
    subjects: Vec<String>,
    body_subjects: HashSet<String>,
}

async fn open(dir: &Path) -> Db {
    std::fs::create_dir_all(dir).unwrap();
    Db::init_redb_file(&dir.join("store.redb"), None, &dir.join("uploads"))
        .await
        .unwrap()
}

fn search_check(store: &Db, fixture: &Fixture) {
    let opts = SearchOpts {
        parents: Some(vec![fixture.drive.clone()]),
        limit: Some(fixture.subjects.len() as u32 + 10),
        ..Default::default()
    };
    let titles: HashSet<_> = search::query(store, "syncfixturetitle", &opts)
        .unwrap()
        .into_iter()
        .map(|hit| hit.subject.pure_id())
        .collect();
    assert_eq!(titles, fixture.subjects.iter().cloned().collect());
    let bodies: HashSet<_> = search::query(store, "syncfixturebody", &opts)
        .unwrap()
        .into_iter()
        .map(|hit| hit.subject.pure_id())
        .collect();
    assert_eq!(bodies, fixture.body_subjects);
}

async fn verify(source: &Db, sink: &Db, subjects: &[String]) {
    for subject in subjects {
        let read_row = |db: &Db| {
            let bytes = db
                .kv
                .get(Tree::Resources, subject.as_bytes())
                .unwrap()
                .unwrap();
            let mut props: std::collections::HashMap<String, atomic_lib::Value> =
                rmp_serde::from_slice(&bytes).unwrap();
            // Derived from retained envelopes at read time, not CRDT state.
            props.remove(urls::LAST_COMMIT);
            serde_json::to_value(props).unwrap()
        };
        assert_eq!(read_row(source), read_row(sink), "projection: {subject}");
        let read_doc = |db: &Db| {
            let bytes = db
                .kv
                .get(Tree::LoroSnapshots, subject.as_bytes())
                .unwrap()
                .unwrap();
            AtomicLoroDoc::from_snapshot(&bytes).unwrap()
        };
        let before = read_doc(source);
        let after = read_doc(sink);
        assert_eq!(before.oplog_vv(), after.oplog_vv(), "VV: {subject}");
        assert_eq!(
            before.doc().get_deep_value(),
            after.doc().get_deep_value(),
            "state: {subject}"
        );
        assert_eq!(
            serde_json::to_value(before.get_history()).unwrap(),
            serde_json::to_value(after.get_history()).unwrap(),
            "history: {subject}"
        );
        let expected = envelopes::envelopes(source, subject);
        let actual = envelopes::envelopes(sink, subject);
        assert_eq!(expected, actual, "envelopes: {subject}");
    }
}

async fn run() {
    let dir = std::env::var("BENCH_DIR").expect("set BENCH_DIR");
    let dir = Path::new(&dir);
    if std::env::var_os("BENCH_PREPARE").is_some() {
        assert!(!dir.exists(), "use a new fixture directory");
        let n: usize = std::env::var("BENCH_N")
            .unwrap_or("1000".into())
            .parse()
            .unwrap();
        let source = open(dir).await;
        let (agent, drive) = source.setup("Sync benchmark").await.unwrap();
        let mut fixture = Fixture {
            drive,
            agent: agent.subject.to_string(),
            subjects: Vec::new(),
            body_subjects: HashSet::new(),
        };
        for i in 0..n {
            let subject = source
                .create_resource(
                    urls::FOLDER,
                    &fixture.drive,
                    &format!("syncfixturetitle {i}"),
                    None,
                )
                .await
                .unwrap();
            if i % 2 == 0 {
                let mut resource = source
                    .get_resource(&Subject::from(subject.clone()))
                    .await
                    .unwrap();
                let doc = resource.live_doc().unwrap();
                let pm = doc.doc().get_map("doc");
                pm.insert("nodeName", "doc").unwrap();
                let children = pm
                    .insert_container("children", loro::LoroList::new())
                    .unwrap();
                let paragraph = children.insert_container(0, loro::LoroMap::new()).unwrap();
                paragraph.insert("nodeName", "paragraph").unwrap();
                paragraph
                    .insert_container("children", loro::LoroList::new())
                    .unwrap()
                    .insert(
                        0,
                        format!("syncfixturebody {}", "document text ".repeat(80)),
                    )
                    .unwrap();
                resource.save_locally(&source).await.unwrap();
                fixture.body_subjects.insert(subject.clone());
            }
            fixture.subjects.push(subject);
        }
        search_check(&source, &fixture);
        source.flush().unwrap();
        std::fs::write(
            dir.join("fixture.json"),
            serde_json::to_vec(&fixture).unwrap(),
        )
        .unwrap();
        return;
    }
    let fixture: Fixture =
        serde_json::from_slice(&std::fs::read(dir.join("fixture.json")).unwrap()).unwrap();
    let run_dir = std::env::var("BENCH_RUN").expect("set a fresh BENCH_RUN");
    let run_dir = Path::new(&run_dir);
    assert!(!run_dir.exists(), "receiver must be fresh");
    let source = open(dir).await;
    let sink = open(run_dir).await;
    let agent = ForAgent::from(fixture.agent.clone());
    let start = Instant::now();
    let frames = engine::handle_sync_vv_reconcile(
        &fixture.drive,
        "",
        2,
        Default::default,
        None,
        &source,
        &agent,
        engine::WireScheme::CANONICAL,
        false,
    )
    .await;
    let reconcile_seconds = start.elapsed().as_secs_f64();
    let mut imported = 0;
    let mut envelope_count = 0;
    let mut chunks = 0;
    let mut subjects = Vec::new();
    let mut saw_last = false;
    for frame in &frames {
        if frame[0] != protocol::tag::SYNC_PUSH {
            continue;
        }
        let push = protocol::decode_sync_push(&frame[1..]).unwrap();
        envelope_count += push.envelopes.len();
        subjects.extend(push.entries.iter().map(|entry| entry.subject.clone()));
        let (count, blobs) = engine::import_sync_push(&push, &sink, &agent, false)
            .await
            .unwrap();
        assert!(blobs.is_empty());
        imported += count;
        chunks += 1;
        saw_last |= push.last;
    }
    assert!(saw_last);
    assert_eq!(imported, subjects.len());
    assert!(imported > fixture.subjects.len());
    assert!(envelope_count >= fixture.subjects.len());
    let durable_seconds = start.elapsed().as_secs_f64();
    while search::index_pending(&sink, 500).await.unwrap() != 0 {}
    search_check(&sink, &fixture);
    let searchable_seconds = start.elapsed().as_secs_f64();
    verify(&source, &sink, &subjects).await;
    drop(sink);
    let reopened = open(run_dir).await;
    search_check(&reopened, &fixture);
    verify(&source, &reopened, &subjects).await;
    println!(
        "{}",
        serde_json::json!({
            "resources": fixture.subjects.len(), "bodyResources": fixture.body_subjects.len(),
            "reconcileSeconds": reconcile_seconds, "durableSeconds": durable_seconds,
            "receiverSeconds": durable_seconds - reconcile_seconds,
            "searchableSeconds": searchable_seconds, "imported": imported,
            "envelopes": envelope_count, "chunks": chunks,
            "wireBytes": frames.iter().map(Vec::len).sum::<usize>(),
            "verifiedStateHistoryEnvelopesSearchAndReopen": true,
        })
    );
}

fn main() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(run());
}
