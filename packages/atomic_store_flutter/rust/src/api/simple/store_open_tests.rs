//! `open_db` on a store that is already open, damaged, or not a store.

use super::*;

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "atomic-bridge-open-{name}-{}-{}",
        std::process::id(),
        state::now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Android runs `main` again in the same process when it recreates the
/// activity. The second `open_db` must keep the open store: a second
/// handle on the file is what damaged stores.
#[tokio::test]
async fn a_second_open_db_keeps_the_store_that_is_open() {
    tests::shared_drive().await;
    let before = db().unwrap().clone();
    let elsewhere = temp_dir("second");
    open_db(elsewhere.to_string_lossy().into_owned())
        .await
        .unwrap();
    assert!(std::sync::Arc::ptr_eq(&before, db().unwrap()));
    assert!(
        !elsewhere.join("atomic.redb").exists(),
        "no second store is opened"
    );
    std::fs::remove_dir_all(elsewhere).ok();
}

/// The damage seen on Android: the file ends before its header says. The
/// file is kept under a new name and a repaired copy (or an empty store)
/// opens in its place, never a panic.
#[tokio::test]
async fn a_store_shorter_than_its_header_is_kept_and_replaced() {
    let dir = temp_dir("short");
    {
        let (store, recovery) = open_native_store(&dir, None).await.unwrap();
        assert_eq!(recovery, None);
        store
            .kv
            .insert(
                atomic_lib::db::trees::Tree::PluginMeta,
                b"k",
                &[1u8; 50_000],
            )
            .unwrap();
        store.flush().unwrap();
    }
    // Let the store close (its flush thread holds only a weak reference).
    std::thread::sleep(std::time::Duration::from_millis(300));
    let path = dir.join("atomic.redb");
    let check = atomic_lib::db::recovery::inspect(&path).unwrap().unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(check.layout_len - 2 * u64::from(check.page_size))
        .unwrap();
    let damaged = std::fs::read(&path).unwrap();

    let (_store, recovery) = open_native_store(&dir, None).await.unwrap();
    let recovery = recovery.expect("a damaged store is reported");
    assert!(
        atomic_lib::db::recovery::is_damaged_store_error(&recovery.reason),
        "{recovery:?}"
    );
    assert_eq!(
        std::fs::read(&recovery.kept_path).unwrap(),
        damaged,
        "the broken file is kept as it was"
    );
    assert!(path.exists());
    std::fs::remove_dir_all(dir).ok();
}

/// Something that is not a store at all: set aside, and the app starts on
/// an empty store.
#[tokio::test]
async fn a_file_that_is_not_a_store_is_kept_and_an_empty_store_opens() {
    let dir = temp_dir("garbage");
    std::fs::write(dir.join("atomic.redb"), vec![0x42u8; 9000]).unwrap();
    let (store, recovery) = open_native_store(&dir, None).await.unwrap();
    let recovery = recovery.expect("a file that is not a store is reported");
    assert!(!recovery.repaired, "{recovery:?}");
    assert_eq!(
        std::fs::read(&recovery.kept_path).unwrap(),
        vec![0x42u8; 9000]
    );
    assert!(store.get_active_drive().is_none());
    std::fs::remove_dir_all(dir).ok();
}

const KEY: [u8; 32] = [7u8; 32];
const SECRET_MARKER: &[u8] = b"PATIENT-DIAGNOSIS-MARKER-0123456789";

fn write_marker(store: &atomic_lib::Db) {
    store
        .kv
        .insert(
            atomic_lib::db::trees::Tree::PluginMeta,
            b"health",
            SECRET_MARKER,
        )
        .unwrap();
    store.flush().unwrap();
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// A store created with a key is ciphertext on disk, reopens with the key,
/// and says so when the key is wrong or missing, without touching the file.
#[tokio::test]
async fn an_encrypted_store_is_ciphertext_on_disk_and_needs_its_key() {
    let dir = temp_dir("encrypted");
    let path = dir.join("atomic.redb");
    {
        let (store, recovery) = open_native_store(&dir, Some(&KEY)).await.unwrap();
        assert_eq!(recovery, None);
        write_marker(&store);
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    let on_disk = std::fs::read(&path).unwrap();
    assert!(on_disk.starts_with(b"ATOMENC1"));
    assert!(
        !contains(&on_disk, SECRET_MARKER),
        "plaintext found in the store file"
    );
    assert!(
        !contains(&on_disk, b"https://atomicdata.dev"),
        "plaintext property URLs found in the store file"
    );

    // Same key: the data is back.
    {
        let (store, recovery) = open_native_store(&dir, Some(&KEY)).await.unwrap();
        assert_eq!(recovery, None);
        let got = store
            .kv
            .get(atomic_lib::db::trees::Tree::PluginMeta, b"health")
            .unwrap();
        assert_eq!(got.as_deref(), Some(SECRET_MARKER));
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    let before_failures = std::fs::read(&path).unwrap();

    // Wrong key: an error that says so, and the file is not set aside.
    let wrong = match open_native_store(&dir, Some(&[8u8; 32])).await {
        Ok(_) => panic!("opened with the wrong key"),
        Err(e) => e,
    };
    assert!(
        atomic_lib::db::encrypted_backend::is_wrong_key_error(&wrong),
        "{wrong}"
    );
    assert!(!atomic_lib::db::recovery::is_damaged_store_error(&wrong));

    // No key: an error, not a "damaged store".
    let none = match open_native_store(&dir, None).await {
        Ok(_) => panic!("opened without the key"),
        Err(e) => e,
    };
    assert!(none.contains("needs its key"), "{none}");

    assert!(path.exists());
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains("corrupt"))
        .collect();
    assert!(leftovers.is_empty(), "the store was set aside: {leftovers:?}");
    assert_eq!(
        std::fs::read(&path).unwrap(),
        before_failures,
        "failed opens leave the file as it was"
    );
    std::fs::remove_dir_all(dir).ok();
}

/// An existing plaintext store keeps opening, and stays plaintext, even when
/// a key is passed.
#[tokio::test]
async fn an_existing_plaintext_store_stays_plaintext() {
    let dir = temp_dir("plain-with-key");
    {
        let (store, _) = open_native_store(&dir, None).await.unwrap();
        write_marker(&store);
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    let (store, recovery) = open_native_store(&dir, Some(&KEY)).await.unwrap();
    assert_eq!(recovery, None);
    assert_eq!(
        store
            .kv
            .get(atomic_lib::db::trees::Tree::PluginMeta, b"health")
            .unwrap()
            .as_deref(),
        Some(SECRET_MARKER)
    );
    drop(store);
    std::thread::sleep(std::time::Duration::from_millis(300));
    let on_disk = std::fs::read(dir.join("atomic.redb")).unwrap();
    assert!(!on_disk.starts_with(b"ATOMENC1"));
    assert!(contains(&on_disk, SECRET_MARKER));
    std::fs::remove_dir_all(dir).ok();
}

/// Through the public bridge call: `is_encrypted_at_rest` tells the app what
/// it got, and a key of the wrong length is refused.
#[tokio::test]
async fn open_with_a_store_key_reports_encryption() {
    use crate::api::resources::AtomicStore;
    let dir = temp_dir("bridge-encrypted");
    let handle = AtomicStore::open(
        dir.to_string_lossy().into_owned(),
        None,
        None,
        Some(KEY.to_vec()),
    )
    .await
    .unwrap();
    assert!(handle.is_encrypted_at_rest());
    let bad = temp_dir("bridge-badkey");
    let err = AtomicStore::open(
        bad.to_string_lossy().into_owned(),
        None,
        None,
        Some(vec![1, 2, 3]),
    )
    .await;
    assert!(err.is_err());
    std::fs::remove_dir_all(dir).ok();
    std::fs::remove_dir_all(bad).ok();
}
