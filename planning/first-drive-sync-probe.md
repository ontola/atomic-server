# First-drive hash probe bootstrap

Status: in progress. Task: Codex Atomic localhost pilot, 2026-10-06.
Worktree: `/Users/michieldejong/gh/ontola/worktrees/atomic-server/first-drive-sync-probe`.
Branch: `codex/first-drive-sync-probe`, base `54eb294d54de0e6d8d1f32cc70ed7c129d5ccbda` (origin/develop).

- [x] Astra architecture review: admit a genuinely absent drive without weakening existing read gates or enrolling on a probe; implementation review found no actionable defects.
- [x] Reproduce missing-drive probe failure at Rust engine layer (ERROR instead of RESEND); client tests also failed before correction.
- [x] Fix server probe bootstrap and test policy / access denials (43 engine/policy/tombstone tests passed).
- [x] Report refused SYNC in client drive status, preserving subscription refusal behavior; 41 WebSocket tests, typecheck and targeted lint passed.
- [x] Update protocol docs and coverage map.
- [x] Targeted checks, 12 real-server authentication-gate tests, full browser workspace/default server builds and staged lint/Clippy hook; reviewed diff.
- [x] Linked issue #2116 and PR #2120 against develop.
- [ ] Exact-head CI: explicitly dispatched Main; self-hosted CI and downstream jobs are queued awaiting a runner.
- [x] Backport tested server fix to isolated Joep-version build; deploy localhost, verify actual drive arrival and signed HTTP access. Existing data/frontend/NodeID preserved; browser reports In sync; signed server usage confirms 70 resources, 937866 blob bytes and 1175770 Loro bytes. Fresh root and eight top-level resource reads succeed. Every nested resource/attachment was not individually verified.

Ownership: coordinator owns plan/docs/publication/deployment; coding agent owns engine and WS client implementation/tests after architecture approval. Joep MCP source and original develop checkout remain untouched. Live browser is user-owned; do not discard its cache or credentials. Production app UI update is outside local deployment; no merge authorized.

Acceptance: authenticated allowed new-drive probe requests full sync; anonymous/disallowed/private-existing probes remain denied; probe never persists/enrolls; full import retains existing admission checks; browser refusal reaches an error status. Local data/key/NodeID preserved on deployment. Root readability is not proof of complete drive inventory or attachment transfer.

Issue: https://github.com/ontola/atomic-server/issues/2116.
PR: https://github.com/ontola/atomic-server/pull/2120.
Local backport: `codex/first-drive-sync-probe-local` at sibling `first-drive-sync-probe-local`, based on deployed Joep pin `0f9b5f4298e41a2da7360c847f455b724b7518ed`. Only Rust fix/tests backported, exact existing frontend assets retained. The hosted browser gets its client error-state fix only through a later upstream deployment.
