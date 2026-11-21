//! Each resource's version vector, stored next to its Loro snapshot.
//!
//! A drive reconcile needs the version vector of every resource in the drive,
//! and the only place it lived was the header of the snapshot, so reading it
//! meant loading every whole snapshot (megabytes for a canvas). [`Tree::VersionVectors`]
//! keeps just the vector, under the same key as the snapshot. The row is
//! written and removed by [`super::compressed_kv::CompressedKv`] in the same
//! batch as every `Tree::LoroSnapshots` write, so it cannot disagree with it.
//! A store from before this tree has no rows: [`read`] derives a missing one
//! from the snapshot and keeps it.

use std::collections::HashMap;

use super::{kv_store::KvStore, trees::Tree};
use crate::loro::AtomicLoroDoc;

/// 8 bytes of peer id, 4 of counter, both little endian, per entry.
const ENTRY: usize = 12;

/// The row for `snapshot`, or `None` when it has no readable header.
pub(super) fn encode_for_snapshot(snapshot: &[u8]) -> Option<Vec<u8>> {
    let vv = AtomicLoroDoc::vv_map_from_snapshot(snapshot).ok()?;
    let mut out = Vec::with_capacity(vv.len() * ENTRY);
    for (peer, counter) in vv {
        out.extend_from_slice(&peer.parse::<u64>().ok()?.to_le_bytes());
        out.extend_from_slice(&counter.to_le_bytes());
    }
    Some(out)
}

fn decode(row: &[u8]) -> Option<HashMap<String, i32>> {
    let (entries, rest) = row.as_chunks::<ENTRY>();
    if !rest.is_empty() {
        return None;
    }
    Some(
        entries
            .iter()
            .map(|e| {
                let peer = u64::from_le_bytes(e[..8].try_into().expect("8 bytes"));
                let counter = i32::from_le_bytes(e[8..].try_into().expect("4 bytes"));
                (peer.to_string(), counter)
            })
            .collect(),
    )
}

/// The version vector of the snapshot stored under `key` (a `pure_id`), or
/// `None` when there is no snapshot or it cannot be read.
pub fn read(kv: &dyn KvStore, key: &[u8]) -> Option<HashMap<String, i32>> {
    if let Some(vv) = kv
        .get(Tree::VersionVectors, key)
        .ok()
        .flatten()
        .and_then(|row| decode(&row))
    {
        return Some(vv);
    }
    // No row yet (a store from before this tree). Write one from the
    // snapshot, then read the snapshot again: a write that landed in between
    // wrote its own row, which ours may have overwritten, so go round again.
    let mut snapshot = kv.get(Tree::LoroSnapshots, key).ok()??;
    for _ in 0..3 {
        let row = encode_for_snapshot(&snapshot)?;
        let _ = kv.insert(Tree::VersionVectors, key, &row);
        match kv.get(Tree::LoroSnapshots, key) {
            Ok(Some(again)) if again == snapshot => return decode(&row),
            Ok(Some(again)) => snapshot = again,
            _ => break,
        }
    }
    // Still moving, or destroyed meanwhile: keep no row, the next read retries.
    let _ = kv.remove(Tree::VersionVectors, key);
    AtomicLoroDoc::vv_map_from_snapshot(&kv.get(Tree::LoroSnapshots, key).ok()??).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{agents::ForAgent, urls, Db, Storelike, Value};

    /// Every snapshot's vector, read from the snapshot header: the ground truth.
    fn from_snapshots(db: &Db) -> HashMap<String, HashMap<String, i32>> {
        db.kv
            .iter_tree(Tree::LoroSnapshots)
            .map(|row| {
                let (key, snapshot) = row.unwrap();
                (
                    String::from_utf8(key).unwrap(),
                    AtomicLoroDoc::vv_map_from_snapshot(&snapshot).unwrap(),
                )
            })
            .collect()
    }

    fn from_rows(db: &Db) -> HashMap<String, HashMap<String, i32>> {
        db.kv
            .iter_tree(Tree::VersionVectors)
            .map(|row| {
                let (key, row) = row.unwrap();
                (String::from_utf8(key).unwrap(), decode(&row).unwrap())
            })
            .collect()
    }

    async fn edit(db: &Db, subject: &str, text: &str) {
        let mut r = db.get_resource(&subject.into()).await.unwrap();
        r.set(urls::DESCRIPTION.into(), Value::Markdown(text.into()), db)
            .await
            .unwrap();
        r.save_locally(db).await.unwrap();
    }

    async fn child(db: &Db, parent: &str, name: &str) -> String {
        let props = vec![
            (urls::DESCRIPTION, Value::Markdown("x".into())),
            (urls::SHORTNAME, Value::Slug(name.into())),
        ];
        db.create_resource(urls::CLASS, parent, name, Some(props))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn rows_follow_every_kind_of_snapshot_write() {
        let a = Db::init_temp("vv_rows_a").await.unwrap();
        let (agent, drive) = a.setup("Alice").await.unwrap();
        let kept = child(&a, &drive, "kept").await;
        let doomed = child(&a, &drive, "doomed").await;
        edit(&a, &kept, "changed").await;
        assert_eq!(from_rows(&a), from_snapshots(&a), "create and commit edit");

        // A second store imports the drive with SYNC_PUSH.
        let b = Db::init_temp("vv_rows_b").await.unwrap();
        b.set_default_agent(
            crate::agents::Agent::from_secret(&agent.build_secret().unwrap()).unwrap(),
        );
        let owner = ForAgent::AgentSubject(agent.subject.clone());
        let frames =
            crate::sync::engine::handle_sync_vv(&drive, "", &[], &HashMap::new(), &a, &owner).await;
        for frame in &frames {
            if frame[0] == crate::sync::protocol::tag::SYNC_PUSH {
                let push = crate::sync::protocol::decode_sync_push(&frame[1..]).unwrap();
                crate::sync::engine::import_sync_push(&push, &b, &ForAgent::Sudo, false)
                    .await
                    .unwrap();
            }
        }
        assert!(!from_snapshots(&b).is_empty());
        assert_eq!(from_rows(&b), from_snapshots(&b), "SYNC_PUSH import");

        let doomed_subject = crate::Subject::from_raw(&doomed, a.get_base_domain().as_deref());
        let key = doomed_subject.pure_id();
        assert!(a
            .kv
            .get(Tree::VersionVectors, key.as_bytes())
            .unwrap()
            .is_some());
        a.remove_resource(&doomed_subject).await.unwrap();
        assert!(a
            .kv
            .get(Tree::VersionVectors, key.as_bytes())
            .unwrap()
            .is_none());
        assert_eq!(from_rows(&a), from_snapshots(&a), "destroy");
    }

    #[tokio::test]
    async fn a_store_without_rows_fills_them_on_read() {
        let db = Db::init_temp("vv_lazy").await.unwrap();
        let (_a, drive) = db.setup("Alice").await.unwrap();
        child(&db, &drive, "one").await;
        let expected = from_snapshots(&db);
        assert!(expected.len() > 1);
        // An old store: snapshots, no rows.
        db.kv.clear_tree(Tree::VersionVectors).unwrap();
        assert!(from_rows(&db).is_empty());

        let drive_subject = crate::Subject::from_raw(&drive, db.get_base_domain().as_deref());
        let subjects = crate::sync::engine::collect_drive_subjects(&db, &drive_subject).await;
        let read = crate::sync::engine::build_drive_vvs(&db, &subjects);
        for (subject, vv) in &read {
            assert_eq!(Some(vv), expected.get(subject));
        }
        assert_eq!(read.len(), subjects.len());
        assert_eq!(from_rows(&db), read, "the rows were filled");
    }
}
