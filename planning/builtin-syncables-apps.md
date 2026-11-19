# Built-in Syncables: shared CI handoff

## Completed follow-up (2026-11-19)

- Canonical `github` catalog published by atomic-plugins PR #748, merged as
  `91a2c7418b64092aa90277b17148bb359690d978`. SaaS deployment 44545754328
  from `18cc23d2c1b151efb8d4d2c5c5a958b7cbeeb99e` passed and serves only the
  new provider ID. All other 16 profiles and the composed API bytes are unchanged.
  Michiel explicitly permits reconnecting all old GitHub clients; no route alias
  or credential/source migration is supplied for the provider rename.
- Principal HTTP 401s get per-slot recovery; genuinely empty accounts get an empty
  state. Saved accounts/data and unrelated errors remain visible. Explicit legacy
  reconnect uses verified cached identity and verifies fresh identity on return.
- Verified typed identity can reuse a historical account across slots. Existing
  conflicting entries remain intact for review or the approved reinstall; no
  resources were merged or deleted automatically.
- Collection replaces the generated Browse label, with a distinct icon. Historical
  default labels are presented consistently without rewriting stored/custom names.
  All six translation catalogs were settled through Vite and reviewed.
- The proposed [flat collection/filter model](flat-syncable-collections.md) is
  documented separately. Its storage and per-filter sync behavior are not built.

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

- 2,889 Data Browser tests and both MCP checks pass in UTC. Full typecheck,
  scoped checks and final pre-commit lint/format are required before publishing.
- Matching optimized native build with the plugin runtime: 14/14 Chromium
  journeys pass, one worker, zero retries, no skips/flakes. Includes ten existing
  Apps journeys plus authenticated selected hierarchy/background sync/pause and
  reconnect, expired orphan-slot recovery, Public migration/21-page pagination,
  and an unrelated Notebook API.
- Report: `.e2e-runs/2026-11-19T14-36-30.123Z-lq9pmP/{report,run}.json`.
  Desktop and mobile screenshots captured and shared in the implementation chat.
  Records are invented; this is not a fresh live GitHub OAuth acceptance run.
- The report records pre-commit HEAD `058cc9020`; the tested worktree also included
  the follow-up recovery, identity-proof and Collection-label fixes. Application source and tests
  remained frozen after the build/run; only documentation/handoff notes followed.
- Tested executable SHA-256:
  `cf0c0a45253e50223e74eac9dd8938bc652cf99bf9551db06a76280f3e501bd8`.
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
