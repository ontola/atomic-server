# Encryption and replica trust

> **Status:** Closed: at-rest + vault (2026-09-01), per
> [`trust-model-decision.md`](./completed/trust-model-decision.md).
>
> The open question this document explored — whether an external hosted server
> can be a **blind replica** of a live drive — is closed as *not planned*. The
> node that serves a drive is a **verifier**: it holds the drive key (or the
> plaintext), materializes, indexes, authorizes, and fans out. What ships as
> encryption is problems 2–4 below: local encryption at rest (shipped 2026-07, see
> [`opfs-per-agent-encryption.md`](./opfs-per-agent-encryption.md)), server
> encryption at rest (to build), and the blind vault for backups
> (vault v1 in `lib/src/vault/`, shipped 2026-08-04,
> [`encrypted-vault-format.md`](./encrypted-vault-format.md)). End-to-end
> encrypted replication (problem 1) is not on the roadmap.
>
> **Reopen test.** This reopens only when a paying customer requires the
> external hosted server to be a blind replica — never granted the drive key,
> never a verifier for their drive — *and* accepts that this server then
> provides none of the content-aware services listed under
> [Search, queries, and server features](#search-queries-and-server-features):
> no property queries, no full-text or vector search, no backlinks or derived
> feeds, no server-side plugins, previews, moderation, or AI over that drive.
> A customer who wants any of those from the host wants a trusted verifier,
> which already exists. The sections below are kept as the design record for
> that case; the "Keys" and "Blobs" sections remain the reference for server
> at-rest and blob encryption.

## Question

How should Atomic protect private data when the user trusts some nodes, such as
their own computer, but does not trust other nodes, such as an external hosted
server?

This is broader than encrypting the redb file. The same logical drive may be:

- decrypted and queryable on the user's computer;
- decrypted and queryable on a trusted home server;
- stored and relayed as ciphertext by an external server;
- persisted locally with encryption at rest;
- exported as an encrypted backup.

These are separate trust and storage decisions.

## Node roles

The role model below is the vocabulary the decision uses. The **Blind replica**
row is *not planned* for live drives; it survives only as the archive/backup
target (the vault).

| Role | Holds drive key | Imports Loro | Materializes and indexes | Stores/relays ciphertext |
| --- | --- | --- | --- | --- |
| Verifier | Yes | Yes | Yes | Optionally |
| Blind replica | No | No | No | Yes |
| Archive / backup target | No | No | No | Checkpoints/backups only |

A user's computer would normally be a verifier. An external hosted server could
be a blind replica. A trusted server could also be granted the drive key and
become a verifier.

This resembles NextGraph's broker/verifier separation, but that does not imply
that Atomic should adopt NextGraph's block, overlay, or capability protocols.

## Separate encryption problems

The following features should not be treated as one toggle:

1. **End-to-end encrypted replication**
   - Protects data from blind replicas and transport operators.
   - Requires encrypted sync envelopes and client-side verification.

2. **Local encryption at rest**
   - Protects a verifier's redb/OPFS data and derived indexes when the device is
     locked, stolen, or copied.
   - Is also the basis for **logout / shared-browser session isolation** — see
     [Local cache and session isolation](#local-cache-and-session-isolation).
   - Does not hide data from the running verifier process.

3. **Encrypted backups** — shipped as vault v1 (2026-08-04), see
   [`encrypted-vault-format.md`](./encrypted-vault-format.md).
   - Protects exported checkpoints or Loro data.
   - Can be useful independently of live encrypted replication.

4. **Transport encryption**
   - TLS, Noise, Iroh, or Reticulum protects a connection.
   - Does not protect data from the receiving node.

## Local cache and session isolation

> **Status: shipped (2026-07).** The mechanism below is implemented — one
> encrypted OPFS database per agent, keyed to the active session. See
> [`opfs-per-agent-encryption.md`](./opfs-per-agent-encryption.md) for the
> as-built design, key hierarchy, migration, and accepted gaps.

"Local encryption at rest" (#2 above) is usually motivated by a lost or stolen
device. There is a second, nearer-term motivation that the same mechanism must
cover: **multiple agents — or none — sharing one browser/device.** When you log
out, the private data you cached must stop being readable on that machine.

### The gap this closed

The browser ClientDb was a single plaintext OPFS store **per origin**, not per
agent. Reading a private resource cached its plaintext there. Sign-out only
cleared the in-memory agent (`setAgent(undefined)` in `SettingsAgent.tsx`),
never touching OPFS, and there was no clear/reset path on the ClientDb at all.
So after logout — or after switching to a different agent — the previous
agent's private resources remained in OPFS as plaintext, readable locally with
no server round-trip and therefore **no authorization check**.

### Requirement and chosen direction

After logout, and when switching to a different agent, a session must no longer
be able to read the previous agent's private cached data. We have chosen to
solve this with **encryption keyed to the active session, not by wiping the
cache** — so a user's offline cache survives a logout/login of the *same* agent
while remaining inaccessible to a logged-out or different session. (Wiping OPFS
on logout is strictly simpler and a valid interim guard, but it throws away the
offline cache, which defeats much of the local-first value.)

### Mechanism

- Private-drive cache content is encrypted with that drive's key (see "Keys"
  below). The minimal first step — a single personal drive — can use one
  per-agent cache key.
- That key is **wrapped by the agent's identity key** and persisted in wrapped
  form (OPFS / IndexedDB). It is **unwrapped into memory only for the active
  session.**
- Login: the active agent unwraps its drive/cache keys into memory; the cache
  decrypts.
- Logout / agent-switch: drop the in-memory keys. The on-disk OPFS is now
  ciphertext the current session cannot read. A different agent can only unwrap
  the keys wrapped for *it*, so it never reads another agent's cache.
- Public/bootstrap data (the ~200 default-vocabulary resources) need not be
  encrypted; only private-drive content and any index/derived state computed
  from it (search, query-members, backlinks) must be.

### Open questions

- Does the cache key derive from / get wrapped by the same per-drive key used
  for encrypted replication, so a device holding the drive key can both sync and
  cache it? (Preferred — avoids a second key hierarchy.)
- How are derived indexes (search, query-members) over private content
  encrypted or partitioned, rather than leaking plaintext through the index?
- What is the unit of encryption in the WASM redb — whole values, whole trees,
  or the redb file? Value-level keeps public/private mixed in one store at the
  cost of per-read crypto.
- Key recovery: a lost agent secret makes the encrypted cache unrecoverable.
  Acceptable, since it is a cache that re-syncs from a verifier — but the UX
  must make that clear rather than appearing as data loss.

## Keys

If encrypted replication is adopted, the current leaning is that each private
drive has an independent random drive key. This is **not decided**.

The agent secret should probably remain an identity/signing secret rather than
directly encrypting bulk drive data:

```text
agent signing/encryption identity
  -> unwraps or receives selected drive keys

drive key
  -> derives keys for updates, checkpoints, blobs, and backups
```

Reasons to prefer per-drive keys:

- an agent can grant a node access to one drive without allowing agent
  impersonation or exposing every drive;
- multiple agents can share one drive;
- trusted verifier nodes can receive a drive key without receiving the agent
  signing secret;
- key rotation and revocation can happen per drive;
- compromising one drive key does not expose all of an agent's data.

Open key questions:

- Does every drive have a key, or only confidential drives?
- Are agent encryption keys distinct from Ed25519 signing keys?
- Are keys granted per agent, per device, or both?
- How are key epochs and rotation represented?
- What does revocation promise, given that a previously trusted verifier may
  retain plaintext?
- Does a server ever receive a drive key through an explicit "trusted verifier"
  grant?

## Not planned: blind live replication

The three sections below (replication shape, authorization, compaction)
describe the blind-replica design space. They are retained as a record and are
**not planned**; see the reopen test in the status box. One later change is
worth noting against them: with commits stored as signed envelopes on the
resource rather than as a retained log
([`commit-retention-floor-decision.md`](./completed/commit-retention-floor-decision.md),
#1313), the "blind replica must retain every encrypted update" concern under
[Compaction and retention](#compaction-and-retention) no longer applies to a
verifier node; it would only return with a blind live replica.

### Possible encrypted replication shape

A blind replica cannot safely accept replacement ciphertext as the current
resource state. It cannot decrypt, merge concurrent Loro changes, inspect a
version vector, or determine whether one ciphertext supersedes another.

One possible design is an immutable signed envelope log:

```text
EncryptedEnvelope {
  version,
  drive,
  resource,
  key_epoch,
  author,
  sequence_or_parents,
  kind: delta | checkpoint | destroy,
  ciphertext,
  signature,
}
```

The exact visible fields are undecided. Every visible field leaks metadata, but
the blind replica needs enough information to authorize publication, find
missing updates, route subscriptions, and compact retained history.

The `ciphertext` size of a `kind: delta` envelope is dominated by the plaintext
Loro update it wraps. Today the server stores a **full Loro snapshot** per
commit (see
[`disk-storage-and-persistence-optimization.md`](./disk-storage-and-persistence-optimization.md)),
so naively reusing that payload would make every encrypted delta envelope a
full-state blob — bloating both the blind replica's retained log and sync
bandwidth, and worsening the metadata leak (ciphertext size tracks document
size, not edit size). Encrypted replication should wrap a **true incremental
Loro update** (that doc's fix #1); the `kind: checkpoint` envelope is the
full-snapshot case, issued deliberately for compaction (below), not on every
write.

A verifier would:

1. fetch missing envelopes;
2. verify signatures and authorization evidence;
3. decrypt payloads;
4. import Loro deltas or checkpoints;
5. materialize `PropVals` and update local indexes.

A blind replica would:

1. authenticate the publishing node or agent;
2. validate the visible signed envelope;
3. enforce whatever publication capability is visible to it;
4. store and relay the envelope;
5. never call `AtomicLoroDoc::from_snapshot` or index the resource contents.

### Authorization is the hardest unresolved part

Atomic currently represents authorization in resource content:

- `parent`
- `read`
- `write`
- `append`
- future group/capability properties

A blind replica cannot inspect these properties. Therefore the current
content-based authorization model cannot be applied unchanged by a blind
server.

Options under consideration:

1. **Drive-level publishing capability**
   - The blind replica only knows which agents/devices may append to a drive.
   - Fine-grained resource authorization is enforced by verifiers.
   - Simple, but a malicious authorized publisher can upload invalid envelopes
     that verifiers later reject.

2. **Visible signed authorization metadata**
   - Grants, parent relationships, or publication capabilities remain visible
     outside ciphertext.
   - Enables stronger blind-server enforcement but leaks graph structure and
     collaboration metadata.

3. **Trusted authoritative verifier**
   - A client or trusted server decrypts and accepts/rejects commits.
   - Blind replicas only distribute states already accepted by that verifier.
   - Raises availability and authority-placement questions.

4. **No blind live collaboration initially**
   - Start with encrypted archive/backup storage and add blind live replication
     only after authorization is resolved.

No option has been selected.

### Compaction and retention

A blind replica cannot create or validate the contents of a compacted Loro
snapshot. Without another mechanism it must retain every encrypted update.

One possible solution is verifier-created encrypted checkpoints:

```text
EncryptedCheckpoint {
  drive,
  resource,
  key_epoch,
  covered_heads_or_sequences,
  ciphertext,                 // encrypted Loro snapshot or shallow snapshot
  signer,
  signature,
}
```

The blind replica can reason about signed coverage metadata without seeing the
snapshot. After accepting a checkpoint and waiting through a retention grace
period, it may delete covered updates.

This requires trusting the checkpoint authority. A blind replica cannot know
whether the ciphertext is a valid Loro snapshot, contains all covered updates,
or is recoverable by other devices.

Open questions:

- Who may issue checkpoints: creator, any writer, trusted verifier, or a
  threshold of devices?
- Must another verifier acknowledge a checkpoint before deletion?
- How long are covered updates retained?
- How are concurrent updates excluded from compaction?
- Does checkpointing preserve resource history, authorization audit, both, or
  neither?
- How does this compose with `retention = full | recent | none`?

## Blobs

Still relevant: this is the shape of blob encryption before an S3 or other
blind object store ships (`s3-blob-storage.md`, trust-model step 4). The blind
blob GC problem below only applies to a blind object store, which does no GC.

Encrypted blobs are related but do not need to use the same storage format as
Loro updates.

Possible direction:

- verifier encrypts blob bytes before upload;
- blind replica or object store keys blobs by ciphertext hash;
- file metadata refers to the ciphertext blob ID;
- authorized verifiers decrypt locally.

Using plaintext content hashes would leak equality of files. Using ciphertext
hashes avoids that leak but changes deduplication behavior.

Blind blob garbage collection is unresolved because the server cannot inspect
encrypted `File` resources to find live references. Options include signed
reachability manifests in checkpoints, explicit retain/release records, or
conservative retention.

## Search, queries, and server features

A blind replica cannot provide content-aware services:

- property queries;
- full-text or vector search;
- backlinks and derived feeds;
- plugins, automations, previews, moderation, or AI over drive contents;
- content-based fine-grained authorization.

Those services run only on verifier nodes. A user could grant a trusted server
the drive key to enable them, but granting access cannot later erase plaintext
the server already observed.

This suggests that "encrypted drive" is not the complete product concept. The
more precise question is:

> Which nodes are trusted verifiers for this drive?

## Relationship to current plans

### `atomic-lib-runtime.md`

`AtomicNode` is the natural boundary for this work. It may need separate
replica and optional verifier services. The current plan assumes every node
owns a materialized `Db`; blind replicas need a separate opaque envelope store.

### `loro-source-of-truth.md`

Still applies inside verifier nodes: Loro is canonical and `PropVals`/indexes
are derived. It does not describe blind-replica persistence, where encrypted
envelopes and checkpoints are opaque.

### `unified-sync.md`

The transport-independent API remains useful. Sync may need negotiated modes:

- verifier-to-verifier Loro version-vector sync;
- blind envelope/checkpoint sync.

The distinction is semantic, not tied to WS, Iroh, or Reticulum.

### `authorization-sync.md`

Signed commits, authorization evidence, creator authority, and authorization
checkpoints are directly relevant. The plan currently assumes verifiers can
inspect and materialize resource content. Blind-replica authorization needs an
additional design.

### `commit-retention-and-state-certificates.md`

Retention modes and checkpoints map well, but encrypted compaction must be
created by a verifier rather than a blind server. State hashes over materialized
plaintext cannot be computed by blind replicas.

### `disk-storage-and-persistence-optimization.md`

The plaintext storage problems that doc diagnoses propagate into encrypted
replication: per-commit **full Loro snapshots** make `kind: delta` envelopes
full-state blobs (see "Possible encrypted replication shape" above), and the
**no-auto-compaction / dead-page** growth applies to a blind replica's retained
envelope log just as it does to a verifier's redb file. The verifier-issued
`EncryptedCheckpoint` (above) is the encrypted realization of that doc's
history-pruning fix — a blind replica can prune covered updates from signed
coverage metadata without decrypting.

### `unified-data-layer.md` and `sign-at-drain.md`

Client-owned Loro state and drain-time signing are useful foundations. If
encrypted envelopes are adopted, signing, encryption, retries, and outbox
durability must produce stable replayable envelopes.

### `s3-blob-storage.md`

The `BlobBackend` abstraction is useful. The current plan assumes servers can
inspect `File` resources and run mark-and-sweep GC; blind replicas cannot.

### `genesis-self-verifying.md`

An inline binary genesis certificate could let blind nodes verify resource
identity without decrypting content. Visible original-parent metadata may leak
hierarchy and needs an explicit privacy decision.

## Threat model questions

Before selecting an architecture, define what must be hidden from an external
server:

- resource contents;
- subjects and drive membership;
- hierarchy and parent relationships;
- agent identities and collaborators;
- update timing and frequency;
- ciphertext sizes;
- equality of repeated content;
- current heads and causal relationships;
- blob existence and file equality.

The more metadata must be hidden, the less useful the blind server can be for
authorization, synchronization, deduplication, and retention.

## Candidate product models

Outcome per [`trust-model-decision.md`](./completed/trust-model-decision.md):

1. **Trusted-server Atomic only** — *chosen*, combined with 2.
   - Add local encryption at rest (shipped) and server encryption at rest (to
     build).
   - Keep current server-side materialization/indexing model.
   - Lowest complexity; no protection from the hosted server beyond at rest.

2. **Encrypted archive first** — *shipped* as the vault.
   - External server stores encrypted checkpoints/backups, not live updates.
   - Avoids blind live-sync authorization and compaction.

3. **Blind replica plus local verifier** — *not planned*.
   - External server stores and relays encrypted envelopes.
   - Clients merge/index locally.
   - Requires envelope sync, checkpointing, and a blind authorization model.

4. **Optional trusted verifier** — *not planned* as a separate mode; every
   serving node is the trusted verifier.
   - Same encrypted replication format, but selected servers receive drive keys
     and run verifier services.
   - Most flexible, but key grants and role transitions become load-bearing.

## Decisions that were required before blind replication

Kept for the reopen case; none of these is being worked on.

- What exact threat model and metadata-leakage budget are we targeting?
- Is blind live replication a core requirement or should encrypted backups ship
  first?
- Is trust configured per drive-node relationship?
- What publication authorization can a blind replica enforce?
- What are the encrypted envelope's visible fields?
- Who is allowed to issue compaction checkpoints?
- How are drive keys created, wrapped, shared, rotated, recovered, and revoked?
- How do encrypted blobs and their garbage collection work?
- How does a new verifier bootstrap efficiently?
- Which existing protocol and storage paths remain shared between plaintext and
  encrypted replication?

## Non-goals for the exploration

- Selecting cryptographic algorithms before the envelope and threat model are
  decided.
- Treating raw redb encryption as end-to-end encryption.
- Allowing a replica relationship to silently downgrade from ciphertext to
  plaintext.
- Copying NextGraph's complete protocol without independently validating that
  its tradeoffs fit Atomic.

