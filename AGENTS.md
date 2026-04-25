# AGENTS.md

Guidance for coding agents working in this repo.

## Local Setup

- `http://localhost:5173` — Vite dev server (frontend). (`cd browser && pnpm dev`)
- `http://localhost:9883` — local AtomicServer. (`cd server && cargo run`)

The frontend auto-updates via HMR. If changes don't appear, reload the page. If you edit `@tomic/lib` or `@tomic/react`, those packages may need a rebuild first.

## Planning

Use the `./planning` folder to write plans and keep track of progress.
Use todo lists and checkboxes to track progress.
Make sure to update the planning as you find new insights and see outdated planning text.

## Quick Dev Setup

Navigate to `http://localhost:5173/app/dev-drive` to instantly create a fresh agent + drive on `localhost:9883` and switch to it. Only works in dev mode.

In E2E tests, most specs use `test.beforeEach(before)` from `test-utils.ts`, which calls `devDrive(page)` and gives every test a fresh agent + drive. For a second browser context signed in as the same user, use `getDevDriveSecret(page)` after `before` has run. Call `devDrive(page)` directly only when a spec does not use the shared `before` hook.

## Charlotte / Browser Automation

- Operate the app at `localhost:5173` for quick iterations on react code.
- Start every session by navigating to `http://localhost:5173/app/dev-drive` to get a clean, authenticated state.
- If the app shows `Unauthorized` or `Something went wrong`, navigate to `/app/dev-drive` to fix it.

## Debugging process

1. Identify the bug, where it's coming from.
2. Reproduce the bug in a test at the right abstraction level. E2E tests are the most expensive, so try to find a different level if possible.
3. After reproduction in a failing test, fix the bug until the test and all other tests are green again

## DevTools Console Helpers

In dev mode, `window.devtools` exposes diagnostics for inspecting a resource across every persistence layer. Run `devtools.help()` for the list. Most useful:

| call                         | what it does                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `devtools.inspect(subject?)` | JS store + WASM/OPFS + server HTTP GET, side-by-side. Defaults to the URL's `?subject=` (or current drive). |
| `devtools.opfsList(prefix?)` | Subjects in the WASM DB (default prefix `did:ad:`)                                                          |
| `devtools.wsLog(n?)`         | `console.table` of the last N commit log entries                                                            |
| `devtools.problems()`        | Resources currently loading, errored, or new                                                                |
| `devtools.forcePut(subject)` | Re-serialize a JS-store resource into OPFS with round-trip verification                                     |

Source: `browser/data-browser/src/helpers/devtools.ts`.

## Architecture Overview

Atomic Server is a graph database with real-time sync, built on **Loro CRDT** for conflict-free collaborative editing.

### Crates

- **`docs`** (`docs`) — Public-facing Atomic Data spec and product documentation. Describes how the protocol works, very important.
- **`planning`** (`planning/`) — Internal design notes and larger technical direction. Read `planning/README.md` and the relevant plan before broad architectural work.
- **`atomic_lib`** (`lib/`) — Core library powering atomic-server + WASM / OPFS browser storage.
- **`atomic-server`** (`server/`) — Actix-web HTTP/WS server. Uses `atomic_lib` + search (tantivy).
- **`@tomic/lib`** (`browser/lib/`) — TypeScript client library, powering the other JS projects
- **`@tomic/react`** (`browser/react/`) — React hooks.
- **`data-browser`** (`browser/data-browser/`) — The web app (React + TipTap + Loro), feels similar to notion.
- **`flutter/`** — Cross-platform canvas app (Android/iOS/Web). Uses `flutter_rust_bridge` to call `atomic_lib`. See `flutter/README.md` and `flutter/AGENTS.md`.

### Data model

- **Resource** = property-value pairs with a Subject URL, backed by a Loro CRDT document.
- **Commit** = a signed mutation containing `loroUpdate` (base64 Loro binary).
- **Agent** = Ed25519 keypair, identified by `did:ad:agent:{publicKey}`.
- **Drive** = top-level container resource.

## Loro CRDT — How It Works

**Loro is the sole state management engine.** The old `set`/`remove`/`push` commit fields are deprecated and rejected by the server.

### Client side (TypeScript)

1. `resource.set(prop, value)` → writes to LoroDoc's `"properties"` map + sets `_dirty`
2. `resource.save()` → `exportLoroDelta()` → base64 → commit `loroUpdate` → sign → POST
3. Incoming WS commits: `execLoroUpdateCommit()` imports Loro binary into resource's LoroDoc, materializes properties into propvals

### Server side (Rust)

1. Commit arrives at `/commit`
2. `apply_changes()` imports `loroUpdate` into resource's LoroDoc
3. `import_update_with_diff()` computes add/remove atoms for search indexing
4. `loro_value_to_atomic_value_tagged()` materializes Loro values to Atomic `Value` types, using the `datatypes` map
5. Loro snapshot stored alongside PropVals for future merges

### Loro value serialization in the Map

The LoroDoc has two sibling root maps:

- **`properties`** — `property URL → value`. Loro primitives stored directly
  (strings, numbers, booleans); arrays as native `LoroList`s; objects as JSON strings.
- **`datatypes`** — sparse `property URL → tag`, recording the datatype only
  where a bare primitive is ambiguous in a load-bearing way. Tags: `atomicUrl`,
  `resourceArray`, `json`, `resource`. Scalars and plain/cosmetic
  strings carry no entry. Written by `set_property` (Rust) and
  `Resource.writeDatatypeTags` at sign time (TS).

Materialization prefers the tag: `loro_value_to_atomic_value_tagged()` recovers
the exact `Value` variant from it. Untagged values fall back to the
`loro_value_to_atomic_value()` heuristic (URL-shaped strings → `AtomicUrl`,
`{...}` → `NestedResource`), kept for legacy / not-yet-tagged docs. Cosmetic
datatypes (`markdown`/`slug`/`date`/`uri`, `timestamp`) are deliberately not
tagged — they collapse to `string`/`integer`; the Property's `datatype` stays
authoritative. See `planning/loro-source-of-truth.md`.

### Critical: always build on existing state

When editing a resource, load the existing Loro snapshot first, then edit on top. Creating a fresh LoroDoc for each edit causes LWW conflicts. The `CommitBuilder` on the server converts `set`/`remove` to Loro at sign time via `sign_at()`.

## Commit Structure

```json
{
  "https://atomicdata.dev/properties/subject": "did:ad:{genesis}",
  "https://atomicdata.dev/properties/signer": "did:ad:agent:{publicKey}",
  "https://atomicdata.dev/properties/loroUpdate": "base64...",
  "https://atomicdata.dev/properties/signature": "base64...",
  "https://atomicdata.dev/properties/createdAt": 1775504552928,
  "https://atomicdata.dev/properties/previousCommit": "did:ad:commit:{sig}",
  "https://atomicdata.dev/properties/isGenesis": true
}
```

- `loroUpdate` is a plain base64 string (not a `{type, data}` object)
- `set`, `push`, `remove` are **rejected** by the server
- Signature: deterministic JSON-AD (sorted keys, minified, no `@id`, no signature field)
- Genesis commits: `subject` excluded from signed bytes (derived from signature)

## Subject Type

`Subject` is an enum: `Internal` (`internal:/path`), `External` (`https://...`), `Did` (`did:ad:{genesis}`).

`Commit.subject` and `Commit.signer` are `Subject`, not `String`.

Equality is by URL string only — `drive_hint` and `subdomain` don't affect identity (custom `PartialEq`/`Hash`).

## WebSocket Protocol

| Message                        | Direction | Purpose              |
| ------------------------------ | --------- | -------------------- |
| `AUTHENTICATE {json}`          | C→S       | Auth                 |
| `AUTHENTICATED`                | S→C       | Confirmed            |
| `SUBSCRIBE {subject}`          | C→S       | Commit notifications |
| `COMMIT {json}`                | S→C       | Applied commit       |
| `LORO_SYNC_SUBSCRIBE {json}`   | C→S       | Real-time Loro sync  |
| `LORO_SYNC_UPDATE {json}`      | Both      | Loro binary (base64) |
| `LORO_EPHEMERAL_UPDATE {json}` | Both      | Cursors/presence     |

**Pattern:** Subscribe to broadcast BEFORE sending a message that expects a response.

## Cryptography

Uses **ed25519-dalek** (pure Rust, WASM-compatible). Server keeps `ring` for TLS only.

## Resource (Rust)

```rust
pub struct Resource {
    propvals: PropVals,              // Read cache
    subject: Subject,
    commit: CommitBuilder,           // Legacy server-side
    loro: Option<AtomicLoroDoc>,     // CRDT doc, lazy
}
```

- `save()` — server-side (CommitBuilder → Loro → apply locally)
- `save_remote(store)` — client-side (propvals → Loro → export → sign → HTTP POST)
- `save_as_genesis(store)` — DID resource, subject = `did:ad:{signature}`

## Rich Text

TipTap + `loro-prosemirror` (`LoroSyncPlugin`, `LoroUndoPlugin`, `LoroEphemeralCursorPlugin`).
Real-time: `useLoroSync` hook → `LORO_SYNC_UPDATE` WebSocket.

## History Page

Loro OpLog time-travel: `doc.getAllChanges()` → sort → `doc.checkout(frontiers)` per version. Instant, no network round-trips.

## Iroh P2P Sync

Devices sync via [Iroh](https://iroh.computer) QUIC connections. The transport is in `lib/src/sync/`:

- **`peer.rs`** — Iroh endpoint, Router (must stay alive for incoming connections), persistent NodeID (secret key stored in redb), known peers list.
- **`engine.rs`** — Transport-agnostic sync engine. Compares Loro version vectors, computes diffs, imports snapshots. Used by both WS and Iroh.
- **`protocol.rs`** — Binary frame encoding: AUTH, SYNC, SYNC_DIFF, SYNC_PUSH, SYNC_OK, GET, UPDATE.

### Sync flow (QR pairing)

1. Both devices start Iroh (`peer::start()`) → get persistent NodeID, connect to n0 relay
2. Device A shows QR code containing `did:ad:node:<nodeId>`
3. Device B scans QR → calls `peer_sync(nodeId)` → `sync_drive_with_peer()`
4. B→A: AUTH, SYNC (with B's version vectors)
5. A→B: SYNC_DIFF (what to push/pull), SYNC_PUSH (A's data)
6. B→A: SYNC_PUSH (B's data for A's pull list)
7. Both devices now have each other's data

### Key details

- The `Router` must be kept alive globally (`ROUTER` static) — dropping it stops incoming connections.
- After sending the final SYNC_PUSH, call `send.finish()` + short delay so the server processes it before the connection drops.
- Loro snapshots are stored in `Tree::LoroSnapshots` keyed by `Subject::pure_id()` (strips query params/drive hints).
- `collect_drive_subjects()` and `build_drive_vvs()` must use `pure_id()` consistently to match snapshot keys.

### Node identity

- `did:ad:node:<hex>` — URI format for Iroh NodeIDs, used in QR codes and UI.
- NodeIDs are persistent — derived from a secret key stored in redb (`Tree::PluginMeta`).
- Known peers are also stored in `Tree::PluginMeta` as a JSON array.

## Testing

```
cargo test -p atomic_lib --no-default-features  # 76 tests
cargo test -p atomic-server --lib               # 23 tests
cargo test -p atomic-server --test sync          # integration test: real server, 2 agents, WS sync
cargo test -p atomic_lib --features "iroh,discovery,db-redb" --lib -- sync::tests  # Iroh sync tests (incl. live sync)
cargo test -p atomic_lib --features "iroh,db-redb" --lib -- sync::iroh_e2e -- --test-threads=1  # Iroh e2e: bulk + live + folderId
cd browser/lib && pnpm test                      # 29 JS tests
cd browser && pnpm run -r build                  # Full workspace build
cd browser && pnpm run test-e2e                  # Full e2e test
```
