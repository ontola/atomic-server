# Permissions and security

## Who sees what

| Actor | People | Fields | Tasks | Admin |
| --- | --- | --- | --- | --- |
| Volunteer | Own record | All of their own | Own and their teams' unowned | – |
| Team lead | Members of their teams | Name, city, involvement (contact details masked) | Their teams' | – |
| Chapter admin | Everyone under the chapter subtree | All | All in the subtree | Chapter settings (roadmap) |
| Global admin | Everyone | All | All | Sync, jobs, grants |

Implemented in `src/lib/server/authz`:

- `buildActor` resolves `access_grants` into chapter paths and team ids once per request.
- `visiblePeoplePredicate(actor)` is a SQL fragment every people query goes through, so scoping is enforced in the database, not by remembering to filter in each route.
- `tierFor(actor, person)` decides `self` / `admin` / `scoped` / nothing for a single record; `maskPerson` blanks email, phone, postcode and coordinates for `scoped`.
- Interactions carry their own `visibility` (`team`, `leads`, `admins`), so a lead's private note never reaches the person it is about.

Grants are additive and scoped by subtree: a grant on PauseAI UK covers Bristol. There is no way to hide a child from a parent's admin, which matches the brief (Global manages everything). Grants can expire (`expires_at`) for temporary roles.

Discord roles are never used as authorization. They are convenient, but anyone with a role-managing bot could otherwise grant themselves CRM access.

## Authentication

Passwordless. A sign-in link goes to the address we already have; the token is random, single-use, fifteen-minute, stored hashed. Sessions are thirty-day cookies (`HttpOnly`, `SameSite=Lax`, `Secure` in production), stored hashed; sign-out deletes the row. Requesting a link for an unknown address returns the same response as for a known one.

Bootstrap: addresses in `BOOTSTRAP_ADMIN_EMAILS` become global admins on first sign-in; after that grants are managed in the app.

Future: optional Discord OAuth as a second way to sign in that also verifies the Discord identity, and passkeys once the team wants them.

## Threat model, briefly

| Threat | Mitigation |
| --- | --- |
| Leak of the whole member list | Chapter-subtree scoping in SQL; contact fields masked for team leads; export endpoints will require `global_admin` and be logged. |
| Forged webhook creating or altering records | HMAC over timestamp and body with a shared secret, five-minute window, constant-time compare; events stored with unique ids. |
| Session or token theft | Hashed at rest, short-lived tokens, single-use, `HttpOnly` cookies, no tokens in URLs except the one-time link. |
| Developer emails real volunteers from a laptop | `EMAIL_MODE=sandbox` by default; `live` is an explicit deploy setting. |
| PII sprawl | The Airtable import requests an explicit field list; no free-text notes are imported; soft delete plus a scrub job for erasure requests. |
| Injection | Every query goes through Drizzle's parameterised builder; `filterByFormula` strings are built from constants and ISO timestamps only, never from user input. |
| Framing and content sniffing | `X-Frame-Options: DENY`, `nosniff`, strict referrer policy set in `hooks.server.ts`; SvelteKit's CSRF origin check on form actions. |
| Dependency compromise | Small dependency set (SvelteKit, Drizzle, postgres, zod); lockfile committed; Renovate can be enabled as on the website. |

## GDPR notes

PauseAI Global is the controller; chapters act under its umbrella, which is why one database with scoped access is the right shape rather than one database per chapter. Consent decisions are append-only rows with source and evidence. Deletion is `people.deleted_at` followed by a scrub job (roadmap) that blanks PII and keeps aggregate counts. The sync never imports "(legacy)" free-text fields.

## Operational hygiene

- Secrets only in environment variables; `.env` is git-ignored; `.env.example` documents each one.
- The admin page shows failed jobs and rejected webhooks, so a wrong secret is visible within an hour.
- Backups: managed database snapshots plus weekly `pg_dump` to object storage once there is real data.
