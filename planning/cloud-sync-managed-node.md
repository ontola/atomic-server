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

## Status

- ✅ Onboarding: new user (username-from-email, auto cloud-sync, recovery backup), sign-in, restore (forgot secret).
- ✅ Managed-node detection: `Create account` → portal when managed, else local (FOSS).
- ✅ Drive sign-in guard: returning user on a new device → sign-in/recover → lands in the clicked drive.
- ✅ Naming: `saas` scrubbed from FOSS code (`node.rs`, `cloud*`, `from_cloud`, `VITE_CLOUD_API_BASE`).
- ✅ Heartbeat/policy/usage wiring compiles + spawns for managed nodes.
- ⏳ End-to-end verification of heartbeat reaching the control plane (in progress).
- ⏳ Enrollment ⇆ node matching by `iroh_node_id`, and actual Iroh data sync of allowlisted drives.
