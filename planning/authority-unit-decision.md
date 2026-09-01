# Unit of authority: drive, zone, or hybrid

**Status:** Accepted 2026-09-01 — C + A2. The drive stays the authority unit; #1254 must restore the drive fast path, drop `collect_zone_subjects`, and keep the zone chain hybrid/additive.

> **Decision needed by maintainer**
>
> Question 1: what is the unit of authority — the drive, the zone (nearest ACL-bearing ancestor), or a hybrid?
> Question 2: how are rights derived — additive creator-chain (creator implicit + grants ascend the parent chain, on top of what ships) or replace-and-replay (nearest zone ACL replaces outer ACLs; verifiers replay `AuthImpact` commits)?
> Options: (A) drive-as-authority (B) zone-as-authority (C) hybrid: drive = identity/replication/fan-out/index unit, zone = rights unit within a drive. Axis 2: (A2) additive creator-chain (B2) replace-and-replay.
> Recommendation: **C + A2** — the four shipped drive-keyed systems are all identity/transport, none is a rights model, so drive stays there; rights move to zones but stay additive because replace semantics turns every existing DID resource (creator auto-inserted in `write`) into a zone root with no migration.
> Blocked PRs: #1254 (must change), #1307 (semantics depend on A2), #1310 (creator check must key on root DID).

## Context

Four shipped systems are keyed by drive. None of them is the rights model; the rights
model (`check_rights`) merely *consults* one of them as a fast path.

| # | System | Where (verified) | What it keys on |
| --- | --- | --- | --- |
| S1 | Genesis cert signs `drive` into identity | `lib/src/genesis.rs:57-61` (`GenesisCert.drive`), encoded at `:97-103`; minted in `lib/src/commit.rs:239-305` | Immutable birth drive inside the signed DID. Cannot hold a mutable value (a zone is mutable). |
| S2 | WS fan-out and drive stamp | `server/src/commit_monitor.rs:57` `drive_subscriptions: HashMap<String, …>` keyed by drive subject; handler matches `resource.get_drive()` via `Subject::is_within_drive` (`:815-829`); `Resource::get_drive` `lib/src/resources.rs:657`; stamp re-derived on genesis and re-parent in `lib/src/commit.rs:866-897` | Mutable `drive` propval, server-derived from the parent, never trusted from the client. |
| S3 | `(drive, property)` watched-query index | `lib/src/db/query_index.rs:31-40` (`QueryFilter.drive` mandatory), routing at `:479-485`; `watched_queries_by_drive` `lib/src/db.rs:304` | Drive prefix for HTTP subjects; **`did:` atoms already fall back to every drive's property bucket** (`query_index.rs:480-481`) — the cert's `drive` is not yet used here. |
| S4 | Deterministic personal drive | `lib/src/genesis.rs:180-200` (`for_private_drive`, `private_drive_subject`); `Db::create_drive` seeds `write`/`read` at `lib/src/db.rs:836-850`; [`deterministic-personal-drive.md`](./deterministic-personal-drive.md) landed | Drive DID derived from the agent key. The drive is a fact about identity. |

Rights today (`lib/src/hierarchy.rs:223-395`): preludes (sudo, self, server agent, public
agent read) → explicit grant on the resource → **drive-first fast path** on the `drive`
propval (`:325-350`, added for the parent-before-child 401 race, comment at
`lib/src/commit.rs:239-244`) → recursive parent ascent (`:354-366`). Additive: first grant
wins, no deny. `RightsCache` (`hierarchy.rs:121-123`) is per-request, keyed
`(right, subject.pure_id())`, never invalidated — it is dropped with the request.
`apply_commit` still auto-inserts the genesis signer into `write` on every new DID
resource (`lib/src/commit.rs:836-858`), so **every existing DID resource carries an
explicit `write` array**. The browser reimplements the additive walk in
`browser/lib/src/resource.ts:1328-1390` (`canWrite`) with no genesis-signer check.

`AuthImpact` (`hierarchy.rs:49-90`) classifies genesis/read/write/append/parent/destroy
commits; retention of exactly those is what [`authorization-sync.md`](./authorization-sync.md)
Phase 2 and PR #1313 ("genesis and rights/parent/destroy still are [stored]") rely on.

What the sources propose: [`zones.md`](./zones.md) — zone = unit of ACL *and* sync, quota,
keys; nested ACL **replaces** outer; `drive` stamp removed from authored state; index
derived. [`authorization-sync.md`](./authorization-sync.md) — implicit creator write
(`effective_write = {genesis_signer} ∪ explicit_write` plus inherited), remove the
auto-insert, replay grant chains. [`genesis-self-verifying.md`](./genesis-self-verifying.md)
— `drive` in the cert because "a resource effectively never moves between drives".
[`partial-sync.md`](./partial-sync.md) — wants subtree/zone scope, but notes it works
"without zones" over `collect_drive_subjects` (its lines 64-70).

## Options

### Axis 1 — unit of authority

| Cost against | (A) Drive-as-authority | (B) Zone-as-authority ([`zones.md`](./zones.md) as written) | (C) Hybrid: drive = identity/replication, zone = rights within a drive |
| --- | --- | --- | --- |
| S1 cert `drive` | Unchanged; the "read the cert's `drive` in `check_rights`" item stays. | Field becomes provenance only. Zone cannot be signed in (mutable). Genesis "gets smaller" per zones.md — a v2 cert layout. | Unchanged; cert `drive` = replication root, still the race-free fast path. |
| S2 fan-out / stamp | Unchanged. | Re-key `drive_subscriptions` to zone; clients subscribe per zone; promote/demote re-keys live subscriptions and re-stamps nothing (index is derived) — but every open tab must re-subscribe. Stamp removed from authored state (`commit.rs:866-897` deleted). | Unchanged. Stamp stays server-derived (as #1254 already keeps it). |
| S3 `(drive, property)` index | Unchanged. | `QueryFilter.drive` → zone; promotion re-buckets every filter in the subtree; DID fallback (`query_index.rs:480`) unchanged either way. | Unchanged; zone index may later shrink the DID fallback (zones.md OQ5). |
| S4 personal drive | Unchanged. | Personal drive = the agent's born zone; fine, but "drive" survives as UX class only — a rename across `Db::create_drive`, `getDrive()`, sync policy (`lib/src/sync/policy.rs:39-43`). | Unchanged. Personal drive is the outermost zone of the agent. |
| Rights model | Keeps the walk; mid-tree grants remain the "defensive code" zones.md names. | Walk-free after a persisted index; until then O(depth) derivation (#1254 bench: deny still walks). | Zone resolution replaces the per-ancestor walk; drive fast path kept for the outermost zone. |
| Verdict | Cheapest, fixes nothing. | Touches all four shipped systems for a benefit only the rights model needs. | Touches none of the four; confines the change to `hierarchy.rs`, `zones.rs`, `resource.ts`. |

### Axis 2 — how rights are derived

| Cost against | (A2) Additive creator-chain | (B2) Replace-and-replay |
| --- | --- | --- |
| Existing data | Auto-inserted creator entries (`commit.rs:836-858`) become redundant, harmless. No migration. | **Every existing DID resource is a zone root** (it has a `write` array). Drive-level grants stop applying to all existing children. Requires a store-wide rewrite of signed Loro state to strip creator entries, or a "creator-only ACL is not a zone" special case that reintroduces the hierarchy as security. |
| #1307 apps | `createApp` grants the app agent `write` on the app; "rights ascend the parent chain" (PR #1307 body, `browser/lib/src/plugin-app.ts:183-204`). Works. | The app resource becomes a zone root with ACL `[appAgent]`; drive collaborators lose access to the app subtree unless re-granted there. Silent behaviour change. |
| Narrowing (private folder in shared drive, "un-share") | Impossible — first grant wins. | Native: nested ACL replaces outer. This is the one thing only B2 delivers. |
| Race-free creation | Drive fast path kept. | `resolve_zone` fails when a parent is not materialized ("reject, not quarantine") — the 401 race the stamp was added for (`commit.rs:239-244`) comes back; #1254 removes the fast path (diff, `hierarchy.rs`). |
| Replay / audit | Same `AuthImpact` retention; proof = additive chain at accept time. | Same retention; needs zone state at commit time, i.e. a persisted, versioned zone index (zones.md OQ2, not built). |
| Browser `canWrite` | Add a genesis-signer check. | Full zone-map reimplementation in TS (zones.md impact table), not in #1254. |
| Verdict | Ships now on top of what exists. | Correct end state; blocked on migration, persisted index, and a client rewrite. |

## Recommendation

**C + A2.** Rule: *the drive is where a resource lives and replicates; the zone chain is
who may touch it; the creator always may.*

Effective rights under C + A2:

```text
zone(R)          = nearest ancestor of R (or R) carrying read/write/append, or parentless
zone_chain(R)    = zone(R), zone(parent(zone(R))), … up to the drive root
effective(R, r)  = {genesis_signer(R)} ∪ ⋃ ACL(z, r) for z in zone_chain(R)   (write ⇒ read, append)
```

The chain has one entry per ACL-bearing ancestor, not per tree level; `RightsCache` keys
on `(right, zone_root)` and the drive fast path answers the outermost entry first. Replace
semantics (B2) is deferred, not rejected: it becomes an explicit per-zone opt-in flag once
steps 5–6 below exist, so no existing resource changes meaning by accident.

Migration order:

1. Implicit creator write, standalone: delete the auto-insert (`lib/src/commit.rs:836-858`),
   add `agent_is_resource_creator` (genesis signer via `Resource::genesis_signer`,
   `lib/src/resources.rs:148`) as a prelude in `check_rights_impl`, and add the same
   check to `browser/lib/src/resource.ts` `canWrite` (`getCreatedBy`). Test: creator of a
   guest reply in a shared drive can still edit it in the UI.
2. `check_append` = append-or-write on the parent chain only; drop the fallback to write on
   the new child (#1254's "implicit creator write hole" fix). Standalone PR.
3. Zone resolution as an accelerator: `lib/src/zones.rs` (`is_zone_root`, `resolve_zone`),
   `check_rights_impl` walks `zone_chain` instead of every parent, drive fast path kept,
   `RightsCache` keyed on zone root. Semantics identical to today; `rights_bench` guards it.
4. Store-wide verification that `drive` stamp == derived drive root (zones.md migration
   step 1; `drive_stamp_matches_zone` in #1254's `zones.rs`), as a `Db` audit, not a
   commit path.
5. Persisted zone index (`subject → zone_root`, `zone_root → enclosing zone`), maintained
   from `AuthImpact` commits; browser mirror in the store. Closes zones.md OQ2.
6. Replace semantics behind an explicit zone marker, plus a one-time migration that strips
   creator entries equal to the genesis signer from `write`. Only now may B2 be enabled.
7. Zone-scoped sync/quota (`collect_zone_subjects`, [`partial-sync.md`](./partial-sync.md))
   — drive remains the sync unit until then.

### What PR #1254 must change if zones win as the rights unit (C + A2)

- `lib/src/hierarchy.rs` (diff): after `agent_in_zone_acl` returns `None`, continue to
  `zone(parent(zone))` until parentless — do not return 401 at the first zone. Restore the
  deleted drive-first block (`develop` `hierarchy.rs:325-350`) ahead of `resolve_zone`.
  Keep the `check_append` change. Keep the creator prelude.
- `RightsCache` key: `(right, zone_root.pure_id())` as the PR has it; the cached deny must
  be allowed to short-circuit members (the PR's `Some(false)` branch only short-circuits
  when `zone == resource`, so every member re-runs `agent_in_zone_acl`). Still per-request,
  no invalidation needed.
- `lib/src/zones.rs`: `resolve_zone` must not error when the chain is broken while a
  `drive` stamp exists — fall back to the stamp (the race). `collect_zone_subjects` is
  unused by any sync caller in the PR: remove it from this PR (axis 1 keeps drive as sync unit).
- `lib/src/commit.rs` (diff): auto-insert removal stays; stamp re-derivation stays (the PR
  already keeps it, "remains a transport/fan-out stamp").
- Data model: no new authored field. `drive` propval stays authored-but-server-derived;
  zone membership stays derived. WS fan-out key: unchanged, `drive_subscriptions` keyed by
  drive subject (`server/src/commit_monitor.rs:57`) — the PR does not touch it; keep it so.
- `browser/lib/src/resource.ts` is not in the PR: `canWrite` needs the genesis-signer
  check or creators outside `write` render read-only after the auto-insert is gone.
- `docs/src/hierarchy.md` (diff): must say "nearest zone first, then enclosing zones,
  additive", not "replaces".
- Split out `lib/src/discovery.rs` agent-keyed pkarr, `didResolve.ts`, DID open/share
  hints, Android manifests, `planning/atomic-uris.md`: orthogonal to rights.

### What PR #1254 must change if drives stay (A)

- Drop `lib/src/zones.rs`, the `hierarchy.rs` rewrite and `docs/src/hierarchy.md`. Keep
  only steps 1–2 above (creator write, `check_append`) plus the discovery split. The
  benchmark (`lib/benches/rights_bench.rs`) can land either way.

## Consequences for open PRs

- **#1254** — change: restructure to C + A2 per the list above (additive zone chain, drive
  fast path restored, `resolve_zone` fallback to stamp, `canWrite` creator check, docs
  wording, `collect_zone_subjects` out); split discovery/DID-open into its own PR.
  Merge order: after #1313 (retention floor), and after steps 1–2 land as small PRs, or
  as those PRs.
- **#1307** — merge-as-is on the rights model; its "rights ascend the parent chain" and
  the `write` grant on the app (`browser/lib/src/plugin-app.ts:183-204`, `check_write` in
  `server/src/plugins/store_host.rs:88-99`) are exactly A2. Rebase after #1254 step 1: the
  app agent is a genesis signer of its rows, so implicit creator write makes the app's
  child writes valid even if the grant on the app is later removed — document that.
  `AppAgentKey::new(drive, subject)` keys on drive: consistent with C.
- **#1310** — change (planning text): "genesis `write` insert" no longer exists after step
  1; the creator check compares `GenesisCert.signerPubKey` (the session key) with the
  agent — under SessionCert it must compare the **root** DID, so either `effective_agent`
  remaps before `agent_is_resource_creator` and the cert carries the root pubkey, or
  session-created resources lose implicit creator write when the session expires. State
  which. Personal-drive derivation from the root key (S4) is unaffected.
- **#1313** — no change from this decision: keeping genesis/rights/parent/destroy commits is
  the floor for both A2 and a later B2 replay. It lands **before** #1254 (sequence
  #1274 → #1313 → #1254, see
  [`commit-retention-floor-decision.md`](./commit-retention-floor-decision.md), which asks
  #1313 for an envelope change); #1254 rebases onto it (both touch `lib/src/hierarchy.rs`,
  `lib/src/commit.rs`, `browser/lib/src/resource.ts`).
- **#1274** — merge-as-is: `authorize_read` in `server/src/commit_monitor.rs` keeps the
  drive as the subscribe-auth unit, which C preserves. Rebase-after #1254 only if #1254
  ever touches `commit_monitor.rs` (it should not).
- **#1243** — no rights impact found (`commit_monitor.rs` diff adds push-notification
  helpers only). Merge independently.
- **#1260**, **#1264** — touch `resource.ts` / CMS publish visibility respectively; no
  rights-model change verified. Rebase #1260 after #1254's `canWrite` change.
