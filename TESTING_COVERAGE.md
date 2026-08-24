# Testing coverage map

What is tested, at which layer, and — the part that matters — **what is not**.

This exists because the protocol is far better tested than the glue around it,
and that imbalance is invisible from a passing CI run. Every production bug in
device sync so far has been in a layer this document lists as uncovered.

**Keep it current.** When you add a test, add the row. When you find a blind
spot, write it down even if you are not fixing it today — an admitted gap is
worth more than a forgotten one. When you fix a bug, ask which row would have
caught it, and if the answer is "none", that is the row to add.

---

## How to read this

Coverage is split by *layer*, because the same flow can be well covered in one
and absent in another:

| Layer | Meaning |
|---|---|
| **protocol** | `atomic_lib` sync engine — the bytes on the wire |
| **glue** | the code wrapping the protocol: HTTP handlers, the Flutter bridge, browser helpers |
| **flow** | what a user actually does, end to end, through a UI |

A flow is only genuinely safe when all three are covered.

### Playwright light vs full

Only the browser suite splits. Lint, Rust, vitest, JS integration, and
Flutter run on every CI job.

| Trigger | Playwright |
|---|---|
| Feature-branch push | **light** (`@smoke`), required |
| `develop` push | **full**, required (staging) |
| stable `v*` tag | **full**, required (production) |
| `workflow_dispatch` `e2e_mode=full`, `[full-e2e]` in the commit, or PR label `full-e2e` | **full** |

Tag a new journey `@smoke` (`smoke` from `browser/e2e/tests/test-utils.ts`)
only if a failure means the first-hour demo is dead. Extra operators,
templates, and offline variants stay in the full suite. Policy:
[`planning/e2e-light-heavy.md`](./planning/e2e-light-heavy.md).

---

## Where the suites live

| Suite | Command | CI job |
|---|---|---|
| `atomic_lib` unit + integration | `cargo nextest run -p atomic_lib --features db-redb,iroh,ws` | `rustTest` |
| Server integration | `cargo test -p atomic-server --test it <module>` | `rustTest` |
| Browser unit (vitest) | `cd browser && pnpm run -r test` | `jsTest` |
| Browser integration (vitest + real server) | `cd browser/lib && pnpm run test:integration` | `jsTestIntegration` |
| Browser e2e light (`@smoke`) | `cd browser && pnpm run test-e2e:light` | `endToEnd` on feature branches |
| Browser e2e full | `cd browser && pnpm run test-e2e` | `endToEnd` on `develop` and `v*` tags |
| Flutter Dart | `cd flutter && flutter test` | `flutterTest` |
| Flutter Rust bridge | `cargo test --manifest-path flutter/rust/Cargo.toml` | `flutterTest` |

CI runs `cargo nextest run --workspace --exclude atomic-server-tauri
--no-default-features --features light`. Feature unification pulls in
`db-redb` + `iroh`, so feature-gated sync tests do run there.

Two things worth knowing about the runners:

- **`flutter/rust` is excluded from the workspace** (root `Cargo.toml`), so
  `--workspace` never compiles it. It is covered only by the explicit
  `--manifest-path` step in `flutterTest`.
- **`.config/nextest.toml` sets `retries = 2`.** A flaky test passes CI
  silently. Check for `FLAKY` in nextest output, not just the summary line.

---

## Sync and pairing

### Protocol — well covered

| Flow | Where |
|---|---|
| Two Iroh nodes reconcile (bulk + live) | `lib/src/sync/iroh_e2e.rs` (13 tests, real QUIC) |
| Stroke appended after sync propagates | `lib/src/sync/iroh_e2e.rs` |
| A peer only receives what its agent may read | `iroh_e2e.rs`, `peer.rs` |
| A peer cannot forge a third agent's resource | `iroh_e2e.rs` |
| Relayed write accepted only for a drive we own and dialled | `peer.rs` |
| Iroh accept side refuses any frame before `AUTH` (ERROR + closed stream), binds `AUTH.requestedSubject` to the handshake drive | `peer.rs` (`accept_gate_tests`, raw QUIC stream) |
| Rejected `SYNC_PUSH` answers `ERROR SYNC_REJECTED`, never `SYNC_OK` | `peer.rs` (`accept_gate_tests`), `server/tests/it/ws_auth_gate.rs` |
| WS: writes and identity-bearing subscriptions need `AUTH`; anonymous `SUB` on a public drive still works; unreadable subscriptions answer `ERROR UNAUTHORIZED_READ` | `server/tests/it/ws_auth_gate.rs` |
| Engine-level two-store sync, private drives, blobs, live push | `lib/src/sync/tests.rs` |
| RBSR reconciliation, drive hashing | `lib/src/sync/rbsr.rs`, `tests.rs` |
| RBSR finds a remote-only subject sorting below every local one | `lib/src/sync/rbsr.rs` **and** `browser/lib/src/rbsr.test.ts` (regression, see below) |
| Remote update merge, drive-spoof rejection, tombstones | `lib/src/sync/ws_apply.rs`, `tombstones.rs` |
| Pairing envelope encode/decode | `browser/lib/src/pairing.test.ts` |

### Cross-process — covered since 2026-07

Both matter because `iroh_transport` holds the router and node identity in
**process globals**; anything sharing a process shares one node.

| Flow | Where |
|---|---|
| Drive reconciles across a real OS process boundary | `lib/tests/cross_process_sync.rs` |
| Iroh NodeID survives an unclean kill (`abort()`, no flush) | `lib/tests/identity_durability.rs` |
| Paired peer + its relay/direct addresses survive a kill | `lib/tests/identity_durability.rs` |
| Two whole servers pair via `POST /iroh-sync` and reconcile | `server/tests/it/iroh_pairing.rs` |
| `/iroh-sync` refuses malformed node ids with a UI-showable error | `server/tests/it/iroh_pairing.rs` |

### Glue

| Flow | Where | Note |
|---|---|---|
| Browser records a peer and calls `/iroh-sync` | `data-browser/src/helpers/pairing.test.ts` | stubbed fetch |
| Known-peer store: labels, dedupe, corrupt data, quota | `data-browser/src/helpers/knownPeers.test.ts` | |
| `forgetServerPeer` signs the exact `?node=` URL, and fails soft | `data-browser/src/helpers/managedServer.test.ts` | mocked `signRequest` |
| Opening a foreign HTTP drive does not move `serverUrl` | `browser/lib/src/store.set-drive.test.ts` | bare origin still switches the server; path-bearing HTTP is a drive |
| Canvas editing session merges a peer's stroke | `flutter/rust/src/api/simple/tests.rs` | |
| Whole-list rewrite (erase/undo) keeps a peer's stroke | `flutter/rust/src/api/simple/tests.rs` | |
| Bridge `start_peer` → `add_known_peer` → `peer_sync` pushes a drawing to a real remote process | `flutter/rust/src/api/simple/peer_tests.rs` | receiving side writes the receipt |
| Bridge known-peer bookkeeping (add / rename / dedupe / forget) | `flutter/rust/src/api/simple/peer_tests.rs` | |
| Bridge `peer_sync` to an unreachable node errors rather than hanging | `flutter/rust/src/api/simple/peer_tests.rs` | |
| **`POST /iroh-sync` request shape, both sides** | `testdata/pairing-request.json` + `pairing.test.ts` + `iroh_pairing.rs` | shared fixture binds them |
| Dart pairing-code parser, peer-sync result formatting | `flutter/test/atomic/` | pure parsers |
| Rotation does not treat a metrics-change pop as "back to gallery" | `flutter/test/canvas/rotation_pop_test.dart` | |
| `AtomicNode`: `mutate` on one node, `apply_commit(IngestPolicy::Peer)` on another, query + `DbEvent` reflect it | `lib/src/runtime/node.rs` | in-process, no transport; `LocalCache` skips signature check, `Peer` does not |

### Flow — the thin layer

| Flow | Where |
|---|---|
| Pairing code renders, is a routable envelope, carries no secret | `browser/e2e/tests/sync-devices.spec.ts` |
| Pasting a code: form gated to the app, malformed refused without dialling, node's refusal shown, success reports what synced, peer remembered | `browser/e2e/tests/pairing-dialog.spec.ts` |
| Paired-device cards render, expose a way to forget, and hide undialable entries | `browser/e2e/tests/pairing-dialog.spec.ts` |
| Copy pairing code | `sync-devices.spec.ts` |
| Add-a-device form validation | `sync-devices.spec.ts` |
| Sync page status renders | `browser/e2e/tests/sync.spec.ts` |
| Offline edits persist and sync on reconnect | `sync.spec.ts` |
| Second device cold-loads a drive from the server | `second-device-load.spec.ts` |

---

## Blind spots

Ordered by how much they would hurt.

### 1. No cross-runtime peer test above the bridge

Canvas's *sync* is now covered against a real remote process
(`peer_tests.rs`), which is Canvas ↔ Desktop at the code level — both sides run
the same `atomic_lib` peer, and there is only one Iroh implementation, so the
wire protocol between any two surfaces is the same well-tested code.

What is still untested is everything **above** the bridge: the Dart call sites,
Flutter's lifecycle, the Tauri wrapper, and the browser driving a real node.
Android-specific behaviour (backgrounding, process death, 16 KB pages) has no
automated coverage at all and is still hand-verified on devices.

### 2. `peer_announce` and discovery from the bridge

`peer_announce` and `peer_discover_sync` remain untested — they depend on pkarr
relay reachability, which the bridge tests deliberately short-circuit by
handing addresses over directly. `pkarr_discovery_and_iroh_sync` covers
discovery in `atomic_lib`, but not through the bridge.

### 3. Remaining one-sided contracts

`POST /iroh-sync` is now bound by a shared fixture
(`testdata/pairing-request.json`): the browser test asserts it *sends* that
body, the server test asserts it *accepts* it, and renaming a field fails both.

`/forget-peer` is covered on both sides now — `iroh_pairing.rs` for the handler
(unsigned refused, full pair → listed → forget → gone lifecycle) and
`managedServer.test.ts` for the client (signs the exact `?node=` URL). They are
not *bound* by a shared fixture the way `/iroh-sync` is, so a rename would still
pass both; the query-parameter name is asserted literally in each.

Unbound: the `nodeId` property on `/server` as consumed by the browser — the
replacement for `/iroh-node-id`.

### 4. Tauri-gated UI

`ConnectToDeviceForm` (paste a code) and the pairing dialog are now covered —
`isRunningInTauri()` only checks for `window.__TAURI_INTERNALS__`, so
`page.addInitScript` reaching it is enough, and nothing on that path calls
`invoke`. See `pairing-dialog.spec.ts`.

Paired-peer cards are covered too, by seeding `atomic-peers` in an init script.

Still uncovered: `PairingLinkHandler`'s deep-link entry (the system camera
launching the app) and `IdentityReconcileGate`. Anything that genuinely calls
`invoke` needs a real desktop harness, not a faked global.

**Known wart, not a test gap:** `PairingLinkHandler` drops input that does not
start with `atomic://` or `did:ad:node:`, so pasting something that is not a
URI reports *nothing at all* — no dialog, no error. Only malformed input that
is URI-shaped reaches the flow and gets a message.

### 5. QR camera path

`scanPairingCode.ts` and the camera flow: untested at every layer.

### 6. Ephemeral / presence over Iroh

No producer or consumer exists (`EPHEMERAL` 0x40 is WS-only), so there is
nothing to test yet. Listed so it is not mistaken for covered.

### 7. Flutter integration_test is effectively dead

One 13-line smoke test, never run in CI — the pipeline has no emulator.

### 8. Known residual races

None outstanding. The concurrent-writer bug that lived here — a local edit
racing a peer update lost ~⅓ of all operations, because both paths
read-modify-write the same Loro snapshot and end in a replace — was fixed
2026-07-20 with a per-subject lock (`lib/src/subject_lock.rs`). Regression test:
`lib/tests/concurrent_commit_and_peer_apply.rs`, which lost 53–56 of 80
operations before the fix and now keeps all of them, with a sequential control
that isolates concurrency as the cause.

No known flaky tests. The one that was
(`rbsr_reduced_matches_full_sync_vv`) turned out to be a genuine RBSR bug, not
test noise — see below.

---

## Things that are *not* what they look like

Recorded because each one cost real debugging time.

- **`push_stroke` + `save_locally` cannot lose a peer's op.** The commit is
  imported into a freshly-read store doc and Loro import never removes ops. The
  damage from a stale editing session comes from *reads* — index-based deletes
  and whole-list rewrites — not from the append. A test written the obvious way
  passes with and without the fix.
- **A test child process must not drop its `Db`.** redb's `Database::drop`
  closes cleanly and makes pending `Durability::None` commits durable, so a
  durability test that lets the store drop is testing a graceful shutdown.
  `std::mem::forget` it before `abort()`.
- **Servers in one process share an Iroh node.** They all advertise the same
  node id regardless of whose store holds the data. Multi-server Iroh tests
  must use subprocesses, and the test process itself must run no server.
- **`--exact` filters need the module path** in the single-binary `it` suite
  (`iroh_pairing::child_runs_a_second_server`, not the bare name).
- **A leaked child server silently corrupts later runs.** Own it with a `Drop`
  guard so a panicking assertion still kills it.
- **The bridge's tests share one drive.** `DB` is a `OnceLock` and every test
  works in the same drive, so "find a canvas with strokes" matches a
  neighbour's drawing. Assert on a specific subject, and never change the
  active drive from a test.
- **Known peers are stored under a normalised node id**, not the
  `did:ad:node:` form the UI passes in. Look them up with
  `normalize_node_id`, or the lookup silently finds nothing.
- **A lock keyed only by subject couples unrelated stores.** `populate()` seeds
  well-known subjects that are byte-identical in every store, so a global
  registry makes two independent `Db` instances — including two tests sharing a
  process — wait on each other for no reason. `SubjectLocks` therefore lives on
  the `Db`, and every clone of a store shares one registry.
- **Measure a suspected regression on a quiet machine.** A test that looked
  newly flaky right after a four-minute stress run was passing 20/20 once the
  machine was idle. Compare against a stashed baseline under the same
  conditions before concluding you caused something.
- **A flaky test can be a real bug wearing a costume.**
  `rbsr_reduced_matches_full_sync_vv` failed ~1 run in 3. It was not noise:
  `reconcile_range` anchored its first child range at the first *local* key
  instead of the range's own `lo`, leaving `[lo, first_local)` covered by no
  child at all. A subject the remote had and we lacked, sorting below
  everything we held, was dropped from the diff and would never have synced.
  It looked intermittent only because the test's subjects are content-derived
  DIDs, so whether one landed in the dead zone varied per run — and
  `retries = 2` meant CI almost never showed it.

  The TypeScript port (`browser/lib/src/rbsr.ts`) had the **same** off-by-one,
  and it *is* live: `websockets.ts` uses it to compute the `subjects` filter a
  browser client sends the server, so an affected resource was never pulled.
  Both were fixed 2026-07-20, each with two deterministic regression tests.

  **Treat a flake as an unread bug report until proven otherwise** — and when
  an algorithm is ported, check the port for the same defect.

- **An empty local-DB collection page used to drop its aggregates.** Count=0
  is a real statistic (and sum=null is too). Leaving `collection.aggregates`
  unset made dashboard/table totals render an em-dash forever, because the
  follow-up `ResourceUpdated` never came — the rows were already in the JS
  store. Guard: `collection-empty-trust.test.ts`, plus the dashboard e2e
  that waits for `946.5` / `4` rather than the placeholder.

- **Opening a filled table (and the sidebar) flashed as if order changed.**
  Two independent paints: (1) WASM `parent=` queries are unsorted;
  hydrating each member notifies `ResourceUpdated`, and `useCollection`
  optimistic-added them in arrival order before client-side sort wrote
  the page. Guard: `collection-page-assemble.test.ts`. (2) The sidebar
  fetched children while `isA` was still empty, so every table row
  appeared in the tree until the class arrived and hid them. The
  ResourceSideBar now treats unknown class as hide-children. OPFS
  cold-load could also shuffle array props (`requires`/`recommends`) by
  seeding a new LoroList from JSON-AD then merging the snapshot;
  `importLoroUpdate(snapshot, true)` replaces instead. Guard:
  `resource.test.ts` ("importing a snapshot over a cache-seeded doc").

### Algorithms mirrored in two languages

`lib/src/sync/rbsr.rs` ↔ `browser/lib/src/rbsr.ts` are line-for-line ports and
must compute the same differing set on either end of the wire. Both carry the
same test names. A fix to one is a fix to the other; the golden-vector tests
(`item_fingerprint_matches_golden_vector`) pin the hashing, but the *traversal*
is only kept in step by mirroring the tests, so do that deliberately.

`lib/src/genesis.rs` ↔ `browser/lib/src/genesis.ts` also share a personal-drive
derivation (`personal_drive_subject` / `personalDriveSubject`). The cross-lang
vector (`personal_drive_cross_lang_vector`) pins the nonce, signature, and DID.

## Documents

| Flow | Layer | Where |
|---|---|---|
| V1 element list + paragraph markdown (+ resource embed) → TipTap JSON; leftover Yjs `XmlFragment` walker; `{ type: 'ydoc' }` detection without loading `yjs` | glue | `browser/data-browser/src/views/Document/documentMigrationUtils.test.ts` |
| Opening a writable v1 document migrates it silently into the Loro editor (no "Update Document" button) | flow | `browser/e2e/tests/documents.spec.ts` |

Not covered: leftover Yjs-era DocumentV2 bodies end-to-end (needs a stored `{ type: 'ydoc' }` fixture); read-only v1 documents stay on the element list and have no e2e.

## Personal drive identity

| Flow | Where |
|---|---|
| Same agent key → same personal-drive DID | `lib/src/genesis.rs`, `browser/lib/src/genesis.test.ts` |
| Cross-language personal-drive vector | `genesis.rs` + `genesis.test.ts` |
| Repeat genesis for that DID merges Loro state | `lib/src/commit.rs::repeat_personal_drive_genesis_merges` |
| Repeat genesis without a cert is still rejected | `lib/src/commit.rs::repeat_genesis_without_cert_is_still_rejected` |
| `createDrive({ personal: true })` uses the derived DID | `browser/lib/src/store.personal-drive.test.ts` |
| Two stores with the same key mint the same subject | `store.personal-drive.test.ts` |
| Extra drives are listed on the derived personal drive | `store.personal-drive.test.ts` |
| Extra drive created offline drains on reconnect (genesis must not set a rewind baseline) | `browser/lib/src/offline-create-drain.test.ts` |
| Lists from a previous random-DID home are unioned onto the derived drive | `store.personal-drive.test.ts` |
| `Agent.personalDriveSubject` matches the genesis helper | `agent.test.ts` |
| `Db::setup` / `ensure_personal_drive` use the derived DID and are idempotent | `lib/src/db.rs::personal_drive_tests` |
| Extra `Db::create_drive` is listed on the personal drive | `lib/src/db.rs::personal_drive_tests` |

Not covered: Flutter `create_drive` still mints a random DID (the Rust
`ensure_personal_drive` helper exists for `setup()`). E2E sign-in on a second
machine with the old machine offline.

---

## Collection query authorization

| Flow | Where |
|---|---|
| Destroyed children don't inflate `parent=` `totalMembers` | `lib/src/db/test.rs` `destroy_clears_parent_index_count` |
| In-page auth-denied members: `count` equals `subjects.len()` | `unauthorized_query_count_matches_subjects` |
| Public child after a private streak still fills the page | `unauthorized_query_skips_denials_to_fill_the_page` (20 private, then one public) |
| Auth-denied listing does not full-decode ancestors; each member is still shallow-fetched | `unauthorized_collection_query_bounds_fetch_counts` (call counts, not wall clock) |

Not covered: wall-clock on a large real store (the 21.7KB-parent form from
`planning/slow-collection-queries.md`); per-GET rights walks on the invite-code
panel (memo is per-query, not per-request).

---

## Commit delivery and the Loro save cursor

The client exports each commit as a delta starting at its save cursor
(`_loroVersionAtLastSave`). If the cursor ever sits past ops the server never
received, every later delta is un-importable server-side — and Loro parks such
ops as *pending* (VV unchanged, empty diff), which without a guard is
indistinguishable from an idempotent replay. This lost a real user's
`form-pages` write in 2026-08.

| Flow | Where |
|---|---|
| Server rejects a delta whose deps it never received (pending import), and accepts the full-range re-send | `lib/src/commit.rs::commit_with_pending_loro_deps_is_rejected` |
| Idempotent replay of an already-applied commit is still accepted | `lib/src/commit.rs::idempotent_commit_replay_is_accepted` |
| Drain reacts to the pending-deps rejection by clearing the cursor and re-sending a self-contained snapshot | `browser/lib/src/store.test.ts` ("recovers from a server pending-deps rejection…") |
| `clone()` / `merge(replaceLoroDocs)` carries the cursor VALUE, not the current doc version | `browser/lib/src/resource.test.ts` ("clone preserves the save cursor value…") |
| Imports/echoes don't advance the cursor past unsigned local edits | `browser/lib/src/resource.test.ts` ("importLoroUpdate does not advance…") |

Not covered: the OPFS-suppression window (edits live only in memory between
`markDirty` and a successful drain — an app kill in that window still loses
them, `store.ts` `addResource`'s `!hasPendingCommits` gate); WS `COMMIT_OK`
acks carrying no server-side apply confirmation beyond the echoed commit.

---

## Forms

| Flow | Where |
|---|---|
| FormCondition evaluator (visibility + hidden-field validation skip) | Shared fixtures `testdata/form-conditions.json` loaded by `server/src/forms.rs::condition_fixtures_match_ts` **and** `browser/form-renderer/src/conditions.test.ts`. A fix to one is a fix to the other. |
| Definition serializer inlines FormCondition resources as `{field, operator, value}` | `server/src/forms.rs::definition_inlines_field_conditions` |
| Form ontology populate (incl. FormCondition) | `lib/src/store.rs::populate_forms_ontology` |
| Publish → anonymous submit of a branching follow-up | `browser/e2e/tests/forms-submission.spec.ts` ("branching hides a follow-up unless its condition matches") |
| Extended question types: validation + coercion per type (phone/url shape, currency bounds, dropdown membership, likert/rating range, matrix rows/columns + completeness, table columns/types/row bounds, address subfields), and all-empty composites reading as unanswered | `server/src/forms.rs` (`phone_field_accepts_common_shapes_and_rejects_junk` … `all_empty_composites_count_as_unanswered`) |
| Extended types route onto the existing summary shapes (choice counts / histogram / answer sample) | `server/src/forms.rs::extended_types_reuse_the_existing_summary_shapes` |
| `picture-choice` option images: subjects rewritten into `/form/{id}/image?file=`, and that route refuses files the form doesn't reference | `server/src/forms.rs::rewrite_option_images_only_touches_option_image_subjects` + `server/src/tests.rs::form_submission_flow` (step 3d) |
| Builder can add every question type and they survive a reload | `browser/e2e/tests/forms.spec.ts` ("create a form, add every field type…") |
| `phone` accepts both the renderer's E.164 output and loosely formatted national numbers, and rejects a half-typed one | `browser/form-renderer/src/validation.test.ts` + `server/src/forms.rs::phone_field_accepts_common_shapes_and_rejects_junk` |
| `country` stores an ISO 3166-1 code: the list is complete and named, names localize, and a country *name* is rejected | `browser/form-renderer/src/validation.test.ts` + `server/src/forms.rs::country_field_takes_an_iso_code_and_rejects_a_name` |
| `country` summaries count picked codes by popularity (no configured option list to zero-fill) | `server/src/forms.rs::country_counts_rank_by_popularity_then_code` |
| Builder → publish → anonymous submit → row, for one type per value shape (dropdown/rating/address) | `browser/e2e/tests/forms-submission.spec.ts` ("extended field types round-trip from builder to submission") |

Not covered (extended types): the client-side mirror of the new validators in
`browser/form-renderer/src/validation.ts` is only unit-tested for `phone` (the
one rule that deliberately diverges — it is stricter than the server for E.164
values); every other type is tested on the Rust side only, and the two are
hand-mirrored, so they can drift (the
same known gap as `buildFormDefinition.ts` vs `build_form_definition`); the
option-image *picker* in `PictureChoiceOptions.tsx` (uploading or picking a file
for an option) is only exercised manually; `choice-matrix` / `table-input` /
`picture-choice` are rendered and validated but never submitted end-to-end in
e2e.

Not covered: builder UI for adding/removing conditions (the e2e walks it once as setup, not as its own assertion); page-level (not field-level) branching in e2e (unit fixtures cover it); add/delete-page write ordering in `PageTabBar` (both now `await` the form's `form-pages` save — add before selecting, delete before destroying — but no test pins that ordering).

---

## Files and image previews

| Flow | Where |
|---|---|
| Upload → blob stored → content-addressed download round-trip | `server/src/tests.rs::upload_download_test` |
| `/download/files/{hash}` answers with the File's real mimetype, not `application/octet-stream` | `server/src/tests.rs::upload_download_test` |
| An uploaded SVG actually decodes in the preview (local `blob:` URL **and** the server `downloadURL`) | `browser/e2e/tests/filePicker.spec.ts` ("uploaded SVG renders in the preview") |
| File picker lists files, filters by name, previews text | `browser/e2e/tests/filePicker.spec.ts` |
| Upload while offline, then reconnect | `browser/e2e/tests/file-upload-offline.spec.ts`, `browser/lib/tests/upload-offline-reconnect.integration.test.ts` |

Both halves of the SVG row guard the same class of bug and neither implies the
other: a `blob:` URL takes its Content-Type from the `Blob`'s `type`, the
network URL from the response header, and an `<img>` renders SVG only when that
type is exactly `image/svg+xml` (raster formats it will sniff; SVG it never
will). `user_blob_response` also sets `nosniff`, so an `application/octet-stream`
answer breaks *every* image type on the network path, not just SVG.

Not covered: that the network `downloadURL` path is what actually renders once
the local bytes are evicted — the e2e asserts the header directly rather than
clearing the ClientDb and re-rendering. No test pins the `?w=`/`?f=` rendition
route's refusal to process SVG (`is_image_bytes` rejects it); the app avoids
that route for SVG, but nothing enforces that it keeps doing so.
