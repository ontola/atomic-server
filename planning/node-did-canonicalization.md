# Node DID canonicalization

## Decision

- [x] `did:ad:node:<hex>` is the only user-facing and HTTP API form for peer node IDs.
- [x] Raw Iroh `NodeId` hex remains an internal transport value.
- [x] `iroh:<hex>` is not accepted by the browser peer-sync endpoint.

## Scope

- Browser Sync page should copy, submit, store, and display node IDs as `did:ad:node:<hex>`.
- AtomicServer should return `did:ad:node:<hex>` from the node ID endpoint.
- AtomicServer should reject peer-sync requests that are not `did:ad:node:<hex>`.
- Existing lower-level sync code may still normalize raw node IDs because `iroh::NodeId` parsing and internal connection maps use raw hex.
