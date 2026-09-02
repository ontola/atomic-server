# Integrations

Principle: the CRM talks to other systems through small adapters under `src/lib/server/integrations`, each with an injectable `fetch` so it can be tested without the network. Anything that can fail or take time runs as a job, never inside a web request. Every inbound event is stored before it is acted on.

## Airtable (built)

**Base**: "PauseAI Volunteers & Actions" (`appWPTGqZmUcs3NWu`). **Tables**: Members (`tblL1icZBhTV1gQ9o`), National groups (`tblEQJ26hxBAEkaP8`). These ids are configurable.

**Direction, phase 1 (now)**: Airtable → CRM, read-only. The website's join form, PauseBot and the Airtable automations keep writing to Airtable exactly as today. The CRM imports hourly (`airtable.sync` job) using `IS_AFTER(LAST_MODIFIED_TIME(), cursor)` with a ten-minute overlap, so nothing is missed if a run is late. `pnpm sync:airtable --full` re-reads everything.

**Mapping**: `integrations/airtable/members.ts` reads only the canonical fields the website writes (the ones without a "(legacy)" suffix in the Airtable cleanup plan). Members become people with `airtable` identities; Intent, hours, skills, motivations and discovery go to `volunteer_profiles`; the five agreement checkboxes become `consents`; the row is routed to a chapter by `Country`. Rows flagged `duplicate` are skipped.

**Drift canary**: values outside the vocabularies in `vocab.ts` (mirrored from the website's `onboarding/options.ts`) are imported anyway and reported per field in the sync stats on the admin page. That is how we find out a form or an Airtable option changed.

**Direction, phase 2 (later)**: once chapters run their day-to-day in the CRM, make the CRM the system of record and either point the join form at the CRM's API or mirror CRM → Airtable for the views people still use. Because every person keeps their `airtable_record_id`, either direction is a bounded change.

**Also in Airtable**: the "UK Politicians" base (`appBInVvIm6opJ1Ob`, table `tblH3ks9wqQHLpYx3`) that the website's email-your-MP tool reads. Importing it into `politician_profiles` is the first stakeholder import on the roadmap; the mapping is a copy of the members one.

## Discord, through PauseBot (built)

PauseBot already sees every join, role change and leave on the PauseAI server. Rather than a second bot with a second token, PauseBot forwards those events:

- **PauseBot → CRM**: `POST /api/webhooks/pausebot` with `member.joined`, `member.roles_updated`, `member.left`. Body is JSON; `X-PauseBot-Timestamp` and `X-PauseBot-Signature` carry an HMAC-SHA256 over `<timestamp>.<body>` with a shared secret; events older than five minutes are rejected. PauseBot enables this only when `CRM_WEBHOOK_URL` and `CRM_WEBHOOK_SECRET` are set and never lets a CRM failure affect onboarding.
- **What the CRM does**: stores the event (`webhook_events`, unique per id, so retries are no-ops), resolves the member to a person (existing Discord identity → username typed on the join form → new person), logs the join as an interaction, and turns country roles into chapter memberships through `chapters.discord_role_id`. A leave closes Discord-sourced memberships.
- **CRM → PauseBot**: `integrations/discord/pausebot.ts` calls PauseBot's existing `/webhook/add_role` (bearer secret) to give someone a role, for example when a chapter admin confirms a volunteer. Not yet wired to a UI action.

Set `chapters.discord_role_id` for each national chapter (the ids are the keys of `COUNTRY_DATA` in PauseBot's `main.py`); a small admin form for that is on the roadmap, until then it is one SQL update per chapter.

## Email, through MailerSend (built)

`integrations/mailersend/send.ts` is the only place that sends email. `EMAIL_MODE=sandbox` (the default) records the message in memory and the log instead of sending, so a developer cannot email volunteers by accident; the admin page shows the sandbox outbox. Used today for magic links, task reminders and escalations. Campaign email (segments, templates, unsubscribe links, bounce webhooks) is a roadmap item and will reuse the consent and interaction tables.

## Stripe (existing, unchanged)

`pauseai-automation`'s Stripe webhook already writes paying-member status to the Airtable Members row; the CRM picks it up through the import (`Paying member`). When the CRM becomes the system of record, the same webhook can write to the CRM instead. No change needed now.

## Luma (designed)

Luma's calendar API lists events and guests. Plan: `luma.sync` job → `events` (keyed by `luma_event_id`) and `event_attendance` (guest email → person by email identity, creating a subscriber if unknown), plus `event_registered` / `event_attended` interactions. Needs a Luma API key with calendar access.

## WhatsApp and SMS (designed)

Community groups on WhatsApp cannot be read by a bot without the Business API, and message content of members should not be harvested anyway. Plan: store the group link on the chapter (done), record consent purposes `whatsapp` and `sms` (done), and send one-to-many messages through the WhatsApp Business Cloud API or an SMS provider as a later `send` adapter, only to people with that consent.

## Substack (existing)

The website subscribes people to the newsletter directly; the CRM records the `newsletter` consent from Airtable. A Substack export import (subscriber list → `subscriber` kind) is trivial when wanted.

## Hansard and press mentions (designed)

For politicians with a `parliament_id`, a job can query the UK Parliament API for contributions mentioning AI and store them as `statement` interactions. Press mentions are manual `press_mention` interactions until there is a monitoring feed worth automating.

## Website (no change today)

The join form keeps writing to Airtable. Two small follow-ups once the CRM is live: an embed of "my tasks" for signed-in volunteers, and pointing the `/api/national-groups` endpoint at the CRM's chapter table so local groups appear on the site automatically.
