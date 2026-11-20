# Built-in Syncables: shared CI handoff

Local implementation and acceptance are complete. Remaining gate:

- [ ] Trekmeester runs full shared server CI on the final PR #2522 head, reviews
  and merges. Workers must not dispatch or rerun shared CI. Remove this handoff
  after that acceptance.

## Contract

`Drive → provider App → authenticated principal / Public → item type`.

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

- Tested application source: `bda3250fe99b1efbd90e9c0e735293662d28f0a5` on
  `codex/builtin-syncables-completion`, published to PR #2522 through
  `feat/builtin-syncables-foundation`. Subsequent cleanup is documentation only.
- Actual npm `syncables@0.30.0`, released from atomic-plugins PR #749, merge
  `e9933e8fbf772c48476e3345d2263494598664ee`. Relevant PR checks and publication
  run 44556325558 passed; registry bytes/provenance match the tested candidate.
- 2,938 Data Browser tests and both MCP checks pass in UTC. Full typecheck,
  pre-commit lint/format, compiler checks and six-language translation audit pass.
- 1,791 @tomic/lib tests pass, with one existing skip. Query snapshots replace
  independent server pages while ordinary documents retain CRDT merge behavior.
- 14/14 optimized native Chromium journeys pass, one worker, zero retries,
  skips or flakes. Includes overlap, independent pause, background/offline
  navigation, reconnect, legacy adoption, 21-page Public reads, unrelated provider
  and existing Apps cases. Desktop/mobile screenshots shared in chat.
- Native report: `.e2e-runs/2026-11-20T07-00-18.764Z-KHeWii/{report,run}.json`.
  Executable SHA-256:
  `11e4e4be313c07a93c3435f00292cfd828934596b28a3f2ebe3902cf3eff8ebf`.
- Localhost port 52771 runs that private executable against the existing drive.
  HTTP health and host/Sync asset bytes match the tested distribution. Live
  catalog SHA-256 remains
  `ac247f6b3cc28c3be5f24e7858c2232bd4a50c0640a0b241823171157d21f621`.

Browser fixtures use invented records; this is not a new live GitHub OAuth test.
Full shared server CI has not validated this application head. Earlier full passes
are not evidence for this refactor. Bidirectional provider writes and unattended
server-side synchronization remain outside this MVP.
