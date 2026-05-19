# Virtual Drive: Atomic as a Filesystem

AtomicServer runs offline-first as a desktop app and syncs across devices.
A natural extension is to expose its hierarchy as a filesystem that the OS can
mount — similar to how Google Drive or Dropbox surface remote storage. Files
and folders inside the Atomic drive appear in Finder / Explorer / your file
manager; opening, editing, renaming, and moving them produces Atomic Commits
that flow through the existing sync protocol.

Benefits:

- Search the drive's contents through Atomic — by filename, folder,
  mimetype, size, ACL, or any property — for free. This works because
  everything in the mount is, by construction, an Atomic resource that the
  server already indexes; we are not scanning an external OS filesystem.
  Atomic Documents (Loro-backed rich text) are already text-extracted into
  the Tantivy index today (`server/src/search.rs`). Full-text search inside
  other binary formats (PDF, docx, images) rides on the planned **Atomizer**
  pipeline — see the [roadmap](../docs/src/roadmap.md) — and is not work the
  VFS itself takes on. The VFS just guarantees that every file landing in
  the mount becomes a normal Atomic resource and inherits whatever
  indexing exists.
- Share files and folders with collaborators using existing ACLs
- Use the Assistant to ask questions about your files
- Back up important data to multiple devices with content-addressed dedup
- Open arbitrary file types via OS apps; non-file resources still open in the
  Atomic UI via a stub file association

## Why the primitives already fit

Three pieces of existing work make this much smaller than it would otherwise
be:

1. **The blob / File split already models a filesystem.** `did:ad:blob:{blake3}`
   is bytes; the File resource is metadata plus ACL; folders are resources with
   `parent`. A virtual drive layer walks the parent tree to materialize
   directories, and for each File child either inlines the blob or presents it
   as a placeholder that pulls bytes on demand via `BLOB_REQUEST`. The
   content-addressed model means renames and moves don't move bytes — only a
   commit updates the File resource. Deduplication is free.

2. **The WS commit work solves the FS-watcher echo problem.** The OS-side mount
   is just another local client of the embedded server. Give it a
   `connection_id`, route its commits through the same `apply_commit_json`
   path, and the existing source-id suppression keeps it from reading its own
   writes back as `UPDATE` frames. No new mechanism is needed — same shape as
   a browser tab.

3. **DIDs give stable identity across devices.** A file's identity
   (`did:ad:{genesis}`) survives moving between drives, so the same file
   appearing in two paired devices is provably the same resource, not just
   "same name and size."

QR pairing is device handshake, not authorization — both devices are already
signed in as the same agent. Mounting your own drive on a second device needs
no consent flow. Cross-agent sharing is a separate problem; see
[sync.md](./sync.md).

## Platform layer — pick the abstraction

Three realistic paths, ordered by cost-to-ship.

### Option A — NFS server (recommended for v1)

Run a local NFS v3 server on 127.0.0.1; each OS mounts it with its built-in
NFS client. One Rust implementation covers macOS, Linux, and Windows Pro /
Enterprise. This is what `rclone` switched to on macOS once macFUSE got
painful, and what several Iroh-adjacent tools use.

- Crate: [`nfsserve`](https://crates.io/crates/nfsserve) — exposes a
  `NFSFileSystem` trait you implement against the store.
- Mount on startup:
  - macOS / Linux: `mount -t nfs -o nolocks,vers=3 localhost:/atomic ~/Atomic`
  - Windows: `mount \\127.0.0.1\atomic Z:`
- Downsides: NFS v3 has weak locking semantics, no native xattrs, Windows Home
  does not ship the client, and the drive shows up as a network mount (not
  cloud-sync UI). Acceptable for v1.

### Option B — FUSE + WinFSP

Most mature path for full POSIX semantics.

- [`fuser`](https://crates.io/crates/fuser) on Linux and macOS (via macFUSE).
- [`winfsp`](https://crates.io/crates/winfsp) on Windows (FUSE-like API; no
  kext needed on Windows because WinFSP is signed).
- Downside: macFUSE on Apple Silicon requires the user to weaken SIP. A real
  onboarding cliff.

### Option C — Native cloud-sync APIs

Best long-term UX (placeholder files, on-demand download, native Finder /
Explorer integration with sync-status overlays).

- macOS File Provider: no good Rust binding. Write a Swift extension that
  talks to atomic-server over a local socket or via `objc2` / `block2`.
- Windows Cloud Files API: same story via `windows-rs`.
- Linux: nothing native — fall back to FUSE.
- Months of work per platform. Defer until v1 proves the model.

**Recommendation:** start with A on desktop. Plan for C as the eventual
destination. B is a fallback for environments where NFS clients are
restricted. Mobile cannot use A or B at all and goes straight to C-shaped
provider APIs (see [Mobile platforms](#mobile-platforms-ios-and-android)) —
which is a reason to invest in the cross-platform VFS backend trait early,
since the mobile work will exercise it before any desktop native-API work
does.

## Integration into atomic-server

Add `server/src/vfs/` with two pieces.

### 1. `AtomicNfsFs` implementing `nfsserve::NFSFileSystem`

Each operation maps to a `Store` call:

- `readdir(parent_fileid)` — TPF query for resources with `parent = <did>`,
  filtered to Files and Folders.
- `getattr(fileid)` — read File properties, project into POSIX `fattr3`.
- `read(fileid, offset, len)` — `FileStore::read_blob(blob_did)` with range.
- `write(fileid, offset, data)` — buffer in a per-handle staging blob; on
  `close` / `commit`, hash with BLAKE3, write the blob, sign a Commit updating
  `File.blob` and `File.checksum`, and submit through `apply_commit_json`.
- `mkdir` / `create` / `rename` / `remove` — commits that mutate `parent`,
  `name`, or destroy the resource.

### 2. A VFS connection source-id

Generate one `connection_id` for the VFS at startup and pass it through
`CommitOpts` so the VFS does not receive echo `UPDATE`s for its own writes.
The plumbing for this exists from the WS commit work — reuse it directly.

### Cache invalidation (remote → VFS)

The inverse direction is the trickier half. NFS v3 has no server push, so
clients rely on attribute-cache TTLs (`actimeo`) and re-stat. This is
acceptable for v1 — bounded staleness on the order of seconds. FUSE and the
native APIs let you push invalidations explicitly when a remote commit
arrives; that's a v2 win, not a blocker.

### Auth

Local user equals the agent whose private key the daemon holds. Bind the NFS
listener to 127.0.0.1, refuse non-loopback. This matches the desktop pattern
already in use.

## Mapping Atomic resources to filesystem entries

- **File resource** → regular file. `filename` becomes the basename.
  Collisions within a parent: append ` (2)`, ` (3)` like Finder, or reject
  the commit at the VFS layer.
- **Folder resource** → directory.
- **Non-File resources** → `.atomic` JSON-AD stub files associated with the
  desktop app. Hide them behind a config flag if users find them noisy. The
  cleaner alternative is hiding non-File resources entirely, but then it
  isn't really a "drive of your Atomic data" — it's just a file-sync product.
- **Atomic properties beyond name / size / mtime** → xattrs where the FS
  supports them; otherwise drop from the FS view (still visible in the Atomic
  UI).

## Mobile platforms (iOS and Android)

Neither mobile OS supports FUSE or NFS mounts. Both ship a system-level
provider API that, end-to-end, is closer to desktop Option C than to A or B —
so mobile lands in the same place desktop is eventually heading, just sooner.
A Flutter app already exists in the repo (`flutter/`), which sets the
host-app pattern: the embedded atomic-server compiles to a static library
linked into the mobile app, and a thin platform-native provider extension
shares that library.

### iOS — File Provider extension

Same API family as macOS File Provider, specifically
`NSFileProviderReplicatedExtension` (iOS 16+). The provider appears in the
Files app as a top-level location alongside iCloud Drive. Every "Open in…"
picker, Photos, Pages, and most third-party apps can read and write through
it.

Constraints that shape the design:

- The extension runs in a **separate process** from the host app, with a
  tight memory cap (~24 MB on older devices, more on recent ones). Cannot
  load a large in-memory store there.
- The extension can be killed and respawned at any time. Cold-start must be
  cheap.
- No background WebSockets. Push-triggered sync (APNs) plus fetch-on-open is
  the realistic model.
- Written in Swift; calls Rust over FFI.

Architecture: keep the embedded server running in the host Flutter app
whenever it is alive. The extension is a thin proxy that talks to the host
process via XPC or a Unix domain socket inside the App Group container. When
the host is not running, the extension opens a minimal read-mostly view
directly against the on-disk store — enough to satisfy `readdir` and
`getattr` and to stream blob bytes lazily — without booting the full sync
engine.

### Android — DocumentsProvider via SAF

Storage Access Framework with a `DocumentsProvider`. Shows up in the system
file picker and the Files app. Apps don't see it as a POSIX mount; they
request `content://` URIs through the picker and can hold long-lived
permission grants.

Constraints:

- Written in Kotlin; calls Rust over JNI.
- Reads and writes go through `openDocument` returning a
  `ParcelFileDescriptor`. For streamed I/O, a pipe pair backed by a worker
  thread.
- Background sync needs `WorkManager` or a foreground service. Same battery
  concerns as iOS.
- The provider lives in the host app's process — simpler than iOS, but
  cold-start latency still matters because the system file picker invokes it
  on demand.

Architecture: same shape as iOS, simpler because there is no separate
process. The embedded server lives in the host app; the DocumentsProvider is
a thin wrapper calling into it.

### Shared backend

Define a single `VfsBackend` trait inside `atomic-lib` (or a new
`atomic-vfs` crate) that all four frontends share:

- NFS server (`nfsserve`) — macOS / Linux / Windows desktop
- FUSE / WinFSP — alternative desktop path
- iOS File Provider extension (Swift, calls via FFI)
- Android DocumentsProvider (Kotlin, calls via FFI)

This is the same trait the macOS / Windows native APIs will eventually use,
so the mobile work is also the groundwork for desktop Option C.

### Tooling

- [`uniffi-rs`](https://crates.io/crates/uniffi) — generates Swift and Kotlin
  bindings from a Rust UDL. Mature; used by Firefox Sync, Matrix Rust SDK,
  and others. Better than hand-rolled FFI for an API that will be called
  from two platforms.
- [`cargo-ndk`](https://crates.io/crates/cargo-ndk) — Android cross-compile.
- [`cargo-lipo`](https://crates.io/crates/cargo-lipo) or `xcodebuild` for
  iOS universal static libraries.
- [`flutter_rust_bridge`](https://crates.io/crates/flutter_rust_bridge) —
  already worth considering for the Flutter app itself. The provider
  extensions run *outside* Flutter, so they should bind through uniffi
  rather than this.
- [`jni`](https://crates.io/crates/jni) and [`objc2`](https://crates.io/crates/objc2)
  for the small amount of platform-specific code that has to live below
  uniffi (lifecycle methods on the extension classes).

### Mobile-specific open questions

- **iOS extension memory budget.** The embedded sync engine probably
  exceeds it. Decide between (a) extension-as-proxy with the host app as
  the engine, (b) a stripped-down read-mostly engine in the extension, or
  (c) accepting that sync only happens when the app is open.
- **Background sync.** WS does not survive mobile suspension. Push (APNs /
  FCM) for "data changed, wake up" with WS reconnect on resume is the
  standard pattern but requires server-side push infrastructure — material
  scope outside the VFS itself.
- **Blob storage location on iOS.** Only the App Group container is shared
  between host app and extension. The blob path needs to live there from
  day one; migrating later is painful.
- **Conflict handling is worse on mobile.** Users routinely edit the same
  file across phone and laptop while offline. Conflicted-copy naming has to
  be solid *before* mobile ships, not after.
- **Android background services and battery.** A foreground service with a
  persistent notification is the most reliable option but the most
  user-hostile. `WorkManager` with constraint-based wake-ups is friendlier
  but less timely.

## Other crates

- [`notify`](https://crates.io/crates/notify) — only for Option C, where we
  push changes to the OS. Not needed for A or B; the OS calls us.
- [`tokio-uring`](https://crates.io/crates/tokio-uring) on Linux if blob reads
  become a bottleneck.
- BLAKE3 — already a dependency.
- [`lru`](https://crates.io/crates/lru) for a metadata cache that mirrors the
  kernel attribute cache, so `getattr` does not hit the store on every `ls`.

## Interaction with S3 blob storage

The VFS does blob I/O through `BlobBackend` (see
[s3-blob-storage.md](./s3-blob-storage.md)) and inherits S3 support for free
once that lands. The user-facing pitch — "give me your S3 creds and I back
up your files there cheaply" — is exactly the per-drive Phase 2 design in
that doc: a drive declares its own bucket and credentials, blobs for that
drive go to that bucket, and storage cost lives with the tenant. No new
mechanism is needed on the VFS side.

There are a few places where the two designs actually touch and need to be
designed together rather than independently:

- **Read latency dominates VFS UX when blobs live in S3.** A `cp -r` across
  a 1 GB folder pays 50–200 ms per blob if every byte round-trips through
  S3. The in-memory LRU planned in s3-blob-storage.md Phase 1c is necessary
  for the VFS to feel acceptable, not just nice-to-have. Size it generously
  by default on desktop (≥ 1 GB).
- **Eager materialization is dangerous.** NFS clients tend to prefetch
  directory contents and run `getattr` on every child. That's fine when
  metadata is local, but if the VFS were to also prefetch *bytes* of every
  visible file we would download (and pay egress for) every blob the user
  glances at. VFS reads must be strictly lazy: bytes only on actual `read`
  syscalls, never on `readdir` or `getattr`. Document this contract.
- **Placeholder UX needs native APIs.** Without iOS File Provider /
  Windows Cloud Files / macOS File Provider, the user has no UI signal
  that a file "is not yet local" — clicking it just hangs while S3
  downloads. This is one of the strongest arguments for prioritizing the
  Option C frontends, especially on mobile where the user is also paying
  for the bytes on a metered connection.
- **Presigned redirect downloads are a big win for the VFS.** Phase 3 of
  s3-blob-storage.md (presigned-URL `302` redirects) means large media
  files stream directly from S3 to the OS without touching the desktop
  server's RAM or upstream bandwidth. For a virtual-drive workload that's
  the difference between "watchable 4K video" and "noticeable buffering."
- **GC matters more with the VFS in play.** Every file edit produces a new
  blob; binary editing churn (e.g. opening a docx, saving, opening, saving)
  generates orphan blobs fast. The mark-and-sweep design in
  s3-blob-storage.md Phase 1d should ship before the VFS goes
  read-write, otherwise users will see their S3 bill grow with no obvious
  cause.
- **Mobile metering.** On a phone with metered data, downloading a 500 MB
  blob because Files.app previewed a folder is a complaint waiting to
  happen. Mobile frontends need a "Wi-Fi only" gate at the VFS layer,
  applied before the `BlobBackend` is asked for bytes.

The split of responsibilities to keep clear: `BlobBackend` is *where bytes
live*, the VFS is *when and how bytes are requested*. The VFS does not need
to know what backend a drive uses — but it does need to assume that any
`read` may be slow and expensive, and design its prefetch and caching
accordingly.

## Caching layers

There are five conceptual cache layers in the read path once the VFS exists,
ordered from cheapest to most expensive on a miss:

1. **Kernel attribute / page cache.** Free, configured at mount time
   (`actimeo` for NFS, `entry_timeout` / `attr_timeout` for FUSE). A few
   seconds is the right default: the OS won't re-stat after every `ls`, but
   remote edits become visible without manual refresh.
2. **VFS metadata LRU (new).** In-process, keyed by `did:ad:...` → `FileAttr`.
   Sized in entries, not bytes. Invalidated on commit via the same `DbEvent`
   subscription that drives WS push.
3. **VFS directory-listing LRU (new).** Parent DID → children DIDs. Same
   invalidation policy. Critical because directory enumeration is the
   chattiest operation an OS does.
4. **Blob LRU.** Already planned in
   [s3-blob-storage.md](./s3-blob-storage.md) Phase 1c. The VFS just needs
   it sized generously (≥ 1 GiB on desktop) and is otherwise an unaware
   consumer.
5. **redb / `BlobBackend`.** The cold path. For S3-backed drives this is
   the 50–200 ms hop.

Two existing caches in the codebase do real work and the VFS should not
replicate:

- **Processed image renditions** (`server/src/handlers/download.rs:133–170`).
  Encoded WebP/AVIF results are stored back into `Tree::Blobs` under a
  deterministic content-derived key, so the rendition cache is itself
  content-addressed and is shared automatically between peers that produce
  the same output. When the VFS serves a thumbnail-like read with image
  params, this path is already efficient.
- **Watched-queries cache** (`lib/src/db.rs`). Powers WS live-query push and
  is what the VFS's commit-driven invalidation should subscribe to rather
  than reinventing.

### Caching things the VFS must *not* do

- **No prefetch of blob bytes on `readdir` or `getattr`.** Bytes only on
  actual `read` syscalls. Eager prefetch turns a folder glance into a
  multi-gigabyte S3 download.
- **No long-lived negative cache.** A short (< 1s) negative cache helps
  with autocomplete misfires, but anything longer hides files that just
  arrived via sync.
- **No cross-agent metadata cache reuse.** Each agent has its own ACL view;
  cache entries are scoped per agent. On a single-user desktop install this
  is one bucket, but the abstraction matters for the multi-tenant server
  case.

### Cache invariants

- All VFS caches drop entries on the `source_id`-aware commit notification
  path, regardless of whether the commit came from this connection or
  another. Self-originated commits already update the store before the
  notification fires, so re-reading is cheap.
- Mount-level cache statistics (`hit_rate`, `evictions`, `size`) should be
  exposed through the existing metrics surface (`lib/src/metrics.rs`) for
  operator visibility — caching mistakes in a VFS are very expensive and
  silent, and the easiest way to find them is a hit-rate chart.

## Hard problems the docs don't yet resolve

- **Non-file resources on disk.** `.atomic` stubs leak the abstraction (users
  will try to edit them in a text editor). The cleaner alternative — hide
  non-File resources entirely — costs the "Atomic as your filesystem" pitch.
  Worth a deliberate decision before v1 ships.
- **Binary file conflicts.** CRDTs help for structured resources but not for
  `.psd` or `.docx`. Need Dropbox-style conflicted-copy naming, because
  last-write-wins on binary bytes silently destroys work.
- **Cross-agent share UX.** The pairing-UX gap in [sync.md](./sync.md) gets
  worse when "share" means mounting someone's folder tree on your filesystem.
  Close that gap before exposing cross-agent shares through the VFS.
- **Blob lifecycle.** File → blob is a forward reference and the CAS docs do
  not describe GC. A virtual drive that rewrites files constantly will
  accumulate orphan blobs fast. Refcounting or a sweep pass is required —
  not VFS-specific but the VFS will surface the need immediately.

## v1 slice

Two tracks, sharing the `VfsBackend` trait.

**Desktop (NFS):**

1. **Read-only NFS mount.** Lists folders, serves blob bytes on `read`.
   Validates OS integration and the Store → VFS mapping. ~1–2 weeks.
2. **Writes.** `write` / `create` / `rename` / `remove`, routing through
   `apply_commit_json` with a VFS source-id. ~1–2 weeks.
3. **Conflict handling.** On commit rejection (remote version differs), write
   the local version back as `filename (conflicted copy from <device>).ext`
   and re-fetch the remote.
4. **Blob GC sweep.** Separate task; not VFS-specific but newly urgent.

**Mobile (after desktop step 2 stabilizes the `VfsBackend` trait):**

5. **uniffi bindings for `VfsBackend`.** Generate Swift + Kotlin bindings,
   wire into the existing Flutter app's Rust build.
6. **Android DocumentsProvider, read-only.** Validates the JNI path and the
   Files-app integration. Simpler of the two mobile targets; do it first.
7. **iOS File Provider extension, read-only.** Decide and prototype the
   extension ↔ host-app IPC model on the way in. Higher complexity due to
   the separate-process and memory-cap constraints.
8. **Mobile writes.** Same commit path as desktop, but with mobile-specific
   battery and background-execution guards.

Holding off on the macOS / Windows native cloud-sync API frontends until
desktop steps 1–3 and mobile steps 6–7 are real means the data model is
proved out across five frontends sharing one `VfsBackend` before any
platform-specific cloud-sync code lands.

## Open questions

- Where does the VFS live in the binary — always-on inside `atomic-server`,
  or a separate `atomic-mount` daemon talking to the server over the existing
  HTTP / WS APIs? The latter keeps `atomic-server` itself headless and lets
  the desktop app ship the mount as an optional component.
- Drive selection: one mount per Drive, or a single root that lists all
  Drives the agent has access to as top-level directories?
- How are blobs cached locally for offline use — full mirror, LRU eviction,
  or pinned-by-folder?
- What does the placeholder story look like before we have native cloud-sync
  APIs? NFS can lazy-fetch blobs on `read`, but the user has no way to see
  "this file is not yet local."
