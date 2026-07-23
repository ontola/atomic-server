# Android data reuse — one Atomic store per device

> Status: draft / design. No code yet. Successor to the Android-specific parts
> of [`on-device-atomic-daemon.md`](./on-device-atomic-daemon.md): same goal
> (one store, many apps), but replaces "localhost HTTP daemon" with Android's
> native IPC (Binder: ContentProvider + bound Service), because a resident
> localhost server is exactly what Android's process lifecycle fights against.

## Goal

A device running several Atomic apps — atomic-canvas (Flutter), the
atomic-server Tauri app, future third-party apps — should have **one** copy of
the user's data, **one** agent identity, and **one** device identity (Iroh
node). Every app reads and writes the same store. If an Atomic store already
exists on the device, a newly installed app **reuses it** instead of creating
its own.

Today each app embeds `atomic_lib` and owns a private redb file. Two Atomic
apps on one phone means two full copies of every drive, two Iroh nodes
announcing on pkarr, two agents-or-shared-secrets, and loopback peer sync
between them to stay consistent. That is the duplication this plan removes.

## Where the duplication comes from (current code)

The canvas app is representative:

- `flutter/lib/main.dart:19` — `getApplicationDocumentsDirectory()` +
  `AtomicClient.openDb(dir.path)`: the store is a redb file in the app's
  private sandbox. No other app can ever reach it (Android sandboxing), and
  redb is single-writer anyway (exclusive lock).
- `flutter/rust/src/api/simple.rs` — the FRB surface (~60 functions in 7
  groups: db, agent, drive, resource, canvas, history, peer/sync). Canvas
  domain logic (stroke CRUD, the Loro editing-session cache `CANVAS_CACHE`,
  undo/redo) lives in the same file as the generic store API.
- `flutter/lib/atomic/atomic_client.dart` — a static-method Dart facade that
  calls the FRB bindings directly. There is no seam where a second (remote)
  backend could plug in.
- Sync is per-app: each app starts its own Iroh endpoint (`start_peer`), has
  its own NodeID, its own known-peers list, its own WS session to a hub.

So "sharing the store" cannot mean sharing the file. One process must own the
store; the others must talk to it over IPC.

## Why Binder, not localhost HTTP

The daemon doc proposed a foreground Service serving HTTP/WS on loopback.
Binder IPC is the better fit on Android:

| | localhost HTTP daemon | Binder (ContentProvider / AIDL) |
|---|---|---|
| Process lifecycle | needs a *running* server → foreground service + permanent notification, or it's dead when you need it | components start **on demand**; a provider query cold-starts the host process, OS manages its lifetime |
| Caller identity | none — any app (or webview) can hit localhost; needs its own auth layer | `Binder.getCallingUid()` → package + signing certificate, OS-verified per call |
| Port management | fixed port (9883) squatting, races if two owners start | authorities are declared in the manifest, resolved by the OS, no races |
| Battery | server idles to keep sockets open | zero cost when idle |
| Existing client code | browser client protocol reusable | new (but small) Kotlin/Dart client layer |

The one thing localhost HTTP does better — serving *web* clients (data-browser
in a mobile browser can't do Binder) — stays available as an optional mode:
the host app may additionally serve WS on loopback while foregrounded. Nothing
native depends on it.

## Architecture

```
        ┌──────────────────────── Device ─────────────────────────┐
        │                                                          │
        │   Host app (elected)                                     │
        │   ┌───────────────────────────────────────────────────┐  │
        │   │  redb store · agent secret · Iroh node · tantivy   │  │
        │   │  Kotlin: AtomicProvider (ContentProvider)          │  │
        │   │          AtomicService  (AIDL, subscriptions)      │  │
        │   │  Rust:   atomic_lib via uniffi (no Flutter needed) │  │
        │   └────────────▲──────────────────────▲────────────────┘  │
        │        Binder  │                      │  Binder            │
        │   ┌────────────┴─────────┐   ┌────────┴────────────────┐   │
        │   │ atomic-canvas        │   │ third-party app         │   │
        │   │ (client mode:        │   │ (client SDK + grant)    │   │
        │   │  same user agent)    │   │                         │   │
        │   └──────────────────────┘   └─────────────────────────┘   │
        └──────────────────────────────│───────────────────────────┘
                                       │ Iroh / WS (host only)
                                       ▼
                          other devices, hosted server
```

- **Host**: the single owner of redb + secret + Iroh node. Exposes the store
  over a ContentProvider (reads, one-shot ops) and a bound AIDL service
  (subscriptions, streams). Runs sync. Cold-starts on demand.
- **Clients**: no store, no node, no secret. All reads/writes over Binder.
- **Election**: every Atomic-capable app ships both modes; at startup it
  discovers whether a host exists and becomes a client if so ("reuse
  atomic-server if it's already somewhere").

## The IPC protocol is mostly already designed

The key realization: Atomic's existing primitives map 1:1 onto Binder
surfaces, so the protocol layer is thin:

- **Writes are commits.** A signed commit is already the serialized,
  self-authorizing write operation — it is what `save_and_push` pushes over
  WS and what peers exchange over Iroh (including `commit.loro_update` bytes
  for CRDT edits). A client submits a commit via `provider.call("commit",
  json)`; the host validates and applies it through the exact pipeline remote
  commits already use (`apply_commit` + rights validation). No new write
  semantics.
- **Reads are JSON-AD.** `call("get", subject)` returns the resource as
  JSON-AD; `call("query", q)` returns subjects + resources. A tabular
  `query()` cursor view can come later for vanilla-Android consumers
  (`content://dev.atomicdata.provider/...`), but `call()` carries the graph
  shape without forcing it into a `Cursor`.
- **Live updates are sync frames over AIDL.** The subscription callback
  carries the same `UPDATE` / `COMMIT` frames the WS session carries
  (`unified-sync.md`'s frame set) — Binder becomes just another transport
  under unified sync, the same move `reticulum-sync.md` makes for Reticulum.
  A client-side Loro editing doc (§4b) consumes `loro_update` bytes
  identically whether they arrived over Binder or Iroh.
  `ContentResolver.notifyChange(uri)` per subject stays as the cheap wake-up
  signal for vanilla `ContentObserver` consumers that just re-fetch.
- **Blobs / uploads** stream over `openFile`/`ParcelFileDescriptor`.

**Why reads are not the sync protocol.** The sync protocol reconciles two
*stores*; a thin client has none. Reading via sync means every client holds a
replica — its own redb, indexes, and cold-start cost per app, i.e. the
duplication this plan removes — and third-party grants would require
materializing *rights-scoped partial replicas* per grant, a far harder
authorization problem than filtering one response host-side. The data-browser
sets the precedent: it fetches JSON-AD over HTTP and takes UPDATE frames over
WS; sync never replaced resource GET there either. `call("get")` is the
Binder analog of that GET. Full sync-over-Binder (client keeps a store, host
as its local peer) remains coherent as an **opt-in replica mode** for a
heavyweight user-tier app that needs full offline — never the default, never
the third-party surface.

**Loro state vs JSON-AD projection.** A Loro doc is strictly more information
than the state it renders: the snapshot carries full history — deleted
content, timestamps, peer IDs, commit messages (genesis carries `createdBy`)
— and CRDT ops cannot be redacted without breaking the doc. Exporting Loro
state is therefore a *higher* privilege than read. Tiers:

- **Reads: JSON-AD only.** Rights-filterable host-side, O(current state),
  and no Loro runtime required in consumers. Holds even after
  `loro-source-of-truth.md` makes Loro authoritative internally — the
  projection stays the exchange format.
- **Open-for-edit (§4b): a shallow snapshot** trimmed at the current version
  — enough to append, merge incoming `loro_update` frames, and undo within
  the session, without shipping the resource's past. Delivered over
  `ParcelFileDescriptor`; incremental updates over the frame channel.
- **History (browse / scrub / restore): host-side API calls** — the existing
  `warm_resource_history` / `get_resource_at_version` group, rights-checked
  per call. History is never exported.
- **Full doc: user-tier replica mode only.**

## What it takes — work items

### 1. Rust: split the generic API out of the canvas crate

`flutter/rust/src/api/simple.rs` mixes the generic store SDK with canvas
domain logic. Extract the generic part (db/agent/drive/resource/history/sync
groups) into a crate the host can bind from Kotlin — either a new `atomic-ffi`
crate or a feature of `atomic_lib` (this is the `atomic-lib-runtime.md`
direction: `atomic_lib` as the complete HTTP-optional local node).

The host's provider must run **without a Flutter engine** — a provider query
from another app must not boot Dart. Recommended: **uniffi** to generate
Kotlin bindings over the same crate. Pitfalls already known from the Android
build work apply to any non-Flutter entry point: rustls-platform-verifier
needs JNI init before any HTTPS, and store durability needs explicit
`flush()` after critical writes because the host process can be killed the
moment the calling app unbinds.

### 2. Kotlin: an `atomic-android` AAR with both roles

One library, shipped inside every Atomic app:

- **Host role**: `AtomicProvider` + `AtomicService`, backed by the uniffi
  bindings; manifest-declared with a `<meta-data android:name=
  "dev.atomicdata.HOST" android:value="<priority>">` marker. Enforces
  authorization on every call (see §identity).
- **Client role**: a small typed SDK wrapping `ContentResolver` — the Kotlin
  mirror of today's `AtomicClient` Dart facade.
- **Election**: query `PackageManager` for providers carrying the HOST
  metadata; pick deterministically (dedicated Atomic app > highest priority >
  earliest install). Listen for `ACTION_PACKAGE_ADDED/REMOVED` to re-elect.
  Losers disable their provider component (`setComponentEnabledSetting`) so
  only one authority is ever active; the redb lock is the backstop against
  races.

### 3. Dart: make `AtomicClient` a seam

Turn the static facade into an interface with two implementations:

- `FfiAtomicClient` — today's FRB path (used in host/standalone mode, and on
  iOS/desktop/web where nothing changes).
- `IpcAtomicClient` — MethodChannel → the Kotlin client SDK.

`main.dart`'s `openDb(dir.path)` becomes `AtomicRuntime.start()`: run
election, then either open the local store (host/standalone) or bind to the
elected host (client). App code above the facade doesn't change.

### 4. Canvas editing under a thin client

The Loro editing session (undo/redo, `CANVAS_CACHE`) currently lives in Rust
*next to the store*. Two options once canvas may not own the store:

- **(a) Session lives host-side.** Expose `push_stroke` / `undo` / `redo` /
  history over IPC unchanged. Cheapest migration — the existing per-canvas
  mutex + cache-invalidation logic keeps working, one stroke = one Binder
  call (Binder round-trips are sub-millisecond; fine at stroke rate).
- **(b) Session lives client-side.** The client keeps an in-memory Loro doc
  for the *open canvas only* and submits commits carrying `loro_update`
  bytes — exactly the commit shape `save_and_push` already produces. The
  client becomes an "editing peer without a store": instant local echo,
  offline-tolerant per open document, no persistent second copy.

Recommendation: (a) for phase 1 (mechanical), evolve to (b) — it is the same
local-first feel canvas has today and it degrades gracefully when the host is
briefly unavailable. The stale-session hazards already solved in `simple.rs`
(`refresh_editing_session`, invalidate-on-remote-change) carry over to (b) as
"import host updates into the open doc before appending".

### 5. Identity and authorization

Two tiers, matching who the caller is:

- **First-party apps** (signed with the same certificate as the host, or
  explicitly user-approved as "this is also me"): act as the user. The agent
  secret stays **only** in the host; clients never hold it. A client submits
  an unsigned op; the host verifies the caller's package + signing cert over
  Binder and signs with the user agent before applying. Binder identity
  replaces the signature for the local hop — this is the "sign at the point
  of trust" shape (`sign-at-drain.md`), and it shrinks the secret's blast
  radius from N app sandboxes to one.
- **Third-party apps**: per-app grants — the consent-screen flow from the
  Android IPC exploration (request intent → user approves scope → Grant
  stored). A grant maps to a real Atomic Agent created for that (package,
  cert) pair and added to the target resource's read/write rights, so
  enforcement is the existing rights system (`authorization-sync.md`), the
  grant list is an ordinary collection, and revocation is removing the agent
  from rights. No parallel permission model.

Every provider entry point checks: calling UID → package(s) → signing cert →
tier → (for third parties) grant + scope. An unguessable capability ID adds
nothing once identity is cert-bound; don't rely on one.

### 6. Sync consolidation

Only the host runs Iroh, pkarr announce, WS hub sessions, and known-peers.
The device presents as **one** peer instead of N. All the sync hardening
(relayed-drive authorization, stored-relay re-dial, `flush()` durability)
lands in exactly one place. Client apps drop their `peer` API group entirely;
"sync now" becomes an IPC call that asks the host to do it.

## Hard problems

**Host uninstall loses the store.** The redb file lives in the host app's
private dir; uninstalling the host deletes it. There is no pre-uninstall hook.
Treat the host store like a device in the sync model: recoverable by
re-election (another app becomes host, starts empty, re-syncs the drives from
other devices / the hub over existing drive replication). The unacceptable
case is a single-device user with no hub — mitigations: nudge toward hub sync
or periodic export (SAF / Auto Backup). This must be designed before third
parties depend on the host.

**Standalone-first, host-appears-later migration.** Canvas installed alone
runs standalone (embedded store — the current behavior is the fallback mode).
When a higher-priority host appears, canvas must hand over: replicate its
drives into the new host over Binder (same replication path as
`sync_drive_to_server`), verify in-sync, flip to client mode, delete the local
store. Get this wrong and we've *created* duplication; the in-sync
verification before deletion is non-negotiable.

**Cold-start latency is now another app's latency.** A provider query
cold-starts the host process and opens the store; store open cost grows with
file age (`disk-storage-and-persistence-optimization.md`). That work stops
being a nicety and becomes a prerequisite for "feels native" third-party
queries. Also: never put the provider in a separate `android:process` — the
store singleton and the provider must share one process.

**Search leakage.** The full-text index is store-wide; every search through a
grant must filter results by that grant's visibility. Leaking titles/snippets
of unauthorized resources through search is the classic broker bug.

**Platform divergence.** iOS has no cross-app IPC like this (app groups only
within one developer account); desktop has no OS-verified caller identity at
all. The *grant model* (principal descriptor, resource, scopes, expiry) is
platform-neutral and shared; the *enforcement transport* is per-platform
(Binder here; `virtual-drive.md` explores the desktop shapes). Don't force one
transport abstraction across them.

## Phasing

- **Phase 0 — status quo interim** (per the daemon doc): shared-secret
  handoff, dual stores reconciling over loopback Iroh. Correct but wasteful;
  everything below removes it.
- **Phase 1 — extract + host.** Split the generic Rust API out of
  `simple.rs`; build the `atomic-android` AAR (uniffi bindings, provider,
  client SDK, no election yet). The atomic-server Tauri app becomes the fixed
  host; canvas gains `IpcAtomicClient` and uses the host **when installed**,
  embedded store otherwise. This alone delivers "reuse atomic-server if it's
  already somewhere".
- **Phase 2 — election + handover.** Any Atomic app can host; deterministic
  election; standalone→client migration with verified replication before
  local-store deletion. Canvas thin-client editing moves from host-side
  sessions (4a) to client-side Loro docs (4b).
- **Phase 3 — third-party surface.** Grant consent flow, grants-as-agents,
  scoped search, published client SDK. Optionally a `DocumentsProvider`
  facade so Atomic files appear in every Android file picker.

## Open questions

- Is the dedicated tiny "Atomic daemon" app (daemon doc option b) worth it
  once election exists, or does election make it unnecessary?
- Does the host keep a foreground service *while syncing* (long Iroh
  reconciles) and stop after, or rely on `WorkManager` for background sync?
- How does the web data-browser on the same device fit — optional loopback WS
  from the host while foregrounded, or not at all on Android?
- Grant expiry / "allow once" semantics: is "allow once" just a short expiry
  (unifies the consent UI)?
- Do first-party-but-different-developer apps (future: apps by others that
  the user fully trusts) get a user-approved path to the "act as user" tier,
  or is that tier strictly same-signature?

## Relationship to existing work

- Supersedes the Android transport choice in
  [`on-device-atomic-daemon.md`](./on-device-atomic-daemon.md); its problems
  1/2/4 (single owner, lifecycle, client auth) are resolved here by election,
  on-demand Binder components, and cert-bound tiers respectively. Its
  localhost-daemon shape may still fit desktop.
- Depends on the [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) direction
  (`atomic_lib` as a complete embeddable node) and on
  [`disk-storage-and-persistence-optimization.md`](./disk-storage-and-persistence-optimization.md)
  for cold-start cost.
- Reuses commits-as-write-certificates
  ([`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md)),
  rights-based enforcement ([`authorization-sync.md`](./authorization-sync.md)),
  and host-side signing ([`sign-at-drain.md`](./sign-at-drain.md)).
- The drive replication used for handover is the one canvas already ships in
  `sync_drive_to_server` (`flutter/rust/src/api/simple.rs`).
