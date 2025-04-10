# DID-Native Drives and Domain Routing Plan

## Overview
Atomic Data is moving away from a fixed "main drive" at the root `/` of a server. Instead, every Drive is a first-class decentralized citizen identified by a DID, and human-readable access is handled via a **Domain-to-DID mapping** system.

## Core Concepts

### 1. Identity vs. Alias
- **Identity (Immutable)**: A Drive is identified by its DID: `did:ad:{genesis}?drive={hash}`.
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

---

## Implementation Phases

### Phase 1: Backend Routing & Mapping
- [ ] **Mapping Store**: Implement a mechanism in `atomic-server` to store and query `Host -> Drive DID` mappings.
- [ ] **Host-Based Resolution**: Update the HTTP request handler to check the `Host` header.
- [ ] **Relative Pathing**: Ensure that paths like `/classes` are correctly resolved relative to the Drive DID mapped to the current Host.

### Phase 2: Drive Lifecycle & Population
- [ ] **Standard Initialization**: Refactor `atomic_lib::populate` so it can be applied to any Drive DID (creating `/classes`, `/tags`, etc. within that drive).
- [ ] **Drive Resource**: Ensure the Drive resource itself contains the necessary metadata (Drive Public Key, Hash, Owner).

### Phase 3: Server Setup & Onboarding UI
- [ ] **Node Setup State**: Detect when a server has no mappings and enter "Setup Mode".
- [ ] **Setup UI**: A dedicated frontend flow for creating an Agent and the first Drive.
- [ ] **Alias Registration**: A secure way for the first Agent to "claim" the server's primary domain.

### Phase 4: Decentralized Discovery
- [ ] **JSON-AD Headers**: Include the true `did:ad` identity in HTTP responses so clients can switch to P2P resolution.
- [ ] **DHT/Reticulum Announces**: Servers announce the Drive hashes they host to the P2P networks.

---

## Success Criteria
1. Running `atomic-server` for the first time leads to an Agent/Drive creation flow.
2. Multiple drives can be accessed via subdomains on the same server instance.
3. Every drive has its own `/classes`, `/templates`, and `/files` collections.
4. Resources shared via `did:ad` identifiers are resolvable across different servers using the routing hints.
