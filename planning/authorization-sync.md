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
- New DID resources currently get the signer inserted into their `write`
  list after authorization succeeds, so the creator keeps future write
  access. The design below replaces this with **implicit creator write**
  derived from the always-retained genesis signature, removing the need
  for the explicit insertion step (see
  [Implicit creator write rights](#implicit-creator-write-rights)).

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

## Creator as the authority root

Every resource is authored by exactly one agent: the signer of its
`isGenesis: true` commit. That agent — the **creator** — is the authority
root for the resource. The creator's authoritative view of the resource
(typically: their drive's current state, served by whichever node currently
holds it) is the canonical place where rights are evaluated. All verifiers
— replicas, indexers, downstream peers — accept a transition iff the
creator's authoritative view accepts it.

This rule removes a CRDT-merge ambiguity that would otherwise affect the
authorization layer. Grant changes (`read` / `write` / `append`) are CRDT
ops on lists inside the resource's Loro doc; concurrent grant changes from
different agents could in principle leave "did this signer have write
authority at the moment of signing?" ill-defined across peers. The
creator-as-authority rule collapses the question: only the merged result
accepted by the creator's authoritative serializer counts. Other peers may
temporarily hold divergent state; on reconcile with the creator's view,
they roll back to it.

Implications:

- The creator's drive (or a trusted server speaking for the creator's
  agent) is the serializer that accepts commits and resolves concurrent
  grants. There is no protocol-level vote between peers.
- Replicas, indexers, and delegated distributors verify against the
  creator's signed commits; they do not substitute their own view as the
  authority.
- The delegated A → B → C case is straightforward: A is the creator, A
  grants B write, B's content commits are valid because A's authoritative
  state showed B with write at the time A's serializer accepted them.
  Verifiers downstream of B replay the same grants and reach the same
  conclusion.
- Same-agent multi-device is the degenerate case — the creator's devices
  collectively *are* the creator.
- The "commit-time vs current-state evaluation" question is moot: there is
  one canonical state (the creator's), and rights are evaluated against it
  at accept time on the creator's authoritative serializer. No
  per-resource policy field is needed.

### Implicit creator write rights

The creator has **implicit write authority** on the resource. The genesis
commit's signature is already cryptographic proof that this agent created
the resource; no explicit entry in the `write` list is needed. Effective
rights are computed as:

```text
effective_write(R)  = { genesis_signer(R) } ∪ explicit_write(R)
effective_append(P) = { genesis_signer(P) } ∪ explicit_append(P) ∪ effective_write(P)
effective_read(R)   = { genesis_signer(R) } ∪ explicit_read(R) ∪ effective_write(R)
```

Plus the existing inherited rights up the `parent` chain.

This has three concrete consequences:

- **`write` lists contain delegated writers only**, not "self + delegates."
  Semantically cleaner; smaller commits when granting; no risk of the
  creator accidentally removing themselves from their own write list.
- **The current `apply_commit` step that inserts the signer into `write`
  after genesis is removed.** The signer is already provably in the
  effective set through the genesis signature.
- **Even more reason to retain the genesis commit** — but that floor is
  already non-negotiable for identity reasons, so no extra cost.

Edge case: if a creator wants to renounce write access (e.g. transfer
ownership), today they would remove themselves from `write`. With implicit
creator-write, that path is closed — the creator is *always* a writer
while the genesis signature is the identity binding. Real ownership
transfer is a separate primitive and out of scope for v1; for now,
creator-write is permanent.

Operational concern: if the creator is offline and has not delegated a
home server to speak for them, a writer with a delegated grant cannot make
progress against the resource. See
[Open questions § Creator availability](#open-questions).

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

> **Two trust modes, not one.** The canvas v1 default in
> [`unified-sync.md`](./unified-sync.md#trust-and-authority) is
> **hub-mediated**: the configured server is the source of truth for a
> same-agent multi-device setup, and bulk `SYNC_PUSH` between honest
> replicas is acceptable. The patterns below describe a **distributor
> mode** where the receiver verifies signed commits against the original
> creator rather than trusting the serving peer. Both modes coexist; the
> distinction is which kind of peer relationship the recipient is in.
> Hub mode is what ships for same-agent multi-device today; distributor
> mode is what unlocks volunteer replicas, indexers, and cross-agent
> social use cases.

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

The cache pool should be kept separable from the user's own drive storage
(separate namespace, or at minimum a provenance flag) — cached commits are
not signed by the user, and conflating the two risks letting cached state
be served as if it were authoritative local content. The concrete mechanism
(separate column family / table / namespace vs. provenance flag on shared
storage) is unresolved — see
[Open questions § Cache provenance separation](#open-questions).

### Indexer / aggregator nodes

An indexer crawls many drives and exposes derived collections (reverse-reply
index, mention lookups, hashtag feeds, ranking algorithms) as resources on
its own drive. The indexer agent signs the collection resources, but each
member they reference is a real signed commit from an originating drive.

Authorization model: indexers do **not** need to be explicitly granted read
on the drives they index. They consume only public-readable subtrees,
either by following DHT/Reticulum announces or by being pointed at drives
explicitly. Private subtrees remain invisible to indexers exactly as they
remain invisible to any other unauthenticated peer. An indexer that wants
access to a private subtree must be granted read like any other agent.

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

**Edit and delete** of a message follow the normal commit model on the
author's own drive: a follow-up commit edits the body, a destroy commit
removes the resource. The counterparty sees the change through their
existing subscription to the granted-read subtree. Best-effort against
replicas applies — see [Revocation](#open-questions).

**`{conv-id}` derivation** is intentionally left unspecified at the
protocol level. Reasonable choices: a deterministic hash of the two agent
DIDs (so a third device of either party can locate the existing
conversation without coordination), or a random UUID established by the
initiator and shared in the first knock (lower discoverability, but
supports multiple parallel conversations between the same pair). Pick one
convention per client, document it; this is a UX choice, not an auth
concern.

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

### Constrained append-only inbox (first-contact and bridges)

Actor-side commits + indexer discovery cover most cross-agent interaction,
but three cases remain where a recipient must accept delivery from a sender
with no prior relationship:

1. **First-contact DMs.** Alice wants to message Bob, but no granted-read
   subtree exists yet and Bob is not crawling Alice's drive. The
   conversation cannot start without some recipient-visible entry point.
2. **Service-originated notifications.** A calendar service, payment
   system, or authentication provider needs to deliver structured events
   to a user without a follow relationship.
3. **Cross-protocol bridges.** ActivityPub / Nostr / Matrix bridges need
   somewhere to deposit inbound mentions and DMs from the foreign network.

For these, each drive may expose a constrained inbox subtree:

```text
Bob's drive: /inbox/
  read:   [bob]
  append: [PUBLIC_AGENT]   (or restricted: [followees] / [allowlist])
  write:  [bob]
```

The authorization properties differ meaningfully from public-write on
ordinary content:

- Each appended resource is a **fresh genesis signed by the sender**.
  Provenance is solid — the recipient verifies the sender's signature on
  the genesis exactly as in any other delegated-sync case.
- Senders cannot mutate existing inbox items (`write: [bob]` only). No
  backdating, no edit-after-delivery, no race against the recipient's
  read.
- Only the recipient can read. Senders cannot enumerate or probe the
  inbox state.
- The recipient can move, archive, or destroy items as normal owner
  operations.

This is structurally different from public-write on existing posts (which
muddies authorship). Here, public append is a **grant by the recipient to
the public** of a narrow right to *create* new sender-signed resources
inside a recipient-private container. The grant chain is clean:
`Bob → PUBLIC_AGENT → sender's signed genesis`.

The hard problem here is spam, not authorization. Stacked controls:

- **Allowlist by default** — `append: [followees + address-book agents]`,
  with an explicit "allow knocks from strangers" toggle that widens to
  `[PUBLIC_AGENT]` plus rate-limiting.
- **Per-sender rate limit** at apply-commit time.
- **Hashcash / proof-of-work** embedded in the inbox item over
  `(recipient_did, timestamp)`.
- **Reputation gating** via indexer-provided scores.
- **Server-side classifier** before surfacing to client.
- **Inbox-specific admission caps.** The
  [`virtual-drive.md` admission-control caps](./virtual-drive.md#admission-control-against-hostile-peers)
  (max children per parent, default ~100k) apply at commit-accept time
  across the whole drive, but the inbox subtree should carry a *tighter*
  cap by default — 100k spam knocks would still wreck the recipient UX
  even if the drive as a whole is healthy.

The inbox is **only the first-contact handshake** for DMs. Once Bob
accepts, the conversation reverts to the paired granted-read subtree
pattern above; the inbox is no longer involved.

## Grant proof model

The simplest model is to treat rights mutations as ordinary signed commits
with special audit semantics:

- A rights grant is a commit whose Loro update changes `read`, `write`,
  `append` (see
  [Constrained append-only inbox](#constrained-append-only-inbox-first-contact-and-bridges)
  and [Open questions](#open-questions) on whether `append` is a distinct
  right or layered on `write`), or a future group/capability property.
- The grant is valid only if its signer already had write rights on the old
  resource (including implicit creator write) or inherited them from an
  ancestor.
- A later commit by agent B is valid if B is in the **effective** rights
  set after replaying accepted grant commits up to the point of accept,
  where effective rights include both the explicit list and the implicit
  creator-write derived from the genesis signature (see
  [Implicit creator write rights](#implicit-creator-write-rights)).

This avoids a second capability format for v1. The grant proof is the accepted
commit history plus the deterministic hierarchy rule.

If commit retention becomes optional, nodes that want cross-agent cryptographic
audit must retain enough authorization evidence:

- genesis commit for every resource,
- commits that mutate `read`, `write`, `append`, `parent`, and future
  group/capability membership,
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
Must retain genesis, parent-changing, rights-changing (read/write/append/
group), and destroy commits, or replace them with an authorization
checkpoint whose basis remains independently verifiable.
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

The authorization-critical floor — genesis, rights-changing
(`read` / `write` / `append` / group), parent-changing, destroy — applies
regardless of class preference. A class cannot declare a policy that drops
grant evidence; only ordinary content commits are subject to class-level
discard policy. This keeps the cryptographic audit story uniform across the
ontology.

### Relationship to node-level retention policy

Per-class preferences are orthogonal to the node-level
`ATOMIC_COMMIT_RETENTION = none | recent | full` policy proposed in
[`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md).
They compose as follows:

| Layer | Authority | Question it answers |
| --- | --- | --- |
| Node policy | Operator | "What does this node retain at all?" — affects every drive hosted on this node. |
| Per-class preference | Ontology author | "Within what the node retains, which commits matter for this class?" — gives the node hints about what to compact first when storage pressure forces a choice. |
| Auth-critical floor | This document | "What MUST be retained for cross-agent verifiability, regardless of node policy or class?" — non-negotiable. |

The floor wins. A node configured `retention=none` still keeps genesis +
rights-changing + parent-changing + destroy commits (the same floor
asserted in `commit-retention.md` for genesis, extended here to cover the
full grant chain). A class declaring "aggressive content compaction" still
keeps the floor for its instances. Node policy and per-class preference
together govern only the *discardable* commits above the floor —
ordinary content edits.

This means [`commit-retention.md`](./commit-retention-and-state-certificates.md)
needs an update: its current must-retain rule is only "genesis commits are
always retained." Cross-agent authorization proofs extend that floor to
include grant evidence (rights / parent / destroy), as enumerated above.

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
  genesis, rights changes (`read` / `write` / `append` / future
  group/capability), parent changes, destroy.
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
  proof basis: direct resource write, inherited parent write, creator
  self-write (now implicit from genesis signature, see
  [Implicit creator write rights](#implicit-creator-write-rights)),
  server/sudo mode, or public write.
- **Remove the current "auto-insert signer into `write` after creation" step**
  from `apply_commit`. Effective write derives from
  `{genesis_signer} ∪ explicit_write` instead.
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

- **Creator availability.** Under the
  [creator-as-authority-root](#creator-as-the-authority-root) rule, the
  creator (or a delegated home server speaking for them) is the serializer
  that accepts commits and resolves concurrent grants. If the creator is
  offline and has not delegated a home server, a writer with a delegated
  grant cannot make progress against the resource. Options for v1:
  - **Require a home server.** Every agent must designate a home server
    (their own, a hosted instance, or a peer they trust) that holds their
    drive and serializes accepts while they are offline. Hard requirement
    for cross-agent collaboration; degenerate same-agent multi-device is
    fine without it. This is also what AT Protocol PDSes and Mastodon
    instances effectively are.
  - **Optimistic offline writes with on-reconcile rollback.** Writers
    sign commits locally; replicas may temporarily accept them; when the
    creator's serializer comes back, any commit it would have rejected
    is rolled back. Confusing UX (commits "un-happen"); only workable
    for non-conflicting writes.
  - **Accept the limitation.** Cross-agent writers wait for the creator
    to come back. Acceptable for low-availability resources, bad for
    real collab. Probably the v1 default if the home-server requirement
    is too much.

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

- **Public *write* vs public *append* as grant basis.** Recommendation:
  reject public `write` as a grant basis, but accept public `append` on
  designated inbox subtrees. The two have very different provenance
  properties:

  - Public `write` on existing resources (mutating someone else's content)
     muddies authorship — the resource owner did not authorize the specific
     mutator, and the resource's history now mixes signers without clear
     intent. **Do not accept** as a v1 grant basis.
  - Public `append` on a recipient-private inbox subtree, where each
     appended item is a fresh sender-signed genesis and only the recipient
     can read or modify existing items, *does* have a clean grant chain:
     `recipient → PUBLIC_AGENT → sender's signed genesis`. **Accept** as a
     v1 grant basis, scoped to inbox-shaped subtrees. See
     [Constrained append-only inbox](#constrained-append-only-inbox-first-contact-and-bridges).

  Social-network primitives that superficially look like inboxes (likes,
  replies, mentions) should still be modeled as actor-side commits on the
  actor's own drive — see
  [Actor-side likes, replies, reposts](#actor-side-likes-replies-reposts).
  The inbox primitive is reserved for cases where actor-side genuinely
  cannot work: first-contact DMs, service-originated notifications, and
  cross-protocol bridges.

  Open sub-question: should "append-only on this parent" be a distinct
  right in the ontology (separate from `write`), or expressed as
  `write: [PUBLIC_AGENT]` on the parent combined with a per-resource
  immutability rule that blocks non-owner mutation of existing children?
  Distinct right is more explicit and easier to audit; reusing `write`
  is less ontology churn.

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
  auth checkpoint for a multi-writer resource? Options, ordered by
  permissiveness: the original creator only; any current writer; a
  threshold of writers (m-of-n signatures on the checkpoint); or any agent
  with an explicit `checkpoint` right. The choice affects compaction
  liveness — if only the creator can checkpoint and they go offline,
  collaborators can't compact. For v1, "any current writer" is the
  simplest workable rule; richer schemes can layer on later by extending
  `AuthCheckpoint.signed_by` from a single signature to a signature set.
