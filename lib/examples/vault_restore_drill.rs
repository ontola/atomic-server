//! Standalone acceptance drill. Exit 1 means the backup is incomplete, even
//! when resource metadata restored correctly. Uses synthetic data and no peers.
//! Run: cargo run -p atomic_lib --features db-redb --example vault_restore_drill
use atomic_lib::{
    db::trees::Tree,
    errors::AtomicResult,
    urls,
    vault::{
        dek::DriveVaultKey,
        store::FilesystemVaultStore,
        sync::{export_vault_segment, import_vault_batch, CheckpointPolicy},
    },
    Db, Storelike, Subject, Value,
};
use std::collections::BTreeMap;

#[tokio::main(flavor = "current_thread")]
async fn main() -> AtomicResult<()> {
    let vault_dir =
        std::env::temp_dir().join(format!("atomic-vault-restore-drill-{}", ulid::Ulid::new()));
    std::fs::create_dir(&vault_dir)?;
    let vault = FilesystemVaultStore::new(&vault_dir);
    let key = DriveVaultKey::from_bytes([7; 32], 1);
    let bytes: Vec<u8> = (0..65537).map(|i| (i % 251) as u8).collect();
    let hash = blake3::hash(&bytes);
    let source = Db::init_temp("restore_drill_source").await?;
    let (agent, drive) = source.setup("Restore drill").await?;
    let recovery_secret = agent.build_secret()?;
    let doc = source
        .create_resource(urls::DOCUMENT_V2, &drive, "Document before backup", None)
        .await?;
    let table = source
        .create_resource(urls::TABLE, &drive, "Table before backup", None)
        .await?;
    let row = source
        .create_resource(
            "https://atomicdata.dev/classes/Folder",
            &table,
            "Row before backup",
            None,
        )
        .await?;
    source.kv.insert(Tree::Blobs, hash.as_bytes(), &bytes)?;
    let file = source
        .create_resource(
            urls::FILE,
            &doc,
            "Attachment before backup",
            Some(vec![
                (urls::FILENAME, Value::String("fixture.bin".into())),
                (
                    urls::BLOB,
                    Value::AtomicUrl(format!("did:ad:blob:{}", hash.to_hex()).into()),
                ),
            ]),
        )
        .await?;
    // An independent ledger: intended contents, not values read back from source.
    let ledger = [
        (doc.clone(), "Document before backup", drive.clone()),
        (table.clone(), "Table before backup", drive.clone()),
        (row, "Row before backup", table),
        (file, "Attachment before backup", doc.clone()),
    ];
    export_vault_segment(
        &source,
        &Subject::from(drive),
        &key,
        &vault,
        "drill",
        "device",
        1,
        1,
        false,
        &BTreeMap::new(),
        CheckpointPolicy::default(),
    )
    .await?
    .ok_or("Populated fixture produced no backup")?;
    drop(source);

    let restored = Db::init_temp("restore_drill_empty_target").await?;
    for (subject, _, _) in &ledger {
        assert!(!restored
            .kv
            .contains_key(Tree::Resources, subject.as_bytes())?);
    }
    assert!(!restored.kv.contains_key(Tree::Blobs, hash.as_bytes())?);
    let result = import_vault_batch(&restored, &key, &vault, "vault/drill/", None).await?;
    for (subject, name, parent) in &ledger {
        let resource = restored
            .get_resource(&Subject::from(subject.clone()))
            .await?;
        assert_eq!(resource.get(urls::NAME)?.to_string(), *name);
        assert_eq!(resource.get(urls::PARENT)?.to_string(), *parent);
    }
    restored.load_agent_from_secret(&recovery_secret).await?;
    let mut editable = restored.get_resource(&Subject::from(doc)).await?;
    editable.set_name("Edited after restore")?;
    editable.save_locally(&restored).await?;
    restored.flush()?;
    let recovered_bytes = restored.kv.get(Tree::Blobs, hash.as_bytes())?;
    let attachment_matches = recovered_bytes
        .as_deref()
        .is_some_and(|b| blake3::hash(b) == hash);
    let complete = attachment_matches && result.objects_unreadable == 0;
    println!(
        "{}",
        serde_json::json!({
            "vault_directory": vault_dir,
        "resources_checked": ledger.len(), "restored_resource_editable": true,
            "attachment_expected_blake3": hash.to_hex().to_string(),
            "attachment_bytes": bytes.len(), "attachment_matches": attachment_matches,
            "objects_unreadable": result.objects_unreadable, "complete": complete,
        })
    );
    if !complete {
        return Err("Restore incomplete: attachment bytes are missing or corrupt".into());
    }
    Ok(())
}
