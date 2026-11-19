# Candidate25 integration

Status: merge resolution and validation in progress.

User request: include envelope-batching PR #2381 and everything merged into develop since candidate24, preserving both histories. Do not advance the production/plugin pin as part of this request.

Worktree: `/Users/michieldejong/gh/ontola/worktrees/atomic-server/candidate25-integration`.
Local branch: `codex/atomic-plugins-pin-candidate25`; publish as `claude/atomic-plugins-pin-candidate25`.
Inputs: candidate24 `9524618a46b7e1c57e440effca310519367e2400`, PR #2381 `8ffbc40b92c321972b447bbd72a29cb30ada35b0`, develop `100841e6640e46147922640e0d7158711382f9c2` (two batches after `2339f4e1fc2de3bf0f6e6d0f550348405837f463`).

- [x] Astra integration review and exact input inventory.
- [x] Merge the focused feature with history retained.
- [x] Merge develop and resolve overlapping sync, catalogs and documentation changes.
- [x] Validate combined persistence, drive events, probe invalidation, flush durability, runtime consumers and frontend build.
- [ ] Publish candidate25 and record inclusion on PR #2381.
- [ ] Exact-head full CI, then completed-plan cleanup.

Coordinator owns Git integration, documentation and validation. Terra owns Rust conflict resolutions and regression tests; a separate Terra owns the four translation catalogs. No concurrent extraction writer. All heavy local commands use the benchmark measurement lock and 20 GiB free-space guard.

Preserve develop's deferred-search/admitted-drive parameters, drive-scoped events, staged parent admission, identity locks, write-log/probe-cache invalidation and redb flush mutex/failure restoration. Append verified envelopes before the single combined storage transaction; notifications follow commit. Public API and protocol remain compatible. Preserve candidate plugin features and translations; retain develop's reorganized docs with candidate-only links.

The feature's prior full CI failed at the unrelated `/all-versions` endpoint test and downstream Server/SaaS `profile.dev` alignment. These are recorded blockers, not green validation. Candidate25 needs its own CI; previous 10k timing is for the feature on candidate24, not this merged candidate.

Validation so far: frontend/WASM build and formatting passed; catalogs unchanged by build. Sync filter: 20 passed; envelope filter: 87 passed; write-log/cache: 10 passed; storage/flush: 5 passed; drive events: 2 passed; import-durability integration: 2 parents passed (2 ignored subprocess entry points were invoked by the parents). Counts overlap between filters. Native server build and plugin-routes-enabled Clippy passed. Mandatory commit-hook checks pending.

## Obsolete endpoint test follow-up

- [x] Remove `version_endpoints`, which still required the deliberately retired `/all-versions` and `/version` routes. Client Loro history and `/history-attribution` coverage remain in place.
- [ ] Re-run candidate CI after publication; the independent Server/SaaS `profile.dev` alignment failure remains unresolved.
