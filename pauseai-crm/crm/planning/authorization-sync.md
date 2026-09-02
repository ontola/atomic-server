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

> **Current (2026-06-10 server, 2026-07-10 browser).** DID identity is no
> longer derived from the genesis *commit* signature. A `did:ad:` subject is
> the signature of a small inline binary **genesis certificate**
> (`create_did_with_cert`, `lib/src/genesis.rs`; browser `mintCertDid`) —
> shipped in `0b1b13b36` and `232aca8a0`, documented in
> [`genesis-self-verifying.md`](./genesis-self-verifying.md). The server
> still dual-accepts the legacy commit-signature form for existing subjects
> (`lib/src/commit.rs`, the `verify` fallback). Statements below that say the
> subject is derived from, or verified via, the genesis commit are superseded
> wording; "genesis commits are always retained" remains true as an audit
> property, not as an identity requirement.
> Also superseded: "acceptable only as same-agent/offline catch-up" below —
> the same-agent peer rule was removed on 2026-07-17 (`683a25d4a`) and
> `SYNC_PUSH` is gated per drive by `may_accept_drive_write`
> (`lib/src/sync/engine.rs`); the point that bulk import is not a signed
> per-resource write path still stands.

The good parts were already present when this was written (2026-05-26):

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

## Node-as-granted-replica: making autonomous replication work

Concrete application of the phases above to the one thing they unblock for the
SaaS product: a managed node acquiring and holding a user's **private** drive
**on its own initiative**, with no key-holder online, without the node ever
signing as a principal it isn't. This is the deferred item in
[`cloud-sync-managed-node.md`](./cloud-sync-managed-node.md) "Resolution" — the
node relays and serves today; this is how it earns the right to *pull*.

### The shape

Three roles, all already in the model: **Owner** (write-authority, holds the
key), **Node** (granted read, always-on, holds the key to *nothing*), **Device**
(the owner's other clients).

1. **The grant is an ordinary signed commit.** The owner commits a change adding
   the node's agent DID to the drive's `read` (§[Grant proof model](#grant-proof-model)).
   No capability format, no new frame — "the client signs" is literally a commit
   the owner already knows how to make. The control plane can *surface* the
   node's agent DID to the client at enrollment (so the client knows whom to
   grant), but it never mints or holds the grant.
2. **The node authenticates as itself, honestly.** It does not impersonate. Its
   `AUTH` is its own agent; it is served because `check_read` for *its* agent
   passes now that it is in `read`. This is why the fix is a *rights* check, not
   a *same-agent* check.
3. **The node ingests verifiable commits, not trusted state.** It receives the
   genesis + content commits (all owner-signed) and verifies each signature. A
   malicious relay cannot forge the owner's data. Raw `SYNC_PUSH` is accepted
   only as a catch-up optimization *from a genesis-verified write-authority*.

### What has to change, in order

**Admission generalizes from same-agent to rights-based.** The refusal shipped
in `peer.rs::is_same_agent_as_ours` (and the dial-side auth-back arm) is the
right *fail-closed* instinct but the wrong *predicate*. Same-agent is the
special case where the peer has both read and write. Generalize:

- **Accept side (serving):** serve iff the authenticated peer has `read` on the
  session drive. Owner devices pass (owner). A granted node passes (in `read`).
  A stranger is refused loudly — same UX the same-agent refusal gives today,
  just keyed on rights instead of identity.
- **Dial side (ingesting):** accept **signed commits** from any peer and verify
  them (authenticity is in the signature, not the connection). Accept raw
  `SYNC_PUSH` state **only** from a peer proven to be a write-authority for the
  drive — verified via the drive's self-verifying genesis signer
  ([`genesis-self-verifying.md`](./genesis-self-verifying.md)), not via a
  local ACL lookup (which is circular when pulling a drive you don't yet have).
  Same-agent stays a valid fast path (the owner's own devices are
  write-authorities by definition).

Keep the same-agent-only guard for the **agent-resource push**
(`own_agent_update_frame`) — that is identity, not drive content, and must never
flow to a granted node.

### Phase order (each independently reviewable, tests gate the next)

- **P2 — Retain the evidence.** Classify each commit's changed props
  (genesis / `read` / `write` / `append` / `parent` / destroy) from
  `CommitResponse`; index subject → retained auth-commit ids; keep an
  authorization-critical retention class that survives pruning. *No trust/sync
  behavior change — pure groundwork.*
  - ✅ **Classifier done.** `hierarchy::AuthImpact` +
    `hierarchy::classify_auth_impact(changed_props, is_genesis, is_destroy)` +
    `CommitResponse::auth_impact()`. Pure, no store access, no rights decision.
    Unit tests plus one real-commit test pinning the assumption it rests on
    (editing a `read` ACL really does surface `read` in `changed_props`).
  - ⏳ **Retention class is moot until pruning exists.** Commits are currently
    stored as ordinary resources in `Tree::Resources` and never pruned (no
    `Tree::Commits`, no `ATOMIC_COMMIT_RETENTION`), so "survive pruning" has
    nothing to survive yet. The `is_critical()` label is ready for the day
    pruning lands; build the retention wiring then.
  - ⏳ **Subject → auth-commit index** is an *optimization*, not yet required: a
    resource's commits are already findable via the `subject` property index
    (`PropValSub`). Add a dedicated auth-commit index when P4's proof-fetch
    makes the full scan too costly.
  - **End-to-end P2 test** ("a drive with a grant + destroy + reparent, pruned
    to the auth floor, still answers who-may-read/write") lands with the index +
    retention, i.e. once pruning exists — not achievable against an all-retained
    store.
- **P3 — Verify grant chains + fix effective-write.** Remove the
  auto-insert-signer-into-`write` step; effective write = `{genesis_signer} ∪
  explicit_write`. Add the query that explains why an agent has effective
  read/write at a commit boundary. **Tests (revert-proven):** a commit by an
  agent not in the effective set is rejected; a commit by a genesis-signer with
  no explicit `write` is accepted; a grant signed by a non-writer is rejected.
  - ⚠️ **Needs a forge-resistant genesis-signer source, not `createdBy`.**
    `{genesis_signer}` must be derivable *without* trusting a mutable propval.
    `createdBy` is explicitly forgeable — `commit.rs:591`: commits carrying it
    are not rejected, "forge-resistance is the job of the genesis certificate,
    not a settable propval." The correct source is the self-verifying genesis
    certificate. *Correction to an earlier note here:* the cert **is** minted,
    DID-bound (`did:ad:` = signature over the cert), and verified at apply — for
    **server-minted** resources (`commit.rs::create_did` + the genesis-commit
    validation). The `GenesisCert` primitive is real and used in production, not
    just tested.
  - ✅ **Done: `Resource::genesis_signer()`** (`resources.rs`) — returns the
    creator proven by the inline cert, verifying the cert against the subject
    DID so a forged/overwritten cert (which cannot sign to the same DID) is
    rejected. `None` for resources with no cert. Tests: a real cert-minted
    resource reports its creating agent; a plain resource has no signer; a
    tampered cert is rejected. This is the sound source P3 will consume.
  - ⏳ **Remaining before P3 can rely on it universally:**
    - **Browser-minted resources are still legacy** (Path 2, DID = commit
      signature, no cert) — and onboarding *drives* are browser-minted, so the
      SaaS use case needs the browser to mint certs too (cross-language: a TS
      `GenesisCert` byte-identical to the Rust binary layout, DID = sig over
      cert). This is the big remaining piece.
    - **`genesis` propval immutability isn't enforced** (the doc claims it, but
      the cited `createdAt`/`createdBy` mechanism deliberately does *not*
      reject). Not required for `genesis_signer()` soundness (it re-verifies),
      but worth closing so the stored cert can be trusted without re-verifying
      on every rights check.
  - **Decision stands: finish minting + verifying certs everywhere** (browser
    included) before removing the auto-insert; then P3 reads `genesis_signer()`
    universally, and P4 gets its offline-verification basis for free.
- **P4 — Commit-backed ingest for granted replicas.** A peer path that sends
  signed commits (genesis + grants + content) and applies them via
  `Db::apply_commit`, verifying each, instead of importing raw state. Then flip
  the admission to rights-based (accept: has-read; dial: verified commits, raw
  state only from a genesis-verified write-authority). **Tests:** a node granted
  read pulls a private drive and hosts it, having verified every commit; a node
  *not* granted read gets nothing (loud refusal); a relay that alters one commit
  is rejected at that commit; revoking-by-reparent stops future content
  reaching the node.
- **P5 — Re-enable the node pull.** Restore `managed-node`'s pull loop as a
  *capability-presenting* pull (it authenticates as itself; it is served because
  it was granted). Discovery stays pkarr (drive DID → NodeIDs); the source is
  any write-authority replica. Removes the "push-only" limitation for the
  offline-owner and node-to-node cases.

### Boundary this keeps

Even fully built, the node never signs *as the user* and never holds the user's
key. It holds a grant the user signed and content the user signed; it verifies
both. A user who wants the node to hold nothing readable stays on the Cloud
Vault (blind-relay) tier and simply doesn't issue the read grant — the same
mechanism, declined. Revocation is by re-parent under narrower ACLs (the v1
model's known limitation, §[Open questions](#open-questions)); good enough for
"stop hosting on cancel," not yet a cryptographic claw-back.

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

- **Node grant lifecycle (see [Node-as-granted-replica](#node-as-granted-replica-making-autonomous-replication-work)).**
  When does the read grant to a node's agent get issued and withdrawn? Options:
  the client issues it during enrollment (needs the node's agent DID surfaced by
  the control plane) and withdraws it on cancel (re-parent, per the revocation
  limitation above). Open: whether the *node's* agent DID is stable enough to
  grant against long-term, and whether a per-drive node sub-agent (rotatable)
  is worth the extra key management vs. granting the node's single server agent.

- **Cold-node write-authority trust.** A node pulling a drive it has never held
  cannot check the server's write rights against a local ACL. The plan grounds
  this in the self-verifying genesis (the drive DID *is* the genesis hash; its
  signer is the creator/write-authority). Open: is genesis-signer alone
  sufficient, or must the node also replay `write`-granting commits before
  trusting a *delegated* writer's raw state (vs. only the original creator's)?
  Safe v1: trust raw `SYNC_PUSH` only from the genesis signer; require
  commit-backed transfer for everyone else.
