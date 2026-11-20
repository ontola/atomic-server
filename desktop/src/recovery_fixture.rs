//! Opt-in Linux CI fixture. Never compiled into a normal desktop build.
//! Only an explicitly marked disposable native database can lose its one blob;
//! the gate pauses the real restore worker, never substitutes its result.
use std::{
  collections::HashSet,
  os::unix::fs::MetadataExt,
  path::{Path, PathBuf},
  sync::Mutex,
  time::{Duration, Instant},
};

use atomic_lib::{Db, Subject};
use serde::Deserialize;
use serde_json::{json, Value};

#[path = "../../lib/examples/support/native_recovery_fingerprints.rs"]
#[rustfmt::skip] // The shared source follows atomic_lib's four-space format.
mod fingerprints;
use fingerprints::fingerprints;

struct Gate {
  drive: String,
  hash: String,
  waiting: bool,
  released: bool,
  consumed: bool,
  timed_out: bool,
}
static GATE: Mutex<Option<Gate>> = Mutex::new(None);

#[derive(Deserialize)]
struct Marker {
  purpose: String,
  drive: String,
  hash: String,
  file: String,
}

struct Fixture {
  hash: [u8; 32],
  subjects: HashSet<String>,
  contents: Option<Vec<u8>>,
}

fn require(condition: bool, message: &str) -> Result<(), String> {
  if condition {
    Ok(())
  } else {
    Err(message.into())
  }
}

fn private_file(path: &Path) -> Result<Vec<u8>, String> {
  let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
  let uid = std::fs::metadata("/proc/self")
    .map_err(|e| e.to_string())?
    .uid();
  require(
    metadata.is_file() && metadata.uid() == uid && metadata.mode() & 0o077 == 0,
    "fixture markers must be private, owned regular files, never symlinks",
  )?;
  std::fs::read(path).map_err(|e| e.to_string())
}

async fn guard(store: &Db, drive: &str, hash: &str) -> Result<Fixture, String> {
  let expected = Path::new(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .ok_or("missing checkout root")?
    .join("target/native-vault-acceptance/native-data");
  let actual = PathBuf::from(std::env::var("ATOMIC_DATA_DIR").map_err(|e| e.to_string())?)
    .canonicalize()
    .map_err(|e| e.to_string())?;
  require(
    actual == expected,
    "native recovery fixture refuses other data directories",
  )?;
  require(
    std::fs::symlink_metadata(&actual)
      .map_err(|e| e.to_string())?
      .is_dir()
      && actual
        .join("store")
        .canonicalize()
        .map_err(|e| e.to_string())?
        == actual.join("store")
      && std::fs::symlink_metadata(actual.join("store/atomic.redb"))
        .map_err(|e| e.to_string())?
        .is_file(),
    "fixture database must not redirect through symlinks",
  )?;
  let owner: Value =
    serde_json::from_slice(&private_file(&actual.join("NATIVE_RECOVERY_CI_ONLY"))?)
      .map_err(|e| e.to_string())?;
  require(
    owner["purpose"] == "native-recovery-ci",
    "missing CI ownership marker",
  )?;
  let marker: Marker =
    serde_json::from_slice(&private_file(&actual.join("NATIVE_VAULT_ACCEPTANCE_ONLY"))?)
      .map_err(|e| e.to_string())?;
  require(
    marker.purpose == "native-vault-acceptance"
      && marker.drive == drive
      && marker.hash == hash
      && drive.starts_with("atomic:")
      && (marker.file.starts_with("atomic:") || marker.file == format!("internal:/files/{hash}")),
    "marker must identify this exact invented drive, file and hash",
  )?;
  let hash_bytes: [u8; 32] = hex::decode(hash)
    .map_err(|e| e.to_string())?
    .try_into()
    .map_err(|_| "expected a 32-byte hash")?;
  require(
    hex::encode(hash_bytes) == hash,
    "expected lowercase content hash",
  )?;
  let subjects =
    atomic_lib::sync::engine::collect_drive_subjects(store, &Subject::from(drive)).await;
  let file = Subject::from(marker.file.as_str());
  require(
    subjects.contains(&file.pure_id()),
    "fixture file must belong to its marked drive",
  )?;
  require(
    store
      .get_resource_shallow(&file)
      .map_err(|e| e.to_string())?
      .blob_hash()
      == Some(hash_bytes),
    "fixture file must currently reference the marked content hash",
  )?;
  let backend = store.blob_store();
  let blobs = backend.list().await.map_err(|e| e.to_string())?;
  require(
    blobs.len() <= 1 && blobs.iter().all(|blob| blob.key == hash_bytes),
    "fixture refuses a database containing unrelated blobs",
  )?;
  let contents = backend.get(&hash_bytes).await.map_err(|e| e.to_string())?;
  if let Some(bytes) = &contents {
    require(
      blake3::hash(bytes).as_bytes() == &hash_bytes,
      "fixture contents fail BLAKE3 verification",
    )?;
  }
  Ok(Fixture {
    hash: hash_bytes,
    subjects,
    contents,
  })
}

pub(super) async fn operate(
  store: &Db,
  operation: &str,
  drive: &str,
  hash: &str,
) -> Result<Value, String> {
  let fixture = guard(store, drive, hash).await?;
  match operation {
    "arm" => {
      require(
        fixture.contents.is_some(),
        "invented blob is already missing",
      )?;
      require(
        GATE.lock().map_err(|e| e.to_string())?.is_none(),
        "fixture gate is already armed",
      )?;
      let before = fingerprints(store, &fixture.subjects).map_err(|e| e.to_string())?;
      store
        .blob_store()
        .delete(&fixture.hash)
        .await
        .map_err(|e| e.to_string())?;
      store.flush().map_err(|e| e.to_string())?;
      require(
        !store
          .has_blob(&fixture.hash)
          .await
          .map_err(|e| e.to_string())?,
        "blob remains after deletion",
      )?;
      let after = fingerprints(store, &fixture.subjects).map_err(|e| e.to_string())?;
      require(before == after, "fixture loss changed metadata or history")?;
      *GATE.lock().map_err(|e| e.to_string())? = Some(Gate {
        drive: drive.into(),
        hash: hash.into(),
        waiting: false,
        released: false,
        consumed: false,
        timed_out: false,
      });
      Ok(
        json!({"blobPresent":false,"blobBytesBefore":fixture.contents.as_ref().map(Vec::len),
        "fingerprintsBefore":before,"fingerprintsAfter":after,"metadataAndHistoryUnchanged":true}),
      )
    }
    "snapshot" => {
      serde_json::to_value(fingerprints(store, &fixture.subjects).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
    }
    "status" | "release" => {
      let mut guard = GATE.lock().map_err(|e| e.to_string())?;
      let gate = guard.as_mut().ok_or("fixture gate is not armed")?;
      require(
        gate.drive == drive && gate.hash == hash,
        "fixture gate belongs to another file",
      )?;
      if operation == "release" {
        require(
          gate.waiting && !gate.released && !gate.timed_out,
          "real restore is not waiting at this one-shot fixture gate",
        )?;
        gate.released = true;
        Ok(json!({"released":true}))
      } else {
        Ok(
          json!({"waiting":gate.waiting && !gate.released && !gate.timed_out,"timedOut":gate.timed_out}),
        )
      }
    }
    _ => Err("unknown native recovery fixture operation".into()),
  }
}

/// Called only in the opted-in build, after real S3 download and chunk decoding.
/// No database/Mutex guard is held while the real restore worker waits.
pub(super) fn before_restore(drive: Option<&str>, wanted: &HashSet<String>) -> Result<(), String> {
  {
    let mut guard = GATE.lock().map_err(|e| e.to_string())?;
    let Some(gate) = guard.as_mut() else {
      return Ok(());
    };
    if drive != Some(gate.drive.as_str()) || !wanted.contains(&gate.hash) {
      return Ok(());
    }
    require(
      wanted.len() == 1 && !gate.consumed,
      "fixture gate accepts one exact restore attempt",
    )?;
    gate.consumed = true;
    gate.waiting = true;
  }
  let started = Instant::now();
  loop {
    {
      let guard = GATE.lock().map_err(|e| e.to_string())?;
      if guard.as_ref().is_some_and(|gate| gate.released) {
        return Ok(());
      }
    }
    if started.elapsed() >= Duration::from_secs(20) {
      if let Some(gate) = GATE.lock().map_err(|e| e.to_string())?.as_mut() {
        gate.timed_out = true;
        gate.waiting = false;
      }
      return Err("native recovery fixture gate timed out without release".into());
    }
    std::thread::sleep(Duration::from_millis(10));
  }
}
