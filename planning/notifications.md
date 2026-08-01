# Notifications (mentions + watch subscriptions)

> Status: **In progress (2026-08-01).** Design + initial implementation for
> in-app notifications in the data-browser (and later Tauri). Scope: **mentions**
> of agents, and **watch settings** for updated queries / collections / tables.
> Complements [`social-apps.md`](./social-apps.md) P2.3 (push as hint-to-sync) and
> [`authorization-sync.md`](./authorization-sync.md) (inbox reserved; actor-side
> social preferred).
>
> **Shipped so far:** ontology (`lib/defaults/notifications.json`), TipTap /
> chat `mentions` write path, `NotificationEngine`, sidebar entry +
> `/app/notifications` center, table **and collection** Watch toggle,
> Settings watches list, App Settings blurb + OS permission,
> Playwright e2e for inbox / mark-read / Watch / watch→item,
> **Phase 4 local OS notifications** (Web Notification API +
> `tauri-plugin-notification`), **Phase 5 scaffold** (`DevicePushToken`
> ontology, `registerDevicePushToken`, hub `push_wake` helpers, cold-start
> tap queue). Live APNs/FCM transport still open.

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
| `notificationRead` | boolean | Inbox UI state (not ACL `read`) |
| `dismissed` | boolean | Soft-hide without destroy |
| `createdAt` | timestamp | Ordering |
| `summary` | string | Short renderable line (optional cache; UI can regenerate) |

Items are **derived, re-creatable** from sources. Destroying them is fine; the
source (the mention in the doc) remains. Dedup key: `(type, about, actor,
mentionedAgent|watchTarget, sourceCommitId?)` so re-materialization is idempotent.

**Decision (2026-08-01): sync read status.** `NotificationItem`s live on the
recipient's personal drive, and `read` / `dismissed` are ordinary properties on
those resources — they sync across laptop / phone / browser like any other
commit. Mark-read on one device clears the bell on the others after sync.
Device-local overlays are rejected: the whole point of multi-device is one
inbox state. Tradeoff: read-flips create small commits (acceptable; batch
mark-all-read into one commit).

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

### `NotificationPreferences` (agent-scoped, syncs)

One resource on the personal drive covering global defaults shared by all
devices:

- Master enable / Do Not Disturb schedule
- Default channels for `mention` vs `watch-*` (`inApp`, `os`, `push`)
- "Mentions in resources I can already read" on/off

### Device-local only (do not sync)

- OS / push permission granted (platform state)
- Sound / vibration preference if OS-specific
- Last registered push token (also mirrored to hub — see below)

### `DevicePushToken` (Phase 5)

Hub-visible (or personal-drive + replicated) registry entry per install:

| Property | Purpose |
| --- | --- |
| `agent` | Owner agent DID |
| `platform` | `ios` \| `android` \| `web` \| `desktop` |
| `token` | APNs device token (hex) or FCM registration token |
| `appId` | Bundle / package id (APNs topic / FCM sender scoping) |
| `updatedAt` | Token refresh time |

Tokens rotate; re-register on every launch. Hub uses this list for wake fan-out.

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

- **In-app entry (decided):** sidebar **App** menu, directly **below User
  Settings** (`AppMenu` in `browser/data-browser/src/components/SideBar/AppMenu.tsx`).
  Order becomes: User Settings → **Notifications** → Settings → Sync → About.
  Row shows an unread count badge (query of personal-drive `NotificationItem`
  where `read != true`). Click opens the notification center route (not a
  popover-only UI — full page/panel so mark-read / filters have room).
- **Prefs** stay under App Settings → Notifications section (channels, DND,
  watches list) — the sidebar row is the inbox, not the preference form.
- **Toast** when the subject isn't already visible (reuse
  `MeetingMessageToaster` pattern: skip own actions).
- **Desktop / browser OS:** when document hidden or Tauri window unfocused,
  fire OS notification via Notification API / `tauri-plugin-notification`.
- Click on an item / OS banner → navigate to `about` (doc deep-link / chat
  message scroll).

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

Two places (don't conflate):

1. **Sidebar → Notifications** (below User Settings) — the **center / inbox**:
   list of `NotificationItem`s, mark read / dismiss, jump to `about`. Route
   e.g. `/app/notifications` (`paths.notifications`).
2. **App Settings → Notifications** section (searchable `SettingsGroup`) —
   **preferences**: mentions on/off + channels, watches list (mute/kind/
   channels), quiet hours / DND, OS/push permission status, (later) devices.

Per-resource toggle also on Table / Collection toolbars (writes the same
`WatchSubscription`).

## Delivery channels

| Channel | When | Implementation |
| --- | --- | --- |
| In-app center | Always when app running | React store of `NotificationItem`s + bell in chrome |
| In-app toast | App focused, subject not visible | Extend toast patterns; respect prefs |
| Local OS notification | App process alive, window/tab unfocused | Web `Notification` API (browser); `tauri-plugin-notification` (Tauri desktop **and** mobile foreground/background-capable local schedule) |
| Remote push (APNs / FCM / web-push) | Process suspended or killed | Required on iOS/Android for anything after the OS freezes the app; wake → sync → materialize |

Local OS ≠ remote push. Confusing them is the main mobile footgun — see next
section.

**Permission UX:** first mention or first watch enable prompts for notification
permission; never on cold start. On Android 13+ this is `POST_NOTIFICATIONS`;
on iOS it is the usual alert/badge/sound prompt (separate from Push capability
entitlement, which is a build-time Xcode setting).

## Native notifications on iOS and Android

Tauri already ships Android/iOS targets (`desktop/`, barcode scanner plugin,
`#[cfg_attr(mobile, tauri::mobile_entry_point)]`). Notifications need two
plugins and two OS concepts:

```text
                    app foreground          app background         app killed
Browser             in-app / toast          Notification API       web-push (later)
Tauri desktop       in-app / toast          tauri-plugin-notification  (process usually alive; tray)
Tauri iOS/Android   in-app / toast          local notif *if* OS    **remote push only**
                                            still schedules us     (APNs / FCM)
```

### Why push is mandatory on mobile

[`virtual-drive.md`](./virtual-drive.md) already records it: WebSockets do not
survive suspension. The embedded node in the Tauri webview is frozen or dead
when the user switches away. Local notifications (`tauri-plugin-notification`)
can show a banner **only while our process can run code** (or for alarms we
pre-scheduled — useless for unpredictable mentions). For "someone mentioned
you while the phone was in your pocket," the hub must send **APNs (iOS)** or
**FCM (Android)**.

Desktop Tauri can defer push longer: the process + tray often stay resident, so
local notifications + live WS cover the common case. Mobile cannot.

### Two Tauri plugins (do not conflate)

| Plugin | Role | Platforms |
| --- | --- | --- |
| [`tauri-plugin-notification`](https://v2.tauri.app/plugin/notification/) | **Local** notifications: permission, show banner/badge from JS when app code is running | Desktop + iOS + Android |
| Push plugin (community; evaluate at implement time — e.g. `tauri-plugin-push-notifications` / `tauri-plugin-mobile-push`) | **Remote** token registration + receive APNs/FCM; tap / cold-start events | iOS + Android only (desktop stubs/rejects) |

Wire both into `desktop/src/lib.rs` behind `#[cfg(mobile)]` for push; keep
local notification on all targets.

### Platform setup (implementor's checklist)

**iOS**

- Xcode capability: **Push Notifications** (`aps-environment` entitlement).
- Capability: **Background Modes → Remote notifications** (silent/wake delivery).
- Apple Developer: APNs key (`.p8`) or certificate on the hub that sends pushes.
- Permission: `requestPermission` for alert/badge/sound (user-facing); entitlement
  alone does not prompt.
- Minimum deployment target per chosen push plugin (often iOS 15+).
- Tap payload → existing `atomic://` / `?subject=` deep link path (same as
  pairing deep links in `desktop/src/lib.rs`).

**Android**

- Firebase project + `google-services.json` + Google Services Gradle plugin.
- `POST_NOTIFICATIONS` runtime permission on API 33+ (plugin may merge the
  manifest permission; JS still must request).
- FCM service in the merged manifest (push plugin responsibility).
- Tap → same deep-link routing as iOS.
- Do **not** rely on a permanent foreground-service notification for sync
  ([`virtual-drive.md`](./virtual-drive.md) / [`android-data-reuse.md`](./android-data-reuse.md)
  already flag that as user-hostile); use FCM wake + short sync work, then stop.

### Push payload contract (hint-to-sync)

Matches [`social-apps.md`](./social-apps.md) P2.3 — push carries **no trusted
body**:

```json
{
  "type": "atomic.notify",
  "notificationItem": "did:ad:…",
  "about": "did:ad:…",
  "notificationType": "mention"
}
```

Client on receive (background or cold start):

1. Bring up store / reconnect sync (WS or Iroh).
2. Fetch/materialize `NotificationItem` (or discover via reverse query if the
   item was created on another device first — see below).
3. **If `read` or `dismissed` is already true → do not show a banner; clear
   badge.** This is why synced read status matters for native UX.
4. Else show local notification (or let the OS show the remote one if we used
   an alert push) and open `about` on tap.

Prefer **data / silent-ish wake** where the platform allows, then render locally
after sync — so a read-on-laptop wins the race before the phone paints a
stale banner. Where iOS requires a visible alert to guarantee delivery, keep
title/body generic ("New mention in Atomic") and collapse/cancel once sync
confirms read state.

### Cross-device + badge

- Unread count = query `NotificationItem` where `read != true` on personal drive
  (same on every client after sync).
- Mark read → commit → other devices update bell; mobile cancels delivered
  notifications with matching id and sets badge to the new unread count.
- Each local/remote notification id should equal or derive from the
  `NotificationItem` subject so cancellation is deterministic.

### Who creates the `NotificationItem` under push?

Two acceptable orders (pick one in Phase 5; both need idempotent upsert):

1. **Hub creates nothing.** Push is pure wake with `about` + type; each device
   runs `NotificationEngine.reconcile` and upserts the same dedup key. First
   device to sync "wins" writing the item; others merge via Loro / see existing.
2. **Recipient's always-on replica (hub hosting their personal drive) materializes
   the item server-side** when it applies the mention commit, then pushes the
   item subject. Heavier hub logic; nicer single writer.

Recommendation: **(1)** for v1 of push — keeps the server dumb, reuses the
client engine, matches local-first. Hub only needs: match commit against
registered watches/mentions → look up `DevicePushToken`s → send wake.

### Flutter canvas

Out of Tauri. When Flutter needs the same product notifications, use
`firebase_messaging` + `flutter_local_notifications` against the **same**
ontology and push payload contract — do not invent a second registry format.
v1 remains data-browser + Tauri.

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

Server stays dumb through Phase 4: no notification fan-out. Phase 5 hooks
`commit_monitor` only as a wake signal to `DevicePushToken`s for matching
mentions/watches — still no trusted body in the push (see payload contract).

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
- [x] Sync `read` / `dismissed` on personal-drive `NotificationItem`s
- [x] iOS/Android: local plugin vs APNs/FCM push split recorded
- [x] UI entry: sidebar App menu below User Settings → `/app/notifications`
- [ ] Product sign-off on: actor-side `mentions` property, client-side watch
      matching, push payload = wake-only

### Phase 1 — Ontology + mention authoring

- [x] Add `mentions`, `NotificationItem`, `WatchSubscription`,
      `NotificationPreferences` to defaults
- [x] TipTap: agent-prioritized `@`; write `mentions` on save (docs + chat)
- [x] Unit tests: extract mentions from fixture docs
- [ ] Reverse-query integration test (mentions ∋ agent)

### Phase 2 — In-app engine + center (browser)

- [x] `NotificationEngine` materializes mention items from `ResourceUpdated`
- [x] Sidebar `AppMenu` item below User Settings + unread badge
- [x] `/app/notifications` center; `markRead` / `dismiss` commit to personal drive
- [ ] Multi-device: mark read on A → unread clears on B after sync (e2e or unit+)
- [x] App Settings → Notifications section (pointer to inbox / watch)
- [ ] E2E: A mentions B in a shared doc → B sees unread item (two contexts /
      `getDevDriveSecret` pattern)

### Phase 3 — Watch subscriptions

- [x] Toggle on Table → `WatchSubscription`
- [x] Engine: membership + coalesced content events
- [x] Settings list + mute/remove UI (per-channel picker still deferred)
- [x] E2E: watch table → other agent adds row → notification
- [x] Watch toggle on Collection views

### Phase 4 — Local OS notifications (browser + Tauri desktop/mobile)

- [x] Notification API when tab hidden (browser)
- [x] `tauri-plugin-notification` on desktop + mobile targets
- [x] Click → deep link to `about`; notification id = item subject
- [x] Permission request UX tied to first enable (Watch / Settings; not cold start)
- [x] On `read` / dismiss: cancel local notifications
- [x] Focused window → in-app toast instead of OS banner

### Phase 5 — Remote push wake (iOS APNs + Android FCM + optional web-push)

- [ ] Choose/integrate Tauri push plugin; iOS entitlements + Android Firebase
- [x] `DevicePushToken` ontology + register/refresh helper (client; call on launch when token exists)
- [x] Hub: wake payload + mention-match helpers (`server/src/push_wake.rs`); commit_monitor hook point documented — provider fan-out still TODO
- [x] Client: suppress-if-read helper + cold-start tap queue (`pushWakeTap.ts`)
- [ ] Client: on push → sync → materialize → suppress if already read (needs plugin)
- [ ] Cold-start tap wired from plugin launch details
- Track operational secrets (APNs `.p8`, FCM service account) with hub deploy;
  product behavior stays aligned with social-apps P2.3.

## Test plan (where tests belong)

Per [`TESTING_COVERAGE.md`](../TESTING_COVERAGE.md) preference for cheaper layers:

| Concern | Layer |
| --- | --- |
| Mention extraction from TipTap/markdown | unit (`@tomic/lib` or data-browser helper) |
| Reverse query `mentions ∋ agent` | lib / WASM query test (multi-filter) |
| Engine idempotency + coalesce | unit with mock store events |
| Watch membership vs table filter | unit reusing Collection match helpers |
| A mentions B / watch fires | e2e (two pages, shared drive) |
| Mark read on A clears B | e2e or sync integration (two agents/devices, personal drive) |
| Local OS notification | manual / desktop smoke |
| Push wake + suppress-if-read | mobile manual + hub unit for token fan-out |

## Open questions

1. ~~**Where do `NotificationItem`s live / sync read?**~~ **Decided:** personal
   drive; `read` / `dismissed` sync.
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
6. **Flutter canvas.** Same ontology + push payload; native stack is
   firebase_messaging, not Tauri plugins. v1 is data-browser + Tauri.
7. **Which Tauri push plugin?** Community options exist (`tauri-plugin-push-notifications`,
   `tauri-plugin-mobile-push`, …); pick at Phase 5 by cold-start tap reliability
   and maintenance. Not blocking Phases 1–4.
8. **Alert push vs silent wake on iOS.** Silent pushes are best-effort and
   throttled; may need visible APNs with generic copy + client cancel-on-read.
   Validate on device before locking.

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
- **Sidebar entry:** `components/SideBar/AppMenu.tsx` (insert below User
  Settings); path in `routes/paths.tsx`; new center route beside
  `SettingsAgent.tsx` / `AppSettings.tsx`
- Prefs chrome: `routes/AppSettings.tsx`, `components/Settings/`
- Toast precedent: `MeetingMessageToaster.tsx`
- Desktop: `desktop/Cargo.toml`, `desktop/src/lib.rs` (plugin init)
