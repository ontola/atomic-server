//! Purge: a signed `destroy` + `purge` commit erases a resource and every
//! trace of it (issue #2155, `planning/purge.md`).
//!
//! The headline test creates a resource with a value, edits it, attaches
//! files, purges it, and then looks for the old values and the file bytes in
//! three places: every tree of the live store (decoded, so compression
//! cannot hide anything), the raw bytes of the redb file, and the raw bytes
//! of the redb file after the scrub the next start performs.
//!
//! Run: cargo test -p atomic_lib --features db-redb --test purge
#![cfg(feature = "db-redb")]

use atomic_lib::{
    agents::Agent,
    commit::CommitBuilder,
    db::trees::Tree,
    sync::engine::{ingest_commit_json, CommitIngestOpts},
    urls, Db, Resource, Storelike, Value,
};
use std::path::{Path, PathBuf};

const ORIGINAL: &str = "ZQXVALUEORIGINAL7731";
const EDITED: &str = "ZQXVALUEEDITED8842";
const NAME: &str = "ZQXNAMEPERSON9953";
const FILENAME: &str = "ZQXFILENAME4417.txt";
const BLOB_ONLY: &[u8] = b"ZQX-BLOB-BYTES-ONLY-THE-PURGED-FILE-HAS-THESE-1234567890";
const BLOB_SHARED: &[u8] = b"ZQX-SHARED-BLOB-BYTES-A-SURVIVING-FILE-HAS-THESE-0987654321";
const CONTROL: &str = "ZQXCONTROLKEEP5521";

/// Everything the purge must remove, in the spellings a scan can see.
fn erased_needles() -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    for s in [ORIGINAL, EDITED, NAME, FILENAME] {
        out.push(s.as_bytes().to_vec());
        out.push(s.to_ascii_lowercase().into_bytes());
    }
    out.push(BLOB_ONLY.to_vec());
    out
}

/// A scratch directory removed again when the test ends, passing or not.
struct Scratch(PathBuf);

impl std::ops::Deref for Scratch {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn scratch_dir(name: &str) -> Scratch {
    let dir = std::env::temp_dir().join(format!("atomic-purge-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    Scratch(dir)
}

async fn open(dir: &Path) -> Db {
    Db::init_redb_file(dir, Some("https://localhost".into()), &dir.join("uploads"))
        .await
        .expect("open store")
}

fn occurrences(haystack: &[u8], needle: &[u8]) -> usize {
    haystack
        .windows(needle.len())
        .filter(|w| *w == needle)
        .count()
}

/// How often each needle occurs in the raw redb file.
fn raw_scan(dir: &Path, needles: &[Vec<u8>]) -> Vec<(String, usize)> {
    let bytes = std::fs::read(dir.join("atomic.redb")).unwrap();
    needles
        .iter()
        .map(|n| {
            (
                String::from_utf8_lossy(n).into_owned(),
                occurrences(&bytes, n),
            )
        })
        .filter(|(_, count)| *count > 0)
        .collect()
}

/// Where each needle occurs among the live rows (keys and values, decoded),
/// as `tree: needle`.
fn logical_scan(db: &Db, needles: &[Vec<u8>]) -> Vec<String> {
    let mut hits = Vec::new();
    for tree in Tree::ALL {
        for entry in db.kv.iter_tree(tree) {
            let (key, value) = entry.unwrap();
            for needle in needles {
                if occurrences(&key, needle) > 0 || occurrences(&value, needle) > 0 {
                    hits.push(format!("{tree:?}: {}", String::from_utf8_lossy(needle)));
                }
            }
        }
    }
    hits.sort();
    hits.dedup();
    hits
}

async fn file_resource(db: &Db, parent: &str, bytes: &[u8], filename: &str) -> String {
    let hash = blake3::hash(bytes);
    let hash_hex = hash.to_hex().to_string();
    db.put_blob(hash.as_bytes(), bytes).await.unwrap();
    let id = db
        .create_resource(
            urls::FILE,
            parent,
            filename,
            Some(vec![
                (urls::INTERNAL_ID, Value::String(hash_hex.clone())),
                (
                    urls::BLOB,
                    Value::AtomicUrl(atomic_lib::identifiers::blob_subject(&hash_hex).into()),
                ),
                (urls::FILENAME, Value::String(filename.into())),
                (urls::FILESIZE, Value::Integer(bytes.len() as i64)),
            ]),
        )
        .await
        .unwrap();
    id
}

async fn edit(db: &Db, subject: &str, property: &str, value: &str) {
    let mut resource = db.get_resource(&subject.into()).await.unwrap();
    resource
        .set(property.into(), Value::Markdown(value.into()), db)
        .await
        .unwrap();
    resource.save_locally(db).await.unwrap();
}

/// The signed purge of `subject` by `agent`, as the JSON a client posts.
async fn signed_purge_json(db: &Db, agent: &Agent, subject: &str) -> String {
    let resource = db.get_resource(&subject.into()).await.unwrap();
    let mut builder = CommitBuilder::new(subject.into());
    builder.purge(true);
    let commit = builder.sign(agent, db, &resource).await.unwrap();
    commit
        .into_resource(db)
        .await
        .unwrap()
        .to_json_ad(None)
        .unwrap()
}

#[tokio::test]
async fn purge_erases_values_history_commits_envelopes_and_unshared_blobs() {
    let dir = scratch_dir("full");
    let db = open(&dir).await;
    // `all` keeps every signed envelope, values included: the hardest case.
    db.set_envelope_retention(atomic_lib::envelopes::EnvelopeRetention::All);
    let (agent, drive) = db.setup("Owner").await.unwrap();

    // The resource to purge: a value, then an edit, so the old value lives on
    // in the Loro oplog, the genesis commit row and (retention `all`) in the
    // envelopes. It has children: a file only it uses, and a file whose bytes
    // another resource keeps.
    let person = db
        .create_resource(
            urls::CLASS,
            &drive,
            NAME,
            Some(vec![
                (urls::DESCRIPTION, Value::Markdown(ORIGINAL.into())),
                (urls::SHORTNAME, Value::Slug("person".into())),
            ]),
        )
        .await
        .unwrap();
    edit(&db, &person, urls::DESCRIPTION, EDITED).await;
    let only = file_resource(&db, &person, BLOB_ONLY, FILENAME).await;
    let shared_child = file_resource(&db, &person, BLOB_SHARED, "child-of-person.txt").await;

    // Survivors: a control resource and a second file with the shared bytes.
    let control = db
        .create_resource(
            urls::CLASS,
            &drive,
            "control",
            Some(vec![
                (urls::DESCRIPTION, Value::Markdown(CONTROL.into())),
                (urls::SHORTNAME, Value::Slug("control".into())),
            ]),
        )
        .await
        .unwrap();
    let survivor = file_resource(&db, &control, BLOB_SHARED, "survivor.txt").await;
    db.kv.flush().unwrap();

    // The scans can see what they are looking for before the purge. The blob
    // is stored plain; values also sit plain in index keys.
    let needles = erased_needles();
    let before_logical = logical_scan(&db, &needles);
    for expected in [ORIGINAL, EDITED, NAME, FILENAME] {
        assert!(
            before_logical.iter().any(|h| h.ends_with(expected)),
            "{expected} should be findable before the purge: {before_logical:?}"
        );
    }
    assert!(
        !raw_scan(&dir, &needles).is_empty(),
        "raw scan sees plain rows"
    );
    assert!(db
        .get_blob(blake3::hash(BLOB_ONLY).as_bytes())
        .await
        .unwrap()
        .is_some());

    // An agent with write access on the resource, but who does not own the
    // drive, cannot purge it.
    let other = db.create_agent(Some("Collaborator")).await.unwrap();
    {
        let mut r = db.get_resource(&person.as_str().into()).await.unwrap();
        r.set(
            urls::WRITE.into(),
            Value::ResourceArray(vec![other.subject.to_string().into()]),
            &db,
        )
        .await
        .unwrap();
        r.save_locally(&db).await.unwrap();
    }
    let refused = ingest_commit_json(
        &db,
        &signed_purge_json(&db, &other, &person).await,
        &CommitIngestOpts::peer(),
    )
    .await
    .expect_err("a collaborator is not the drive owner");
    assert!(refused.to_string().contains("owner"), "{refused}");
    assert!(db.get_resource(&person.as_str().into()).await.is_ok());

    // The owner can.
    let purge_json = signed_purge_json(&db, &agent, &person).await;
    ingest_commit_json(&db, &purge_json, &CommitIngestOpts::peer())
        .await
        .expect("the drive owner purges");
    db.kv.flush().unwrap();

    // Gone: the resource, its children, their snapshots.
    for subject in [&person, &only, &shared_child] {
        assert!(db.get_resource(&subject.as_str().into()).await.is_err());
        assert!(db.get_loro_snapshot_bytes(subject).is_none());
        assert!(atomic_lib::sync::tombstones::is_tombstoned(&db, subject));
    }
    // Kept: the unrelated resources and the bytes a survivor still uses.
    let control_res: Resource = db.get_resource(&control.as_str().into()).await.unwrap();
    assert_eq!(
        control_res.get(urls::DESCRIPTION).unwrap().to_string(),
        CONTROL
    );
    assert!(db.get_resource(&survivor.as_str().into()).await.is_ok());
    assert!(
        db.get_blob(blake3::hash(BLOB_SHARED).as_bytes())
            .await
            .unwrap()
            .is_some(),
        "a blob another resource references must survive"
    );
    assert!(
        db.get_blob(blake3::hash(BLOB_ONLY).as_bytes())
            .await
            .unwrap()
            .is_none(),
        "the purged file's bytes are gone"
    );

    // The tombstone: one signed destroy envelope, no values.
    let envelopes = atomic_lib::envelopes::envelopes(&db, &person);
    assert_eq!(envelopes.len(), 1, "only the purge envelope is kept");
    assert!(envelopes[0].is_destroy());
    let tombstone = atomic_lib::sync::tombstones::destroy_envelope(&db, &person)
        .expect("peers can be sent the signed tombstone");
    assert!(tombstone.contains(urls::PURGE));
    assert!(!tombstone.contains(urls::LORO_UPDATE));

    // No live row anywhere holds a value, a name or a file byte.
    let after_logical = logical_scan(&db, &needles);
    assert!(
        after_logical.is_empty(),
        "live rows still hold: {after_logical:?}"
    );
    // The envelope tree holds only the tombstone for the purged subjects.
    for (key, _) in db.kv.iter_tree(Tree::Envelopes).flatten() {
        let key = String::from_utf8_lossy(&key).into_owned();
        assert!(
            !key.contains(&only) && !key.contains(&shared_child),
            "children's envelopes are gone: {key}"
        );
    }

    // The purge asked for a compaction at the next start.
    assert!(
        atomic_lib::db::compaction::pending_after_purge(&dir),
        "purge must leave a scrub request for the next start"
    );

    // Raw file, right after the purge. redb does not zero freed pages, so
    // plain residue may sit in them until the file is compacted: report it.
    let residue_before_scrub = raw_scan(&dir, &needles);
    eprintln!("raw residue before scrub: {residue_before_scrub:?}");

    // Restart: the pending request rewrites the file before serving it.
    drop(db);
    let db = open(&dir).await;
    assert!(!atomic_lib::db::compaction::pending_after_purge(&dir));
    let residue = raw_scan(&dir, &needles);
    assert!(
        residue.is_empty(),
        "raw redb file still holds erased bytes after the scrub: {residue:?}"
    );
    assert!(logical_scan(&db, &needles).is_empty());
    // And the survivors came through the compaction.
    assert!(db.get_resource(&control.as_str().into()).await.is_ok());
    assert!(db
        .get_blob(blake3::hash(BLOB_SHARED).as_bytes())
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn replaying_the_purge_on_a_replica_that_holds_the_resource_erases_it_there() {
    // The owner's node purges; the commit JSON (what the live `COMMIT` frame
    // and `SYNC_DIFF.removeCommits` carry) is applied on a second node that
    // holds a copy, and that node erases its copy too.
    let dir_a = scratch_dir("replica-a");
    let a = open(&dir_a).await;
    let (agent, drive) = a.setup("Owner").await.unwrap();
    let doc = a
        .create_resource(
            urls::CLASS,
            &drive,
            NAME,
            Some(vec![
                (urls::DESCRIPTION, Value::Markdown(ORIGINAL.into())),
                (urls::SHORTNAME, Value::Slug("person".into())),
            ]),
        )
        .await
        .unwrap();
    edit(&a, &doc, urls::DESCRIPTION, EDITED).await;

    // The replica receives the owner's drive and the document by the same
    // path sync uses: the Loro snapshots plus the genesis commits.
    let dir_b = scratch_dir("replica-b");
    let b = open(&dir_b).await;
    b.set_default_agent(agent.clone());
    for subject in [&drive, &doc] {
        let snapshot = a.get_loro_snapshot_bytes(subject).unwrap();
        atomic_lib::sync::ws_apply::apply_state_update(&b, subject, &snapshot)
            .await
            .unwrap();
    }
    assert!(b.get_resource(&doc.as_str().into()).await.is_ok());

    let json = signed_purge_json(&a, &agent, &doc).await;
    ingest_commit_json(&a, &json, &CommitIngestOpts::peer())
        .await
        .unwrap();
    ingest_commit_json(&b, &json, &CommitIngestOpts::peer())
        .await
        .expect("the replica accepts the signed purge");

    assert!(b.get_resource(&doc.as_str().into()).await.is_err());
    assert!(b.get_loro_snapshot_bytes(&doc).is_none());
    assert!(atomic_lib::sync::tombstones::is_tombstoned(&b, &doc));
    let needles = erased_needles();
    assert!(logical_scan(&b, &needles).is_empty());
}

#[tokio::test]
async fn a_purge_commit_must_be_a_destroy_and_carry_no_values() {
    let dir = scratch_dir("shape");
    let db = open(&dir).await;
    let (agent, drive) = db.setup("Owner").await.unwrap();
    let doc = db
        .create_resource(urls::CLASS, &drive, "doc", None)
        .await
        .unwrap();
    let resource = db.get_resource(&doc.as_str().into()).await.unwrap();

    // `purge` without `destroy`: refused.
    let mut builder = CommitBuilder::new(doc.as_str().into());
    builder.purge(true);
    builder.destroy(false);
    let commit = builder.sign(&agent, &db, &resource).await.unwrap();
    let json = commit
        .into_resource(&db)
        .await
        .unwrap()
        .to_json_ad(None)
        .unwrap();
    let err = ingest_commit_json(&db, &json, &CommitIngestOpts::peer())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("destroy"), "{err}");
    assert!(db.get_resource(&doc.as_str().into()).await.is_ok());
}

#[tokio::test]
async fn resource_purge_api_enforces_the_drive_owner() {
    let dir = scratch_dir("api");
    let db = open(&dir).await;
    let (agent, drive) = db.setup("Owner").await.unwrap();
    let doc = db
        .create_resource(urls::CLASS, &drive, "doc", None)
        .await
        .unwrap();

    // Not an owner, not even a writer: refused, nothing erased.
    let stranger = db.create_agent(Some("Stranger")).await.unwrap();
    let mut resource = db.get_resource(&doc.as_str().into()).await.unwrap();
    assert!(resource.purge_as(&stranger, &db).await.is_err());
    assert!(db.get_resource(&doc.as_str().into()).await.is_ok());

    // The owner purges through the same API.
    let mut resource = db.get_resource(&doc.as_str().into()).await.unwrap();
    resource.purge_as(&agent, &db).await.unwrap();
    assert!(db.get_resource(&doc.as_str().into()).await.is_err());
    assert!(atomic_lib::db::compaction::pending_after_purge(&dir));
}
