# Zones: ACL-bearing roots as the one boundary

**Status: In progress (2026-08-05).** Core lib path landed: zone derivation,
zone-based `check_rights`, implicit creator write (no per-genesis `write`
insert), and agent-keyed pkarr discovery alongside legacy drive-keyed
announces. Remaining: persisted zone index, sync `collect_zone_subjects` wire
cutover, browser `canWrite` / Share UI, drop authored `drive` stamp.
Successor-in-spirit to the drive-stamp mechanics in
[`commit-fanout-drive-isolation.md`](./commit-fanout-drive-isolation.md) and the
authority-replay ideas in [`authorization-sync.md`](./authorization-sync.md).
Motivated by the social overlay a recipes/social app needs (feeds, sharing,
likes, comments across users), but the model is general.

## The idea

Today a Drive is the unit of sync, quota, announce, and query scope — but *not*
the unit of access control, because `read`/`write` ACLs may sit on any resource
mid-tree. That mismatch is where the defensive code lives: per-resource
readability filtering during sync, the `drive` stamp fast-path that can still be
overridden deeper down (`lib/src/hierarchy.rs:229` + recursive walk), the
client-side reimplementation of the parent walk (`browser/lib/src/resource.ts`
`canWrite`), and the stamp-preservation hacks for guest commits.

**A zone is any DID resource that carries a rights array.** One rule replaces
the model:

> Rights live only on zone roots — and setting rights on a resource is what
> makes it a zone root.

- The parent hierarchy is purely organizational; it carries zero security
  meaning.
- Every resource belongs to exactly one zone: its nearest ACL-bearing ancestor
  (possibly itself). Nearest zone wins, completely — a nested zone's ACL
  *replaces* the outer one, never intersects it.
- The zone is simultaneously the unit of: access control, sync/replication
  (fingerprint tree per zone, cf. [`drive-reconciliation.md`](./drive-reconciliation.md)),
  admission/quota (`lib/src/sync/policy.rs`), encryption keys
  ([`encryption.md`](./encryption.md) per-drive keys become per-zone keys), and
  optional announcement.
- `Drive` survives as a UX-only class ("top-level zone in your sidebar").
  Apps may call zones "spaces" or "folders"; the protocol word is zone (the DNS
  analogy is structural: subtree under one authority, nested by delegation,
  per-zone keys, zone transfer = sync).

"Share this one recipe" = write an ACL onto it. That single commit promotes it
to a zone. Un-share = remove the ACL; it dissolves back into the parent zone.
No wrapper drives, no ghost containers. This aligns with
[`drafts-and-suggestions.md`](./drafts-and-suggestions.md): visibility is
location — publish/unpublish stays re-parenting across a zone boundary.

## The zone index is derived, not authored

`subject → zone` is a **locally maintained index**, like the query indexes —
NOT a property in signed state. The current `drive` stamp
(re-derived in `lib/src/commit.rs:777`) is removed from authored state.

Why derived:

- Fully derivable from facts every replica has (parent chain + ACL presence);
  storing it is denormalization that can drift and must be trusted.
- Promotion/demotion is free on the wire: un-sharing a folder with 500
  descendants is a local O(subtree) index rebuild on each node, zero re-stamp
  commits, zero sync churn. It takes effect atomically with the ACL commit.
- CRDT-friendly: no stamp container for concurrent edits to fight over.

The `drive`/zone identifier survives in two *unauthenticated* places:

1. **Transport frames** (`SYNC`/`SYNC_PUSH` context): the sender's *claim*
   about which zone a session concerns, needed for admission/quota/fan-out
   before parent chains resolve. Receiver verifies each resource actually
   derives to that zone before data takes effect (claim-then-verify).
2. **Subject hints** (`?drive=` → zone hint): a routing locator, never
   authenticated; load-bearing for share links. `Subject::pure_id` already
   strips it from identity.

Genesis gets smaller and purely user-authored: subject-from-signature,
`parent`, initial props, and — iff born a zone — its initial ACL (as
`create_drive` seeds today). A commit whose target's zone cannot be derived is
**rejected, not quarantined** (client retries after the parent lands).

## Authority is a function of time

Initial placement is pinned by genesis (`parent` is in it), but placement and
ACLs are mutable. Consequences:

1. **Commit authorization is evaluated against zone state at commit time.**
   Replica verification replays authority-defining commits in order — exactly
   the `AuthImpact` set (`lib/src/hierarchy.rs:49`): genesis, read, write,
   append, parent, destroy. `AuthImpact` graduates from verification aid to the
   definition of the model: its flags are precisely the commits that mutate the
   zone index. Removing an agent never invalidates their past commits.
2. **Widening publishes history, not just state.** Resources are Loro docs;
   moving a draft from a private to a public zone syncs every draft state out
   with it. The publish flow needs an explicit choice: *move with history*
   (collaboration) or *publish a snapshot* — export current state as a fresh
   genesis with a `derivedFrom` link (new identity; usually correct for
   publishing). Default for private→public moves: snapshot.
3. **Encrypted zones rekey on membership change**; revocation is forward-only
   everywhere (bytes already replicated are gone — UI says "stop sharing",
   never "make private again"). ACL properties stay plaintext containers even
   in an encrypted zone, so blind hubs can enforce admission; content
   containers are what gets sealed.

## Discovery: zones don't flood the DHT

Boundary and announce are decoupled. pkarr/mainline records are for finding
*nodes*, not data:

- **One opt-in pkarr record per agent** — the agent's own ed25519 key IS a
  valid pkarr key (`did:ad:agent:{pubkey}`), so the record is self-certifying
  with no derivation trick (drives need the genesis-signature derivation in
  `lib/src/discovery.rs:154` only because replicas lack the drive key). It
  points at current NodeIDs + the agent's public zone. O(discoverable agents)
  records total.
- Zones resolve *through the connection*: dial a node, SYNC the zone DID,
  admission decides.
- Share links carry their own routing: zone DID + agent DID / node hint.
  The link is the discovery record; nothing per-share touches the DHT.
- Per-zone announces remain only for owner-independent discovery (community
  zones with many hosts) as an explicit action, never a default.

## Impact inventory

| Area | Change |
| --- | --- |
| `lib/src/hierarchy.rs` | `check_rights` becomes walk-free: preludes (sudo/server/self/commits) → zone lookup → ACL check. Drive fast-path, recursive walk, and 401-cascade warn deleted. `check_append` = append on `zone(parent)`; the "Drive or DID without a parent" branch becomes the explicit born-zone rule. CMS tests translate (a public folder in a private drive already *is* a zone root). |
| `lib/src/commit.rs` | Drop stamp re-derivation; add reject-if-zone-underivable. Enforcement calls unchanged in shape. |
| Zone index (new) | `subject → zone`, incrementally maintained from parent/ACL commits, in lib (Rust) and browser store (TS). The main new engineering, with `AuthImpact` as its mutation trigger set. |
| `lib/src/sync/engine.rs` | `collect_drive_subjects` → `collect_zone_subjects`: **BFS stops at nested zone boundaries** (descendant zones sync/quota/encrypt separately). The one wire-visible semantic change; concentrate migration tests here. |
| `lib/src/sync/policy.rs`, `commit_monitor` | Admission, quota, and fan-out re-key from drive to zone; `is_within_drive` → zone containment. |
| Query index | Drive scoping becomes zone scoping (`lib/src/db/query_index.rs:31` constraint unchanged in shape). |
| `browser/lib/src/resource.ts` | Delete client-side parent walk (`canWrite` ~line 1204, incl. cycle detection) and the drive-prop preservation for guest commits (~709–716); replace with zone-map lookup. |
| Share panel (`data-browser/src/routes/Share/`) | `useInheritedRights` walk → single zone lookup. Two states: "lives in zone X" (link + *Share separately…* = promote) / "shared directly" (existing editor + *Stop sharing separately* = demote, confirm fallback audience). Audience badge everywhere. |
| Invites (`server/src/plugins/invite.rs`) | No redesign: redeeming on a non-zone resource promotes it — the semantics it always wanted. |
| Flutter | Dart layer mostly untouched; bridge inherits lib. |

## Migration

1. [x] Zone derivation helpers (`lib/src/zones.rs`: `is_zone_root`,
   `resolve_zone`, `collect_zone_subjects`, stamp-vs-zone compare). Nested ACLs
   intentionally disagree with the drive stamp — that is the model.
2. [x] Switch `check_rights` to zone lookup + remove genesis `write` insert
   (implicit creator write via `genesis_signer`). Browser `canWrite` still walks
   parents — replace next.
3. [ ] Drop the stamp from authored state; keep frame-level context + hints.
4. [ ] Existing mid-tree grants need no data migration — they already *are* zone
   roots under the new semantics.
5. [x] Agent-keyed pkarr publish/resolve (`discovery::publish_agent_node_id`);
   server announces agent record at boot; legacy drive-keyed path retained.
6. [x] End-to-end DID open: search parses DIDs, `atomic://open` + bare
   `did:ad:` deep links, `/resolve-agent` endpoint, known-peers fallback on
   ErrorPage when the link has no node hint.
7. [ ] Sync engine: `collect_drive_subjects` → `collect_zone_subjects` (BFS stops
   at nested zones).
8. [ ] Share panel / invites UX for promote-demote.

## Acceptance test

Zones are created by ordinary users at share-time, so cheapness is the feature,
not an optimization: **500 shared recipes on a phone** — measure fingerprint
trees, sync handshakes, and (absence of) announces per zone. If that fails, the
model fails.

## Open questions

- **OQ1 — Append's fate.** With foreign social content living in the author's
  own zone (comments/likes reference their target; indexer/crawler assembles
  threads; moderation = display-time filtering), does `append` survive at all,
  or only as a zone-level role for genuinely collaborative zones?
- **OQ2 — Zone index persistence.** Rebuild-on-boot vs persisted tree; interaction
  with `disk-storage-and-persistence-optimization.md`.
- **OQ3 — Groups.** Zones don't solve "share with my friends as a unit"; a
  `Group` resolvable one level deep in ACL checks is still the missing
  primitive for followers-only audiences.
- **OQ4 — Snapshot-publish mechanics.** `derivedFrom` linkage, and whether the
  private original tracks its published copy for re-publishing diffs.
- **OQ5 — Does the zone index remove query-side resource fetches too?**
  [`index-performance.md`](./index-performance.md) found that collection
  queries pay for a full resource decode per match (not just per permission
  check) even when the client only wants subjects. Once the zone index makes
  `check_rights` walk-free, can `query_basic` answer "is this subject visible
  to `for_agent`" from the index alone, with zero resource fetches for the
  subjects-only case? If so this proposal fixes that bottleneck too, not just
  the walk itself.
