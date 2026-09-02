# Meetings: follow-mode with a front door

> **Status:** built and verified in July 2026. A Meeting is now one dedicated
> resource with a rich-text Agenda/Notes/Minutes body and child chat messages.
> It is neither a DocumentV2 nor a ChatRoom. The clean cutover deliberately has
> no migration or backwards-compatibility path.
>
> Focused browser integration covers prepared agenda → start → minutes and the
> two-session More → Start → join → follow trail → end → reopen flow.
>
> **Open follow-ups:** stale-meeting reaping when a leader disappears without
> ending; attendance events; and choosing among several simultaneous live
> meetings in the banner.

## Agenda, notes, and minutes build plan

### Decided model

```text
Meeting (isA: Meeting only)
├── name
├── documentContent       Agenda → Notes → Minutes
├── meetingStartedAt      absent while preparing
├── meetingEndedAt        absent until ended
├── meetingLeader         persisted agent reference
└── Message children      chat and FollowEvent trail
```

- Meeting has a dedicated page and visual identity. It reuses the rich-text
  editor and chat view as components, but is neither `DocumentV2` nor
  `ChatRoom`.
- `currentMeetings` remains the drive's live index. Persisted timestamps
  distinguish preparing, live, and ended Meetings after presence expires.
- **New meeting** creates an editable Agenda without going live. **Start
  meeting** activates that resource. Global Start remains a quick-create/start.
- Meeting chat can be explicitly opened by subject before, during, or after a
  meeting; it is not inferred only from follow state.
- Existing multi-class Meeting resources are unsupported. Demo/test data is
  recreated; no migrations, fallbacks, aliases, or dual rendering.

### Checklist

- [x] Move Meeting ontology definitions into `lib/defaults/meeting.json`; add
  lifecycle properties and update generated TypeScript mappings.
- [x] Split Meeting creation from activation; make Start/End persisted and
  idempotent; create Meeting resources with only the Meeting class.
- [x] Introduce explicit `selectedMeeting` / `openMeetingPanel(subject)` state
  and use it from Start, Join, Meeting pages, toasts, and ended chat history.
- [x] Add a dedicated Meeting page with title, lifecycle status,
  Agenda/Notes/Minutes editor, Start/End, and Open chat; participants remain in
  the linked meeting panel.
- [x] Generalize document-content readers/editors/AI paths through one
  capability helper supporting DocumentV2 and Meeting.
- [x] Add New meeting and quick-start surfaces; make the Meeting itself the
  deterministic first Focus when quick-started.
- [x] Update the demo and remove all Meeting+ChatRoom creation paths and
  assumptions.
- [x] Extend focused tests through prepare → start → join → collaborative notes
  → end → reopen minutes/chat; run browser typecheck/lint/unit/E2E checks.

### Acceptance

- [x] New Meetings have only the Meeting class and one rich-text body.
- [x] Prepared agendas are editable without becoming live.
- [x] Start preserves the agenda, opens chat, and focuses the Meeting first.
- [x] Live notes and child chat messages synchronize independently.
- [x] Ended Meetings retain minutes, chat, and trail and can reopen either.
- [x] Meeting UI is distinct from generic DocumentV2 and ChatRoom pages.
- [x] No backwards-compatibility code is introduced.

Original design sketch follows and is superseded where it calls Meeting a
ChatRoom.

---

> Grew out of the demo workspace: "follow Mara for a tour" is the demo's
> hero moment, but the follow feature has no _front door_ — you must
> know to click an avatar and pick Follow from a menu. A meeting is
> follow-mode made discoverable, joinable, and social.

## The idea (Joep)

- Mara (or any agent) **starts a meeting**. A meeting is just a
  ChatRoom, stored under a Meetings folder — nothing exotic.
- The special part is the **relationship from the drive**:
  `drive => currentMeetings => [Meeting]`. A live meeting is drive
  state, not buried presence state.
- **If a drive has a current meeting, it shows in the top bar**: a
  vibrant, unmissable button — "Mara is giving a tour · Join". One
  click = follow the meeting leader + open the meeting chat panel.
- In the demo: Mara starts the meeting; when the guest joins, the
  follow chat opens, Mara shows places and features, the user is asked
  to type something in the chat, and team members are visibly making
  changes on each page she visits.

## Why this is better than bare follow-mode

1. **Discoverability.** Presence avatars are subtle; a top-bar banner
   is an invitation. The current demo asks users to find a menu item —
   observed friction.
2. **A meeting is addressable.** It's a resource: it has a name
   ("Launch prep", "Onboarding meeting"), a chat log that persists after
   the meeting ends (minutes for free), and can be linked/referenced
   like anything else.
3. **Asymmetric join is explicit.** Follow-mode is peer-to-peer and
   symmetric-ish; a meeting has a _leader_ (whoever's presence entry
   carries `session = meeting`) and _attendees_ (everyone following
   into it). Roles clarify UX: the leader gets "End meeting", the
   attendee gets "Leave".
4. **The demo becomes a story with a door.** "Join the tour" is a
   much stronger beat than "hit Follow on my avatar (top right)".

## Data model (minimal delta from what exists)

Today's follow sessions already have 90% of this:

- `PresenceEntry.session` points at a ChatRoom; followers open it in
  the FollowSessionPanel.
- `drive.followSessionsChatroom` is a drive-level singleton chatroom
  created on demand (`getOrCreateFollowSessionsChatroom`).

Proposed:

- **Class**: `Meeting` = subclass-in-spirit of ChatRoom (or just a
  ChatRoom with an extra class, like `followEvent` messages do).
  Recommended props: `name`, `leader` (agent subject), maybe
  `startedAt`/`endedAt`.
- **Drive prop**: `currentMeetings: ResourceArray<Meeting>` on the
  Drive. Starting a meeting pushes it; ending removes it (the chatroom
  itself stays, filed under a Meetings folder → minutes).
- **Presence**: the leader's entry sets `session = meeting` (exactly
  as follow sessions do today) so attendees' follow machinery needs
  zero changes.
- **Join** = `follow(leader)` + `togglePanel('followSession')` — both
  exist.

So the new surface area is: one class + one drive prop + the top-bar
banner + start/end affordances. The trail/chat/follow mechanics are
already shipped.

## UX sketch

- **Top bar**: when `drive.currentMeetings` is non-empty and the
  leader's presence is live, render a pill next to the breadcrumbs:
  `● Tour with Mara — Join`. Vibrant (theme main color, subtle pulse).
  Clicking joins (follow + open chat). While joined it flips to
  `Leave · 🔴 following Mara`.
- **Stale meetings**: leader presence gone (TTL) → banner hides; the
  meeting can be auto-ended (remove from `currentMeetings`) by the
  next client that notices, or left for the leader's return — decide.
- **Starting**: "Start meeting" in the presence/avatar menu or the
  drive's context menu → creates the Meeting chatroom (under
  /Meetings), pushes to `currentMeetings`, sets own presence
  `session`, announces `allowFollow`.

## Demo v3 restructured around the meeting

1. User lands; Mara + Yusuf present. Mara types the welcome doc.
2. Mara **starts "Onboarding meeting"** → the top-bar banner appears
   (the scripted director just sets drive.currentMeetings + her
   presence `session`; the banner is real UI).
3. Beat waits for the user to click **Join** (with a fallback nudge in
   the doc after ~20s: "there's a Join button up top 👆").
4. Tour plays as today (board → team chat → moodboard), but now the
   meeting chat is open alongside: Mara narrates each stop in chat
   ("this is the launch board — Pip just claimed a card"), and the
   trail events land in the same room.
5. Mara asks the user to **type something in the chat**; the reactive
   trigger becomes "first chat message from the user" (cleaner than
   "any save" — no echo-suppression heuristics).
6. Wind-down: Mara ends the meeting; banner disappears; the meeting
   chatroom remains in /Meetings as a souvenir with the whole story.

## Open questions

- One `currentMeeting` or plural `currentMeetings`? Plural models
  parallel rooms but complicates the banner (which one to show?).
  Suggest: plural in data, banner shows the most recent live one.
- Should joining announce attendance in chat ("You joined") — probably
  yes, via the existing followEvent message class.
- Does a meeting need rights of its own (private meetings in a shared
  drive)? v1: inherits drive rights.
- Viewport sync (see planning/presence-views.md "Later"): meetings
  make "follow the leader's zoom/scroll" more valuable, still out of
  scope.

## Relationship to existing planning

- `planning/presence-views.md` — canvas/table presence payloads the
  tour benefits from.
- `planning/demo-experience.md` — the demo is the first consumer and
  the forcing function; demo v3 should build on the real meeting
  feature, not simulate one.
