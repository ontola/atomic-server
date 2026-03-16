# Commits as State Certificates

> **Status:** Proposal (2026-05). Reframes Atomic Commits around Loro as the
> resource history engine. It does **not** propose removing signed writes — it
> separates the *required trust boundary* (verify a signed write) from
> *optional audit retention* (keep the commit afterwards).

## Thesis

Atomic keeps commits, but changes what they *mean*.

Today commits carry signed Loro updates, but the surrounding model still reads
as if the linear `previousCommit` chain is the canonical history of a resource.
That clashes with the Loro direction: the Loro document already holds the
mergeable, causal history. A linear commit chain is not the right source of
truth for conflict-free concurrent editing.

The cleaner split:

```text
Resource history   = Loro document / oplog
Write authority    = signed Commit
Commit retention   = node policy
```

A Commit is a **signed certificate authorizing a Loro state transition for one
resource**. It is required at the write/import boundary. A node does not have
to retain it forever as a resource once the resulting state is durable.

## Current tension

The system has already moved most state semantics to Loro:

- Property changes are encoded as `loroUpdate` bytes on the commit.
- Server apply imports the Loro bytes, materializes the current projection
  (`PropVals`), and stores a Loro snapshot.
- [`loro-source-of-truth.md`](./loro-source-of-truth.md) makes the Loro
  snapshot the canonical state for CRDT-backed resources.
- `loro.rs::get_history()` already reconstructs history by walking the Loro
  oplog's change ancestors — not the commit chain.

But commits still carry responsibilities that belong elsewhere:

| Responsibility | Belongs to |
| --- | --- |
| Mergeable resource history | Loro oplog |
| Causal ordering of edits | Loro (op IDs / version vectors) |
| Write authorization | Signed Commit |
| Proof of resulting state | Optional `stateHash` on the Commit |
| Audit feed (who changed what, when) | Optionally-retained Commits |
| DID genesis identity | Genesis Commit signature |

Signing is essential and stays. The problem is treating *retained commit
resources* as the canonical history store.

## Proposed definition

Replace:

> A Commit is a Resource that describes how a Resource must be updated.

With:

> A Commit is a signed certificate authorizing a Loro state transition for one
> Resource. The Resource's mergeable history lives in its Loro document;
> Commits provide verifiable authorship, authorization, and (optionally) a
> proof of the resulting state.

The public name "Commit" and the `/commit` endpoint / `COMMIT` frame stay
unchanged.

## Required versus optional

A conforming node **must** verify and apply signed commits. It **does not** have
to retain a commit after the resulting state is accepted and persisted.

**Required persistence:**

- Loro snapshot / oplog for each CRDT-backed resource.
- Derived current projection (`PropVals`) for reads, queries, and indexing.
- Tombstones for destroyed resources, keyed by resource identity.
- Sync metadata needed to compare causal state with peers.

**Optional persistence:**

- Commit resources themselves.
- Append-only audit logs and feed indexes derived from retained commits.

Normative shape for the spec:

```text
A conforming node MUST verify a Commit before applying a remote write.
A conforming node MUST persist the resulting resource state if the write is accepted.
A conforming node MAY persist the Commit as an audit resource.
Clients MUST NOT assume that historical Commit resources are retrievable.
```

## Idempotency: re-applying a commit is safe by construction

This is the load-bearing property that makes `retention=none` workable, so it
is spelled out before the wire format.

A node with `retention=none` keeps **no record that it applied a given
commit**. So it cannot answer "have I seen this commit?" by lookup. It does not
need to — **Loro provides idempotency directly**:

- Every Loro op has a unique ID `(peerId, counter)`.
- Importing an update whose ops are already in the doc is a **no-op**: Loro
  deduplicates by op ID.
- Therefore re-applying a commit to a doc that already contains its ops
  changes nothing, deterministically.

The apply path must treat this correctly. A re-applied commit produces **no
state change** — and that must be reported as **success** (return the commit
id), *not* an error.

This requires distinguishing two cases that look identical at the projection
level ("the commit produced no atom changes"):

1. **Idempotent replay** — the commit's ops are already in the Loro oplog.
   → Accept; it is already applied.
2. **Silent LWW loss** — the commit's ops are *new* but were authored against
   a doc that diverged from the server's, so they lose last-writer-wins and
   contribute nothing. → Reject; the client must refetch and retry.

The existing `validate_loro_causality` guard (`lib/src/commit.rs`) currently
conflates these — it rejects any commit that produced no atom changes. It must
instead check whether the commit's ops are already present in the doc's oplog
(case 1, accept) before treating an empty diff as loss (case 2, reject).

The browser outbox depends on this: on reconnect it may replay a commit the
server already applied over a different transport. With correct idempotency
that replay succeeds cleanly instead of stranding the outbox queue.

## Commit shape

The commit format does **not** need to change for this proposal. Today's
fields are sufficient:

```json
{
  "subject": "did:ad:...",
  "signer": "did:ad:agent:...",
  "createdAt": 1775504552928,
  "loroUpdate": "base64...",
  "previousCommit": "did:ad:commit:...",
  "destroy": false,
  "isGenesis": false,
  "signature": "base64..."
}
```

One **optional** field may be added later — a state proof:

| Field | Purpose |
| --- | --- |
| `stateHash` | Blake3 of the resource's materialized projection *after* this commit applies cleanly with no concurrent edits. Optional, signed when present. A diagnostic, not a gate — see below. |

What is **deliberately not** added:

- **No signed Loro frontiers / version vectors.** A Loro frontier is a set of
  `(peerId, counter)` pairs, and peer IDs are random per document. The client's
  doc and the server's doc for the same resource are different peer lineages,
  so "the same logical state" has *different* frontier bytes on each side.
  A signed `newFrontiers` the server is expected to reproduce and verify
  cannot work across peers. Frontiers/version vectors remain a **local,
  per-document** concern owned by the sync engine — never signed, never
  compared across peers as an identity. (Cross-peer frontier comparison is an
  open research item, not a dependency of this proposal.)
- **No `loroUpdateHash`.** The `loroUpdate` bytes are already covered by
  `signature`. A separate hash would only matter for content-addressed
  offloading of large updates — a distinct future concern, out of scope here.

### On `stateHash`

`stateHash` must be computed over the **canonical materialized projection** —
the resource's `PropVals` serialized as deterministic JSON-AD (sorted keys,
`loroUpdate` itself excluded) — **not** over Loro snapshot bytes. Loro
snapshots embed random peer IDs and are not byte-deterministic; hashing them
would produce a different hash on every node for identical state. The
deterministic-JSON-AD precedent already exists in
`commit.rs::serialize_deterministically_json_ad`.

`stateHash` is a **diagnostic**, not a validation gate. The signer computes it
over the state they *expect*. If a concurrent edit merged in between, the
server's materialized state legitimately differs and the hashes will not
match — that is correct CRDT behaviour, not an error. A mismatch means either
"a concurrent edit occurred" (expected) or "client and server materialized the
same Loro state differently" (a bug — the datatype-fidelity work in
`loro-source-of-truth.md` Phase 1 is what keeps materialization identical).
Treat a mismatch as a signal to log/investigate, never as a rejection.

### `previousCommit`

Demoted to optional audit/display metadata. It may stay for legacy chains and
human-readable history, but it is **not** a causal-validation gate — Loro op
IDs are the causal model. (This is already largely true in `commit.rs`, where
`previous_commit` is recorded as a propval but not validated.)

## Apply semantics

The authoritative apply path:

```text
parse Commit
verify signature over the canonical commit payload
check signer rights against current resource/drive policy
load the resource's current Loro document
import loroUpdate into the doc
  └─ ops already present  → idempotent replay: accept, no state change
  └─ ops new, empty diff  → silent LWW loss: reject, ask client to refetch
  └─ ops new, real diff   → normal apply
materialize the projection from the resulting doc
if stateHash present: recompute and compare (log on mismatch, do not reject)
persist Loro snapshot + projection + indexes  (one transaction)
persist a tombstone if destroy
persist the Commit only if node retention policy says so
emit node events
```

Invariants:

- Commit signature verification is **required** before any remote import.
- Commit *retention* is **not** required for future reads, sync, or history.
- The history UI reads the Loro oplog (the change list), not retained commits.
- `retention=none` must not break reads, writes, sync, history, search, or
  permissions — only the *audit feed* and *cryptographic authorship
  attribution per change* depend on retained commits (see below).

## What `retention=none` actually costs

Be honest about the tradeoff. The Loro oplog records, per change: *what*
properties changed, *when*, and *which peer*. It does **not** record the
*signed agent* — that lives only on the Commit.

So with `retention=none`:

- Resource history (the sequence of changes and time-travel) — **works**, from
  the Loro oplog.
- "Edited by «agent»" attribution per historical change — **lost**, unless the
  commit is retained.
- An append-only audit feed across resources — **unavailable**.

The current authorship of a resource is still knowable (the projection can
carry a "last editor" reference), but per-change attribution and audit feeds
genuinely require retained commits. Deployments that need those run `recent`
or `full`.

## Retention policy

Commit persistence is an explicit node-side policy:

```text
ATOMIC_COMMIT_RETENTION = none | recent | full
```

| Policy | Behaviour |
| --- | --- |
| `none` | Verify, apply, and discard the commit once the resulting state is durable. |
| `recent` | Keep a bounded, time- or count-limited cache for retry, diagnostics, and short-term feeds. |
| `full` | Keep every commit as an audit resource. |

Migration default: `full` (today's behaviour). Long-term default: `recent` —
it preserves recent-audit and diagnostics with bounded cost. `none` is for
storage-constrained or privacy-focused deployments that explicitly opt in.

**Genesis commits are always retained, regardless of policy.** A DID subject
is derived from its genesis commit's signature; verifying a resource's identity
requires the genesis commit's signed content. They are one per resource and
tiny — retaining them is cheap and non-negotiable.

## DID genesis

DID resource identity still derives from the genesis commit signature:

```text
did:ad:{signature-of-genesis-commit}
```

The genesis commit is the first signed certificate for a resource. For genesis
commits, `subject` is excluded from the signed bytes because the subject is
derived *from* the signature (circular otherwise). Genesis commits establish
identity and are always retained; this does not imply later commits must be.

## Relationship to Loro

| Loro owns | Commits own |
| --- | --- |
| Concurrent-edit causality and merge | Who authorized an import |
| Resource-local history (the oplog) | When the authorization happened |
| Time travel by version | Which resource was affected |
| Coalescing many local edits into one exported update | Which Loro transition was accepted |
| | Optional proof of the resulting state (`stateHash`) |

Commit granularity is free to vary — one property edit, a save boundary, a
batch of local edits, a sync boundary, a periodic checkpoint, a destroy. **One
commit is not assumed to equal one UI action or one Loro op.**

## Code impact

### `lib/src/commit.rs`

- Keep `Commit`; document it as a signed Loro-transition certificate.
- Split the `validate_loro_causality` guard into the two cases above:
  idempotent replay (ops already in the oplog → accept) vs. silent LWW loss
  (new ops, empty diff → reject).
- Add an optional `stateHash` field (computed/verified, never a gate).
- `previousCommit` stays compatibility/audit-only.
- Commits remain native signed resources, never CRDT-backed.

### `lib/src/loro.rs`

- Expose deterministic projection hashing for `stateHash` — over the
  materialized `PropVals` as canonical JSON-AD, never over snapshot bytes.
- Expose an "are these op IDs already in the oplog?" check for the idempotency
  branch of apply.

### `lib/src/db.rs` and apply paths

- Ensure accepted resource state is complete without any retained commit.
- Add `CommitRetentionPolicy` to the store/node config.
- Route commit storage through a single `maybe_store_commit` gate.
- Verify `get_resource`, sync import, query, history, and destroy never require
  a previous commit resource to exist.

### `server/src/handlers/commit.rs`

- Keep `/commit`.
- Return the accepted commit id/signature even when the commit resource is not
  retained.

### WebSocket protocol

- Keep `COMMIT` / `COMMIT_OK`.
- `COMMIT_OK` may include a retention hint (later protocol revision; not
  required for migration):

```json
{ "commit": "did:ad:commit:...", "subject": "did:ad:...", "retained": false }
```

### Browser and outbox

- The outbox stores signed commits as outbound certificates.
- A successful drain removes the outbox entry on acceptance, regardless of
  whether the server retained the commit — and an **idempotent-replay
  acceptance counts as success** (this is what unblocks the outbox after a
  same-commit retransmit).
- Client history reads the local Loro doc, never refetched commit resources.

### History / audit UI

- Resource history page: Loro oplog (the change list + time travel).
- Audit/feed views: retained commits only, and the UI must clearly indicate
  when retention is unavailable rather than silently showing an empty feed.
- Distinguish "resource history" (always available) from "audit log"
  (retention-dependent).

## Spec impact

Update `docs/src/commits/intro.md`, `commits/concepts.md`, `did.md`,
`websockets.md`, and `atomic-data-overview.md` (if it claims commits are the
history model):

- Define commits as signed state-transition certificates.
- State that commit retention is optional and node-policy-controlled.
- Demote `previousCommit` to optional audit metadata.
- Define the Loro oplog as the causal/history model for CRDT-backed resources;
  state explicitly that frontiers/version vectors are local sync state, not a
  cross-peer identity.
- Specify `stateHash` (canonical-projection hash) and that it is diagnostic.
- Clarify that a node may return an accepted commit id without making the
  commit resource retrievable later.

## Migration plan

### Phase 0 — audit assumptions

- [ ] Find code that fetches or depends on historical commit resources.
- [ ] Find code that treats `previousCommit` as required causal state.
- [ ] Find tests that assume commits are persisted; separate
      resource-history tests from audit-retention tests.

### Phase 1 — correct idempotency (do this first; unblocks the outbox)

- [ ] Split `validate_loro_causality` into idempotent-replay vs. LWW-loss.
- [ ] Accept idempotent replays as success end-to-end (server + outbox).
- [ ] Tests: replaying an applied commit succeeds; a divergent write is still
      rejected.

### Phase 2 — retention policy behind the current format

- [ ] Add `CommitRetentionPolicy`; default `full` (current behaviour).
- [ ] Route storage through `maybe_store_commit`.
- [ ] Add a test mode with retention disabled; ensure write/read/sync/history
      all pass with it off (genesis commits still retained).

### Phase 3 — Loro-based history

- [ ] Move the history UI/API onto the Loro oplog.
- [ ] Keep audit/feed UI explicitly backed by retained commits, surfacing when
      retention is unavailable.

### Phase 4 — optional `stateHash`

- [ ] Compute `stateHash` over the canonical projection on sign.
- [ ] Recompute and compare on apply; log mismatches, never reject.
- [ ] Keep accepting commits without it.

### Phase 5 — shift the default

- [ ] Default retention → `recent`; keep `full` available for audit
      deployments and `none` for opt-in minimal storage.
- [ ] Conformance tests asserting retained commits are optional.

This proposal depends on [`loro-source-of-truth.md`](./loro-source-of-truth.md)
being substantially complete — Loro must be the canonical, faithfully
materialized state before commit retention can safely become optional.

## Open questions

1. Should retention be per-node, per-drive, or per-resource? (Leaning
   per-node, with a per-drive override for shared/audited drives.)
2. Do audit feeds need a bounded mode with periodic signed checkpoints, so a
   feed survives `recent` eviction without keeping every commit?
3. How should a node advertise its retention policy to clients and peers?

## Related plans

| Doc | Relationship |
| --- | --- |
| [`loro-source-of-truth.md`](./loro-source-of-truth.md) | Makes Loro the canonical CRDT resource state — a prerequisite. |
| [`unified-sync.md`](./unified-sync.md) | Uses signed commits at the outbox/transport boundary. |
| [`sync.md`](./sync.md) | Current WS `COMMIT` implementation and echo suppression. |
| [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) | Future node boundary where retention becomes runtime policy. |
| [`unified-data-layer.md`](./unified-data-layer.md) | Browser outbox must not assume retained commit resources. |
