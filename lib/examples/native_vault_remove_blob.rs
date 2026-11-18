// SPDX-License-Identifier: MIT
//! Offline-only corruption fixture for the isolated native Cloud Vault acceptance.
//!
//! Stop the acceptance app before either command (redb's exclusive lock enforces
//! this). Never point this tool at an installed app or an ordinary user's data.
//! `native_vault_remove_blob inspect|remove <native-data-dir> <hash> <drive>`
//! Build with `cargo build -p atomic_lib --features db-redb,anyhow --example native_vault_remove_blob`.
//!
//! The data directory must be this checkout's
//! `target/native-vault-acceptance/native-data`, containing the regular marker
//! `NATIVE_VAULT_ACCEPTANCE_ONLY` with JSON:
//! `{"purpose":"native-vault-acceptance","hash":"<hex>","drive":"<drive>","file":"<file>"}`.
//! Write that marker only after uploading the invented acceptance file. Removal
//! refuses stores with any additional blobs. It calls only BlobBackend::delete,
//! preserving every resource row, raw CRDT snapshot, and retained signed envelope.

#[cfg(all(feature = "db", feature = "anyhow", not(target_arch = "wasm32")))]
mod fixture {
    use std::{collections::BTreeMap, collections::HashSet, path::Path};

    use atomic_lib::{db::compaction::CompactionPolicy, db::trees::Tree, Db, Subject};
    use serde::{Deserialize, Serialize};

    #[derive(Deserialize)]
    struct Marker {
        purpose: String,
        hash: String,
        drive: String,
        file: String,
    }

    #[derive(Debug, PartialEq, Eq, Serialize)]
    struct Fingerprint {
        entries: u64,
        bytes: u64,
        blake3: String,
    }

    #[derive(Debug, PartialEq, Eq, Serialize)]
    struct Fingerprints {
        all: BTreeMap<String, Fingerprint>,
        drive: BTreeMap<String, Fingerprint>,
    }

    fn regular_file(path: &Path) -> anyhow::Result<()> {
        anyhow::ensure!(
            std::fs::symlink_metadata(path)?.file_type().is_file(),
            "expected a regular, non-symlink file: {}",
            path.display()
        );
        Ok(())
    }

    fn fingerprint(
        db: &Db,
        tree: Tree,
        subjects: Option<&HashSet<String>>,
    ) -> anyhow::Result<Fingerprint> {
        let mut digest = blake3::Hasher::new();
        let mut entries = 0;
        let mut bytes = 0;
        // KvStore iter_tree is ordered by key. Length prefixes prevent field
        // boundaries from creating ambiguous concatenations.
        for entry in db.kv.iter_tree(tree) {
            let (key, value) = entry?;
            if let Some(subjects) = subjects {
                let subject_key = if tree == Tree::Envelopes {
                    key.split(|byte| *byte == 0).next().unwrap_or_default()
                } else {
                    &key
                };
                if !subjects.contains(std::str::from_utf8(subject_key)?) {
                    continue;
                }
            }
            digest.update(&(key.len() as u64).to_be_bytes());
            digest.update(&key);
            digest.update(&(value.len() as u64).to_be_bytes());
            digest.update(&value);
            entries += 1;
            bytes += (key.len() + value.len()) as u64;
        }
        Ok(Fingerprint {
            entries,
            bytes,
            blake3: digest.finalize().to_hex().to_string(),
        })
    }

    fn fingerprints(db: &Db, subjects: &HashSet<String>) -> anyhow::Result<Fingerprints> {
        let mut all = BTreeMap::new();
        let mut drive = BTreeMap::new();
        for (name, tree) in [
            ("resources", Tree::Resources),
            ("loroSnapshots", Tree::LoroSnapshots),
            ("signedEnvelopes", Tree::Envelopes),
        ] {
            all.insert(name.into(), fingerprint(db, tree, None)?);
            drive.insert(name.into(), fingerprint(db, tree, Some(subjects))?);
        }
        Ok(Fingerprints { all, drive })
    }

    pub async fn run() -> anyhow::Result<()> {
        let args: Vec<String> = std::env::args().skip(1).collect();
        anyhow::ensure!(
            args.len() == 4 && matches!(args[0].as_str(), "inspect" | "remove"),
            "usage: native_vault_remove_blob inspect|remove <native-data-dir> <hash> <drive>"
        );
        let command = &args[0];
        let directory = Path::new(&args[1]).canonicalize()?;
        let expected = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| anyhow::anyhow!("missing checkout root"))?
            .join("target/native-vault-acceptance/native-data")
            .canonicalize()?;
        anyhow::ensure!(
            directory == expected,
            "refusing a directory outside this checkout's isolated acceptance fixture"
        );
        let marker_path = directory.join("NATIVE_VAULT_ACCEPTANCE_ONLY");
        regular_file(&marker_path)?;
        let marker: Marker = serde_json::from_slice(&std::fs::read(marker_path)?)?;
        anyhow::ensure!(
            marker.purpose == "native-vault-acceptance"
                && marker.hash == args[2]
                && marker.drive == args[3]
                && marker.drive.starts_with("atomic:")
                && (marker.file.starts_with("atomic:")
                    || marker.file == format!("internal:/files/{}", marker.hash)),
            "marker must identify this exact invented acceptance drive, file and hash"
        );
        anyhow::ensure!(marker.hash.len() == 64, "expected a 32-byte content hash");
        let hash: [u8; 32] = hex::decode(&marker.hash)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("expected a 32-byte content hash"))?;
        anyhow::ensure!(
            hex::encode(hash) == marker.hash,
            "hash must be lowercase hexadecimal"
        );
        let store_path = directory.join("store");
        anyhow::ensure!(
            store_path.canonicalize()? == directory.join("store"),
            "store must not redirect outside the fixture"
        );
        regular_file(&store_path.join("atomic.redb"))?;
        // Same native layout as server::config, with compaction disabled. The
        // existing redb lock refuses this open if the app has not been stopped.
        let db = Db::init_redb_file_with_policy(
            &store_path,
            None,
            &directory.join("uploads"),
            &CompactionPolicy::disabled(),
        )
        .await?;
        let drive: Subject = marker.drive.as_str().into();
        let file: Subject = marker.file.as_str().into();
        let subjects = atomic_lib::sync::engine::collect_drive_subjects(&db, &drive).await;
        anyhow::ensure!(
            subjects.contains(&file.pure_id()),
            "invented file is not in the marked drive"
        );
        anyhow::ensure!(
            db.get_resource_shallow(&file)?.blob_hash() == Some(hash),
            "marked file does not reference the requested blob"
        );
        let backend = db.blob_store();
        let blobs = backend.list().await?;
        anyhow::ensure!(
            blobs.len() <= 1 && blobs.iter().all(|blob| blob.key == hash),
            "fixture contains an unrelated blob; refusing access"
        );
        let contents = backend.get(&hash).await?;
        if let Some(contents) = &contents {
            anyhow::ensure!(
                blake3::hash(contents).as_bytes() == &hash,
                "invented blob fails content verification"
            );
        }
        let before = fingerprints(&db, &subjects)?;
        if command == "remove" {
            anyhow::ensure!(contents.is_some(), "invented blob is already absent");
            backend.delete(&hash).await?;
            db.kv.flush()?;
            anyhow::ensure!(
                backend.get(&hash).await?.is_none() && backend.list().await?.is_empty(),
                "blob remains after deletion"
            );
        }
        let after = fingerprints(&db, &subjects)?;
        anyhow::ensure!(
            before == after,
            "resource metadata or history changed during offline operation"
        );
        println!(
            "{}",
            serde_json::json!({
                "command": command,
                "drive": marker.drive,
                "file": marker.file,
                "hash": marker.hash,
                "blobPresent": backend.size(&hash).await?.is_some(),
                "blobBytesBefore": contents.as_ref().map(Vec::len),
                "driveSubjects": subjects.len(),
                "fingerprintsBefore": before,
                "fingerprintsAfter": after,
                "metadataAndHistoryUnchanged": true,
            })
        );
        Ok(())
    }
}

#[cfg(all(feature = "db", feature = "anyhow", not(target_arch = "wasm32")))]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    fixture::run().await
}

#[cfg(not(all(feature = "db", feature = "anyhow", not(target_arch = "wasm32"))))]
fn main() {
    panic!("native_vault_remove_blob requires a native build with --features db-redb,anyhow");
}
