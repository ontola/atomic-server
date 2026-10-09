//! Proof of possession for blob access (issue #2157, `planning/blob-possession.md`):
//! a resource only counts as a referrer of a blob when its drive holds a claim,
//! stores from before claims existed are backfilled once, and purge drops the
//! claims together with the bytes.
//!
//! Run: cargo test -p atomic_lib --features db-redb --test blob_claims
#![cfg(feature = "db-redb")]

use atomic_lib::{agents::ForAgent, urls, Db, Storelike, Value};

async fn file_in(db: &Db, drive: &str, hash_hex: &str, shape: &str) -> String {
    let blob = Value::AtomicUrl(atomic_lib::identifiers::blob_subject(hash_hex).into());
    let props = match shape {
        "internalId" => vec![(urls::INTERNAL_ID, Value::String(hash_hex.into()))],
        "blob" => vec![(urls::BLOB, blob)],
        _ => vec![(
            urls::CHUNKS,
            Value::ResourceArray(vec![match blob {
                Value::AtomicUrl(s) => s.into(),
                _ => unreachable!(),
            }]),
        )],
    };
    db.create_resource(urls::FILE, drive, "f.txt", Some(props))
        .await
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn a_reference_counts_only_with_a_claim_for_its_drive() {
    let db = Db::init_temp("blob_claims_gate").await.unwrap();
    let (_alice, drive_a) = db.setup("Alice").await.unwrap();
    let (_mallory, drive_m) = db.setup("Mallory").await.unwrap();
    let bytes = b"alice's secret";
    let hash = blake3::hash(bytes);
    let hex = hash.to_hex().to_string();
    db.put_blob(hash.as_bytes(), bytes).await.unwrap();

    for shape in ["internalId", "blob", "chunks"] {
        file_in(&db, &drive_m, &hex, shape).await;
    }
    file_in(&db, &drive_a, &hex, "internalId").await;

    // Nobody proved anything yet.
    assert!(db
        .readable_blob_referrers(&hex, &ForAgent::Sudo)
        .await
        .unwrap()
        .is_empty());

    // Alice's drive supplies the bytes: only her File counts.
    db.claim_blob(&hex, &drive_a).unwrap();
    let found = db
        .readable_blob_referrers(&hex, &ForAgent::Sudo)
        .await
        .unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(db.claim_drive_of(&found[0]), db.claim_drive_id(&drive_a));
    assert!(!db.resource_holds_its_blobs(
        &db.get_resource(
            &file_in(&db, &drive_m, &hex, "internalId")
                .await
                .as_str()
                .into()
        )
        .await
        .unwrap()
    ));
    assert!(db.resource_holds_its_blobs(&found[0]));

    // All four referrers exist; the claim, not their number, decides.
    assert!(db.all_blob_referrers(&hex).await.unwrap().len() >= 4);
}

#[tokio::test]
async fn stores_from_before_claims_are_backfilled_once() {
    let db = Db::init_temp("blob_claims_backfill").await.unwrap();
    let (_alice, drive) = db.setup("Alice").await.unwrap();
    let bytes = b"old file";
    let hash = blake3::hash(bytes);
    let hex = hash.to_hex().to_string();
    db.put_blob(hash.as_bytes(), bytes).await.unwrap();
    let file = file_in(&db, &drive, &hex, "internalId").await;

    // Simulate an installation upgraded from before claims existed.
    let drive_id = db.claim_drive_id(&drive);
    assert!(!db.drive_holds_blob(&hex, &drive_id));
    db.kv
        .remove(
            atomic_lib::db::trees::Tree::PluginMeta,
            b"blob-claims-backfilled:v1",
        )
        .unwrap();

    assert!(db.backfill_blob_claims().unwrap() >= 1);
    assert!(db.drive_holds_blob(&hex, &drive_id));
    let file = db.get_resource(&file.as_str().into()).await.unwrap();
    assert!(db.resource_holds_its_blobs(&file));
    assert_eq!(
        db.readable_blob_referrers(&hex, &ForAgent::Sudo)
            .await
            .unwrap()
            .len(),
        1
    );
    // Marked done: a second run is a no-op.
    assert_eq!(db.backfill_blob_claims().unwrap(), 0);
}

#[tokio::test]
async fn purging_a_blob_drops_its_claims() {
    let db = Db::init_temp("blob_claims_purge").await.unwrap();
    let (_alice, drive) = db.setup("Alice").await.unwrap();
    let hash = blake3::hash(b"bytes");
    let hex = hash.to_hex().to_string();
    db.put_blob(hash.as_bytes(), b"bytes").await.unwrap();
    db.claim_blob(&hex, &drive).unwrap();
    // No referrer is left, so the purge deletes the bytes and the claim.
    let deleted = db
        .purge_unreferenced_blobs(std::slice::from_ref(&hex))
        .await
        .unwrap();
    assert_eq!(deleted, vec![hex.clone()]);
    assert!(!db.drive_holds_blob(&hex, &db.claim_drive_id(&drive)));
}
