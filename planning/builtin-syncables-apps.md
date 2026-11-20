# Built-in Syncables: shared CI handoff

Local implementation and acceptance are complete. Remaining gate:

- [ ] Trekmeester resolves PR #2522's conflicts with develop, runs full shared
  server CI on the final integration candidate, reviews and merges. Integration
  and shared CI remain with trekmeester; workers must not rebase, dispatch or
  rerun shared CI. Remove this handoff after that acceptance.

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

The catalog supplies identity, API schemas, relationships and filter bindings.
One canonical table holds each item type; following a relationship saves a filter
of that table. Filters have independent sync/pause status and memberships.
Overlapping reads share typed rows, explicit field evidence and durable run order.
Complete reads replace only their own membership; incomplete/cancelled reads
retain accepted data. Canonical identity survives same-drive moves.

Collection and Table are native views of stored data. Open saves a declared scope
without provider/catalog reads. Sync runs in an opaque iframe through the existing
bridge; the proxy retains credentials. Request authority comes from the selected
filter, current catalog and actual response provenance, without Drive-root iframe
write grants. Reopening Sync revalidates metadata without restarting its worker.

Proven legacy sources preserve subjects, local IDs, user fields and read plans.
Ambiguous/unprovable sources block competing allocations. Out-of-root moves remain
protected. Adopted tables are navigation leaves despite retained old local IDs;
cold rows hydrate before ownership validation. Canonical `github` replaces
`github-issues`; Michiel approved reinstall/reconnect of all old clients. Old data
is retained rather than deleted or merged automatically.

## Dependency and local proof

- Tested application source: `5c7ac5e76fa345d60dc5ebf94879ac6ed862f6c6` on
  `codex/builtin-syncables-completion`, published to PR #2522 through
  `feat/builtin-syncables-foundation`. Browser acceptance source
  `410a7c6e35eff42d527a210eb538b06404c3266c` adds chooser checks/screenshots only;
  subsequent cleanup is documentation only.
- Actual npm `syncables@0.30.0`, released from atomic-plugins PR #749, merge
  `e9933e8fbf772c48476e3345d2263494598664ee`. Relevant PR checks and publication
  run 44556325558 passed; registry bytes/provenance match the tested candidate.
- 2,983 Data Browser tests and both MCP checks pass in UTC. Full typecheck,
  pre-commit lint/format, compiler checks and six-language translation audit pass.
- 1,791 @tomic/lib tests pass, with one existing skip. Query snapshots replace
  independent server pages while ordinary documents retain CRDT merge behavior.
- 15/15 optimized native Chromium journeys pass, one worker, zero retries,
  skips or flakes. Includes overlap, independent pause, background/offline
  navigation, principal-App reuse/isolation, Public reinstall, reconnect,
  legacy adoption before saved-filter navigation, 21-page Public reads, unrelated
  provider and existing Apps cases. Desktop/mobile screenshots shared in chat.
- Native report: `.e2e-runs/2026-11-20T09-27-24.155Z-Y21UYi/{report,run}.json`.
  Executable SHA-256:
  `0189c03d44fed449468b621afbfe7347d2c62372a528add5a2b5d2620aa62003`.
- Localhost port 52771 runs that private executable against the existing drive.
  HTTP health and host/Sync asset bytes match the tested distribution. Live
  catalog SHA-256 remains
  `ac247f6b3cc28c3be5f24e7858c2232bd4a50c0640a0b241823171157d21f621`.

Browser fixtures use invented records; this is not a new live GitHub OAuth test.
Full shared server CI has not validated this application head. Earlier full passes
are not evidence for this refactor. Bidirectional provider writes and unattended
server-side synchronization remain outside this MVP.
