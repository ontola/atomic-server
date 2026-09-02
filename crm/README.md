# PauseAI CRM

One place for everyone the movement works with: volunteers, chapters and local groups, politicians, journalists and donors. Managed by PauseAI Global, usable by every national chapter, with each chapter seeing only its own people.

Status: **foundation**. The data model, Airtable import, Discord link, sign-in, chapter-scoped access, task templates with reminders and escalation, and a small UI exist and are tested. The bigger product surface (campaign email, segments, politician and journalist pipelines, WhatsApp) is designed but not built. Start with [docs/architecture.md](docs/architecture.md).

## Why a new project, and what already exists

PauseAI's data lives in Airtable (the "PauseAI Volunteers & Actions" base) and is written by the website's join form, PauseBot and Airtable automations. There is also an earlier custom CRM, [PauseAI Everything](https://github.com/PauseAI/pauseai-everything) (Next.js, last active May 2026), that covers contacts, segments and campaign email but has no Discord, task or chapter-hierarchy support. See [docs/decisions/0001-build-on-postgres-not-airtable-or-atomicserver.md](docs/decisions/0001-build-on-postgres-not-airtable-or-atomicserver.md) and [0002](docs/decisions/0002-relationship-to-pauseai-everything.md) for how this project relates to both.

## Quick start

```bash
cd crm
pnpm install
pnpm db:local            # throwaway PostgreSQL 16 on port 54329 (or: docker compose up -d)
cp .env.example .env     # defaults work with db:local
pnpm db:migrate
pnpm db:seed             # global chapter + built-in project templates (+ BOOTSTRAP_ADMIN_EMAILS as admins)
pnpm dev                 # http://localhost:5173
pnpm worker              # background jobs: Airtable sync, task reminders and escalation
```

Sign in at `/login` with an address listed in `BOOTSTRAP_ADMIN_EMAILS`; with `AUTH_DEV_PRINT_LINKS=true` the magic link is shown on screen instead of emailed. Email is sandboxed by default (`EMAIL_MODE=sandbox`): nothing leaves the machine, and the admin page shows the outbox.

Import from Airtable once you have a read token: `AIRTABLE_API_KEY=... pnpm sync:airtable --limit 50`.

## Commands

| Command              | What it does                                                    |
| -------------------- | --------------------------------------------------------------- |
| `pnpm test`          | Vitest against a real PostgreSQL (`TEST_DATABASE_URL`, default local 54329) |
| `pnpm check`         | svelte-check, strict TypeScript                                 |
| `pnpm build`         | Production build (Node adapter)                                 |
| `pnpm db:generate`   | Generate a migration after editing `src/lib/server/db/schema.ts` |
| `pnpm db:migrate`    | Apply migrations                                                |
| `pnpm sync:airtable` | One-off Airtable import (`--full`, `--limit N`)                 |
| `pnpm worker`        | Run the job worker                                              |

## Layout

```
src/lib/server/
  db/            schema.ts (Drizzle), client, migrations runner
  chapters.ts    chapter tree, routing of signups to chapters
  people.ts      find-or-create, identities, consents, interactions, memberships
  auth/          magic links and sessions
  authz/         actor, chapter-subtree scoping, field masking
  tasks/         project templates, task instantiation, reminders, escalation
  jobs/          Postgres job queue and the recurring schedule
  sync/          Airtable → CRM import
  integrations/  airtable, discord (PauseBot events), mailersend
src/routes/      login, tasks, people, chapters, admin, webhooks
docs/            architecture, data model, integrations, permissions, decisions, roadmap
drizzle/         generated SQL migrations
```

Server modules never import SvelteKit, so they can be reused from scripts, the worker, or another framework.
