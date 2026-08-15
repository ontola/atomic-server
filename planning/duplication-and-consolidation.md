# Duplication and consolidation audit (2026-08-15)

Index of things that exist more than once, and whether they should stay that
way. This is a map, not a rewrite plan. How a listed copy is allowed to land is
[`consolidation-contract.md`](./consolidation-contract.md): characterization
tests on the old code, then a line-count gate so the remaining path is smaller
and the old behavior is still pinned.

Where a dedicated plan already owns the work, this file links to it instead of
restating it.

**Related plans (do not duplicate):**

| Plan | What it already covers |
| --- | --- |
| [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) | Node API; blob/search/query owned by `atomic_lib`; Flutter/WASM as thin bindings |
| [`unified-sync.md`](./unified-sync.md) | One sync API; WS vs Iroh; remaining `handle_frame` gaps; AUTH/VV/blob-hash copies |
| [`unified-data-layer.md`](./unified-data-layer.md) | Browser ingress, outbox, subscriptions, dirty signals |
| [`loro-source-of-truth.md`](./loro-source-of-truth.md) + [`unify-resource-representations.md`](./unify-resource-representations.md) | Loro doc as authority; `PropVals` / `_cache` as derived |
| [`unify-subscription-primitives.md`](./unify-subscription-primitives.md) | Server `SUB` / `SUBSCRIBE` / `SUBSCRIBE_QUERY` → one match type |
| [`canvas-undo-consolidation.md`](./canvas-undo-consolidation.md) | Flutter Dart action stack vs Loro undo (Phase B still open) |
| [`structural-problems-index.md`](./structural-problems-index.md) | Ranked structural issues that overlap several of the above |
| [`sync-onboarding-ux.md`](./sync-onboarding-ux.md) | Browser ↔ Flutter twin map for pairing / servers / onboarding |

## How to classify a duplicate

1. **Must dual-maintain** — two languages, same bytes (signing, wire tags, genesis). Keep both; generate or golden-test.
2. **Should be one implementation** — same crate, same job, two call paths that can drift.
3. **Intentional twins** — browser UI and Flutter UI. Do not merge codebases; share specs and golden tests.
4. **Leftover** — deprecated path still imported, or a migration half-done.

---

## Highest leverage

These are the copies that actually cause bugs, or that keep growing in pairs.

### 1. Three commit-ingest paths with different validation

HTTP `/commit` and hub WS `COMMIT` go through `engine::ingest_commit_json`
(`lib/src/sync/engine.rs`). That is the intended hub. Two other paths still
apply commits with weaker or different `CommitOpts`:

| Path | File | Signature | Timestamp | Rights | Previous-commit |
| --- | --- | --- | --- | --- | --- |
| Hub HTTP/WS | `server/src/handlers/commit.rs` → `ingest_commit_json` | yes | hub policy | yes | hub policy |
| Flutter WS receive | `lib/src/sync/ws_apply.rs::apply_commit_json` | **yes** | **no** | **no** | **no** |
| WASM `apply_commit` | `wasm/src/lib.rs` | own `CommitOpts` block | own | own | own |

`ws_apply::apply_commit_json` is the Flutter WS ingest. **Done (2026-08-15):**
it is a thin wrapper around `ingest_commit_json` with
`CommitIngestOpts::replica()` (signature on, rights and timestamp off —
the hub already checked; local ACL may be incomplete). WASM `apply_commit`
still builds its own `CommitOpts`.

`Resource::save` / `save_locally` / `save_as_genesis` / `save_remote` /
`apply_signed_commit` (`lib/src/resources.rs`) each construct another
`CommitOpts` literal. Same apply core, inconsistent policy.

**Consolidate:** one `CommitIngestOpts` (already exists for hub vs peer) used
by `ws_apply` and WASM too. Collapse `save_*` to `AtomicNode::mutate` per
[`atomic-lib-runtime.md`](./atomic-lib-runtime.md).

### 2. Loro merge/persist written twice

`lib/src/sync/ws_apply.rs::resolve_update` + `persist_update` (~160 lines:
load snapshot, import, materialize, resolve drive, persist) parallels
`engine.rs` sync-push import and `resources.rs::merge_persisted_state`.

The drive-spoof fix (F2 in `unified-sync.md`) lives on the `ws_apply` path
with its own tests. The engine path must not grow a second copy of that
check.

**Consolidate:** one `import_and_materialize(subject, bytes) -> ResolvedUpdate`
used by live WS, Iroh, and engine push.

### 3. Wire protocol in two languages

Canonical spec: `docs/src/websockets.md`.

| Side | File | ~lines |
| --- | --- | --- |
| Rust | `lib/src/sync/protocol.rs` | 969 |
| TypeScript | `browser/lib/src/ws-v2.ts` | 749 |

Both files say "update the other in the same change." Drift today:

- Rust has `HELLO` (`0x37`); TS `Tag` enum does not.
- Error classification: `protocol::classify_commit_error` vs string matchers
  in `browser/lib/src/local-outbox.ts`.
- Legacy text frames (`LORO_SYNC_*`, `SYNC_VV`) still parsed in both
  `lib/src/client/ws.rs` and `browser/lib/src/websockets.ts`.

**Consolidate:** generate TS constants/encoders from the Rust module or from
the markdown spec. Until then, a round-trip fixture (Rust encode → TS decode
and back) is cheaper than codegen.

`cleanup-update-encoding.md` already unified `decode_update` on the Rust
side; the remaining problem is the language boundary.

### 4. Ontology URLs in three places

| Source | Status |
| --- | --- |
| `lib/src/urls.rs` | Hand-written Rust constants (authoritative for server/lib) |
| `browser/lib/src/ontologies/*.ts` | Generated by `@tomic/cli` from live ontology resources |
| `browser/lib/src/urls.ts` | **Deprecated**, still imported |

Remaining `urls.ts` importers (all in `@tomic/lib`):

- `resource.ts` — `GENESIS`, `properties`, `instances`
- `store.ts` — `BLOB`, `endpoints`, `INTERNAL_ID`
- `websockets.ts` — `BLOB`
- `invites.ts` / `invites.test.ts` — `properties`
- `index.ts` — re-exports the whole deprecated module

TS generation exists; Rust does not. Datatype URL strings are also copied
into `browser/lib/src/datatypes.ts` (`enum Datatype`).

**Consolidate:** finish deleting `urls.ts`. Generate `urls.rs` from the same
ontology source as the TS files (or from `lib/defaults/`).

### 5. Datatype tags: same table, two functions, different timing

Load-bearing Loro tags (`atomicUrl`, `resourceArray`, `json`, `resource`,
plus cosmetic `markdown`/`slug`/`uri`/`date`/`timestamp`/`localizedText`):

| | Rust | TypeScript |
| --- | --- | --- |
| Write | `datatype_tag()` in `lib/src/loro.rs`, at `set_property` | `datatypeTag()` in `browser/lib/src/datatypes.ts`, at **sign time** (`writeDatatypeTags`) |
| Read | `loro_value_to_atomic_value_tagged` | `normalizeLoroValue` / `rebuildCacheFromLoro` (subset) |

TS does not emit a `resource` tag; it relies on the server heuristic for
nested objects. Untagged values fall back to Rust heuristics that TS does
not replicate (URL-shaped strings → `AtomicUrl`, `{...}` → nested resource).

Validation regexes (`SLUG_REGEX`, `DATE_REGEX`, `LANG_TAG_REGEX`) are
copied between `lib/src/values.rs` and `browser/lib/src/datatypes.ts`.

**Consolidate:** one JSON tag table + golden tests (the genesis-certificate
pattern in `lib/src/genesis.rs` ↔ `browser/lib/src/genesis.ts` is the model).
Writing tags at different times is a real drift risk: a crash between
`set` and `save` leaves an untagged doc.

### 6. Subject types have drifted

Rust `lib/src/subject.rs`: `Internal` / `External` / `Did`, `drive_hint`,
`pure_id()` equality (query params do not affect DID identity).

TS `browser/lib/src/subject.ts`: branded `string`; `did:ad:` or `https?://`
only. No `internal:`, no `pure_id()` equality.

Plan: [`subject-types-end-to-end.md`](./subject-types-end-to-end.md)
(started, consumer migration not done). Until that lands, TS string compare
and Rust `pure_id()` can disagree on the same DID.

### 7. Search and blobs still live in the server crate

Blocks the runtime plan. Concrete copies:

- **Tantivy escape** in two languages, bound by `testdata/search-query.json`:
  `browser/lib/src/search.ts` `escapeTantivyKey` and
  `lib/src/client/search.rs` `escape_tantivy_key`. The File-picker repro
  reads the escaped `isA` key from that fixture instead of a third copy.
  `SearchOpts` / `build_search_subject` are also dual (same fixture).
- **Blob write admission:** HTTP in `server/src/handlers/blob.rs`, WS in
  `lib/src/sync/engine.rs`. Same policy, two implementations.
- **Upload File-resource construction** (`save_file_and_create_resource`) and
  **chunked download reconstruction** exist only in server handlers; WASM
  talks to `Tree::Blobs` directly.

`Storelike::search` in lib still builds a `/search` URL and fetches it —
an HTTP dependency the runtime plan wants gone.

### 8. Dev server port is not one number

Default atomic-server port is **9883**. Vite proxy and
`.env.development` point at **9885**. Hardcoded `9883` remains in:

- `browser/data-browser/src/App.tsx`
- `browser/data-browser/src/hooks/useDevDrive.ts` (`DEV_SERVER`)
- `browser/data-browser/src/helpers/tauri.tsx`
- `browser/e2e/tests/test-utils.ts` (`SERVER_URL` fallback)
- placeholders in `SyncRoute.tsx` / `ConnectDeviceStep.tsx`

AGENTS.md (Cloud section) and `browser/e2e/README.md` already warn that
misalignment silently repoints drives. This is config duplication with a
known failure mode, not an architecture issue.

**Consolidate:** one env-driven origin; e2e and Vite read the same value;
UI placeholders should not hardcode a port.

---

## Cross-language copies that should stay (with tests)

These are the language boundary. Merging them into WASM-only would make
the browser unable to sign or speak the wire format without a round-trip.

| Concern | Rust | TS | Dart | Tests today |
| --- | --- | --- | --- | --- |
| Commit JCS signing | `commit.rs` `serde_jcs` | `commit.ts` `fast-json-stable-stringify` | golden vectors | `browser/lib/src/sign.test.ts` vs Rust bytes |
| Genesis certificate | `genesis.rs` | `genesis.ts` | `signing_golden_vectors_test.dart` | Explicitly byte-identical |
| Agent secret envelope | `agents.rs` | `CryptoProvider.ts` | `atomic_auth.dart` (HTTP auth only) | Shared `genesis_test_vectors.json` |
| Pairing envelope | — | `browser/lib/src/pairing.ts` | `_parsePairingUri` in `pair_screen.dart` | Separate tests, **not** a shared fixture |
| Server URL normalize | — | `helpers/serverUrl.ts` | `atomic/server_url.dart` | Twin tests; comments require lockstep |
| Canvas fan/undo constants | — | `views/Canvas/fan-helpers.ts`, `history-helpers.ts` | `fan_helpers.dart`, `stroke_data.dart` | Comments "Matches Flutter"; no shared JSON |
| Filter operators | `storelike.rs` `FilterOperator` | `collection.ts` `valueMatches` | via WASM query | No shared fixture |

**Do this, not a merge:**

- Pairing: Flutter should call the same envelope rules as `pairing.ts`
  (golden URI fixtures, or parse in Rust and expose via FRB).
- `normalizeServerUrl` / `isLocalAddress`: **done** — `testdata/server-url.json`.
  Empty input still disagrees (TS `https://`, Dart `''`).
- Filter operators: WASM already runs Rust queries locally; client-side
  `valueMatches` is the live-membership shortcut. Either call WASM or
  share operator fixtures.
- Canvas constants: a tiny JSON of `SCRUB_PIXELS_PER_HISTORY`,
  `UNDO_STACK_LIMIT`, `BRANCH_GRACE_MS` imported by both.

TS `CommitBuilder` still models legacy `set` / `push` / `remove` fields
that the server rejects. Dead API surface on the client.

---

## Browser app-layer duplicates

Not the same as the protocol copies. These are multiple UIs for one job
inside `data-browser`.

### Search: overlay vs full-page route

`SearchOverlay.tsx` (~430 lines) and `SearchRoute.tsx` (~252 lines) both:

- call `useServerSearch` with drive/scope/filters
- keyboard-select results
- render `ResourceCard` lists and tag chips
- share `searchUtils.ts` for filter encoding

Keep two shells (command palette vs `/app/search`). Extract one
`SearchResultsList` + query hook.

Other search surfaces (`SearchBox`, `useLocalSearch`, table
`useResourceSearch`, `SettingsSearch`) are different jobs; do not merge
them into the overlay.

### Create-resource: six entry points

| Entry | Path |
| --- | --- |
| `/app/new` hub | `routes/NewResource/` |
| Per-class dialogs | `components/forms/NewForm/` |
| Sidebar / folder | `NewInstanceButton`, `QuickCreateRow` |
| Ontology page | `views/OntologyPage/CreateInstanceButton.tsx` |
| Table rows | `chunks/TablePage/QuickAddBar.tsx` |
| Context menu | `actions/resourceActions.tsx` |

`BasicInstanceHandlers.ts` is already a class → handler registry. Route
the other entries through it instead of adding a seventh.

### Four things named "history"

| Name | What it actually is |
| --- | --- |
| `routes/History/` + `useVersions` | Loro OpLog time-travel for a resource |
| `views/Canvas/history-helpers.ts` | Canvas stroke undo + discarded branches (`localStorage`) |
| `useTableHistory` | In-memory table cell undo |
| `hooks/useDriveHistory.ts` | Recent **drives** in `localStorage` |

Do not merge. Rename `useDriveHistory` → `useRecentDrives`.

### Document v1 still shipped next to v2

`views/DocumentPage.tsx` (element-based) vs
`views/Document/DocumentV2FullPage.tsx` (TipTap + Loro).
`BasicInstanceHandlers` still registers both `document` and `documentV2`.
Finish the cutover, then delete v1 (grid item, card, class handler).

Markdown editing is layered, not duplicated: `CollaborativeEditor` →
`AsyncMarkdownEditor` → `MarkdownInput` → `InputMarkdown` → table
`MarkdownCell`. Leave that stack.

### Device pairing vs resource invites

Easy to confuse, different security models:

- Device pairing: `SyncRoute`, `PairingCode`, `ConnectToDeviceForm`, Flutter
  `pair_screen.dart`
- Resource invite: `InvitePage`, `InviteForm`, `ShareRoute`

Do not merge. The onboarding plan already insists on distinct vocabulary.

---

## Flutter ↔ browser twins (do not merge UIs)

Documented in [`sync-onboarding-ux.md`](./sync-onboarding-ux.md). Tauri is
not a third UI — it loads the same SPA.

| Concern | Browser | Flutter | Gap |
| --- | --- | --- | --- |
| Canvas draw + undo scrub | `views/Canvas/` | `canvas/infinite_canvas.dart` | Phase B of canvas-undo plan: Dart `_allActions` stack still exists |
| Pairing UI | `SyncRoute` / `PairingFlowProvider` | `pair_screen.dart` | Flutter parses `atomic://pair` locally instead of sharing `pairing.ts` |
| Server URL | `helpers/serverUrl.ts` | `atomic/server_url.dart` | Twin, tested separately |
| Documents, tables, chat, AI | data-browser | absent | Expected; Flutter is canvas-first |

`flutter/AGENTS.md` previously said Loro was "the biggest remaining gap" and
strokes were stored as JSON. That contradicted
[`canvas-undo-consolidation.md`](./canvas-undo-consolidation.md) (Phase A
landed; tap-undo is Loro `UndoManager`). **Updated 2026-08-15.** Stale agent
context is its own kind of duplication.

Flutter `flutter/rust/src/api/simple.rs` (~1444 lines) is app-specific
canvas/folder/peer glue. WASM `wasm/src/lib.rs` is closer to a generic
node API. Per the runtime plan, Flutter should shrink toward WASM's
surface, not grow more canvas FFI.

---

## Server-internal copies

| Copy | Where | Action |
| --- | --- | --- |
| Subscribe `check_read` ×3 | `server/src/commit_monitor.rs` | **Done (2026-08-15):** `authorize_read`. Remaining map split is [`unify-subscription-primitives.md`](./unify-subscription-primitives.md). |
| `SUB` / `UNSUB` still hand-rolled | `server/src/handlers/web_sockets.rs` | Last actor-bound frames after GET/AUTH/COMMIT moved to the engine (`unified-sync.md` inventory item 1) |
| AUTH parse ×3 | `engine.rs`, `web_sockets.rs`, `peer.rs` | `unified-sync.md` inventory item 2 — still open |
| Compact-VV build ×2 | `peer.rs` vs browser `computeDriveSyncState` | inventory item 3 |
| Six `sync_drive_with_peer*` entry points | `lib/src/sync/peer.rs` | inventory item 5 |

Query collection construction is already shared
(`construct_collection_from_params`). That is the pattern blob/search
should follow.

---

## Giant files that mix jobs

These are not copy-paste duplicates, but they prevent consolidation because
too many concerns share a type:

| File | Lines | Mixes |
| --- | --- | --- |
| `browser/lib/src/store.ts` | 5358 | HTTP, WS, OPFS, outbox, subscriptions, drive sync |
| `browser/lib/src/resource.ts` | 3680 | cache, Loro, signing, undo, genesis, datatype tags |
| `lib/src/loro.rs` | 2961 | wrapper, tags, materialization, tests |
| `lib/src/commit.rs` | 2555 | builder, sign, apply, serialize |
| `lib/src/resources.rs` | 2323 | CRUD, save paths, Loro mirror |

Splitting these is a prerequisite for
[`unified-data-layer.md`](./unified-data-layer.md), not a separate cleanup.

Worker-bound copies (`STORAGE_BLOCKED_MARKER`, WASM URL helpers in
`client-db.ts` vs `client-db-open.ts` vs `wasm-url.ts`) are **intentional**
— Vite worker bundling. Do not merge; `client-db-open.test.ts` guards this.

---

## Docs that overlap

| Topic | Files | Keep |
| --- | --- | --- |
| Loro as authority | `AGENTS.md`, `loro-source-of-truth.md`, `unify-resource-representations.md`, comments in `loro.rs` / `resource.ts` | Planning docs; AGENTS.md should link, not retell |
| Sync / pairing | `sync-onboarding-ux.md`, `device-pairing.md`, `unified-sync.md`, both `AGENTS.md`s, `flutter/AGENTS.md` | `sync-onboarding-ux.md` for UX twins; `unified-sync.md` for protocol |
| Flutter Loro status | `flutter/AGENTS.md` (stale) vs `canvas-undo-consolidation.md` | Update Flutter AGENTS |

`planning/README.md` already says protocol wire format lives in
`docs/src/websockets.md` and planning must not duplicate it.

---

## What not to consolidate

- Flutter canvas UI into React (or the reverse).
- Resource-invite flow into device-pairing.
- Canvas / table / OpLog / recent-drive "history" implementations.
- Store / OPFS / WASM layering (those are layers, not copies).
- Worker vs main-thread WASM URL helpers.
- `@tomic/svelte` (`browser/svelte/`) vs `@tomic/react` — framework bindings
  over the same `@tomic/lib`. Tiny and appropriate.
- Commit signing / genesis encode — dual-maintain with golden vectors.
- Tauri "desktop app" — it is the SPA plus a thin origin helper.

---

## Suggested order (small → structural)

Work that is local and pays off without waiting on the runtime rewrite.
Every item still has to pass [`consolidation-contract.md`](./consolidation-contract.md).

1. **Port/env single source** — stop 9883/9885 drift.
2. **Delete `browser/lib/src/urls.ts`** — only after data-browser stops using
   the nested `urls.properties.*` public API. Not a six-file leftover.
3. **Shared golden fixtures** for pairing URIs, `normalizeServerUrl`,
   and Tantivy key escaping — **done (2026-08-15)** (`testdata/search-query.json`,
   `testdata/server-url.json`). Datatype tags still open.
4. **`ws_apply::apply_commit_json` → `ingest_commit_json`** — **done
   (2026-08-15).** `CommitIngestOpts::{hub,peer,replica}`. WASM `applyCommit`
   still has its own `CommitOpts`.
5. **Extract `SearchResultsList`**; rename `useDriveHistory`.
6. **One `check_read` helper** in `commit_monitor.rs` — **done (2026-08-15)**
   (`authorize_read`).
7. **Update `flutter/AGENTS.md`** so it matches the Loro canvas path —
   **done (2026-08-15)**.

Then the existing plans, in this order, because each removes a class of
copies rather than one function:

8. [`unify-subscription-primitives.md`](./unify-subscription-primitives.md) —
   kills the three subscribe maps and the three `check_read` blocks together.
9. [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) blob + search move —
   kills handler-owned semantics.
10. [`unified-data-layer.md`](./unified-data-layer.md) — kills the browser's
    many ingresses; requires splitting `store.ts` / `resource.ts`.
11. Protocol codegen (`protocol.rs` ↔ `ws-v2.ts`) once the tag set is stable
    under unified-sync.

---

## File index

**Ingest / Loro / protocol:** `lib/src/sync/engine.rs`, `lib/src/sync/ws_apply.rs`,
`lib/src/sync/protocol.rs`, `lib/src/resources.rs`, `lib/src/commit.rs`,
`lib/src/loro.rs`, `wasm/src/lib.rs`, `server/src/handlers/commit.rs`,
`server/src/handlers/web_sockets.rs`, `server/src/commit_monitor.rs`

**TS mirrors:** `browser/lib/src/ws-v2.ts`, `websockets.ts`, `commit.ts`,
`resource.ts`, `datatypes.ts`, `subject.ts`, `urls.ts`, `ontologies/*.ts`,
`collection.ts`, `search.ts`, `pairing.ts`, `genesis.ts`

**UI twins:** `browser/data-browser/src/helpers/serverUrl.ts` ↔
`flutter/lib/atomic/server_url.dart`; `views/Canvas/` ↔
`flutter/lib/canvas/`; `SyncRoute.tsx` ↔ `flutter/lib/screens/pair_screen.dart`

**Search UI:** `browser/data-browser/src/routes/Search/SearchOverlay.tsx`,
`SearchRoute.tsx`
