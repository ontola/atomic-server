# Automatic HTTP/WebSocket storage receipts

Status: implementation and local validation complete; required CI pending.
PR: https://github.com/ontola/atomic-server/pull/2594. Follows #2592; related
#2538, #2537 and #2244. Separate from the TablePage extraction.

## Isolation and ownership

- Chat: `regarding-https-github-com-ontola-atomic`.
- Worktree: `/Users/michieldejong/.codex/worktrees/atomic-peer-receipts/atomic-server`.
- Branch: `codex/atomic-server-receipts-2538`.
- Base: `codex/atomic-iroh-receipts-2538`,
  `0cd97292a6c93f60797df4b6ffa27370d65726e0` (#2592, unmerged).
- Coordinator: integration, documentation, plan, validation and publication.
- Architecture/SDK agent: `browser/lib/src/` requester, transport hooks and unit tests.
- Server agent: `server/src/`, server integration tests and protocol constant.
- Independent reviewer: read-only architecture and final diff review.
- Coordinator owns `browser/lib/tests/server-receipts.integration.test.ts`.
- Agents do not commit or push.

## Acceptance criteria

- HTTP and WebSocket servers reuse the shared authenticated producer: exact
  requested applied-state coverage, read authorization, persistent scoped
  identity, flush barrier and post-flush rechecks.
- SDK produces correlated observations automatically for captured versions;
  ordinary commit acknowledgements retain their acceptance-only meaning.
- No evidence from legacy/unsupported servers, memory-only receiving stores,
  malformed replies, expired requests or changed account/database sessions.
- Bounded best-effort work does not break ordinary saves or sync.
- Tests exercise real HTTP/WS servers plus negative authorization/correlation
  and lifecycle cases. Documentation identifies the public consumption API and
  separates historical storage observations from retention, independence and
  recoverable backup guarantees.

## Work

- [x] Architecture contract and bounded implementation assignments
- [x] Server producer adapters and tests
- [x] Automatic SDK requester and lifecycle tests
- [x] Real-server integration coverage
- [x] Public docs and coverage map
- [x] Independent review and required local checks
- [x] Dedicated stacked PR (#2594)
- [ ] Exact-head required CI (self-hosted runners were unavailable for #2592)

The plan remains until required CI passes; pending dependency plans stay intact.

## Contract

`server-storage-receipts-v1` is adapter-specific. A successful HTTP `/commit`
response advertises it with `X-Atomic-Storage-Receipts`; WS advertises it in
`AUTH_OK` and requires the client's `HELLO` opt-in. Signed `POST /storage-receipt`
uses the existing request/receipt JSON (200 proof, 204 no evidence); WS uses
0x56/0x57. HTTP authentication binds the exact request URL. Server adapters reuse
the shared producer and keep commit acknowledgement semantics unchanged.

The SDK's `StoreEvents.ServerReplicaReceipt` reports immutable
`ServerReplicaReceipt` observations with server origin/endpoint, actual transport,
client agent, account/database generations and connection ID. Local source
identity is optional: memory-only clients can obtain remote storage evidence
without claiming a persistent local copy. Applications still decide whether the
identified storage and transport satisfy their trust and independence policy.

## Validation and remaining limits

- Four real HTTP/WS server tests passed: explicit proof, capability/CORS,
  authentication, URL/body tampering, drive/read gating, missing/uncovered state,
  local-only target reads and WS opt-in compatibility.
- A cancellation regression reproduced premature admission release before the
  fix, then passed with the load guard owned by the actual blocking flush.
- Three real SDK/server scenarios passed: automatic exact HTTP/WS save targets,
  delayed C1 after C2, and fresh reconciliation evidence after reconnect.
  Reconciliation targets are stored state and may include server metadata added
  after a captured save; tests compare against the actual captured inventory.
- SDK unit tests cover context fencing, optional-source evidence, bounded work,
  fair 300-resource inventories and HTTP adapter boundaries.
- Final SDK unit suite: 1,903 passed, one existing skipped test. TypeScript
  checking, Rust formatting and the full browser/WASM production build passed.
  The mandatory staged lint/workspace Clippy gate also passed.
- Independent source review found no remaining blocker. Deterministic WS
  held-proof/overlapping-AUTH reauthentication coverage remains a test gap.
- No new dependency, UI or TablePage changes. These are historical resource
  observations, without physical-independence, blob/key, retention or backup
  guarantees. Native WS/Flutter callers are not automatically subscribed to the
  TypeScript Store event.
