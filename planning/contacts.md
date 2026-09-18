# Contacts

> **Status:** active build plan (2026-08-03). Scopes Milestone 1–2 of
> [`personal-information-suite.md`](./personal-information-suite.md) into a
> shippable Contacts feature: ontology, local Address Book UI over query,
> VCF import (Google / iCloud / Microsoft export), and optional Agent links.
> OAuth connectors and two-way CardDAV sync stay in the suite plan.

## Goal

Make people you know first-class Atomic resources so they can be searched,
queried, linked from meetings/chat/docs, and optionally tied to an Atomic
Agent — without pretending a Contact *is* an Agent.

## Agent vs Contact (critical distinction)

| | **Agent** | **Contact** |
| --- | --- | --- |
| Class | `https://atomicdata.dev/classes/Agent` | `https://atomicdata.dev/classes/Contact` |
| Identity | `did:ad:agent:{publicKey}` (Ed25519) | Ordinary Drive-scoped resource (`did:ad:…` genesis) |
| Role | Cryptographic actor: signs commits, holds `read`/`write` | Address-book card: name, emails, phones, notes |
| Rights | Subject *of* authorization | Object *under* Drive hierarchy rights |
| Server | Special (invite, auth, publicKey) | Normal resource — no ClassExtender needed for MVP |

A Contact may link to an Agent via `contactAgent`. That link:

- does **not** grant the Agent rights on the Contact or Drive;
- does **not** make the Contact sign anything;
- *does* let UIs show “this person is also `@alice`”, resolve attendees, and
  reverse-query “which Contact is this Agent?”.

Many Contacts will never have an Agent (vendors, relatives, paper contacts).
Many Agents will never appear as Contacts (bots, service accounts).

## How Contacts interact with atomic-server

Contacts are ordinary Loro-backed resources:

1. Client `resource.set(…)` → Loro `properties` (+ datatype tags) → `save()`
   → signed commit with `loroUpdate` → `POST /commit`.
2. Server `apply_changes()` imports the update, materializes PropVals, indexes
   for search (tantivy) and collection queries.
3. Subscribers get `COMMIT` over WebSocket; peers sync via Iroh like any other
   Drive child.
4. Authorization is hierarchical: rights on the Address Book / Drive cover
   Contacts. The optional Agent link is just an `atomicUrl` property.

No server plugin, no special commit path, no bootstrap Agent registration.
Server already understands `isA`, Collection filters, and full-text search —
the feature rides those.

## Ontology

Bootstrap vocabulary in `lib/defaults/contacts.json`, imported from
`populate_default_store()` (same pattern as `meeting.json`).

### Classes

#### `AddressBook` — `https://atomicdata.dev/classes/AddressBook`

Container for Contacts. Custom page lists children via `useCollection`.

- **requires:** `name`
- **recommends:** `description`

Contacts are **not** stored in a property array. They are child resources
(`parent` = Address Book subject), listed with the built-in query stack.

#### `Contact` — `https://atomicdata.dev/classes/Contact`

One address-book entry.

- **requires:** `name` (vCard `FN` / display name)
- **recommends:** properties below

### Properties

| Property | URL suffix | Datatype | Notes |
| --- | --- | --- | --- |
| `givenName` | `properties/givenName` | string | vCard `N` given |
| `familyName` | `properties/familyName` | string | vCard `N` family |
| `organization` | `properties/organization` | string | vCard `ORG` |
| `jobTitle` | `properties/jobTitle` | string | vCard `TITLE` |
| `email` | `properties/email` | string | **Primary** email — indexed, filterable |
| `telephone` | `properties/telephone` | string | **Primary** phone — indexed, filterable |
| `emails` | `properties/emails` | json | `[{ "value": "…", "type"?: "work"\|"home"\|… }]` |
| `telephones` | `properties/telephones` | json | same shape |
| `addresses` | `properties/addresses` | json | `[{ "street"?, "locality"?, "region"?, "postalCode"?, "country"?, "type"? }]` |
| `website` | `properties/website` | uri | vCard `URL` |
| `contactAgent` | `properties/contactAgent` | atomicUrl → Agent | Optional linked Agent |
| `vcardUid` | `properties/vcardUid` | string | vCard `UID` for import dedup |
| `contactsFolder` | `properties/contactsFolder` | atomicUrl → Folder | Drive pointer (standard location) |

Reuse existing props where they already fit: `name`, `description` (notes /
vCard `NOTE` as markdown via `description`), `image` (avatar File).

Primary `email` / `telephone` are denormalized from the JSON arrays so
Collection filters and search stay simple. Import fills both; the Contact page
keeps them in sync when the user edits the primary.

### Ontology resource

Group under `https://atomicdata.dev/ontology/contacts` with `classes` /
`properties` arrays (same pattern as `i18n.json` / `forks.json`).

### Drive standard location

`drive.contactsFolder` → Folder named “Contacts”, get-or-create via
`getOrCreateDriveLocation` (see `standardLocations.ts`). New Address Books
default there; sidebar can hide the folder if it stays empty clutter (same
treatment as Comments / AI Chats — decide at UI time; default: **show** so
Contacts are discoverable).

## Queries (built-in)

All listing uses `@tomic/react` `useCollection` / Collection resources — no
ad-hoc child arrays.

```ts
// Contacts in an Address Book
useCollection({
  property: core.properties.parent,
  value: addressBook.subject,
  filters: [{ property: core.properties.isA, value: dataBrowser.classes.contact }],
  sort_by: core.properties.name,
});

// Drive-wide contacts
useCollection({
  property: core.properties.isA,
  value: dataBrowser.classes.contact,
  sort_by: core.properties.name,
});

// Reverse: Contact for an Agent
useCollection({
  property: dataBrowser.properties.contactAgent,
  value: agentSubject,
});
```

Users can also create a classic **Collection** resource with
`property=isA`, `value=Contact` for a reusable filtered view — CollectionPage
already supports card/table display and `NewInstanceButton`.

## UI (reuse first)

### Address Book page

`views/Contacts/AddressBookPage.tsx`

- Shell: `ContainerWide`, `EditableTitle`, `Row` / `Column`
- Toolbar: search input (client filter on loaded page + optional
  `useServerSearch` later), **Import vCard**, **New Contact**
  (`NewInstanceButton` / `useNewResourceUI`)
- Body: `useCollection` → list rows (name, email, telephone, Agent pill via
  `ResourceInline` / Agent styling). Prefer dense list (`TableList` or custom
  row using `ResourceGlyph` + `AtomicLink`) over card masonry for contacts.
- Empty state: `SkeletonButton` for New + Import

### Contact page

`views/Contacts/ContactPage.tsx`

- Header: name (`EditableTitle`), optional avatar (`image`)
- Identity block: given / family / org / job title
- Reachability: primary email & phone (editable), expand JSON multi-values
- **Linked Agent:** `ResourceSelector` with `isA={core.classes.agent}`
  (automatic from `classtype` via `InputSwitcher` / `InputResource`)
- Notes: markdown `description`
- Footer actions: open Agent (if set), delete

Register in `ResourcePage.selectComponent`, optional Card + `iconMap`
(`FaAddressBook` / `FaUser`).

### Create flows

| Action | Behavior |
| --- | --- |
| New → Address Book | Instant create under `contactsFolder` (or current parent), navigate to page |
| New → Contact | Create under parent if parent is AddressBook; else under default Address Book in `contactsFolder` |
| Import vCard | Dialog: drop/select `.vcf` / `.vcard`, preview count + sample names, commit as Contact children |

Wire: `BaseButtons`, `registerBasicInstanceHandler` / `registerNewResourceDialog`,
`CustomForms/index.ts`.

### Components to reuse (do not rebuild)

Dialog / `useDialog`, `Button`, `Field`, `InputStyled`, `ResourceSelector`,
`EditableTitle`, `ContainerWide` / `ContainerNarrow`, `Row` / `Column`,
`NewInstanceButton`, `SkeletonButton`, `FileDropzone` / react-dropzone,
`ResourceInline`, `AtomicLink`, `LoaderInline`, `ConfirmationDialog`.

## VCF import

Google Contacts, Apple iCloud, and Microsoft Outlook/People all export
**vCard** (`.vcf`, typically 3.0; sometimes 4.0). No OAuth in this milestone —
user exports from the provider, imports the file.

### Pipeline (Level 0 importer, per `importers.md`)

```text
file pick → parse VCF (first-party) → map to Contact props → preview → commit
```

- Parser: small first-party module in `browser/data-browser/src/views/Contacts/vcf.ts`
  (unfold lines, split `BEGIN:VCARD`…`END:VCARD`, handle `N`, `FN`, `EMAIL`,
  `TEL`, `ORG`, `TITLE`, `URL`, `NOTE`, `UID`, `ADR`, `PHOTO` as URL only).
  Avoid a heavy dependency unless 3.0/4.0 edge cases force it.
- Dedup: if `vcardUid` matches an existing child Contact, update that resource
  instead of creating a duplicate (LWW on props).
- PHOTO binary (`ENCODING=b`) is skipped in MVP; URL photos may set `imageUrl`
  if we keep that property, else ignore.
- Batch create with sequential `store.newResource` + `save()`; show progress
  toast. For very large books (>500), chunk — still client-side.

### Tests

Unit tests on the parser with fixtures that look like Google / Apple /
Outlook exports (minimal representative cards, not full dumps).

## TypeScript / Rust wiring checklist

- [x] `lib/defaults/contacts.json` + import in `populate.rs`
- [x] URL constants in `lib/src/urls.rs` (optional if only used via JSON)
- [x] Hand-update `browser/lib/src/ontologies/dataBrowser.ts` (classes,
      properties, prop type maps) — CLI regen later if desired
- [x] `getOrCreateContactsFolder` in `standardLocations.ts`
- [x] Basic instance handlers + BaseButtons
- [x] `AddressBookPage` + `ContactPage` + ResourcePage / Card / iconMap
- [x] VCF parser + import dialog + tests
- [x] Docs blurb optional; update `planning/README.md` + suite plan pointer
- [x] Focused VCF unit tests (5 passing). Full data-browser typecheck still
      fails on pre-existing `pairing.test.ts` `@types/node` issue; Contacts
      files have no type errors.

## Out of scope (stay in personal-information-suite)

- Google People / Microsoft Graph / CardDAV OAuth connectors
- Two-way sync, ETag / sync tokens
- Person / ContactProfile / ExternalIdentity split (Contact is enough for now;
  suite can introduce Person later and migrate)
- Duplicate-merge UI, organization graph
- Email/calendar deep linking beyond storing the Agent relation
- Server-side ClassExtender behavior

## Acceptance

- [x] Fresh server bootstrap includes Contact + AddressBook vocabulary
      (`contacts.json` wired into `populate_default_store`)
- [x] User can create an Address Book and Contacts from New Resource
- [x] Address Book page lists Contacts via `useCollection` (query), searchable
- [x] Contact page edits fields and links an Agent through ResourceSelector
      (`classtype=Agent` on `contactAgent` + Edit form / AllProps)
- [x] Importing a `.vcf` creates Contacts with name/email/phone/uid populated
- [x] Re-import with same UID updates rather than duplicating
- [x] Contacts sync/search like any other resource (no special server path)
- [x] UI reuses Dialog, ResourceSelector, EditableTitle, layout primitives

## Relationship to other plans

- Supersedes suite Milestone 1–2 for the Contacts slice only;
  [`personal-information-suite.md`](./personal-information-suite.md) remains
  the umbrella for calendar/mail/connectors.
- Import architecture aligns with Level 0 / first-party parse in
  [`importers.md`](./importers.md).
- Follows Meeting’s packaging pattern (`meeting.json` + dedicated page +
  drive folder pointer).
