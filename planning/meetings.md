# Meetings: follow-mode with a front door

> **Status:** v1 built and verified live (July 2026). A meeting is a
> ChatRoom+Meeting listed in the drive's `currentMeetings`; while its
> leader's presence entry announces it (`session`), a vibrant Join
> banner shows in the top bar. Join = follow the leader + open the
> meeting chat. Verified: banner appears on start, Join follows +
> opens chat + flips to Chat/Leave, narration and "Viewing …" trail
> land in the meeting room (leader-attributed), End clears the banner.
>
> **Built:**
>
> - Ontology: `Meeting` class + `currentMeetings` drive property in
>   `lib/defaults/chatroom.json` and the browser `dataBrowser` ontology.
> - `FollowContext`: `activeMeeting` + `startMeeting`/`endMeeting`;
>   while leading, presence `session` points at the meeting and the
>   session trail posts there.
> - `MeetingBanner` (top bar, in `NavBar`): Join / Chat+Leave /
>   Chat+End states.
> - Start/End affordance in the drive switcher menu.
> - Demo v3: Mara starts an "Onboarding meeting" meeting; join-gated tour
>   with a fallback nudge; chat narration per stop; reactive payoff on
>   the user's first meeting-chat message; End at wind-down.
>
> **Refinements since v1 (all built + verified):**
>
> - Follow-sessions **removed entirely** — meetings replace them. Plain
>   follow is navigation-only; shared chat/trail lives in a meeting.
>   `ChatRoomView`'s FollowEvent renderer now shows markers verbatim
>   ("Started the meeting.", "The meeting has ended.").
> - The banner is one big button: Join when out, open-chat when in.
>   Leave/End moved into the chat panel header.
> - **Opening a live meeting resource = joining it** (follow + open
>   chat), so the welcome-doc link behaves like the Join button.
> - The chat panel **persists the last meeting** after it ends (log /
>   minutes), instead of clearing.
> - "Own" = I'm the leader (not merely same agent), so a second tab or
>   same-agent attendee can still join.
> - e2e: `browser/e2e/tests/meetings.spec.ts` (two-session start → join
>   → follow-along → end); `presence-follow.spec.ts` trimmed to
>   navigation-only follow. Both green.
>
> **Follow-ups / not yet done:**
>
> - Server ontology ships in `chatroom.json`; a pre-existing server
>   needs a re-`populate`/migration to know `Meeting`/`currentMeetings`
>   (fresh init picks it up — verified via the e2e server).
> - Stale-meeting reaping: leader presence expiring without End leaves
>   a stale `currentMeetings` entry (banner hides — no live `session` —
>   but the list entry lingers). Wants a janitor / TTL.
> - Joining doesn't announce attendance ("X joined") in chat.
> - `MeetingBanner` shows only the most-recent live meeting when several
>   run at once in one drive.
>
> Original design sketch follows.

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
