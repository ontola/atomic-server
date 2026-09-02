# Personal Information Suite: Contacts, Calendar, Email

## Status

Exploration. This plan sketches what it would take to make Atomic a credible
home for contacts, calendars, and email while preserving Atomic's local-first
resource model.

## Goal

Make contacts, calendar events, and email first-class Atomic resources so they
can participate in:

- local-first storage and sync;
- full-text and structured search;
- launcher / command-palette actions;
- relations between people, messages, meetings, files, chats, and notes;
- rights, audit trails, versioning, and future encrypted replication.

The target is not merely "show a Gmail view inside Atomic". The long-term value
comes from converting personal information into Atomic resources with stable
subjects and typed relationships.

## Core Recommendation

Use a hybrid model:

1. **Atomic-native canonical resources** for contacts, calendar events, email
   message metadata, threads, labels, and relationships.
2. **Blob-backed opaque originals** for large or protocol-specific payloads:
   raw RFC 822 messages, MIME parts, attachments, iCalendar payloads, and
   vCard payloads.
3. **Connector plugins / services** for Google, Microsoft, IMAP, SMTP, CalDAV,
   and CardDAV. These synchronize external accounts into Atomic resources and
   publish outbound changes back to the provider where possible.
4. **Read-through external views only as a bootstrap / fallback**, not as the
   main architecture. Pure external views cannot provide offline operation,
   cross-domain search, local AI context, audit, sharing, or unified launcher
   behavior.

This mirrors the existing File split: Atomic owns identity, metadata, rights,
and indexable properties; blobs preserve original bytes and avoid forcing every
protocol detail into properties.

## Shared Ontology

The three domains should share a person/account substrate instead of shipping
separate app-specific schemas.

### Contact / Person

Suggested first-class resources:

- `Person` — human or organization identity known to the user.
- `ContactProfile` — user-maintained contact card for a person.
- `ExternalIdentity` — email address, phone number, Matrix/Jabber/Signal
  handle, Google/Microsoft person ID, etc.
- `Organization`, optional for richer contact graphs.

Important properties:

- display name;
- given / family / organization name;
- email addresses and phone numbers as structured child resources or typed
  arrays;
- avatar file;
- notes;
- external IDs per account/provider;
- merged / same-as links between duplicate people.

The same `Person` should be referenced by an email sender, a meeting attendee,
and search / launcher actions.

### Calendar

Suggested resources:

- `CalendarAccount` — Google, Microsoft, CalDAV, local-only.
- `Calendar` — a provider calendar or local calendar.
- `CalendarEvent` — the user-facing event object.
- `CalendarOccurrence` — optional materialized instance for recurring events.
- `CalendarAttendee` — event-person relation with role and participation
  status.
- `CalendarReminder`.

Important properties:

- title, description, location;
- start / end with timezone;
- all-day flag;
- recurrence rule and exceptions;
- organizer;
- attendees;
- status and transparency;
- conference links;
- external UID / ETag / sync token;
- raw iCalendar blob reference.

Recurring events should store the canonical recurrence rule and materialize
occurrences into an index for fast month/week/day views. Do not make every
occurrence a separately edited event unless it has an override.

### Email

Suggested resources:

- `MailAccount` — provider identity and sync settings.
- `Mailbox` — inbox, sent, archive, custom labels/folders.
- `MailThread` — conversation grouping.
- `MailMessage` — immutable-ish message resource.
- `MailAddressParticipant` — sender/to/cc/bcc/reply-to relation.
- `MailAttachment` — file/blob metadata linked from a message.
- `MailDraft` — mutable outgoing message before send.

Important properties:

- subject;
- normalized body text for search;
- body variants: plain, HTML, markdown-ish derived view;
- date sent / received;
- message ID, in-reply-to, references;
- participants linked to `Person` where resolvable;
- mailbox labels / read / starred / archived state;
- provider UID / thread ID / history ID / modseq;
- raw RFC 822 blob reference and attachment blob refs.

Message identity must handle provider quirks. Use provider UID plus account as
the sync identity, but also retain Message-ID for cross-account threading and
deduplication.

## Connector Architecture

Treat Google, Microsoft, IMAP/SMTP, CalDAV, and CardDAV as sync connectors, not
as UI-only plugins.

### Connector Shape

A connector needs:

- OAuth / credential setup and refresh-token storage;
- provider-specific sync cursor storage;
- importer from provider payloads to Atomic resources;
- exporter from Atomic changes to provider mutations;
- conflict handling;
- rate limiting and retry state;
- background scheduling when the app/server is online;
- explicit account-level permissions and scopes.

In the existing architecture this probably starts as a server/native service
behind the plugin system rather than a pure iframe UI plugin. Browser-only
connectors are blocked by OAuth refresh-token security, CORS, background sync,
and provider SDK constraints.

### Google

Use provider APIs first:

- Gmail API for mail rather than IMAP where possible;
- Google Calendar API rather than CalDAV where possible;
- People API for contacts.

The API route gives better incremental sync, labels, thread IDs, batch requests,
and OAuth integration than pretending Google is just IMAP/CardDAV/CalDAV.

### Microsoft

Use Microsoft Graph first:

- Outlook mail;
- calendar;
- contacts / people.

Graph gives one OAuth setup and consistent delta queries across domains.

### Open Protocols

Still support:

- IMAP for email import / sync from generic providers;
- SMTP for sending;
- CalDAV for calendar providers;
- CardDAV for contacts.

These should be adapters into the same Atomic ontology, not separate data
models.

## Sync Direction

Start with import and local indexing, then add two-way sync.

### Phase 1: Import-Only Mirrors

- Provider is source of truth.
- Atomic creates resources with external IDs and sync cursors.
- Local edits are either disabled or stored as Atomic-only annotations.
- Search, contact linking, launcher actions, and views work locally.

This is the fastest path to product value and avoids pretending we can safely
round-trip every provider behavior immediately.

### Phase 2: Two-Way Contacts and Calendar

Contacts and calendar are tractable for two-way sync because their object models
are smaller and provider APIs expose update semantics reasonably well.

Required:

- map Atomic changes to provider update calls;
- detect provider-side conflicts using ETag / version / sync token;
- preserve unknown provider fields in raw blobs or provider metadata;
- emit emails / notifications when calendar invite semantics require it.

Calendar invite behavior is not just resource mutation. Adding/removing guests,
changing time, or cancelling an event should enqueue provider-specific outbound
actions that send the right email/calendar notifications.

### Phase 3: Email Send and Drafts

Sending mail is not local-first in the same way editing a note is:

- an SMTP/Gmail/Graph send operation is externally visible and irreversible;
- drafts can be local-first resources;
- "send" should be a queued command with explicit delivery state.

Atomic should model outgoing mail as:

```text
MailDraft resource
  -> SendMailCommand resource
     pending | sending | sent | failed
     provider response / delivered message link
```

The draft is collaborative/local-first if desired. The send command is a
side-effecting job executed by a connector when online.

### Phase 4: Full Mail Two-Way State

After send/drafts, support provider state mutations:

- read/unread;
- archive;
- labels/folders;
- star/flag;
- delete/trash;
- move.

Avoid editing received message content. Treat received email bodies as immutable
payloads plus local Atomic annotations.

## Views

Views should be normal Data Browser screens over Atomic resources, not
provider-specific app silos.

### Contacts

- contact list with search and facets;
- contact page showing profile, identities, recent emails, upcoming meetings,
  files, notes, and chats;
- duplicate merge UI;
- person picker shared by mail compose and calendar attendee search.

### Calendar

- month / week / day / agenda;
- recurrence expansion index;
- timezone-correct rendering;
- invitee availability later, if connectors can expose free/busy;
- event page with related people, emails, notes, files, and tasks.

### Email

- mailbox list;
- thread list;
- thread reader;
- compose / reply;
- attachment viewer;
- contact side panel;
- search result integration.

Initial email UI can be read-heavy. The big unlock is that messages are
searchable and linked to people/events/files, not that Atomic immediately
replaces every Gmail feature.

## Launcher Integration

The launcher / command palette should operate on the shared ontology:

- search people, mail threads, events, files, chats, and documents in one
  index;
- actions: email person, schedule with person, open next event, join meeting,
  create contact, create event from selected text, attach file to draft;
- ranking can use recency across domains: recent email correspondents,
  upcoming attendees, frequently opened docs.

This only works well if people, messages, and events are Atomic resources with
stable subjects.

## Storage and Indexing

Email is the storage stress test.

- Store raw email and attachments as blobs.
- Store extracted plain text and relevant headers as resource properties for
  search.
- Avoid storing every MIME detail as Atomic properties.
- Deduplicate attachments by content hash.
- Consider per-account retention settings before importing huge mailboxes.
- Make sync incremental; never reimport a full mailbox on every run.

Calendar recurrence should have a materialized occurrence index for view
performance. The canonical resource remains the event + recurrence rule.

## Security and Privacy

This feature area raises the privacy stakes of Atomic.

Requirements before serious rollout:

- credential storage with a clear threat model;
- per-connector OAuth scope display;
- account disconnect and data deletion;
- local encryption-at-rest story, or at least clear disclosure of plaintext
  local indexes;
- careful handling of contact/email data in AI context;
- no blind-replica promise until encrypted replication authorization is solved.

The existing `planning/encryption.md` distinction between verifier and blind
replica matters here. A hosted server with full email/contact/calendar indexes
is a highly trusted verifier, not a neutral relay.

## Server / Local Runtime Needs

This work depends on the `AtomicNode` direction in `atomic-lib-runtime.md`.
Connectors need background jobs and durable side-effect queues. Those should
belong below HTTP handlers so desktop, server, and mobile can share behavior.

Needed runtime primitives:

- background job scheduler;
- durable connector state table;
- secret storage API;
- side-effect command queue;
- resource-change subscriptions for connectors;
- provider webhook ingress where available;
- provider polling fallback;
- blob import and extraction pipeline.

## Suggested Roadmap

### Milestone 1: Ontology and Local Views

- Define Contact/Person, Calendar, and Mail classes/properties.
- Build local-only contact list/page.
- Build local-only calendar views over sample events.
- Build read-only mail thread view over imported fixture messages.
- Add launcher result types for people, events, and mail threads.

### Milestone 2: Import Fixtures and Open Formats

- Import `.vcf` into contacts.
- Import `.ics` into calendar.
- Import `.eml` / mbox into email resources and blobs.
- Add tests that round-trip key fields into Atomic resources.

This de-risks ontology and views without OAuth.

### Milestone 3: Google Read-Only Connector

- OAuth setup.
- Read-only People, Calendar, and Gmail sync.
- Incremental cursors.
- Search and launcher integration.

Google is the best first connector because one account can exercise all three
domains and the APIs expose good sync metadata.

### Milestone 4: Two-Way Contacts / Calendar

- Push Atomic contact changes to Google.
- Push event create/update/delete to Google Calendar.
- Model invite notification side effects explicitly.
- Add conflict UI for divergent provider/Atomic changes.

### Milestone 5: Drafts and Sending

- Local Atomic drafts.
- Send through Gmail / Graph / SMTP connector.
- Delivery state resources.
- Reply/forward support.

### Milestone 6: Microsoft and Generic Protocols

- Microsoft Graph connector.
- IMAP/SMTP connector.
- CalDAV/CardDAV connector.

### Milestone 7: Hardening

- encryption-at-rest / secret storage;
- retention controls for large mailboxes;
- attachment indexing pipeline;
- webhook support;
- mobile background sync strategy;
- provider account migration / disconnect flows.

## Open Questions

- Should contacts/calendar/mail classes live in the default ontology, or in
  installable suite plugins that register classes?
- What is the minimum plugin/runtime API for background connector jobs?
- How should provider secrets be encrypted on desktop, server, and browser?
- How much mail should be imported by default: all history, recent window, or
  headers-first with body-on-demand?
- Should email bodies become collaborative Atomic documents for drafts only, or
  also for local annotations on received mail?
- How do we present provider conflict resolution without exposing protocol
  jargon?
- Where should full-text extraction happen for HTML mail and attachments:
  connector, blob pipeline, or search indexer?

