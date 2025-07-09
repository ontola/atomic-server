# AGENTS.md

Guidance for coding agents working in this repo.

## Local Setup

- `http://localhost:5173` — Vite dev server (frontend).
- `http://localhost:9883` — local Atomic Server.

The frontend auto-updates via HMR. If changes don't appear, reload the page. If you edit `@tomic/lib` or `@tomic/react`, those packages may need a rebuild first.

## Quick Dev Setup

Navigate to `http://localhost:5173/app/dev-drive` to instantly create a fresh agent + drive on `localhost:9883` and switch to it. Only works in dev mode.

In E2E tests, most specs use `test.beforeEach(before)` from `test-utils.ts`, which calls `devDrive(page)` and gives every test a fresh agent + drive. For a second browser context signed in as the same user, use `getDevDriveSecret(page)` after `before` has run. Call `devDrive(page)` directly only when a spec does not use the shared `before` hook.

## Charlotte / Browser Automation

- Always operate the app at `localhost:5173`, not `9883` directly.
- Start every session by navigating to `http://localhost:5173/app/dev-drive` to get a clean, authenticated state.
- If the app shows `Unauthorized` or `Something went wrong`, navigate to `/app/dev-drive` to fix it.

## Debugging Checklist

- Is the frontend open on `5173`?
- Is the active drive/server `9883`?
- Is there a signed-in agent?
- Run `devDrive(page)` to reset to a clean state.

## Architecture Overview

Atomic Server is a graph database with real-time sync, built on **Loro CRDT** for conflict-free collaborative editing.

### Crates
- **`atomic_lib`** (`lib/`) — Core library. WASM-compatible (no `ring`, no `rt-multi-thread`). Contains Resource, Commit, Store, Loro integration, WS client, connected Client API.
- **`atomic-server`** (`server/`) — Actix-web HTTP/WS server. Uses `atomic_lib` + sled DB + search (tantivy).
- **`@tomic/lib`** (`browser/lib/`) — TypeScript client library.
- **`@tomic/react`** (`browser/react/`) — React hooks.
- **`data-browser`** (`browser/data-browser/`) — The web app (React + TipTap + Loro).

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
4. `loro_value_to_atomic_value()` materializes Loro values to Atomic `Value` types
5. Loro snapshot stored alongside PropVals for future merges

### Loro value serialization in the Map
- Strings, numbers, booleans → stored directly
- `ResourceArray` → JSON string `["url1", "url2"]`
- `AtomicUrl` → plain string
- `loro_value_to_atomic_value()` parses back: strings starting with `[` → ResourceArray, `{` → NestedResource

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

| Message | Direction | Purpose |
|---|---|---|
| `AUTHENTICATE {json}` | C→S | Auth |
| `AUTHENTICATED` | S→C | Confirmed |
| `SUBSCRIBE {subject}` | C→S | Commit notifications |
| `COMMIT {json}` | S→C | Applied commit |
| `LORO_SYNC_SUBSCRIBE {json}` | C→S | Real-time Loro sync |
| `LORO_SYNC_UPDATE {json}` | Both | Loro binary (base64) |
| `LORO_EPHEMERAL_UPDATE {json}` | Both | Cursors/presence |

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

## Testing

```
cargo test -p atomic_lib --no-default-features  # 76 tests
cargo test -p atomic-server --lib               # 23 tests
cargo test -p atomic-server --test sync          # E2E: real server, 2 agents, WS sync
cd browser/lib && pnpm test                      # 29 JS tests
cd browser && pnpm run -r build                  # Full workspace build
```

## Watch Out For

1. **ChatRoom plugin** (`chatroom.rs`): Fake commit must include full messages array — Loro `set` replaces, doesn't append.
2. **Empty Loro updates**: ~22 byte header only. `exportLoroDelta()` filters with `<= 28` byte threshold.
3. **`default_store.json`**: `loroUpdate` property and `lorodoc` datatype must be present. New servers need `--initialize`.
4. **CSP**: Includes `'wasm-unsafe-eval'` for Loro WASM in browser.
5. **`build.rs`**: Watches `lib/src`, `react/src`, `data-browser/src`. Delete `server/assets_tmp` to force JS rebuild.
6. **`CommitBuilder.push_propval`**: Starts from empty, not from resource's existing value. Load current value first if appending.
