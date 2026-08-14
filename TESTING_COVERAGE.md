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

---

## Where the suites live

| Suite | Command | CI job |
|---|---|---|
| `atomic_lib` unit + integration | `cargo nextest run -p atomic_lib --features db-redb,iroh,ws` | `rustTest` |
| Server integration | `cargo test -p atomic-server --test it <module>` | `rustTest` |
| Browser unit (vitest) | `cd browser && pnpm run -r test` | `jsTest` |
| Browser e2e (playwright) | `cd browser/e2e && pnpm run test-e2e` | `endToEnd` |
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
| Canvas editing session merges a peer's stroke | `flutter/rust/src/api/simple/tests.rs` | |
| Whole-list rewrite (erase/undo) keeps a peer's stroke | `flutter/rust/src/api/simple/tests.rs` | |
| Bridge `start_peer` → `add_known_peer` → `peer_sync` pushes a drawing to a real remote process | `flutter/rust/src/api/simple/peer_tests.rs` | receiving side writes the receipt |
| Bridge known-peer bookkeeping (add / rename / dedupe / forget) | `flutter/rust/src/api/simple/peer_tests.rs` | |
| Bridge `peer_sync` to an unreachable node errors rather than hanging | `flutter/rust/src/api/simple/peer_tests.rs` | |
| **`POST /iroh-sync` request shape, both sides** | `testdata/pairing-request.json` + `pairing.test.ts` + `iroh_pairing.rs` | shared fixture binds them |
| Dart pairing-code parser, peer-sync result formatting | `flutter/test/atomic/` | pure parsers |

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

### Algorithms mirrored in two languages

`lib/src/sync/rbsr.rs` ↔ `browser/lib/src/rbsr.ts` are line-for-line ports and
must compute the same differing set on either end of the wire. Both carry the
same test names. A fix to one is a fix to the other; the golden-vector tests
(`item_fingerprint_matches_golden_vector`) pin the hashing, but the *traversal*
is only kept in step by mirroring the tests, so do that deliberately.

---

## Headless CMS (Website template)

The CMS is the Website template in the Data Browser plus `@tomic/create-template`
(Next.js / SvelteKit). Forks and i18n are generic platform features the templates
consume.

### Covered

| Flow | Where |
|---|---|
| Apply template, scaffold Next.js, production build, homepage, blog search, two-locale routing | `browser/e2e/tests/template.spec.ts` (`apply next-js template`) |
| Same for SvelteKit, including `<html lang>` | `template.spec.ts` (`apply sveltekit template`) |
| Future-dated post hidden from listing, search, and direct URL (404) | `template.spec.ts` (`assertTwoLocaleSite` + search `Time Travel`) |
| Cmd/Ctrl+E and **Edit this page** open `/app/edit?subject=` on the Data Browser origin (`--cms-url`) | `template.spec.ts` (`assertCmsEditFromSite`) |
| Nav on `/nl/blog` → Home stays on `/nl` | `template.spec.ts` (`assertTwoLocaleSite`) |
| Next.js `<html lang>` follows the URL prefix | `template.spec.ts` (`checkHtmlLang: true` for both templates) |
| `/` serves `website.homepage` even when that page's path is not `/` | `template.spec.ts` (`assertHomepageIsAbout`) |
| Fork of a page with a copied `href` does not replace the published page | `template.spec.ts` (`assertHomepageIsAbout` + `DRAFT ABOUT LEAK`) |
| Blog cards on `/nl/blog` keep the `/nl` prefix | `template.spec.ts` (`assertLocaleBlogCards`) |
| `sitemap.xml` / `rss.xml` / `robots.txt` omit unpublished posts and forks | `template.spec.ts` (`assertCmsFeeds`) + `browser/lib/src/cms.test.ts` |
| Forks hidden; scheduled / undated blog posts hidden; `cmsEditUrl` | `browser/lib/src/cms.test.ts` |
| Fork → edit → merge; pending forks listed on the original | `browser/e2e/tests/forks.spec.ts` |
| Three-way merge / conflict / document body CRDT | `browser/lib/src/forks.test.ts` |
| LocalizedText table editor | `browser/e2e/tests/localized-text.spec.ts` |

### Blind spots

| Gap | Why it hurts |
|---|---|
| Confidential drafts (private folder in a non-public Drive) | Not built. `makeDrivePublic()` still publishes the whole Drive. A `published-at` filter is not an ACL. |
| Suggest-an-edit for non-writers, reject-with-reason, Canvas body fork | Platform gaps in `planning/drafts-and-suggestions.md`; templates cannot paper over them. |
| Astro from-scratch guide | No test. The Website-template path is what CI exercises. |
| Image resizing / GraphQL | Documented product absences, not test gaps. |
