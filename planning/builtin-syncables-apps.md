# Built-in Syncables: shared CI handoff

## Remaining work

- [ ] Trekmeester runs full shared server CI on the final PR #2522 head, reviews
  and merges. Workers must not dispatch or rerun shared CI for this refactor.
  Remove this handoff after acceptance; implementation is locally complete.

## Final source and published dependencies

- Owned server worktree: `builtin-syncables-completion/atomic-server`, branch
  `codex/builtin-syncables-completion`, published through existing PR #2522 on
  `feat/builtin-syncables-foundation`. Refactor base: `43eb0306c0555f45db77ee2ed5dd8ddde1d168c6`.
- atomic-plugins PR #747 passed all required checks and merged as
  `4f7ceb8100cb461e3e0b3e223bcfaaa4b6883935`. The actual registry package
  `syncables@0.29.0` is pinned with a frozen lockfile. Archive integrity matches
  the tested candidate; provenance names the merged source and official publisher.
- Immutable IAP profile `2026-11-19-collection-navigation.json` is published and
  deployed on integrations.atomic.place by SaaS run 44520913028. All 17 providers,
  runtime binary, public connection key, credentials and permissions were retained.
  Public GitHub document SHA-256:
  `ac247f6b3cc28c3be5f24e7858c2232bd4a50c0640a0b241823171157d21f621`.

## Local acceptance

- 2,858 Data Browser tests and both MCP checks pass in UTC. Full typecheck,
  scoped checks and final pre-commit lint/format are required before publishing.
- Matching optimized native build with the plugin runtime: 13/13 Chromium
  journeys pass, one worker, zero retries, no skips/flakes. Includes ten existing
  Apps journeys plus authenticated selected hierarchy/background sync/pause and
  reconnect, Public migration and 21-page pagination, and an unrelated Notebook API.
- Report: `.e2e-runs/2026-11-19T13-17-04.382Z-VixFsq/{report,run}.json`.
  Desktop and mobile screenshots captured and shared in the implementation chat.
  Records are invented; this is not a fresh live GitHub OAuth acceptance run.
- The report records pre-commit HEAD `b65b9b231`; the tested worktree also included
  the final migration-coverage and paused-mount fixes. Application source and tests
  remained frozen after the build/run; only documentation/handoff notes followed.
- Tested executable SHA-256:
  `64ad894b74fe4509cd5ad6d462bbbee47b5479fc48d7c0d98e059da295700837`.
  Localhost port 52771 uses that private executable with the existing drive.
  HTTP health and host-app/Sync-app bytes match the tested embedded assets.
- A pre-existing date-formula test fails in Europe/Amsterdam and passes in UTC;
  its source is unchanged. The earlier full hosted pass 44341195612 tested
  `43eb0306c`, not this refactor. New-head full shared CI remains unverified.

## Contract and compatibility limits

Drive → provider App → authenticated principal or Public → catalog collections.
Authenticated Principal, CRUD references and standard OpenAPI response Links own
identity and organization/repository/Issues navigation. The new GitHub profile
omits legacy owner-path mutation annotations; historical published profiles remain
unchanged. GitHub Issues explicitly includes pull requests.

The actual Syncables library owns API discovery, bound reads, pagination and typed
projection. Atomic owns storage, UI and permission checks. Refresh executes through
the existing opaque AppFrame bridge; native views read saved Atomic data only.
Credentials stay outside the iframe. Selected-root write boundaries are unchanged;
compact logical-parent hashes preserve identity across moves within bridge limits.

Migration retains subjects, user fields and manual locations, and fails closed on
incomplete/duplicate query pages or ambiguous aliases. Unresolved old-format sources
opened directly show a validated integration-App link before frame/schema setup.
Aliases outside the selected frame root are retained without broader drive grants.
Paused Sync views retain Resume after reload while provider reads and starts remain
blocked, including requests awaiting principal verification.
