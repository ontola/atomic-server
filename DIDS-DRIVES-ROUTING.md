# DID-Native Drives and Domain Routing Plan

## Overview
Atomic Data is moving away from a fixed "main drive" at the root `/` of a server. Instead, every Drive is a first-class decentralized citizen identified by a DID, and human-readable access is handled via a **Domain-to-DID mapping** system.

## Core Concepts

### 1. Identity vs. Alias
- **Identity (Immutable)**: A Drive is identified by its DID: `did:ad:{genesis}`.
- **Alias (Mutable)**: A Domain or Subdomain (e.g., `joep.atomicdata.dev`, `localhost:9883`) is an alias that routes to a specific Drive DID.

### 2. Agent-First Onboarding
Onboarding no longer starts with a "nameless" drive. It starts with the user:
1. **Create Agent**: Generate an Ed25519 keypair (`did:ad:agent:...`).
2. **Create Drive**: The Agent signs the genesis commit for a new Drive.
3. **Bind Alias**: The Server maps the current `Host` (e.g., `localhost`) to this Drive's DID.

### 3. Multi-Tenancy & Routing
The server uses the HTTP `Host` header to determine which Drive to serve:
- `joep.atomicdata.dev` -> Serves Joep's Drive.
- `jane.atomicdata.dev` -> Serves Jane's Drive.
- `localhost:9883` -> Serves the developer's default Drive.

### 4. Custom Path Routing
Human-readable access to resources within a Drive is handled via two strategies:
- **Flat Slugs**: If a resource has a `https://atomicdata.dev/properties/path` property (e.g., `path: "/my-blog-post"`), it is served directly at that URL relative to the Drive's domain.
- **Hierarchical Fallback**: If no explicit `path` is found, the server traverses the hierarchy using `PARENT` and `shortname` properties (e.g., `/folders/2026/note`).

---

## Implementation Phases

### Phase 1: Backend Routing & Mapping
- [x] **Mapping Store**: Sled `drive_mapping` tree in `lib/src/db.rs` — `add_drive_mapping` / `get_drive_did`.
- [x] **Host-Based Resolution**: `appstate.rs::get_drive_did_for_host` — checks explicit mapping, falls back to subdomain query.
- [x] **Relative Pathing**: `db.rs::get_resource_at_path` — traverses hierarchy relative to a Drive DID; supports both flat `path` lookups and hierarchical fallback.

### Phase 2: Drive Lifecycle & Population
- [x] **Standard Initialization**: `atomic_lib::populate::bootstrap` is drive-agnostic and reusable.
- [x] **Drive Resource metadata**: `OnboardingPage.tsx` creates the genesis drive with `write` and `read` set to the agent's DID.

### Phase 3: Server Setup & Onboarding UI
- [x] **Node Setup State**: `db.rs::is_uninitialized` + `get_resource.rs` injects `isUninitialized: true` on root responses.
- [x] **Setup UI**: `OnboardingPage.tsx` — generate agent keypair → genesis drive commit → set `INITIAL_DRIVE` on root → show secret.
- [x] **Alias Registration**: `handlers/commit.rs` — after commit, if new resource has `INITIAL_DRIVE` set, calls `store.add_drive_mapping(host, drive_did)` using the `Host` header.
- [x] **Authorization during onboarding**: `handlers/commit.rs` allows unauthenticated writes to `INITIAL_DRIVE` only when the specific host is uninitialized.

### Phase 4: Decentralized Discovery
- [x] **JSON-AD Headers**: Added `Link: <did:ad:...>; rel="canonical"` response header in `handlers/get_resource.rs` for DID subjects.
- [x] **DHT/Reticulum Announces**: `dht.rs` — periodic `announce_peer(SHA1(drive_did))` every 15 min; DHT fallback resolution in `get_resource.rs`.
- [x] **Explicit Subdomains**: `Subject::Internal` explicitly stores subdomains for reliable multi-tenant routing.

---

## What to work on next (priority order)

1. **Path Uniqueness Validation** — ensure that two resources in the same Drive cannot share the same `path` property during `commit` validation.
2. **Drive-Scoped Search** — update the search endpoint to respect the resolved Drive DID so results are filtered by the current "Tenant".
3. **End-to-end test** — write a server integration test that exercises the full onboarding flow: fresh DB → `isUninitialized` → genesis drive commit → `INITIAL_DRIVE` commit → drive mapping → resource resolution.
4. **Reticulum Pathfinding** — implement the binary announce/resolution logic for `did:ad` over the Reticulum mesh.

## Success Criteria
1. Running `atomic-server` for the first time leads to an Agent/Drive creation flow.
2. Multiple drives can be accessed via subdomains on the same server instance.
3. Every drive has its own `/classes`, `/templates`, and `/files` collections.
4. Resources shared via `did:ad` identifiers are resolvable across different servers using the routing hints.
