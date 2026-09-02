# ADR 0002: Relationship to the existing "PauseAI Everything" CRM

Date: 2026-09-02. Status: proposed, needs a decision from PauseAI Global.

## Context

While surveying the organisation's repositories, an earlier CRM turned up: [PauseAI/pauseai-everything](https://github.com/PauseAI/pauseai-everything) (upstream `Maximophone/pauseai-everything`), "a custom-built CRM and operational platform for PauseAI Global". Next.js 16, PostgreSQL, Drizzle, graphile-worker, Google OAuth, MailerSend. Twelve build phases are marked done: contacts with custom fields, tags, interactions, segments, campaign email with a three-state consent model and unsubscribe enforcement, JavaScript automation scripts, Airtable and Notion one-way sync, Gmail contact import, and flat "workspaces" (Global plus one per chapter). It has a production deployment on Railway, a security audit log in `BUGS.md`, 16 test files and thorough docs. Last commit: 2026-05-02. It has no Discord integration, no tasks or project templates, no chapter hierarchy below national level, and a known open issue that API keys always grant admin.

The website's onboarding code (August 2026) mentions "the CRM's `member_intent` vocabulary" and an import "drift canary"; no repository visible to this session contains those, so there may be a newer private branch or a script inside that app. This should be checked with Jakub Fidler (RisingOrange), who made the last commit there and wrote the website comments.

## Options

1. **Extend PauseAI Everything** with what this project adds (Discord link, chapter tree, tasks, escalation, Airtable field mapping). Pros: reuse campaign email and segments. Cons: Next.js and React versus the team's SvelteKit; flat workspaces would need reworking into a tree; the app has been idle four months and its author is external to the PauseAI org.
2. **Continue this project** as the CRM and, when campaign email is needed, port PauseAI Everything's consent and unsubscribe logic (its best-designed part) into it. Pros: one stack with the website, hierarchy and scoping designed in from the start. Cons: campaign email has to be rebuilt.
3. **Run both**: PauseAI Everything for broadcast email, this CRM for people, chapters and volunteer operations, synced through their APIs. Cons: two sources of truth for contacts, exactly the situation the brief wants to end.

## Recommendation

Option 2, on the condition that PauseAI Global agrees PauseAI Everything is not going to be actively developed. If it is, option 1 is the honest choice and most of this project's server modules (Drizzle schema, Airtable mapping, Discord handlers, task engine, all framework-free TypeScript) can move into it with modest changes.

Either way, the work here that is independent of the choice: the data model and ADR 0001, the PauseBot event webhook, the Airtable field mapping and drift canary, the task templates.

## Action

Ask Joep and Jakub which it is before building campaign email in this project.
