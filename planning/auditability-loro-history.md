# Verifiable History

> **Status:** Open (2026-08-27). Companion to
> [`commit-retention-and-state-certificates.md`](./commit-retention-and-state-certificates.md)
> and [`authorization-sync.md`](./authorization-sync.md).
>
> Product goal: History is a list of **verifiable changes** — who, what,
> when, with cryptographic proof — for **every replica**, including a
> newly invited user. Same bar as `git clone` then `git log`.

## Goal

A new user who syncs a drive must be able to validate the log. Not only
the node that happened to see the live `COMMIT`. If they cannot, we have
not replaced what stored commits used to give.

Each History row:

| Shown | Source | Proof |
| --- | --- | --- |
| **What** | Loro checkout / diff | The oplog is the document |
| **When** | Envelope `createdAt` | Inside the signed JSON |
| **Who** | Envelope `signer` | Ed25519 over that JSON |
| **Proof** | Envelope `signature` | Same bytes `/commit` accepted |

Today History is Loro-only (`Edited … by peer {hex}`). Content envelopes
are discarded after apply. A clone gets the document, not the log.

## Git analogy

| Git | Atomic |
| --- | --- |
| Blob / tree | Loro snapshot + oplog |
| Commit object (author, time, tree hash, signature if signed) | Signed envelope |
| `git clone` copies objects | Catch-up must copy envelopes **with** the snapshot |
| `git log` | History page |

Snapshot-only `SYNC_PUSH` is `git clone --no-checkout` of the tree with
the `.git` directory empty. Unattributed History on a new device is that
failure mode. It is not an acceptable default.

A linear `previousCommit` chain is **not** the git part we need (git
also has merge commits; Loro already merges). The git part we need is
**replicated commit objects**.

## Split

```text
Loro oplog       = mergeable document (what)
Signed envelope  = commit object (who, when, proof)
Both             = replicate together
Graph / /commits = not a history store
```

Do not treat Loro change messages as “who.” They are plaintext.
Do not restore `/commits` as a queryable class. The log belongs to the
resource, like git objects belong to the repo — not to a site-wide
commit collection.

## Requirement: proofs travel with the resource

After apply, keep the signed envelope **on the resource’s replica
state**, so the next `SYNC_PUSH` / OPFS snapshot / Iroh catch-up
includes it.

Preferred: a sibling Loro container on the same doc (e.g. `envelopes`:
commit-id → signed JSON-AD). Then today’s snapshot sync *is* clone of
the log. No `/commits` class, no extra Layer 2 trailer, no “blob table
the new user never sees.”

Apply:

1. Verify envelope, import `loroUpdate` into `properties` (as now).
2. Append the signed envelope to `envelopes` (CRDT map/list — concurrent
   writers both land).
3. Stamp `lastCommit` for echo-dedup / genesis detection (as now).

History:

```text
Loro version  →  lastCommit / envelopes key  →  verify signature
              →  checkout                    →  diff / restore
```

Missing envelope ⇒ **Unattributed** (legacy snapshot, truncated replica,
tamper). That is an error state, not the path for a new invitee.

Authorization-critical commits (genesis / ACL / parent / destroy) stay
in the graph as the must-retain floor. Content envelopes live on the
resource. Neither is a site-wide event log.

## Storage

Same `Db` as the document (server redb, browser OPFS), because they are
part of that resource’s replica, not a server-only audit tape.

If they live **in** the Loro doc, `Tree::LoroSnapshots` already holds
them. If they live in a side tree, bulk sync **must** send that tree
with the snapshot — same requirement, more wire. Prefer in-doc so
catch-up cannot forget them.

Cost: the envelope repeats `loroUpdate`. That duplication is the
verifiable object, as a git commit repeats a pointer at content. A
header-only object (signer, createdAt, signature, hash of the change)
is a later size win; v1 stores the full signed body so verify matches
today’s `/commit` bytes.

## Sync

| Path | Must happen |
| --- | --- |
| Live `COMMIT` | Apply + persist envelope on the receiver (stop dropping it). |
| Bulk `SYNC_PUSH` | Snapshot includes envelopes (in-doc) **or** the push is incomplete. A new user who only got `properties` has an unverifiable log. |
| Offline local | OPFS snapshot includes envelopes; History verifies without network. |

Layer 2 that imports a snapshot and ignores `envelopes` is a bug, not a
mode. See unsigned `SYNC_PUSH` in
[`authorization-sync.md`](./authorization-sync.md).

## History row (target UI)

- **Verified** — `{agent name} · {createdAt}` after Ed25519 check
- **Unattributed** — warning, not the normal row (legacy / incomplete replica)
- Diff and restore stay Loro checkouts
- No navigation to `did:ad:commit:…` as a document

## What not to do

- Local-only blob table that live writes keep and clones never get.
- “Unattributed is fine for new users.”
- Re-index envelopes as Atomic resources / `/commits`.
- Put the agent DID in the Loro change message and call it proof.
- Require a linear `previousCommit` chain.

## Open questions

1. **Container shape.** Loro map `envelopes[commitId] = json` vs list of
   signed strings. Map is idempotent on retry (same id).
2. **Who writes the container.** Client includes it in `loroUpdate` at
   sign time (envelope must then sign a doc that already contains itself
   — chicken/egg) **or** server appends after verify (replica that only
   has the client delta must apply the same append). Server-append after
   verify is simpler; two replicas that both apply the same COMMIT must
   append the same bytes so the CRDT converges.
3. **Concurrent edits.** Two envelopes, one merged document: both rows
   verified, diffs from Loro. Correct, like two git commits on diverging
   branches that later merge.
4. **Size / prune.** Full bodies grow the snapshot. Compaction that drops
   old envelopes is a policy on that container, and it *removes*
   verifiability for those versions — same as `git replace` / shallow
   clone. Default is full log.
5. **Verify in WASM.** Same signature check as apply; fail closed to
   Unattributed, never display a forged signer.
