# Built-in Syncables: integration handoff

Real-data import acceptance passed on `18c46ed3a`; the final SDK counter fix
and matching localhost build are `d993656e6`.

- [ ] Trekmeester resolves PR #2522's conflicts with develop, runs full shared
  Main/server CI on the final integration candidate, reviews and merges.
  Integration and shared CI remain with trekmeester; workers must not rebase,
  dispatch or rerun shared CI. Remove this handoff after that acceptance.
- [x] Attached the [current real-data walkthrough](https://github.com/ontola/atomic-server/pull/2522#issuecomment-7102109541)
  on 23 November 2026: 25 seconds from My drive through the principal App to
  the 2,608 stored Issues/PRs and linked authors. This edited capture uses the
  existing connection and completed import; it does not repeat OAuth.
  The earlier real sign-in recording shows the historical UI.

## Contract

`Drive → provider · principal / Public (App) → item type`.

Each typed principal has one App for the selected drive/proxy/provider. The
provider chooser stays in Apps; Public is its own App. Promotion preserves the
existing principal subject/local ID, child tables/rows/rules, user fields and
views. Native registrations outside iframe write roots prevent duplicate Apps,
including after reload, a new OAuth slot, renaming and same-drive moves. App
binding changes revoke old workers; child sync inherits the verified current
slot. Opening the chooser cannot silently select an older orphan slot.
Existing conflicting data is preserved and reported rather than merged.

Apps and Sync reads, query results, subscriptions and writes stay in the selected
Drive even while another is active or cached. Local and server queries retain
explicit Drive scope. Hosted identity lookups require complete server results;
known foreign legacy rows are filtered before ambiguity and pagination, while
unproven ancestry fails closed. Native Open keeps cached/offline behavior.
Deterministic identity collisions park pending writes for review, retaining
genesis/edits instead of replaying indefinitely or deleting data.

The catalog supplies identity, API schemas, relationships and filter bindings.
One canonical table holds each item type; following a relationship saves a filter
of that table. Filters have independent sync/pause status and memberships.
Overlapping reads share typed rows, explicit field evidence and durable run order.
Complete reads replace only their own membership; incomplete/cancelled reads
retain accepted data. Canonical identity survives same-drive moves.

Collection and Table are native views of stored data. Ordinary Table cells show
stored resource links; its Open action follows proven catalog relationships to a
saved filter of the target table, without provider/catalog reads. The navigation
column adds no API schema field. Saved Collection views remain compatible. Sync
runs in an opaque iframe through the existing bridge; the proxy retains
credentials. Request authority comes from the selected filter, current catalog
and actual response provenance, without Drive-root iframe write grants.
Reopening Sync revalidates metadata without restarting its worker.

The catalog's `x-embeddedResources` declarations supply object, object-array,
discriminator-selected and explicit scalar reference links. Host-held response
observations authorize native materialization only within the same
Drive/proxy/platform/typed principal. No extra provider reads or recursive
expansion are needed. Canonical target IDs survive richer hydration and
same-drive moves; moved rows are reused without reparenting or updating them.
Partial-reference resources retain actual identity evidence until required API
and class fields are proved. Raw values and richer/user-authored data remain
stored; reference-only targets claim no invented collection read or membership.
Trash, ambiguity, unproven ancestry and changed permissions fail closed. Link
schema/view migration preserves existing row/class IDs and user column choices.

Proven legacy sources preserve subjects, local IDs, user fields and read plans.
Ambiguous/unprovable sources block competing allocations. Out-of-root moves remain
protected. Adopted tables are navigation leaves despite retained old local IDs;
cold rows hydrate before ownership validation. Canonical `github` replaces
`github-issues`; Michiel approved reinstall/reconnect of all old clients. Old data
is retained rather than deleted or merged automatically.

## Dependency and verification

- Production source: `d993656e6e413d71ccd738e1b96a9429c75a1554`, owned branch
  `codex/builtin-syncables-completion`, published through
  `feat/builtin-syncables-foundation` in
  [PR #2522](https://github.com/ontola/atomic-server/pull/2522).
- The actual registry package `syncables@0.31.2` is bundled into the Sync app,
  from merged plugins [#755](https://github.com/ontola/atomic-plugins/pull/755),
  [#756](https://github.com/ontola/atomic-plugins/pull/756) and
  [#757](https://github.com/ontola/atomic-plugins/pull/757), final merge
  `026b22f2242a715a67260f2f5427cd092a56246d`. Required package CI and 2,158
  tests passed (85 existing skips). All 230 registry files and modes match the
  tested release candidate, with publication provenance verified.
- 3,125 Data Browser tests across 381 files and both MCP tests pass in UTC.
  Full app typecheck, staged lint/format, navigation hook compiler checks and
  the six-language audit pass; locales contain 3,146 keys each.
- The 84 focused host/query/profile cases cover large 5,518- and 10,734-record
  journals, bulk cold hydration, scope changes, malformed pages, cancellation
  and native retained-parent identities. Every child page uses a fresh signed
  server query; pagination retains only bounded totals/seen-ID metadata.
  Parent and explicit Drive stamps are checked again after async work.
  Full identity scans retain Trash-aware, fail-closed behavior.
- Read limits remain 128 requests, 4,000 records, 32 partitions and zero retries,
  with a five-minute elapsed budget including native response processing.
  Timed tests complete a valid 150-second read and retain only accepted pages
  when the elapsed budget is exhausted.
- The final SDK suite passed 1,804 tests (one existing skip), including seven
  HTTP paging/count regressions. Existing off-page updates revalidate partial
  server membership instead of being counted twice; complete local/small-query
  optimistic behavior remains covered. The matching WASM was rebuilt.
  Rust paging tests passed 38 query cases (one existing ignored benchmark),
  12 Trash cases and explicit authorization/Drive regressions. No later Rust
  change was made. Both query paths check visibility before totals/offsets.
- All 17 optimized native Chromium journeys pass with one worker and zero
  retries, skips or flakes (171.6 seconds for seven Syncables journeys and
  53.4 seconds for ten shared App journeys). They cover real stored target IDs,
  native Table navigation without provider reads, overlapping filters, pause,
  background/offline navigation, principal reuse, moves, reconnect, Public,
  unrelated providers, two populated Drives and retained Trash collisions.
  Fixtures use invented records; the real-data check below is separate.
- Native reports: `.e2e-runs/2026-11-21T07-57-52.646Z-UW45VM/{report,run}.json`
  and `.e2e-runs/2026-11-21T08-06-26.916Z-mIxSai/{report,run}.json`.
  Executable SHA256:
  `b8f349e89cb80400bc64d4e2bf4798515a84e5d1e0ec8fbcc64b8660bf7833ec`.
  Localhost52771 runs that private executable against the existing drive data;
  host, Sync and WASM bytes match the tested distribution. No data was reset.
- [Flutter checks 44882636597](https://github.com/ontola/atomic-server/actions/runs/44882636597)
  passed on that production source. Full shared Main/server CI has not run on
  this head. PR #2522 remains draft/conflicting pending integration acceptance.

## Real-data acceptance

The existing real GitHub connection, running `18c46ed3a`, completed the `ontola/atomic-server` Issues
and pull requests filter at **2026-11-21 07:41:12.909 UTC**: 2,608 rows,
708 added, one changed and 1,899 unchanged, `incomplete=false`, `error=null`.
The worker finished with no queued execution. All 2,608 author fields contain
stored Atomic links to 43 distinct author resources. Full signed row scans
verified target IDs, Drive, proxy, platform and typed principal; no invalid links
were found. Original issue and author subjects were retained, including the
formerly failing #1829, whose undeclared structured `type` remains in raw data.

The provider returned 27 Issues pages. The 41 total provider requests comprise
identity, repository discovery and Issues; embedded owner/author summaries
required no extra detail fetches. The current shared reader preserves catalog
query defaults and projects only fields declared on each resource schema.

The preceding repository backfill completed 1,274 rows with zero added and
1,274 changed, `incomplete=false`, `error=null`. Every repository has a stored
owner link. The existing `ontola/atomic-server` subject and its same-drive
`ontola` organization link were rechecked after the Issues import.

Ordinary Table and an author resource were verified as native stored-data views:
zero iframes and no provider refresh on opening. The final SDK-only build keeps
2,608 data rows (2,609 ARIA rows including the header); the Sync bundle and WASM
bytes are unchanged from the accepted import. Dev drive's old App remains in
Trash as explicitly requested, and the 22 historical blocked drafts are retained.
No restore, deletion or initialization was performed.

On the final localhost build, explicitly refreshing 30 existing off-page Issues
kept all 41 Table count samples at 2,608 data rows plus the header. This used only
signed Atomic reads, with zero iframes or provider requests.

The immutable record-links catalog is active on `integrations.atomic.place` via
[catalog-only rollout 44760703345](https://github.com/ontola/atomic-saas/actions/runs/44760703345),
which retained runtime, connection keys, credentials and other provider profiles.
This acceptance used the existing connection; the earlier real OAuth
[walkthrough](https://github.com/user-attachments/assets/f8f7e24a-d23e-47ea-8193-bf8ae75dc51c)
shows the historical UI, not this final refactor.

Earlier Main CI passes are not evidence for this head. Bidirectional provider
writes and unattended server-side synchronization remain outside this MVP.
