# Plan: from Airtable to the CRM as system of record

Date: 2026-09-02. Owner: PauseAI Global. Status: proposal for decision.

This document answers three questions: what do we do with Airtable, what does the CRM have to be able to do for real people (use cases), and how far along is it, code and tests included. The short answer: **make the CRM the system of record in five stages, keep Airtable as a mirror until the ops team stops opening it, and never do a big-bang cut-over.**

## 1. Where the data lives today

Everything below was verified against the repositories on 2026-09-02.

| Airtable table (base `appWPTGqZmUcs3NWu` unless noted) | Written by | Read by |
| --- | --- | --- |
| Members `tblL1icZBhTV1gQ9o` | Website join form (`/embed/onboarding-form?/submit`), `/api/verify` (email verification flag), pauseai-automation Stripe webhook (paying member), Airtable automations, ops by hand | Website `/api/about` (people page), the CRM import, Airtable automations (onboarder alert, US share, verification email, follow-up), Irina's volunteer view |
| National groups `tblEQJ26hxBAEkaP8` | Ops by hand | Website `/api/national-groups` (communities page, chapter routing), the CRM import |
| Signatories `tbl2emfOWNWoVz1kW` | Statement form, `/api/verify` | Website `/api/signatories` |
| Contact form `tblPP2kM7uTheBrpw` | Website `/contact-us` | Ops |
| Discord members `tblxeqggeTWU7Y8ME` | PauseBot | Airtable → PauseBot role webhook, ops |
| UK Politicians base `appBInVvIm6opJ1Ob`: parliamentarians `tblH3ks9wqQHLpYx3`, web form emails `tblkzjrRHiZiqMDGR` | Ops, website `/api/uk-send-mp-email` | Website MP lookup and contact status, an Airtable automation that sends the emails |

Also in the picture: the n8n instance (its Members automation is disabled), MailerSend (onboarding and verification emails from Airtable automations), Substack (newsletter, subscribed by the website), Luma (events, not integrated anywhere), and the earlier PauseAI Everything CRM (see ADR 0002).

## 2. The stages

Each stage has an exit criterion. Nothing in a later stage starts before the earlier one has met it. Effort is a rough count of focused developer days, assuming one person who knows the code.

### Stage 0: mirror and observe (now, no risk)

- Run the hourly Airtable import on a deployed CRM for two to three weeks.
- Watch the drift report on the admin page; fix mappings; get the vocabularies in `vocab.ts` and the website's `options.ts` to agree.
- Set `discord_role_id` on each national chapter so PauseBot events map to memberships.
- Exit: three consecutive weeks with zero import errors and no unexplained drift. Effort: 2 days plus waiting.

### Stage 1: first chapter uses it daily (PauseAI UK)

- Admin UI for access grants and chapters (create local group, set Discord role, deactivate).
- Interaction logging (note, call, meeting) on the person page; idle-volunteer list with "assign a next step".
- Volunteer self-service: edit own details, see own consents, link Discord.
- UK chapter admins get grants; volunteers sign in; reminders go live (`EMAIL_MODE=live`).
- Exit: UK leads run one event from a template end to end and stop keeping a side spreadsheet. Effort: 8 to 10 days.

### Stage 2: the CRM takes the writes (Airtable becomes a mirror)

- A `POST /api/signups` endpoint with the same validation as the website's form action; the website form action calls it instead of Airtable. The CRM writes the row on to Airtable itself, so every existing view and automation keeps working unchanged.
- Stripe webhook and `/api/verify` write to the CRM (the CRM mirrors to Airtable).
- The onboarder alert becomes a CRM job (Discord ping via PauseBot, or email), with a log.
- Exit: one month where every new row in Airtable Members was written by the CRM. Effort: 6 to 8 days plus a website pull request.

### Stage 3: the website reads from the CRM

- `/api/national-groups`, `/api/about` and the UK MP contact status read cached CRM endpoints (one hour cache, same shapes as today, same dev fallbacks).
- Politicians imported from the UK base into `politician_profiles`; the email tool logs each send as an interaction.
- Exit: the website has no read path to Airtable. Effort: 4 to 5 days across both repos.

### Stage 4: ops moves in

- A grid view with filters, sort, inline edit, saved views and CSV export, scoped by the actor's grants. This is the one thing Airtable does that nothing in the CRM does yet, and the reason not to retire Airtable earlier.
- Segments over memberships, consents, profiles and recent interactions; campaign email through MailerSend with unsubscribe links and bounce handling (port the consent enforcement from PauseAI Everything).
- Exit: the ops team and Comms have not edited Airtable for a month. Effort: 15 to 20 days.

### Stage 5: retire Airtable

- Stop the mirror; final export archived; delete API keys; move the Airtable automations inventory to "gone".
- Keep a CSV export job so anyone can still get a spreadsheet.

### Rollback at any stage

Because the CRM mirrors to Airtable in stages 2 to 4, rolling back is "point the website back at Airtable", a one-line change per endpoint. Data is never only in the CRM until stage 5.

### Conditions

- Someone owns the CRM: deploy, backups, watching the admin page. Without an owner, stop at stage 0.
- A decision on PauseAI Everything (ADR 0002) before stage 4, because that is where the two overlap.
- A one-hour session with the Airtable admins to inventory automations before stage 2.

## 3. Use cases and how far along each one is

Legend: **Built** works end to end and has tests. **Partial** works for part of the flow. **Designed** has a data model and a documented plan, no code. **Not started** has neither.

| # | Use case | Status | What exists | What is missing | Stage |
| --- | --- | --- | --- | --- | --- |
| 1 | Someone joins on pauseai.info and ends up in the CRM, routed to their chapter | Partial | Import maps every canonical Members field, consents and intent; routes by country and by distance to a local group; drift report | Signup endpoint so the website writes to the CRM directly; onboarder notification; geocoding so distance routing has coordinates | 0, 2 |
| 2 | Someone joins Discord and is linked to their record; a country role makes them a chapter member | Built | PauseBot emitter, signed webhook, event store, username-claim matching, role → chapter mapping, leave handling | Chapter Discord role ids need to be set (admin UI in stage 1); Discord OAuth sign-in for self-service linking | 0, 1 |
| 3 | A chapter lead sees their volunteers and nobody else's | Built | Grants scoped to a chapter subtree; SQL-level predicate; contact fields masked for team leads; person page with timeline | Admin UI to give and revoke grants (SQL today); audit log entries on grant changes | 1 |
| 4 | A volunteer signs in with the email they joined with and sees their next step | Built | Magic-link sign-in gated on the imported Members table; my-tasks page; task detail with the email-your-MP action | Live Airtable lookup for people who joined minutes ago; a catalogue of standard actions to assign; Discord sign-in | 1 |
| 5 | A chapter runs a known-good event from a template; missed deadlines escalate | Built | Three templates (screening plus emails plus pub, MP surgery visit, volunteer onboarding); relative deadlines; reminders; escalation to project owner, chapter admin, then Global | UI to start a project from a template and to reassign tasks; template editor; more templates from chapters | 1 |
| 6 | Every active volunteer always has an open task | Partial | `idleVolunteers()` query | The page that shows it and the one-click assignment | 1 |
| 7 | A local group grows too big and is split into two | Designed | Chapter tree with materialized paths; memberships move with a single update; distance routing | The admin action (create children, reassign by distance, deactivate parent), WhatsApp group creation stays manual | 1 |
| 8 | Global or a chapter emails a segment ("Leicester volunteers who missed the last event") | Designed | Consents, memberships, interactions and coordinates are all in place; MailerSend adapter with sandbox | Segment builder, campaign composer, unsubscribe links, bounce webhook, send log | 4 |
| 9 | Track every politician: how we contacted them, what they said, when their surgeries are | Designed | `politician_profiles` with level, party, constituency, stance, surgery info, parliament id; interaction kinds `statement` and `press_mention` | Import from the UK Politicians base; Hansard job; pipeline view; the email tool logging sends | 3 |
| 10 | Track journalists and press coverage | Designed | `journalist_profiles`, interaction kinds | Import, pipeline view, coverage logging UI | 3 |
| 11 | Paying members and donations | Partial | `paying_member` flag from Airtable; `donation` interaction kind | Stripe webhook writing to the CRM; donation history | 2 |
| 12 | Events on Luma and who attended | Designed | `events` and `event_attendance` tables keyed by Luma id | Luma sync job | 4 |
| 13 | GDPR: consent history, access request export, erasure | Partial | Append-only consents with source and evidence; soft delete flag; minimal field import | Per-person export; scrub job after erasure; retention policy for dormant records | 1, 2 |
| 14 | The website shows chapters, the people page and MP contact status from the CRM | Designed | The data is present after import | Three cached read endpoints and the website changes | 3 |
| 15 | Ops edit data in a grid with filters, views and CSV export | Not started | Search on the people list | The grid; this gates retiring Airtable | 4 |
| 16 | Mass WhatsApp or SMS to people who agreed to it | Designed | Consent purposes `whatsapp` and `sms`; chapter WhatsApp links | A send adapter (WhatsApp Business Cloud API or an SMS provider) | 4 or later |
| 17 | Web scraping people (from the UK notes) | Not started, deliberately | | A lawful basis first; then, at most, enrichment of politicians and journalists from public sources | none |

### Against the UK notes, in one line each

- Exhaustive database of everyone: the model covers it; imports exist for members and chapters only.
- Track every volunteer's actions, events, communications: the timeline exists; Discord and tasks feed it; email sends, Luma and the website's actions do not yet.
- Track politicians and journalists: modelled, not imported.
- Volunteer hand-holding, gatekeeping, teams, roles, hierarchies: built at the data and permission level; the volunteer-facing UI is minimal.
- Redraw local group boundaries: one admin action away.
- Task deadlines with re-delegation: built and tested.
- Project templates that "just work": three exist; chapters should write more.
- Mass email, location-based email, SMS and WhatsApp: designed, not built.
- Don't get hacked: see `permissions-and-security.md`; the honest gaps are no audit trail on grant changes yet and no rate limiting on the sign-in endpoint.
- Good software, cheap to run: one container, one worker, one Postgres; tests against a real database; strict TypeScript.

## 4. Testing: what is covered and what is not

Measured with `pnpm test:coverage` (Vitest, istanbul provider, real PostgreSQL 16) on 2026-09-02: 24 tests in 6 files.

| Area | Lines | Branches | Notes |
| --- | --- | --- | --- |
| Server modules overall (`src/lib/server`) | 83% | 66% | 727 statements |
| `people.ts`, `chapters.ts`, `authz/people.ts` | 100% | 76 to 87% | Core rules: identity resolution, consent history, scoping |
| Airtable mapping, vocab, chapters mapping | 96 to 100% | 87 to 100% | Drift canary covered |
| Discord webhook verification | 100% | 92% | Plus a one-off check that a Python-signed event verifies |
| Discord handlers | 97% | 55% | Join, roles, leave; the branch gaps are error paths |
| Tasks and escalation | 92% | 56% | Reminder, escalation, "responded after reminder" case |
| Auth (magic links, sessions) | 91% | 63% | Unknown email, single use, sign-out, bootstrap admin |
| Airtable sync | 83% | 58% | Incremental cursor, pagination, limit; failure bookkeeping not exercised |
| Job queue | 73% | 51% | Run, retry with backoff, dedupe, dead; the worker loop and stale-release are not |
| MailerSend sender | 44% | 20% | Sandbox path only; the live HTTP path is untested |
| `authz/guard.ts`, `jobs/handlers.ts`, `discord/pausebot.ts`, `db/migrate.ts` | 0% | | Thin wrappers; covered by the manual smoke test, not by tests |
| Routes, hooks, form actions, the webhook endpoint | 0% | | No HTTP-level tests. Verified once by a manual smoke run: health, sign-in flow, scoped pages, a signed and a forged webhook |

The PauseBot change has no tests at all (the repository has none); it was checked by compiling and by verifying its signature against the CRM's verifier.

### What to add, in order

1. HTTP-level tests for the webhook endpoint and the sign-in routes using SvelteKit's request handlers, so the 0% rows above disappear. About a day.
2. A contract test that runs the PauseBot signer (Python) against the CRM verifier in CI, so the two cannot drift. Half a day.
3. Error-path tests for the sync (Airtable 5xx mid-run, cursor not advanced) and the live MailerSend path with an injected `fetch`. Half a day.
4. One Playwright journey per stage-1 feature (sign in, complete a task, admin grants a role). Two days, and the website already has the tooling.
5. A CI workflow running `pnpm test:coverage`, `pnpm check` and `pnpm build` against a Postgres service container, with the coverage thresholds set at today's numbers so they only go up.

## 5. Decisions needed

1. Go ahead with stages 0 and 1 for PauseAI UK (yes or no, and who owns the deployment).
2. PauseAI Everything: continue this project or fold into that one (ADR 0002). Needed before stage 4.
3. Hosting: Railway next to PauseBot is the default; say if it should be elsewhere.
4. Branding: apply the pauseai.info tokens and fonts to the CRM in stage 1 (small).
5. Web scraping stays out until there is a written lawful basis.
