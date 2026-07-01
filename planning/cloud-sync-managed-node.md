# Cloud Sync, Onboarding & Managed-Node Integration

Tracks the **relevant files** for the cloud-sync / onboarding / managed-node
work, spanning `atomic-server` (this repo: data plane + browser) and
`atomic-saas` (control plane + portal). Companion to
`atomic-saas/planning/SAAS_ATOMIC_SERVER_CONTRACT.md` (the cross-repo contract).

## Concept

- **atomic-server identity** = local DID agent secret (IndexedDB). Independent
  of the **SaaS session** (email + `session_token` cookie). Both can be
  signed-in/out independently.
- A **managed node** is an `atomic-server` configured with
  `ATOMIC_CONTROL_PLANE_URL`. It heartbeats to the control plane, polls it for
  which drives to host (allowlist policy), and reports per-drive usage.
- **FOSS / self-hosted** servers leave that unset → no heartbeat, unrestricted
  (`OpenPolicy`), `/node-info` reports `managed: false`. FOSS UX never changes.

## Relevant files — atomic-server (data-browser)

| Area | File |
| --- | --- |
| Onboarding / sign-in / restore flow | `browser/data-browser/src/views/getting-started/GettingStartedFlow.tsx` |
| New-identity (username, drive, recovery backup) | `browser/data-browser/src/components/NewIdentitySection.tsx` |
| Node managed-info + `accountCreationTarget` (+ test) | `browser/data-browser/src/helpers/managedServer.ts` (`.test.ts`) |
| Drive sign-in guard decision (+ test) | `browser/data-browser/src/helpers/isDriveSignInError.ts` (`.test.ts`) |
| Guard redirect → welcome `?next=` | `browser/data-browser/src/views/ErrorPage.tsx` |
| Welcome route search params (`next`, `from_cloud`) | `browser/data-browser/src/routes/WelcomeRoute.tsx` |
| Cloud API base / session / enrollment / recovery | `browser/data-browser/src/helpers/cloud/*.ts` |
| Drive usage helper (Sync route) | `browser/data-browser/src/helpers/cloudUsage.ts` |

## Relevant files — atomic-server (Rust server + lib)

| Area | File:def |
| --- | --- |
| Managed-node heartbeat / policy poll / usage report | `server/src/node.rs` (`spawn_heartbeat`, `spawn_policy_poll`, `is_managed`) |
| Spawn wiring at startup (managed only) | `server/src/serve.rs` (after Iroh start) |
| `GET /node-info` → `{ managed, dashboardUrl }` | `server/src/routes.rs` (`node_info_handler`) |
| Config opts (`control_plane_url`, `_node_id`, `_region`, `_heartbeat_interval`, `dashboard_url`) | `server/src/config.rs` (`Opts`) |
| Learned portal URL store | `server/src/appstate.rs` (`managed_dashboard_url`) |
| `DriveUsage` type + `Db::per_drive_usage()` | `lib/src/db.rs` |
| Sync admission/quota policy | `lib/src/sync/policy.rs` (`AllowlistPolicy`, `SyncPolicy`, `OpenPolicy`) |
| Per-drive resource grouping | `lib/src/sync/engine.rs` (`collect_drive_subjects`) |

## Relevant files — atomic-saas (control plane + portal)

| Area | File |
| --- | --- |
| Cross-repo contract (canonical) | `planning/SAAS_ATOMIC_SERVER_CONTRACT.md` |
| Node routes: heartbeat / node-policy / node-usage | `src/main.rs`, `src/enrollments.rs` |
| Enrollment + node models (incl. `http_origin`) | `src/models.rs`, `src/enrollments.rs` |
| Portal: drives list, drive links, post-verify redirect | `portal/src/App.tsx` |

## Control-plane API contract (node ⇆ control plane)

Matches `atomic-saas` exactly (locked by its `node_policy_matches_managed_node_wrapper_contract` test):

- `POST /api/nodes/heartbeat` — `{ id, iroh_node_id?, http_origin?, region?, capacity_bytes?, used_bytes?, active_drive_count? }` → `{ status: "ok" }`. `http_origin` flows heartbeat → `SyncNode` → enrollment, so drives gain a clickable origin.
- `GET /api/node-policy?node_id=` — `{ portal_url?, allowed_drives: [{ drive_subject, quota_bytes? }] }`. Installed as `AllowlistPolicy`; `portal_url` → `managed_dashboard_url` → `/node-info`.
- `POST /api/node-usage` — `{ node_id, drives: [DriveUsage{ drive_subject, name?, resource_count, blob_bytes, loro_bytes }] }` → `{ updated }`.

## Enrollment ⇆ node matching (the join key)

- The control plane picks a node at **enrollment creation** (`nodes::get_available_node`) and writes `enrollment.node_id`. In dev that's the seeded `Node.id = "local-dev"` (`atomic-saas/src/nodes.rs::seed_dev_node`).
- A node's heartbeat `id` **must equal** that `node_id`. `node.rs` defaults `id` to `control_plane_node_id` → iroh id → origin, so a managed node must be configured with its control-plane id: **`ATOMIC_CONTROL_PLANE_NODE_ID`** (dev: `local-dev`).
- With the ids aligned: `GET /api/node-policy` returns the enrollment in `allowed_drives`; the node installs it as `AllowlistPolicy`; `enrich_node_identity` backfills `node_iroh_id` + live `http_origin` onto the enrollment; and the usage report flips the enrollment **Active** (`record_usage`).

## Admission enforcement (paid-service abuse prevention)

A managed node should only accept writes/sync for drives it actually hosts (the
control-plane allowlist) — otherwise a random user (no SaaS account, no email)
could point a drive at the paid node and use it for free.

**Status: NO gate currently. A commit-time gate was tried and reverted.**

- ❌ **Commit-time `drive_is_allowed` gate — tried, reverted.** Checking the
  allowlist in `commit.rs::validate_and_build_response` (covering HTTP `POST
  /commit` + WS `COMMIT`, both via `apply_commit_json` with
  `validate_rights: true`) is the **wrong layer** — it broke onboarding on
  managed nodes and every patch revealed another hole:
  - **Create-before-enroll ordering.** A new drive is created *before* it can be
    enrolled (you need the drive DID to enroll), so its genesis push is rejected;
    even skipping genesis, the drive's non-genesis *setup* commits are rejected.
  - **Agents caught in the net.** An agent (`did:ad:agent:…`) has no parent, so
    the drive-resolver treats it as its own "drive", which is never enrolled →
    the agent's own profile commits get denied.
  - Making it work would require special-casing agents, drive-setup commits, the
    enrollment window, *and* the 5s policy-poll lag — a losing game.
  - Reverted: removed the check + `Storelike::drive_is_allowed` + the
    `managed_node_enforces_drive_allowlist` test. Onboarding works again.
- 🔜 **Proper gate (later).** The commit-time approach is dead. A **reaper** is
  the leading candidate: accept all commits, but the node periodically deletes
  any *drive* (isA Drive, not an agent) that isn't in its allowlist after a short
  grace window. Sidesteps ordering, agent, and poll-lag issues; the
  `AllowlistPolicy` + policy poll already built feed it directly. Trade-off: a
  brief free-storage window (standard for paid services). Not yet built.
- The `AllowlistPolicy`, `set_sync_policy`, `allowed_drive_subjects`, and
  `has_resource_locally` plumbing is **kept** — still used by the proactive pull,
  and reusable by the future gate.
- Note: enrollment itself requires a verified-email session (`require_user` →
  magic-link); there is no payment/plan gate yet (billing concern, separate).

## Status

- ✅ Onboarding: new user (username-from-email, auto cloud-sync, recovery backup), sign-in, restore (forgot secret).
- ✅ Managed-node detection: `Create account` → portal when managed, else local (FOSS).
- ✅ Drive sign-in guard: returning user on a new device → sign-in/recover → lands in the clicked drive.
- ✅ Naming: `saas` scrubbed from FOSS code (`node.rs`, `cloud*`, `from_cloud`, `VITE_CLOUD_API_BASE`).
- ✅ Heartbeat/policy/usage verified end-to-end against the control plane (zero failures; node registered; `portal_url` learned).
- ✅ Enrollment ⇆ node matching via `ATOMIC_CONTROL_PLANE_NODE_ID`: enrolled drive lands in `allowed_drives`, enrollment goes **Active**, node identity (iroh id + `http_origin`) shown.
- ✅ Usage report scoped to the **allowlisted** (hosted) drives, not the node's own agent drives (`per_drive_usage(drive_subjects)` + `AllowlistPolicy::allowed_drive_subjects`).
- ✅ **Proactive replication pull wired**: after each policy refresh, the node walks its allowlist and, for every drive it doesn't already host (`Db::has_resource_locally`), resolves a peer via pkarr (`discovery::resolve_node_id_filtered` — drive DID → Iroh NodeIDs) and Iroh-pulls it (`sync::peer::sync_drive_with_peer_outcome`). In `node.rs::pull_allowed_drives`, called from `spawn_policy_poll`. Idempotent; skips already-hosted drives. Discovery is **pkarr, not the control plane** (decoupled; the control plane could carry the source node as an optimization later).
  - Verified the loop runs against the live control plane (resolves peers, attempts Iroh sync).
  - **Replication itself is verified by an automated localhost test** — `sync::iroh_e2e::e2e_managed_node_replicates_missing_drive`: a drive on endpoint A that B doesn't have is Iroh-pulled to B (the same `sync_drive_with_peer` call the managed node uses), after which B hosts it (`has_resource_locally` → true) and reports `resource_count > 0`. No relay needed — two endpoints on localhost connect via direct address (`add_node_addr`), which is why this works in the sandbox even though the public iroh.network relays are unreachable. Run: `cargo test -p atomic_lib --features "iroh,db-redb" --lib sync::iroh_e2e -- --test-threads=1`.
  - The only piece NOT exercised locally is the pkarr discovery hop (drive DID → NodeID), which needs a pkarr relay; the test substitutes a direct address for it. Full prod path (pkarr resolve + relay-assisted connect) needs a real network.
  - ⏳ Follow-ups: bound/parallelize the pull and add backoff for no-peer drives (currently sequential per cycle); re-announce pulled drives via pkarr; and the sync-path admission gate (below) so pulled/pushed sync also respects the allowlist.
