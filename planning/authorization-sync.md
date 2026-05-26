# Sync authorization and resource authorship

> **Status:** Draft plan (2026-05). Builds on [`unified-sync.md`](./unified-sync.md),
> [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md),
> [`sync.md`](./sync.md), and the DID model in [`docs/src/did.md`](../docs/src/did.md).

## Goal

Every accepted resource state must be explainable as:

1. A genesis commit signed by the resource creator, proving who created the
   resource and binding the resource DID to that signature.
2. Later commits signed by an agent that had write authority at the time of the
   commit.
3. If the signer is not the creator, a verifiable grant chain showing that an
   authorized signer granted that agent write rights before the later commit was
   accepted.

This must hold for server-backed WebSocket sync and for peer sync. Transport
authentication can identify a connection, but it is not proof that a resource
mutation is authorized. Signed commits are the write boundary.

## Current model

The good parts are already present:

- `did:ad:{signature}` resource identity is derived from the genesis commit
  signature. For genesis commits, the subject is excluded from signed bytes, and
  `isGenesis: true` is included in the signed payload.
- Commit signatures are verified against the signer agent. For `did:ad:agent:*`
  signers the public key is embedded in the DID, so verification does not need
  network resolution.
- HTTP `/commit` and WS `COMMIT` use the same signed JSON-AD body and shared
  apply path.
- `apply_commit` validates rights against the old resource for existing
  resources, so a malicious commit cannot grant itself write rights and then
  pass authorization in the same commit.
- New DID resources get the signer inserted into their `write` list after
  authorization succeeds, so the creator keeps future write access.

The weak part is bulk sync:

- `SYNC_PUSH` imports Loro bytes directly and materializes state. It checks that
  the authenticated peer has write access to the drive, but it does not verify a
  signed commit per imported resource update.
- This is acceptable only as same-agent/offline catch-up between honest
  replicas. It is not sufficient as the authoritative cross-agent write path.
- `remove[]` in `SYNC_DIFF` is likewise an anti-resurrection reconcile signal,
  not a signed delete.

## Required invariant

The invariant should be phrased in terms of accepted state transitions, not
transport frames:

```text
accept(resource transition) only if:
  commit signature verifies
  signer matches signed payload
  genesis subject identity matches signature, for genesis commits
  signer had write authority before the transition
  the authority can be explained by current resource/ancestor rights,
  or by a retained/verifiable grant commit chain
```

The last line is the new authorization work. Current hierarchy checks can answer
"does this signer have write now?", but cryptographic audit needs to answer
"why did this signer have write at the moment this commit was accepted?"

## Delegated sync example

Target case:

```text
A creates resource R
A signs a commit granting B write rights on R
B signs later commits that modify R
C connects to B and asks for R
```

B must be able to send C more than the current resource state. C needs a proof
bundle:

1. `genesis(R)` — signed by A, with `isGenesis: true`, proving A created
   `did:ad:{genesis_signature}`.
2. `grant(A -> B, R)` — signed by A, whose Loro update adds B to `write` on R
   or on an ancestor that grants inherited write rights.
3. `change(B, R)*` — B's signed commits after the grant.
4. Optional current snapshot/delta bytes so C can materialize quickly after the
   commits have verified.

If old B content commits were compacted, B replaces the pre-compaction
`change(B, R)*` range with an authorization checkpoint plus a snapshot hash. C
can still prove A created R and authorized B, and can verify B's
post-checkpoint commits, but C cannot reconstruct every compacted historical
edit.

C verifies the bundle in order:

```text
verify genesis signature
derive R subject from genesis signature
materialize R0
verify A's grant signature
check A had write rights before the grant
apply grant -> effective rights now include B
if compacted:
  verify auth checkpoint basis and signature
  verify snapshot hash
for each B commit:
  verify B signature
  check B had write rights before that commit
  apply commit
compare optional final snapshot/state hash, if present
```

This makes B a distributor, not a trusted authority. C trusts the signed commit
chain, not B's statement that B was allowed to write.

## Application patterns

The delegated A → B → C model is the foundational primitive for several
distinct use cases. The proof-bundle structure is the same in each; what
varies is whether there are grant commits, who B is, and what C does with
the result.

### Collaborative resource (the canonical A → B → C case)

A creates R, grants B write, B edits, C verifies. Already covered above.
Grant commits are present; B's own commits are authoritative.

### Volunteer replica of a public-readable subtree

Bob volunteers to mirror Alice's public posts. Bob is B; clients fetching
from Bob are C. The proof bundle for any resource R in Alice's public
subtree contains:

- `genesis(R)` signed by Alice
- Alice's content commits to R (with optional auth checkpoint + snapshot
  for compacted ranges)
- *No* grant commits, because Alice did not delegate write — Bob is a
  read-only distributor

Clients verify Alice's signatures, never Bob's. Bob serves bytes; he cannot
forge or alter Alice's content. The same fail-closed rule applies: if Bob
serves a resource without a verifiable genesis + chain back to Alice, C
rejects it.

### Cached followees / feed assembly

A user's home server caches drives in the user's follow list. For each
cached drive, the home server is B; the user's clients are C, pulling from
their own server. Cache eviction must respect authorization retention: the
per-drive cache may discard ordinary content commits, but must retain
genesis + rights-relevant + parent-changing + destroy commits and at least
one auth checkpoint per resource, otherwise the client cannot independently
verify commits arriving after the eviction boundary.

The cache pool is physically separate from the user's own drive storage —
cached commits are not signed by the user, and conflating the two storage
classes risks letting cached state be served as if it were authoritative
local content.

### Indexer / aggregator nodes

An indexer crawls many drives and exposes derived collections (reverse-reply
index, mention lookups, hashtag feeds, ranking algorithms) as resources on
its own drive. The indexer agent signs the collection resources, but each
member they reference is a real signed commit from an originating drive.
Consumers can either:

- Trust the indexer's aggregation (lighter, requires trust in the indexer
  not to fabricate or omit members), or
- Independently verify the referenced commits against their original drives
  (heavier, fully trustless).

Indexers are distributors, not authorities — same shape as the volunteer
replica above, just with a many-to-one fan-in. They expand reachability
without expanding the trust surface.

### Direct messages as paired granted-read subtrees

A two-party conversation is two granted-read subtrees, one per drive:

```text
Alice's drive: /dms/{conv-id}/from-alice/...  read: [alice, bob]
Bob's drive:   /dms/{conv-id}/from-bob/...    read: [alice, bob]
```

Each party writes only to their own drive — no cross-drive write grant is
needed. The other party subscribes to the granted-read subtree on the
sender's drive. The grant commit (Alice granting Bob read on her DM
subtree) is the auth-relevant evidence Bob retains; Alice's message commits
are ordinary content commits within that subtree.

Sealed-box encryption of message bodies is defense-in-depth on top of the
ACL — authorization already provides confidentiality against unauthorized
peers; encryption defends against server compromise or accidental ACL
widening.

### Actor-side likes, replies, reposts

A "like", "reply", or "repost" referencing a post on another agent's drive
is a signed commit on the *actor's* own drive, with a property pointing at
the target post DID. No cross-drive grant is required — the actor writes
only to their own drive. The target's drive owner never sees the like as an
inbox push; instead an indexer (above) builds the reverse index for "who
liked / replied to post X".

This is the recommended alternative to public-write inboxes (see
[Open questions](#open-questions)). It keeps the grant chain clean and
sidesteps the spam-inbox class of problem entirely.

## Grant proof model

The simplest model is to treat `read` / `write` mutations as ordinary signed
commits with special audit semantics:

- A rights grant is a commit whose Loro update changes `read`, `write`, or a
  future group/capability property.
- The grant is valid only if its signer already had write rights on the old
  resource or inherited them from an ancestor.
- A later commit by agent B is valid if B appears in effective write rights
  after replaying accepted grant commits up to that point.

This avoids a second capability format for v1. The grant proof is the accepted
commit history plus the deterministic hierarchy rule.

If commit retention becomes optional, nodes that want cross-agent cryptographic
audit must retain enough authorization evidence:

- genesis commit for every resource,
- commits that mutate `read`, `write`, `parent`, and future group/capability
  membership,
- destroy commits,
- optionally a signed or locally certified checkpoint proving the current
  effective-rights state.

## Compaction and authorization

We should not require a complete commit history forever. Loro already owns the
mergeable resource history; commits are write certificates. That means old
ordinary change commits can be compacted once their effects are represented in a
trusted state certificate.

Compaction must preserve the ability to answer two questions:

1. Who created this resource?
2. Why was each currently-authorized writer allowed to write from the compacted
   point onward?

A compacted resource therefore needs an authorization checkpoint:

```text
AuthCheckpoint {
  resource: R,
  covers_state_at: commit/time/frontier marker,
  creator: A,
  effective_read: [...],
  effective_write: [...],
  parent: P?,
  basis: [genesis(R), grant commits or parent checkpoint references],
  snapshot_hash: hash(canonical materialized state),
  signed_by: checkpoint issuer(s),
  signature: ...
}
```

The checkpoint does not need to prove every historical content edit. It proves
the authority state at a boundary. After that boundary, C only needs:

- the checkpoint,
- retained commits after the checkpoint,
- any post-checkpoint rights/parent/destroy commits,
- an optional Loro snapshot matching `snapshot_hash`.

This creates two levels of verifiability:

| Retained evidence | What C can prove |
| --- | --- |
| Full commit history | Creator, every historical writer, every content transition, every grant. |
| Auth checkpoint + recent commits | Creator and current/delegated write authority from checkpoint onward; old compacted content is trusted as certified state, not replayed history. |
| Snapshot only | Current bytes only; no independent proof of creator or delegated write authority. Not acceptable for cross-agent sync. |

Checkpoint trust matters. A checkpoint signed only by B does not prove that A
created R or granted B write rights unless it includes independently verifiable
basis references. Safer options:

- A grant-changing commit also signs or implies a new auth checkpoint.
- A node compacts only after retaining the genesis and grant commits that
  justify the checkpoint.
- For shared resources, require checkpoint signatures from an already-authorized
  writer and include enough retained basis commits for a new verifier to audit
  that signer.

The practical v1 rule should be conservative:

```text
May discard ordinary content commits after checkpointing.
Must retain genesis, parent-changing, rights-changing, and destroy commits,
or replace them with an authorization checkpoint whose basis remains
independently verifiable.
```

### Per-class retention preferences

Different resource classes have very different retention needs. A collaborative
document is most useful with full history; a "like" is a one-bit fact whose
edit history is meaningless. Per-class defaults should live in the ontology
(e.g. a `retentionPolicy` property on the class) and inform compaction
decisions:

| Class shape | Default retention |
| --- | --- |
| Posts, blogs, long-form, collab documents | Full content history (audit, attribution, edit trail matters) |
| Likes, follows, blocks, bookmarks, settings | Genesis + auth checkpoint + current state; aggressive content compaction |
| Profile (display name, avatar, bio) | Same as above; the checkpoint doubles as a cacheable "profile card" strangers fetch |
| Direct messages | Full history within the granted-read subtree, but the subtree compacts independently of the rest of the drive |
| Files (metadata) | Genesis + auth checkpoint + current state; blob bytes are content-addressed and outside this policy |

The authorization-critical floor — genesis, rights-changing, parent-changing,
destroy — applies regardless of class preference. A class cannot declare a
policy that drops grant evidence; only ordinary content commits are subject to
class-level discard policy. This keeps the cryptographic audit story uniform
across the ontology.

## Protocol direction

Keep WS `COMMIT` as the authoritative write path. Do not make raw `SYNC_PUSH`
authoritative for cross-agent writes.

Recommended shape:

1. Same-agent catch-up may continue using `SYNC_PUSH` Loro deltas, gated by
   `AUTH` and drive-level write/read checks.
2. Cross-agent writes must be exchanged as signed `COMMIT` frames, even over
   Iroh.
3. Bulk sync between non-identical agents should either:
   - send retained commit certificates, then apply them through `apply_commit`,
     or
   - only advertise/fetch state after a trusted hub has already accepted the
     signed commits.
4. `SYNC_PUSH` should be treated as state replication, not authorization.

For delegated sync, add a commit-certificate path rather than overloading raw
state sync:

| Frame / API | Purpose |
| --- | --- |
| `GET_COMMITS(subject, since?)` or equivalent query | Ask a peer for retained signed commits needed to verify a subject. |
| `COMMIT_BUNDLE` | Return ordered commit resources plus optional final Loro snapshot. |
| Existing `COMMIT` | Submit one signed commit for acceptance by the receiver. |
| Existing `SYNC_PUSH` | Fast state transfer after the receiver already trusts the commit evidence, or same-agent replica catch-up. |

The first implementation does not need a new binary frame if we expose this as
ordinary resource/query fetches for `did:ad:commit:*` resources. The important
semantic requirement is that B can enumerate the authorization-critical commits
for R and that C applies them through commit verification, not by directly
trusting B's snapshot.

## Implementation phases

### Phase 1: Fail closed on peer auth

- Require `AUTH` before `SYNC` and `SYNC_PUSH` on every transport.
- Bind `AUTH.requestedSubject` to the session drive.
- Carry the authenticated `ForAgent` from Iroh handshake into live mode.
- Add tests that unauthenticated peers cannot receive private snapshots or push
  state into private drives.

### Phase 2: Preserve authorization evidence

- Introduce a commit retention class for authorization-critical commits:
  genesis, rights changes, parent changes, destroy.
- Add helpers to classify changed props from `CommitResponse.changed_props`.
- Make retention independent from UI audit retention; even
  `ATOMIC_COMMIT_RETENTION=none` should not discard grant evidence if
  cross-agent authorization proofs are enabled.
- Add an index from resource subject to retained commit ids, at least for
  authorization-critical commits. B needs this to answer C's proof request
  without scanning every retained commit.
- Define the first auth checkpoint format. It should certify effective rights
  and a canonical state hash, not pretend to be a full replayable history.

### Phase 3: Verify grant chains

- Add an `AuthorizationProof` or equivalent query that explains why an agent has
  effective write rights for a resource at a commit boundary.
- For existing resources, check the signer against the old state and record the
  proof basis: direct resource write, inherited parent write, creator self-write,
  server/sudo mode, or public write.
- For rights-changing commits, require the grant signer to already have write
  rights before the change.

### Phase 4: Commit-backed peer sync

- Add a peer path that transmits signed commits for resources whose updates are
  not already trusted from the hub.
- Apply those commits through `Db::apply_commit` instead of importing raw Loro
  state.
- Keep raw `SYNC_PUSH` for snapshot catch-up only when the session policy says
  the peer is a trusted replica of the same authority.
- Support the delegated A -> B -> C case: B sends C the genesis commit, grant
  commits, B's change commits, and optionally a final snapshot. C verifies and
  applies the commits before accepting the snapshot as a cache optimization.

## Open questions

- **Commit-time vs current-state evaluation.** Do we evaluate authorization
  strictly at the moment of commit (requiring grant history to be replayed in
  order), or is current-state evaluation with retained grant evidence enough
  for v1? Strictly-at-commit-time is more defensible cryptographically but
  meaningfully heavier on the verifier.

- **Grant authority delegation.** Should `write` imply "can grant write", or
  should invite/share become a separate right before cross-agent sharing is
  user-facing? Today's additive model conflates the two; a separate grant
  right would let resource owners share read without enabling re-share.

- **Revocation.** The current hierarchy model is additive: grants only expand
  rights. The available workaround is to re-parent affected resources to a new
  subtree with narrower ACLs and republish under a new subject, requiring
  subscribers to re-resolve. This is acceptable for v1 social-network use
  cases (block is local-filter only; no claw-back of previously-public posts;
  no kick-from-collab semantics). Real revocation needs a new primitive before
  shipping multi-writer collaborative documents with kick/demote operations.

- **Public write as grant basis.** Recommendation: **do not** accept public
  write as a cryptographic grant basis in v1. Two reasons:
  1. Public-write inboxes are a spam attractor (ActivityPub experience).
  2. The provenance chain for content arriving via a public-write subtree is
     structurally weaker — the subtree owner never authorized the specific
     writer, only "anyone".

  Social-network primitives that superficially look like inboxes (likes,
  replies, mentions) should be modeled as actor-side commits on the actor's
  own drive, with reverse-index discovery via indexers. See
  [Actor-side likes, replies, reposts](#actor-side-likes-replies-reposts).

  Public write may still be useful for narrow product cases (an open
  feedback/comments box on a single resource, deliberately accepted as
  unauthenticated). If kept, it should be opt-in per resource and clearly
  marked in the UI as "not provenance-checked beyond commit signature."

- **Per-class retention defaults.** Where do retention policies live in the
  ontology, and what are the v1 defaults for `Post`, `Like`, `Follow`,
  `Block`, `Profile`, `DirectMessage`, `File`? The authorization-critical
  floor is fixed; the class-level discard policy above that floor is the
  open question. See
  [Per-class retention preferences](#per-class-retention-preferences).

- **Cache provenance separation.** When a server caches another drive (feed
  assembly, replica volunteering), it stores commits it did not sign. Should
  cached commits be physically separated from own-drive commits in the store
  (separate column family / table / namespace), or marked with a provenance
  flag? Affects retention enforcement, attack surface, and the "am I serving
  this as authority or distributor?" decision when answering peer requests.

- **Checkpoint authority for shared resources.** Who is allowed to issue an
  auth checkpoint for a multi-writer resource? Options: the original creator
  only; any current writer; a quorum of writers; or any
  agent with an explicit checkpoint right. The choice affects compaction
  liveness — if only the creator can checkpoint and they go offline,
  collaborators can't compact.
