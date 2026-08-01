# Notifications (mentions + watch subscriptions)

> Status: **Proposal (2026-08-01).** Design for in-app / desktop / (later) push
> notifications in the data-browser and Tauri app. Scope of this doc: **mentions**
> of agents, and **watch settings** for updated queries / collections / tables.
> Complements [`social-apps.md`](./social-apps.md) P2.3 (push as hint-to-sync) and
> [`authorization-sync.md`](./authorization-sync.md) (inbox reserved; actor-side
> social preferred).

## Problem

Today the stack has realtime *data* delivery but no *product* notifications:

| Layer | What exists | Gap |
| --- | --- | --- |
| Wire | Drive `SUB` → `UPDATE`/`DESTROY`; server also has `SUBSCRIBE_QUERY` | No offline / OOB path; browser never uses query subscribe |
| Mentions | TipTap `@` inserts a resource embed (any drive resource); AI chat `@` is context | Not agent-targeted; no mention edge; no alert |
| Collections / tables | Live membership via `ResourceUpdated` + `Collection.applyResourceChange` | No "notify me when this changes" preference |
| UI | Toasts (`Toaster`, `MeetingMessageToaster`); Settings have theme/AI/VFS only | No notification center, mute, or watch toggles |
| Desktop | Tray + deep links | No `tauri-plugin-notification` |

Product ask: when someone `@`s you in a doc/chat, or a watched table/collection
gains/loses rows, you should see it — in the browser, in the Tauri app, and
eventually when the app is closed (push).

## Constraints from existing planning (do not violate)

1. **Mentions are not inbox spam.**
   [`authorization-sync.md`](./authorization-sync.md) puts likes / replies /
   **mentions** in the *actor-side commit + reverse-index* bucket. The constrained
   append-only `/inbox/` is reserved for first-contact DMs, **service-originated**
   notifications, and protocol bridges. Same-drive collaborative mentions must
   *not* invent a fourth inbox use case.
2. **Push is a wake hint.** [`social-apps.md`](./social-apps.md) P2.3: payload
   comes from the store after sync; hang device tokens off commit fan-out later.
3. **One delivery channel for resource changes.** `QUERY_UPDATE` is retired
   ([`docs/src/websockets.md`](../docs/src/websockets.md)); membership arrives as
   ordinary `UPDATE`/`DESTROY`. Do not revive a parallel membership frame.
4. **Prefer reverse query when ACL already allows it.** Pattern used by
   [`drafts-and-suggestions.md`](./drafts-and-suggestions.md) / `PendingForks`:
   if the reviewer already syncs the drive, discover via local query — no push
   of content into their drive.
5. **Subscription unification is orthogonal.**
   [`unify-subscription-primitives.md`](./unify-subscription-primitives.md) may
   collapse `SUB` / `SUBSCRIBE` / `SUBSCRIBE_QUERY`; notification watches should
   target the *semantic* filter (property/value/drive), not a specific wire opcode.

## Design summary

Three separable layers:

```text
┌─────────────────────────────────────────────────────────────┐
│  Sources (what happened)                                    │
│  • Mention edges on authored content (actor-side)           │
│  • WatchSubscription prefs → membership / content deltas    │
└───────────────────────────┬─────────────────────────────────┘
                            │ materialize
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  NotificationItem (personal, local-first)                   │
│  typed event + subject refs + read/dismiss state            │
└───────────────────────────┬─────────────────────────────────┘
                            │ present
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Channels                                                   │
│  in-app center/toast → OS (Tauri / Notification API) → push │
└─────────────────────────────────────────────────────────────┘
```

**Key decision:** notification *items* live on the **recipient's** personal
drive (or local-only until sync exists). Sources are discovered from data the
recipient can already read. Nothing is appended into a stranger's inbox for a
same-drive `@mention`.

## Ontology

New defaults (bootstrap + `ATOMIC_REPOPULATE_DEFAULTS` caveat as in drafts):

### `NotificationItem`

A personal, recipient-owned resource under e.g. `{personalDrive}/notifications/`.

| Property | Datatype | Purpose |
| --- | --- | --- |
| `isA` | — | `NotificationItem` |
| `notificationType` | enum/string | `mention` \| `watch-membership` \| `watch-content` \| (later: `invite`, `fork`, …) |
| `about` | atomicUrl | Primary subject (doc, message, table row, …) |
| `actor` | atomicUrl | Who caused it (`createdBy` / signer of source) |
| `mentions` / `mentionedAgent` | atomicUrl | For mentions: the agent DID that was tagged |
| `watchTarget` | atomicUrl | For watches: Collection / Table / WatchSubscription subject |
| `read` | boolean | Inbox UI state |
| `dismissed` | boolean | Soft-hide without destroy |
| `createdAt` | timestamp | Ordering |
| `summary` | string | Short renderable line (optional cache; UI can regenerate) |

Items are **derived, re-creatable** from sources. Destroying them is fine; the
source (the mention in the doc) remains. Dedup key: `(type, about, actor,
mentionedAgent|watchTarget, sourceCommitId?)` so re-materialization is idempotent.

### `mentions` property (on content)

`https://atomicdata.dev/properties/mentions` — `resourceArray` of Agent subjects
extracted from authored content.

- Written by the client at save time (TipTap / markdown parser), same moment as
  datatype tags.
- Indexed like any other resourceArray (search caveat #597: confirm array
  members are indexed for reverse query; if not, fix that before relying on
  server-side reverse lookup — local WASM query still works for same-drive).
- Reverse query for "mentions of me":
  `filters: [{property: mentions, value: <myAgent>}]` (multi-property filter
  already landed — see [`multi-property-filter.md`](./multi-property-filter.md)).

This is the actor-side mention edge. No separate `Mention` class required for v1;
a dedicated class is only needed if we want mention *events* detached from the
hosting resource (e.g. chat without rewriting message body metadata). Prefer the
property on the host resource first.

### `WatchSubscription`

Recipient-owned preference: "alert me when this query-shaped thing changes."

| Property | Purpose |
| --- | --- |
| `watchTarget` | Subject of a Collection, Table, or saved Query resource |
| `watchKind` | `membership` (row enter/leave) \| `content` (any matching resource updated) \| `both` |
| `channels` | ResourceArray or JSON: `inApp`, `os`, `push` (which surfaces) |
| `mutedUntil` | Optional timestamp |
| `enabled` | Boolean |

For Tables: `watchTarget` is the Table resource; membership = children matching
the table's class/parent filter (same filter the Table view already uses).
For Collections: reuse the Collection's `property`/`value`/`filters`.
For ad-hoc queries: either persist a Collection resource, or embed the filter
params on the `WatchSubscription` itself (`filters` JSON) — prefer pointing at
an existing Collection/Table so there is one source of truth for the query shape.

### `NotificationPreferences` (agent / device)

One resource (or localStorage for device-only knobs) covering global defaults:

- Master enable / Do Not Disturb schedule
- Default channels for `mention` vs `watch-*`
- "Mentions in resources I can already read" on/off
- Desktop: show OS notifications when window unfocused / always / never
- Browser: request Notification permission
- Later: device-token registry pointer (push)

Device-local keys (sound, OS permission granted) stay in `AppSettings` /
`localStorage`; syncable prefs live as Atomic resources on the personal drive so
phone and desktop share mute rules.

## Mentions — end-to-end

### Authoring (browser TipTap)

Today `@` → `store.search` → insert `atomic-data-resource` (any class). Change:

1. Split suggestion UX into **People** (Agents in drive / address book) and
   **Resources** (everything else), or prioritize Agents when query looks like a
   name. Keep resource linking; add an agent-aware path.
2. On insert of an Agent subject, mark the node as a mention (existing resource
   node is enough if `subject` is an Agent).
3. On `resource.save()`, scan the Loro/TipTap doc (and markdown `description` for
   chat Messages) for Agent subjects → set `mentions` resourceArray. Clear when
   none remain.
4. Chat Messages: same property on the Message resource; body stays markdown.

### Discovery (recipient, same-drive — v1)

While the drive is subscribed (browser already `SUB`s the drive):

1. `NotificationEngine` listens to `StoreEvents.ResourceUpdated`.
2. If the resource's `mentions` contains `currentAgent` and `createdBy !== me`
   and we haven't emitted for this `(about, commit/frontier)` yet → create or
   upsert a `NotificationItem`.
3. Optionally also run a boot-time reverse query for unread backlog since
   `lastSeenAt`.

No server special-case. Works offline once OPFS has the commit (local-first).

### Cross-drive / strangers (later)

- Prefer indexer reverse index of public `mentions` (authorization-sync indexer
  pattern).
- Only if the recipient cannot discover the source at all: deposit a thin
  *service* notification via constrained inbox (case 2 in auth-sync) — a pointer
  (`about`, `actor`), not the document body. Do not build this in v1.

### Surfaces

- **In-app:** bell → notification center (unread count); toast when unfocused
  panel (reuse `MeetingMessageToaster` pattern: skip own actions, skip if
  already viewing the subject).
- **Desktop / browser OS:** when document hidden or Tauri window unfocused,
  fire OS notification via Notification API / `tauri-plugin-notification`.
- Click → navigate to `about` (doc deep-link / chat message scroll).

## Watch subscriptions — queries / collections / tables

### Intent

User opens a Table or Collection → "Notify me when rows change" toggle in the
view chrome / overflow menu. Creates/updates a `WatchSubscription` on their
personal drive. Settings page lists all watches with mute/channel controls.

### How deltas are detected (v1 — client-side)

Browser already receives every drive commit. For each enabled
`WatchSubscription`:

1. Resolve filter from `watchTarget` (Collection params or Table's class/parent).
2. On `ResourceUpdated` / destroy: run the same membership test
   `Collection.applyResourceChange` uses.
3. Emit `NotificationItem` with type `watch-membership` (entered/left) or
   `watch-content` (still a member, props changed — only if `watchKind`
   includes content).

Coalesce: burst of 20 row imports → one item "12 rows added to *Tasks*" with
a short debounce (e.g. 2s), not 12 toasts.

### Optional server assist (v1.5)

For watches whose drive is *not* currently open in the client, register
`SUBSCRIBE_QUERY` (or future `SUBSCRIBE_V2` filter match) so the server fans
membership `UPDATE`s without the client holding a full drive SUB. Auth already
gates on drive read. Does **not** replace client materialization — still create
`NotificationItem` locally from the delivered `UPDATE`.

Aligns with unify-subscription work; do not hard-depend on the refactor.

### Settings UI

New **Notifications** section in `AppSettings` (searchable `SettingsGroup`
pattern already used there):

- Mentions: on/off, channels
- Watches: list of `WatchSubscription`s with enable / mute / kind / channels
- Quiet hours / DND
- Desktop & browser permission status + request button
- (Later) Push device list

Per-resource toggle also on Table / Collection toolbars (writes the same
`WatchSubscription`).

## Delivery channels

| Channel | When | Implementation |
| --- | --- | --- |
| In-app center | Always when app running | React store of `NotificationItem`s + bell in chrome |
| In-app toast | App focused, subject not visible | Extend toast patterns; respect prefs |
| OS notification | Window unfocused / background | Web `Notification` API in browser; `tauri-plugin-notification` in desktop |
| Push (FCM/APNs/web-push) | App killed / mobile suspended | Out of v1 — see social-apps P2.3; wake → sync → materialize |

**Tauri specifics**

- Add `tauri-plugin-notification` (desktop + mobile targets).
- Tray can show unread badge / "N notifications" menu item (optional stretch).
- Deep link already exists (`atomic://…`) — OS notification click should open
  the app to `?subject=` of `about`.
- Embedded server keeps WS alive while the app runs, so OS notifications for
  watches/mentions work without push as long as the process is up.

**Permission UX:** first mention or first watch enable prompts for OS
permission; never on cold start.

## Notification engine (client module)

New module in `@tomic/lib` or data-browser (prefer lib if Flutter will share):

```text
NotificationEngine
  .start({ store, agent, prefs })
  .onResourceUpdated(res)     // mentions + watches
  .reconcileBacklog()         // reverse queries on boot
  .list() / markRead() / dismiss()
  .subscribe(uiCallback)      // for bell + toasts
```

Rules of thumb (shared with `MeetingMessageToaster`):

- Never notify for the current agent's own commits.
- Never notify for the resource currently focused (optional soft rule).
- Honor `mutedUntil` / DND / channel flags.
- Idempotent upsert of `NotificationItem`.

Server stays dumb in v1: no notification fan-out service. Push later hooks the
same commit_monitor path *only* as a wake signal to devices that registered
tokens for agents mentioned or watches matching — still no payload body.

## What we are *not* doing (v1)

- Public-write mention inbox on the recipient drive.
- Reviving `QUERY_UPDATE`.
- Email notifications.
- Cross-agent mention delivery without shared read / indexer.
- Server-authored `NotificationItem`s (keeps local-first and avoids trust in
  hub formatting).
- Replacing chat Presence toasts — they remain session-scoped; engine can
  later absorb them as `notificationType: meeting-chat` if desired.

## Build phases

### Phase 0 — Design lock (this doc)

- [x] Constraints mapped from auth-sync / social-apps / subscriptions
- [ ] Product sign-off on: actor-side `mentions` property, personal
      `NotificationItem`s, client-side watch matching

### Phase 1 — Ontology + mention authoring

- [ ] Add `mentions`, `NotificationItem`, `WatchSubscription`,
      `NotificationPreferences` to defaults
- [ ] TipTap: agent-prioritized `@`; write `mentions` on save (docs + chat)
- [ ] Unit tests: extract mentions from fixture docs; reverse query finds them

### Phase 2 — In-app engine + center (browser)

- [ ] `NotificationEngine` materializes mention items from `ResourceUpdated`
- [ ] Bell + notification center + mark read/dismiss
- [ ] Settings section: mention toggles
- [ ] E2E: A mentions B in a shared doc → B sees unread item (two contexts /
      `getDevDriveSecret` pattern)

### Phase 3 — Watch subscriptions

- [ ] Toggle on Table / Collection → `WatchSubscription`
- [ ] Engine: membership + coalesced content events
- [ ] Settings list + mute/channels
- [ ] E2E: watch table → other agent adds row → notification

### Phase 4 — OS notifications (browser + Tauri)

- [ ] Notification API when tab hidden
- [ ] `tauri-plugin-notification` + click → deep link to subject
- [ ] Permission request UX tied to first enable

### Phase 5 — Push wake (platform)

- [ ] Device-token registry per agent (hub)
- [ ] commit_monitor → mention/watch match → FCM/APNs/web-push *wake*
- [ ] Client: on wake, sync, then materialize (social-apps framing)
- Track under social-apps; this doc only requires the client engine be
  push-ready (idempotent materialize, prefs already have a `push` channel).

## Test plan (where tests belong)

Per [`TESTING_COVERAGE.md`](../TESTING_COVERAGE.md) preference for cheaper layers:

| Concern | Layer |
| --- | --- |
| Mention extraction from TipTap/markdown | unit (`@tomic/lib` or data-browser helper) |
| Reverse query `mentions ∋ agent` | lib / WASM query test (multi-filter) |
| Engine idempotency + coalesce | unit with mock store events |
| Watch membership vs table filter | unit reusing Collection match helpers |
| A mentions B / watch fires | e2e (two pages, shared drive) |
| Tauri OS notification | manual / desktop smoke; plugin config in CI later |

## Open questions

1. **Where do `NotificationItem`s live?** Personal drive folder (syncs across
   devices, uses quota) vs IndexedDB/OPFS-only (lighter, per-device read state).
   Recommendation: personal drive for the item graph; `read`/`dismissed` may be
   device-local overlays if syncing read-state feels noisy — decide in Phase 2.
2. **Should `mentions` include non-Agent resource links?** No for v1 — only
   Agent subjects. Resource embeds stay separate.
3. **Chat `@` vs document `@`.** Unify on `mentions` property for both; AI chat
   context mentions stay out of the notification path (they tag context for the
   model, not people).
4. **Watch on server-only drives the client isn't syncing.** Needs Phase 1.5
   `SUBSCRIBE_QUERY` or push; accept "watches only fire for drives you're
   connected to" as v1 limitation and document it in the toggle tooltip.
5. **Group mentions / `@everyone`.** Defer; needs groups (zones.md / social-apps
   P3.7).
6. **Flutter canvas.** Same ontology + engine in Rust/`atomic_lib` later; v1 is
   data-browser + Tauri webview (shared JS).

## Relationship to other plans

| Plan | Relationship |
| --- | --- |
| [`social-apps.md`](./social-apps.md) | Push (P2.3) is Phase 5 here; do not duplicate FCM design |
| [`authorization-sync.md`](./authorization-sync.md) | Mentions = actor-side; inbox only for service wake pointers later |
| [`unify-subscription-primitives.md`](./unify-subscription-primitives.md) | Watches consume filter subscriptions when unified |
| [`multi-property-filter.md`](./multi-property-filter.md) | Enables `mentions ∋ me` (+ class) reverse queries |
| [`drafts-and-suggestions.md`](./drafts-and-suggestions.md) | Same discovery pattern as PendingForks; fork events can become a later `notificationType` |
| [`virtual-drive.md`](./virtual-drive.md) | Mobile background: push wake, not persistent WS |
| [`sync-onboarding-ux.md`](./sync-onboarding-ux.md) | Any new Settings copy follows shared vocabulary |

## Highest-signal code touch points (when building)

- Mentions authoring: `browser/data-browser/src/chunks/RTE/ResourceExtension/`
- Chat body: `ChatRoomView.tsx` / Message `description`
- Live collection match: `browser/lib/src/collection.ts`, `useCollection.ts`
- Drive WS: `browser/lib/src/websockets.ts`
- Server query sub (optional assist): `server/src/commit_monitor.rs`,
  `SUBSCRIBE_QUERY` in `web_sockets.rs`
- Settings chrome: `routes/AppSettings.tsx`, `components/Settings/`
- Toast precedent: `MeetingMessageToaster.tsx`
- Desktop: `desktop/Cargo.toml`, `desktop/src/lib.rs` (plugin init)
