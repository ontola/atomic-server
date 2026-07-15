//! Virtual Drive: mount your Atomic drives as a filesystem over local NFS v3.
//!
//! This is the desktop v1 of `planning/virtual-drive.md`: a read-only NFS server
//! bound to loopback that the OS mounts, with the mount root listing every Drive
//! the node can see, folders as directories, and Files streaming their blob
//! bytes. Neither mobile OS can mount NFS, so this module is compiled only on
//! desktop (see the `cfg` gate on `mod vfs` in `lib.rs`).
//!
//! **Designed for read-write even though v1 is read-only.** The mutating trait
//! methods return `NFS3ERR_ROFS` today, but the structure that a write path
//! needs is already here: the id map *allocates* ids (create/mkdir will need
//! fresh ones), names are sanitized at the materialization boundary (a
//! load-bearing safety step for writes), and the filesystem carries a stable
//! `source_id` so commits it will eventually sign are echo-suppressed like any
//! other transport (see `CommitOpts::source_id`). Turning it read-write is
//! flipping `capabilities()` and filling in the stubs, not a reshape.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;

use atomic_lib::db::trees::Tree;
use atomic_lib::{urls, Db, Resource, Storelike, Subject, Value};
use nfsserve::nfs::{
  fattr3, fileid3, filename3, ftype3, nfspath3, nfsstat3, nfstime3, sattr3, specdata3,
};
use nfsserve::tcp::{NFSTcp, NFSTcpListener};
use nfsserve::vfs::{DirEntry, NFSFileSystem, ReadDirResult, VFSCapabilities};

/// The synthetic mount root. Its children are the node's Drives. Real resources
/// get ids >= 2 from the id map.
const ROOT_ID: fileid3 = 1;

/// Loopback address + port the NFS server listens on. The OS mounts it with
/// `port=`/`mountport=` pointing here, so no privileged (<1024) port is needed.
pub const NFS_ADDR: &str = "127.0.0.1:11111";

/// Read-only permission bits: everything is world-readable (so the mount works
/// regardless of which uid the NFS client asserts over AUTH_UNIX) and nothing is
/// writable while `capabilities()` is `ReadOnly`.
const DIR_MODE: u32 = 0o555;
const FILE_MODE: u32 = 0o444;

/// Bidirectional `fileid3 <-> Subject` map. NFS needs small stable `u64` file
/// ids; Atomic subjects are long strings. v1 keeps this in memory and rebuilds
/// it per mount — `planning/virtual-drive.md` calls for a disk-backed map before
/// fileid stability becomes a wire guarantee, but for a read-only session an
/// in-memory map is correct. `get_or_alloc` is what a future `create`/`mkdir`
/// will call to mint an id for a freshly committed resource.
struct IdMap {
  inner: Mutex<IdMapInner>,
}

struct IdMapInner {
  to_subject: HashMap<fileid3, String>,
  to_id: HashMap<String, fileid3>,
  next: fileid3,
}

impl IdMap {
  fn new() -> Self {
    IdMap {
      inner: Mutex::new(IdMapInner {
        to_subject: HashMap::new(),
        to_id: HashMap::new(),
        // 1 is the synthetic root; real resources start at 2.
        next: ROOT_ID + 1,
      }),
    }
  }

  /// Return the existing id for a subject, or mint a new stable one.
  fn get_or_alloc(&self, subject: &str) -> fileid3 {
    let mut inner = self.inner.lock().unwrap();

    if let Some(id) = inner.to_id.get(subject) {
      return *id;
    }

    let id = inner.next;
    inner.next += 1;
    inner.to_id.insert(subject.to_string(), id);
    inner.to_subject.insert(id, subject.to_string());

    id
  }

  fn subject(&self, id: fileid3) -> Option<String> {
    self.inner.lock().unwrap().to_subject.get(&id).cloned()
  }
}

pub struct AtomicNfsFs {
  store: Db,
  ids: IdMap,
  /// Echo-suppression identity for commits this mount will sign once it goes
  /// read-write. Unused while read-only, held now so the write path threads it
  /// into `apply_commit_json` without reshaping this struct.
  #[allow(dead_code)]
  source_id: String,
}

impl AtomicNfsFs {
  pub fn new(store: Db) -> Self {
    AtomicNfsFs {
      store,
      ids: IdMap::new(),
      source_id: format!("vfs-{}", std::process::id()),
    }
  }

  /// The Drives the mount root exposes as top-level directories. On a
  /// single-user desktop node the default query context is `Sudo`, so this is
  /// every Drive in the store — "all my drives".
  async fn drives(&self) -> Result<Vec<Subject>, nfsstat3> {
    let result = self
      .store
      .query(&atomic_lib::storelike::Query::new_class(urls::DRIVE))
      .await
      .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?;

    Ok(result.subjects)
  }

  /// The File/Folder children of a container (drive or folder), by `parent`.
  async fn children(&self, parent: &str) -> Result<Vec<Resource>, nfsstat3> {
    let query = atomic_lib::storelike::Query::new_prop_val(urls::PARENT, parent);
    let result = self
      .store
      .query(&query)
      .await
      .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?;

    // The query returns the resources directly under `Sudo`; fall back to
    // fetching by subject if a backend ever returns subjects only.
    let mut resources = result.resources;

    if resources.is_empty() && !result.subjects.is_empty() {
      for subject in &result.subjects {
        if let Ok(resource) = self.store.get_resource(subject).await {
          resources.push(resource);
        }
      }
    }

    resources.retain(is_file_or_folder);

    Ok(resources)
  }

  async fn get(&self, id: fileid3) -> Result<Resource, nfsstat3> {
    let subject = self.ids.subject(id).ok_or(nfsstat3::NFS3ERR_NOENT)?;
    self
      .store
      .get_resource(&Subject::from(subject.as_str()))
      .await
      .map_err(|_| nfsstat3::NFS3ERR_NOENT)
  }

  /// A directory entry for a resource: mint its id, project its attributes.
  fn entry_for(&self, resource: &Resource) -> DirEntry {
    let id = self.ids.get_or_alloc(resource.get_subject().as_str());
    DirEntry {
      fileid: id,
      name: sanitize_name(&display_name(resource)).into_bytes().into(),
      attr: attr_for(id, resource),
    }
  }
}

#[async_trait]
impl NFSFileSystem for AtomicNfsFs {
  fn capabilities(&self) -> VFSCapabilities {
    // Read-only for v1. The write path (create/write/mkdir/rename/remove
    // routing through `apply_commit_json`) flips this to `ReadWrite`.
    VFSCapabilities::ReadOnly
  }

  fn root_dir(&self) -> fileid3 {
    ROOT_ID
  }

  async fn getattr(&self, id: fileid3) -> Result<fattr3, nfsstat3> {
    if id == ROOT_ID {
      return Ok(dir_attr(ROOT_ID));
    }

    let resource = self.get(id).await?;
    Ok(attr_for(id, &resource))
  }

  async fn lookup(&self, dirid: fileid3, filename: &filename3) -> Result<fileid3, nfsstat3> {
    let target = filename.as_ref();

    if dirid == ROOT_ID {
      for drive in self.drives().await? {
        if let Ok(resource) = self.store.get_resource(&drive).await {
          if sanitize_name(&display_name(&resource)).as_bytes() == target {
            return Ok(self.ids.get_or_alloc(drive.as_str()));
          }
        }
      }

      return Err(nfsstat3::NFS3ERR_NOENT);
    }

    let subject = self.ids.subject(dirid).ok_or(nfsstat3::NFS3ERR_NOENT)?;

    for child in self.children(&subject).await? {
      if sanitize_name(&display_name(&child)).as_bytes() == target {
        return Ok(self.ids.get_or_alloc(child.get_subject().as_str()));
      }
    }

    Err(nfsstat3::NFS3ERR_NOENT)
  }

  async fn readdir(
    &self,
    dirid: fileid3,
    start_after: fileid3,
    max_entries: usize,
  ) -> Result<ReadDirResult, nfsstat3> {
    // Gather every child entry (allocating ids), order by id for a
    // deterministic listing, then page from `start_after`.
    let mut entries: Vec<DirEntry> = if dirid == ROOT_ID {
      let mut out = Vec::new();

      for drive in self.drives().await? {
        if let Ok(resource) = self.store.get_resource(&drive).await {
          out.push(self.entry_for(&resource));
        }
      }

      out
    } else {
      let subject = self.ids.subject(dirid).ok_or(nfsstat3::NFS3ERR_NOENT)?;
      self
        .children(&subject)
        .await?
        .iter()
        .map(|resource| self.entry_for(resource))
        .collect()
    };

    entries.sort_by_key(|entry| entry.fileid);

    let start = entries
      .iter()
      .position(|entry| entry.fileid > start_after)
      .unwrap_or(entries.len());
    let page: Vec<DirEntry> = entries.into_iter().skip(start).collect();
    let end = page.len() <= max_entries;
    let page: Vec<DirEntry> = page.into_iter().take(max_entries).collect();

    Ok(ReadDirResult { entries: page, end })
  }

  async fn read(&self, id: fileid3, offset: u64, count: u32) -> Result<(Vec<u8>, bool), nfsstat3> {
    let resource = self.get(id).await?;

    // Read bytes lazily on `read` only — never on readdir/getattr (the doc's
    // no-prefetch contract). No range API on the blob store yet, so read the
    // whole blob and slice; content-defined chunking (v2) makes this cheap.
    let internal_id = resource
      .get(urls::INTERNAL_ID)
      .map_err(|_| nfsstat3::NFS3ERR_INVAL)?;
    let hash_hex = value_string(internal_id).ok_or(nfsstat3::NFS3ERR_INVAL)?;
    let hash_bytes = hex::decode(&hash_hex).map_err(|_| nfsstat3::NFS3ERR_IO)?;

    let bytes = self
      .store
      .kv
      .get(Tree::Blobs, &hash_bytes)
      .map_err(|_| nfsstat3::NFS3ERR_IO)?
      .ok_or(nfsstat3::NFS3ERR_NOENT)?;

    let start = (offset as usize).min(bytes.len());
    let end = start.saturating_add(count as usize).min(bytes.len());
    let eof = end >= bytes.len();

    Ok((bytes[start..end].to_vec(), eof))
  }

  async fn readlink(&self, _id: fileid3) -> Result<nfspath3, nfsstat3> {
    // No symlink resources are surfaced yet.
    Err(nfsstat3::NFS3ERR_NOTSUPP)
  }

  // --- Write path: not yet. Everything below returns ROFS until
  //     `capabilities()` becomes `ReadWrite`. See the module doc. ---

  async fn setattr(&self, _id: fileid3, _setattr: sattr3) -> Result<fattr3, nfsstat3> {
    Err(nfsstat3::NFS3ERR_ROFS)
  }

  async fn write(&self, _id: fileid3, _offset: u64, _data: &[u8]) -> Result<fattr3, nfsstat3> {
    Err(nfsstat3::NFS3ERR_ROFS)
  }

  async fn create(
    &self,
    _dirid: fileid3,
    _filename: &filename3,
    _attr: sattr3,
  ) -> Result<(fileid3, fattr3), nfsstat3> {
    Err(nfsstat3::NFS3ERR_ROFS)
  }

  async fn create_exclusive(
    &self,
    _dirid: fileid3,
    _filename: &filename3,
  ) -> Result<fileid3, nfsstat3> {
    Err(nfsstat3::NFS3ERR_ROFS)
  }

  async fn mkdir(
    &self,
    _dirid: fileid3,
    _dirname: &filename3,
  ) -> Result<(fileid3, fattr3), nfsstat3> {
    Err(nfsstat3::NFS3ERR_ROFS)
  }

  async fn remove(&self, _dirid: fileid3, _filename: &filename3) -> Result<(), nfsstat3> {
    Err(nfsstat3::NFS3ERR_ROFS)
  }

  async fn rename(
    &self,
    _from_dirid: fileid3,
    _from_filename: &filename3,
    _to_dirid: fileid3,
    _to_filename: &filename3,
  ) -> Result<(), nfsstat3> {
    Err(nfsstat3::NFS3ERR_ROFS)
  }

  async fn symlink(
    &self,
    _dirid: fileid3,
    _linkname: &filename3,
    _symlink: &nfspath3,
    _attr: &sattr3,
  ) -> Result<(fileid3, fattr3), nfsstat3> {
    Err(nfsstat3::NFS3ERR_ROFS)
  }
}

/// True for resources the filesystem surfaces: Files (regular files) and
/// Folders (directories). Everything else stays out of the mount for v1 — the
/// `.atomic` stub-file question in the doc is deferred.
fn is_file_or_folder(resource: &Resource) -> bool {
  classes(resource)
    .iter()
    .any(|class| class == urls::FILE || class == urls::FOLDER)
}

/// Directories in the mount: Folders and Drives (the mount root's drives are
/// top-level directories). Everything else that is surfaced is a regular file.
fn is_dir(resource: &Resource) -> bool {
  classes(resource)
    .iter()
    .any(|class| class == urls::FOLDER || class == urls::DRIVE)
}

fn classes(resource: &Resource) -> Vec<String> {
  match resource.get(urls::IS_A) {
    Ok(Value::ResourceArray(array)) => array.iter().map(|sub| sub.to_string()).collect(),
    _ => Vec::new(),
  }
}

/// The name to show in the filesystem: a File's `filename`, else `name`, else
/// `shortname`, else the last path segment of the subject.
fn display_name(resource: &Resource) -> String {
  for property in [urls::FILENAME, urls::NAME, urls::SHORTNAME] {
    if let Ok(value) = resource.get(property) {
      if let Some(string) = value_string(value) {
        if !string.is_empty() {
          return string;
        }
      }
    }
  }

  subject_fallback(resource.get_subject().as_str())
}

fn subject_fallback(subject: &str) -> String {
  subject
    .trim_end_matches('/')
    .rsplit('/')
    .next()
    .filter(|segment| !segment.is_empty())
    .unwrap_or(subject)
    .to_string()
}

fn value_string(value: &Value) -> Option<String> {
  match value {
    Value::String(string) | Value::Markdown(string) | Value::Slug(string) => Some(string.clone()),
    Value::AtomicUrl(subject) => Some(subject.to_string()),
    _ => None,
  }
}

fn attr_for(id: fileid3, resource: &Resource) -> fattr3 {
  if is_dir(resource) {
    dir_attr(id)
  } else {
    let size = resource
      .get(urls::FILESIZE)
      .ok()
      .and_then(|value| match value {
        Value::Integer(number) => u64::try_from(*number).ok(),
        _ => None,
      })
      // Size is read from the `filesize` property only — never by reading
      // the blob (that would violate the no-prefetch-on-getattr contract).
      .unwrap_or(0);

    file_attr(id, size)
  }
}

fn dir_attr(id: fileid3) -> fattr3 {
  base_attr(id, ftype3::NF3DIR, DIR_MODE, 2, 4096)
}

fn file_attr(id: fileid3, size: u64) -> fattr3 {
  base_attr(id, ftype3::NF3REG, FILE_MODE, 1, size)
}

fn base_attr(id: fileid3, ftype: ftype3, mode: u32, nlink: u32, size: u64) -> fattr3 {
  let time = nfstime3 {
    seconds: 0,
    nseconds: 0,
  };

  fattr3 {
    ftype,
    mode,
    nlink,
    uid: 0,
    gid: 0,
    size,
    used: size,
    rdev: specdata3 {
      specdata1: 0,
      specdata2: 0,
    },
    fsid: 0,
    fileid: id,
    atime: time,
    mtime: time,
    ctime: time,
  }
}

/// Map a free-form Atomic name to an FS-safe basename. Applied only at the
/// materialization boundary (the canonical name in Atomic keeps the original
/// string). This is load-bearing security once the write path exists — every
/// cloud-sync product has shipped a path-traversal CVE here — so it lands with
/// the read-only mount rather than being bolted on later. This is a v1 subset of
/// the full table in `planning/virtual-drive.md`; collision `(2)`/`(3)`
/// suffixing is a follow-up.
fn sanitize_name(name: &str) -> String {
  if name.is_empty() {
    return "_".to_string();
  }

  if name == "." || name == ".." {
    // U+2024 one-dot leader keeps it visually a dot without being one.
    return name.replace('.', "\u{2024}");
  }

  let sanitized: String = name
    .chars()
    .map(|character| match character {
      '/' | '\\' => '\u{ff0f}',                 // fullwidth solidus
      '\0'..='\u{1f}' | '\u{7f}' => '\u{fffd}', // control chars
      // Strip bidi/RTL overrides that can spoof the displayed name.
      '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' => '\u{fffd}',
      other => other,
    })
    .collect();

  // Bound to the FS limit, on a codepoint boundary.
  if sanitized.len() > 255 {
    let mut truncated = String::new();

    for character in sanitized.chars() {
      if truncated.len() + character.len_utf8() > 247 {
        break;
      }

      truncated.push(character);
    }

    return truncated;
  }

  sanitized
}

/// Where the drive is mounted: `~/AtomicDrive`.
fn mount_point() -> Option<std::path::PathBuf> {
  let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
  Some(std::path::PathBuf::from(home).join("AtomicDrive"))
}

/// Status of the virtual drive, surfaced to the desktop UI.
#[derive(serde::Serialize)]
pub struct VfsStatus {
  /// The NFS server is listening.
  pub running: bool,
  /// The drive is mounted into the filesystem at `mount_path`.
  pub mounted: bool,
  pub mount_path: Option<String>,
}

/// Serve the NFS filesystem until `shutdown` resolves (fired, or its sender
/// dropped). Bound to loopback.
async fn serve_until(
  store: Db,
  shutdown: tokio::sync::oneshot::Receiver<()>,
) -> std::io::Result<()> {
  let listener = NFSTcpListener::bind(NFS_ADDR, AtomicNfsFs::new(store)).await?;

  tokio::select! {
    result = listener.handle_forever() => result,
    _ = shutdown => Ok(()),
  }
}

/// Wait for the NFS server to accept connections before mounting, so `mount`
/// doesn't race the listener's bind. ~3s budget.
fn wait_until_listening() -> bool {
  for _ in 0..30 {
    if std::net::TcpStream::connect(NFS_ADDR).is_ok() {
      return true;
    }

    std::thread::sleep(std::time::Duration::from_millis(100));
  }

  false
}

/// Mount the running NFS server into the filesystem. On macOS a normal user can
/// mount NFS to a directory they own (no sudo); on Linux `mount` usually needs
/// privilege, so the error is surfaced to the UI.
#[cfg(unix)]
fn os_mount(mount_point: &std::path::Path) -> Result<(), String> {
  std::fs::create_dir_all(mount_point)
    .map_err(|e| format!("Could not create the mount folder: {e}"))?;

  let port = NFS_ADDR.rsplit(':').next().unwrap_or("11111");
  let options = format!("nolocks,vers=3,tcp,port={port},mountport={port},soft,ro");

  let output = std::process::Command::new("mount")
    .args(["-t", "nfs", "-o", &options, "127.0.0.1:/"])
    .arg(mount_point)
    .output()
    .map_err(|e| format!("Could not run mount: {e}"))?;

  if output.status.success() {
    Ok(())
  } else {
    Err(format!(
      "mount failed: {}",
      String::from_utf8_lossy(&output.stderr).trim()
    ))
  }
}

#[cfg(unix)]
fn os_unmount(mount_point: &str) {
  let _ = std::process::Command::new("umount")
    .arg(mount_point)
    .output();
}

#[cfg(not(unix))]
fn os_mount(_mount_point: &std::path::Path) -> Result<(), String> {
  Err("Mounting the virtual drive isn't supported on this platform yet.".into())
}

#[cfg(not(unix))]
fn os_unmount(_mount_point: &str) {}

/// Open the mounted folder in the OS file manager.
pub fn open_mount() -> Result<(), String> {
  let path = mount_point().ok_or("No mount location.")?;
  #[cfg(target_os = "macos")]
  let opener = "open";
  #[cfg(all(unix, not(target_os = "macos")))]
  let opener = "xdg-open";
  #[cfg(windows)]
  let opener = "explorer";

  std::process::Command::new(opener)
    .arg(&path)
    .spawn()
    .map(|_| ())
    .map_err(|e| format!("Could not open the folder: {e}"))
}

/// Owns the virtual drive's lifecycle — the NFS server *and* the OS mount — so
/// the app (via a Tauri command) turns it on and off with one action.
#[derive(Default)]
pub struct VfsController {
  running: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
  mount_path: Mutex<Option<String>>,
}

impl VfsController {
  /// Start the NFS server (if needed) and mount it into the filesystem. The
  /// server runs on its own thread + runtime, independent of the embedded
  /// server's actix reactor.
  pub fn start(&self, store: Db) -> Result<(), String> {
    {
      let mut running = self.running.lock().unwrap();

      if running.is_none() {
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();

        std::thread::Builder::new()
          .name("atomic-vfs-nfs".to_string())
          .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
              .enable_all()
              .build()
            {
              Ok(runtime) => runtime,
              Err(error) => {
                eprintln!("[vfs] could not start the NFS runtime: {error}");
                return;
              }
            };

            if let Err(error) = runtime.block_on(serve_until(store, shutdown_rx)) {
              eprintln!("[vfs] NFS server stopped: {error}");
            }
          })
          .expect("failed to spawn the atomic-vfs-nfs thread");

        *running = Some(shutdown_tx);
        println!("[vfs] virtual drive listening on {NFS_ADDR}");
      }
    }

    if self.mount_path.lock().unwrap().is_some() {
      return Ok(()); // already mounted
    }

    if !wait_until_listening() {
      return Err("The virtual drive did not start listening.".into());
    }

    let mount_point = mount_point().ok_or("Could not find a home folder to mount into.")?;
    os_mount(&mount_point)?;

    let path = mount_point.to_string_lossy().to_string();
    println!("[vfs] virtual drive mounted at {path}");
    *self.mount_path.lock().unwrap() = Some(path);

    Ok(())
  }

  /// Unmount and stop the server. Dropping the shutdown sender ends the accept
  /// loop; the worker thread then exits on its own.
  pub fn stop(&self) {
    if let Some(path) = self.mount_path.lock().unwrap().take() {
      os_unmount(&path);
    }

    self.running.lock().unwrap().take();
  }

  pub fn status(&self) -> VfsStatus {
    let mount_path = self.mount_path.lock().unwrap().clone();

    VfsStatus {
      running: self.running.lock().unwrap().is_some(),
      mounted: mount_path.is_some(),
      mount_path,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn name_of(entry: &DirEntry) -> String {
    String::from_utf8_lossy(entry.name.as_ref()).to_string()
  }

  /// Walk root → drive → folder → file through the NFS trait and confirm the
  /// store maps onto the filesystem: drives are dirs at the root, folders
  /// nest, and a File streams its blob bytes.
  #[tokio::test(flavor = "multi_thread")]
  async fn maps_store_hierarchy_and_reads_a_blob() {
    let store = Db::init_temp("vfs_maps_hierarchy").await.unwrap();

    let drive = store.create_drive("Test Drive").await.unwrap();
    let folder = store
      .create_resource(urls::FOLDER, &drive, "MyFolder", None)
      .await
      .unwrap();

    // A blob keyed by an arbitrary 32-byte hash; the File points at it by
    // hex-encoded internalId, which is exactly what `read` decodes.
    let blob = b"hello vfs".to_vec();
    let hash = [7u8; 32];
    store.kv.insert(Tree::Blobs, &hash, &blob).unwrap();
    store
      .create_resource(
        urls::FILE,
        &folder,
        "hello.txt",
        Some(vec![
          (urls::FILENAME, Value::String("hello.txt".into())),
          (urls::INTERNAL_ID, Value::String(hex::encode(hash))),
          (urls::FILESIZE, Value::Integer(blob.len() as i64)),
        ]),
      )
      .await
      .unwrap();

    let fs = AtomicNfsFs::new(store);

    // Root lists the drive as a directory.
    let root = fs.readdir(ROOT_ID, 0, 100).await.unwrap();
    let drive_entry = root
      .entries
      .iter()
      .find(|entry| name_of(entry) == "Test Drive")
      .expect("drive should appear at the mount root");
    assert!(matches!(drive_entry.attr.ftype, ftype3::NF3DIR));
    assert_eq!(
      fs.lookup(ROOT_ID, &b"Test Drive"[..].into()).await.unwrap(),
      drive_entry.fileid
    );

    // The drive lists the folder as a directory.
    let drive_listing = fs.readdir(drive_entry.fileid, 0, 100).await.unwrap();
    let folder_entry = drive_listing
      .entries
      .iter()
      .find(|entry| name_of(entry) == "MyFolder")
      .expect("folder should appear under the drive");
    assert!(matches!(folder_entry.attr.ftype, ftype3::NF3DIR));

    // The folder lists the file as a regular file with its byte size.
    let folder_listing = fs.readdir(folder_entry.fileid, 0, 100).await.unwrap();
    let file_entry = folder_listing
      .entries
      .iter()
      .find(|entry| name_of(entry) == "hello.txt")
      .expect("file should appear under the folder");
    assert!(matches!(file_entry.attr.ftype, ftype3::NF3REG));
    assert_eq!(file_entry.attr.size, blob.len() as u64);

    // Reading the file returns the blob bytes and flags EOF.
    let (bytes, eof) = fs.read(file_entry.fileid, 0, 1024).await.unwrap();
    assert_eq!(bytes, blob);
    assert!(eof);

    // A partial read respects offset/count and does not flag EOF early.
    let (head, eof) = fs.read(file_entry.fileid, 0, 5).await.unwrap();
    assert_eq!(head, b"hello");
    assert!(!eof);
  }

  #[test]
  fn sanitizes_unsafe_names() {
    assert_eq!(sanitize_name("a/b"), "a\u{ff0f}b");
    assert_eq!(sanitize_name(""), "_");
    assert_eq!(sanitize_name(".."), "\u{2024}\u{2024}");
    assert_eq!(sanitize_name("normal.txt"), "normal.txt");
  }

  #[test]
  fn falls_back_to_the_last_subject_segment() {
    assert_eq!(subject_fallback("https://x.com/foo/bar"), "bar");
    assert_eq!(subject_fallback("https://x.com/baz/"), "baz");
  }
}
