# Migrating from PostgreSQL

Adopting Atomic is a change to the application's data and consistency model, not a PostgreSQL connection-string change. `atomic_lib` currently uses redb storage on native platforms and OPFS in the browser; it is not a PostgreSQL storage adapter.

Start by identifying the feature you want: offline editing, live collaboration, portable data, direct peer sync or a shared resource model. You can introduce that feature alongside an existing backend before deciding whether to replace its database.

## Inventory guarantees before moving data

| Existing concern | What to evaluate in Atomic |
| --- | --- |
| Tables and rows | Model entities as Classes and Resources, with Properties for fields. Keep a stable mapping from source primary keys to Atomic IDs. |
| Foreign keys and joins | Represent references using Resource identifiers. Rewrite queries against the available query/search APIs; measure required joins, aggregates and reports rather than assuming SQL compatibility. |
| Unique constraints | Define business identity and concurrent-creation policy. Import `localId` matching is useful but is not distributed uniqueness across offline peers. |
| Transactions, locks and triggers | Atomic's local storage has transactional batches, but those do not provide a drop-in equivalent of arbitrary SQL transactions or cross-replica serializability. Identify which operations need a coordinated authority. |
| Accounts and authorization | Map application accounts to Agents and design key storage, recovery, read/write rights and tenancy. Existing sessions, passwords and permission rules do not automatically become Atomic identities or ACLs. |
| Audit history | New Atomic changes can be signed and versioned. Imported SQL history is historical data, not retroactive cryptographic proof that the original users signed it. |
| Numeric types | Preserve exact amounts, units, ranges and rounding. Test the representation through every Rust, JavaScript and import boundary; do not silently convert exact SQL decimals to floating-point values. |
| Jobs and external effects | Keep explicit workers and idempotency keys for email, bank calls and other effects. Replaying synchronized state must not execute an effect twice. |

An app can keep PostgreSQL for authoritative transactions and reporting while Atomic serves collaborative documents, offline drafts, or selected read models. Atomic's sync outbox delivers edits; it does not automatically replace a transactional outbox for external business effects.

## Migrate one workflow first

1. **Choose a boundary.** Pick a small set of entities and a user-visible feature. Decide which system owns each field and operation; avoid unrestricted bidirectional writes to both databases.
2. **Model and scope the data.** Define Classes, Properties, identifiers, destination parents, Drives and ACLs. Keep server credentials and unreleased protocol secrets outside data that is replicated to clients.
3. **Import a repeatable snapshot.** Preserve source IDs in a mapping or scoped `localId`, resolve references, and verify counts, amounts and permissions. Use [JSON-AD or import helpers](../create-json-ad.md) as appropriate; PostgreSQL migrations and SQL dumps are not directly executable Atomic imports.
4. **Project ongoing changes.** Use a durable outbox or change-data-capture process from PostgreSQL, with replay-safe identities and a checkpoint. Treat that bridge as application integration work; it is not supplied automatically by choosing a sync transport.
5. **Port a client workflow.** Add local persistence, subscriptions and the chosen [transports](7-design-decisions.md). Distinguish local drafts from accepted business decisions. Reconcile the Atomic projection against PostgreSQL while it remains authoritative.
6. **Exercise failure and recovery.** Test concurrent/offline creation, revoked access, retries, interrupted imports, crashes and restore procedures. Check that reports and financial invariants still agree.
7. **Cut over deliberately.** If replacing a source workflow, pause or fence its writes, drain the bridge, reconcile the final state and switch authority. Define rollback before cutover; do not restore stale settlement state while peers continue processing.

## Financial and coordination-heavy apps

A ledger's balances, reservations, approvals, receipts and outgoing protocol messages form a state machine. CRDT merging alone does not preserve its invariants. Two separately valid offline operations may spend or reserve the same capacity.

An incremental design keeps settlement and its transactional storage authoritative, publishes selected results to Atomic, and allows clients to create offline drafts or requests. The authority validates a request before recording a final result. Enforce that distinction through command handling and permissions, not merely through a label in the UI. An Atomic Commit signature attributes a mutation; it does not replace counterparty consent, hashlock conditions or settlement finality.

Moving the protocol itself into `atomic_lib` would require implementing and verifying the required admission, atomic local state transitions, durable messaging, replay protection and crash recovery. Do not infer those guarantees from the presence of Loro or signed Commits.

## Deployment is a separate migration

You can retain the existing application host while adding an AtomicServer with durable storage. Replacing managed PostgreSQL with an embedded database shifts responsibility for persistent disks, backups, restore testing, availability and upgrades. A default Heroku dyno filesystem is ephemeral and is not suitable for the authoritative redb file.

Measure total cost, including hosting, storage, relay traffic, operations and migration effort. Offline capability and data portability are potential gains; lower cost, simpler operations and equivalent transactional behavior require evidence from the actual application.
