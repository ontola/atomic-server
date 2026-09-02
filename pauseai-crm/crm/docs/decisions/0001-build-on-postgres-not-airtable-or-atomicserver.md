# ADR 0001: Build the CRM as a TypeScript service on PostgreSQL

Date: 2026-09-02. Status: proposed, awaiting Joep's confirmation.

## Context

The brief asks for a robust CRM, usable by all chapters and managed by Global, integrating with Airtable and Discord, with strong access control and a small attack surface. Three foundations were considered.

### Option A: stay on Airtable, add automations

Airtable is where the data is and what the ops team knows. But it has no row-level permissions inside a base (a chapter lead who can see the Members table sees every country), no first-class consent history, no task engine, and the 2026 cleanup document shows how select-option pollution and comma-splitting have already degraded the data. Automations are opaque and untestable. It stays as the signup landing zone for now, not as the CRM.

### Option B: AtomicServer

AtomicServer (Joep's own project) ships typed classes, tables similar to Airtable, invites, real-time sync, full-text search, versioned commits and a Svelte client, and PauseAI would be a good flagship user. A survey of the repository on 2026-09-02 found these gaps for this use case, all confirmed in `docs/src/hierarchy.md` and `planning/`:

- Authorization is additive down the hierarchy with no groups and no field-level rights; "chapter leads see only their country, and only some fields" needs every member under a disjoint subtree and sensitive fields split into separately permissioned child resources. `planning/zones.md` proposes a fix but nothing is built.
- No scheduled jobs, no inbound webhooks, no outbound email; plugins are WASM class extenders that run only on get or commit (`atomic-plugin/README.md`). `planning/plugins.md` designs cron and webhook triggers on an open PR.
- No `Person`, `Contact` or `Organization` class; `planning/personal-information-suite.md` is an exploration.
- Status alpha with breaking changes expected before 1.0, and the brief's first non-functional requirement is "don't get hacked".

So the automation and permission layers this CRM needs would have to be built outside AtomicServer anyway, and the store would be an alpha. That may change; see "Revisit" below.

### Option C: a dedicated TypeScript service on PostgreSQL (chosen)

Mature row-level scoping, transactions, partial unique indexes for idempotent syncs, `skip locked` for a queue without extra infrastructure, managed hosting everywhere PauseAI already deploys. TypeScript and SvelteKit match the website team's skills. Cheap: one small container plus a managed database.

## Decision

Build the CRM as a SvelteKit + Drizzle + PostgreSQL service (`pauseai-automation/crm`), with server modules kept free of framework imports so the domain code is portable.

## Consequences

- Airtable remains the write target for the join form during phase 1; the CRM imports incrementally and reports vocabulary drift. Making the CRM the system of record is a later, bounded step.
- Authorization is enforced in SQL predicates, so the "usable by all chapters, managed by Global" requirement is a property of every query.
- No dependency on AtomicServer's roadmap.

## Revisit

If AtomicServer ships zone-based ACLs, groups, field-level visibility and cron/webhook plugin triggers, the CRM's ontology (people, chapters, memberships, consents, interactions, tasks) maps cleanly onto Atomic classes, and a mirror into an AtomicServer drive would give chapters its Data Browser, documents and chat for free. The `people.ts` and `chapters.ts` modules are the boundary to swap.
