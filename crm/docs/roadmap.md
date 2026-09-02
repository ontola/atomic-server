# Roadmap

Milestones are small on purpose: each one should be usable by a real chapter before the next starts.

## M0: foundation (this pull request)

- Schema, migrations, local Postgres, tests against a real database.
- Airtable import of Members and National groups with drift reporting.
- PauseBot → CRM events; Discord identity linking; country roles → chapters.
- Magic-link sign-in; chapter-subtree scoping; field masking.
- Project templates, tasks, reminders, escalation; "my tasks" page; people and chapter pages; admin page.

## M1: first chapter live (PauseAI UK)

- Admin UI for grants, chapter Discord role ids and local groups (create, split, deactivate).
- Volunteer self-service: link Discord (OAuth), update details, see own consents.
- Idle-volunteer view for chapter admins with one-click "assign next step" from a catalogue of standard actions (email your MP, attend the welcome call, bring a friend).
- Interaction logging UI (note, call, meeting) on the person page.
- Deploy on Railway next to PauseBot; `EMAIL_MODE=live` for reminders only.

## M2: stakeholders

- Import the UK Politicians Airtable base into `politician_profiles`; constituency ⇄ member matching by postcode (geocode at postcode-district level only).
- Journalist records with pitch history; press-mention logging.
- Hansard job for politicians with a parliament id.
- Pipeline views (cold → contacted → met → supportive → endorsed) per chapter.

## M3: communication

- Segments over memberships, consents, profiles and recent interactions ("Leicester volunteers who have not attended an event this quarter").
- Campaign email through MailerSend with unsubscribe links and bounce webhooks, porting PauseAI Everything's consent enforcement (ADR 0002).
- Location-based sends ("within 50 miles of Leicester") using chapter and person coordinates.
- WhatsApp Business / SMS adapter for people with that consent.

## M4: system of record

- Join form writes to the CRM API (Airtable becomes a mirror or is retired for signups).
- Luma sync for events and attendance.
- Stripe webhook writes paying-member status to the CRM.
- Website reads chapters and local groups from the CRM.

## Always

- Keep `docs/` current with the code; ADRs for anything that changes direction.
- Every module ships with tests against Postgres.
- Review the permissions table in `permissions-and-security.md` whenever a new page or endpoint is added.
