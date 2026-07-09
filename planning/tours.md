# Tours: replayable meetings and custom onboarding (design)

> **Status:** design, not built (July 2026). Grew out of
> `planning/demo-experience.md` (the scripted demo proved the
> primitives) and `planning/meetings.md` (meetings made follow-mode
> addressable — and, it turns out, recordable).
>
> One sentence: **a meeting you can join after it ended.** The owner of
> a workspace — or the author of a template — records a tour once by
> walking through it alone in a meeting; every future member replays
> it, led by the recorder's ghost, against live data, with zero writes.

## The problem

The demo experience is one hardcoded flow that sells *the app*. But
onboarding needs exist one level up:

1. **Template authors.** Someone builds an Atomic CRM template and
   wants to show adopters the ropes — "this is where you log calls,
   this is the pipeline board."
2. **Production drives.** A team's real workspace, real data; a new
   member joins and someone has to show them around. Today that's a
   live meeting (works, but the guide must be present) or nothing.

Both are "the demo, but for *your* workspace" — and neither can reuse
the demo as-is, because `DemoDirector` is a hand-written screenplay
coupled to one specific template.

## The key insight: the recording already exists

Two facts, both already shipped, make this design nearly free:

1. **A meeting leader records their own tour without knowing it.**
   `FollowContext` posts a "Viewing […](…)" `followEvent` trail entry
   into the meeting for every new resource the leader visits — **with
   zero followers required** (`FollowContext.tsx`, the trail effect).
   Someone who starts a meeting alone and walks around narrating in
   chat produces a complete, timestamped, author-signed recording on
   the server: navigation as trail entries, narration as messages,
   pacing in `createdAt`.
2. **The demo director's vocabulary decomposes into "camera + speech"
   vs "mutations".** The camera/speech half (presence movement,
   narration, trail) is exactly what a meeting log stores. The
   mutation half (typing, card drags) is what must *not* replay on
   production data (see below).

Consequence: **the meeting log IS the tour format.** No `TourStep`
ontology, no scenario DSL, no meeting→tour transpiler. Authoring a
tour = leading a meeting; editing a tour = editing its chat messages
(they're ordinary resources). What's missing is only a **player, not a
director**.

## Two use cases, one player

- **Production drive onboarding** — replay in place. The viewer's own
  read rights gate every stop, so tours self-censor (the intern
  replaying the admin's tour simply skips stops they can't see).
  Live data is a *feature*: the tour shows today's pipeline, not a
  screenshot from when it was recorded.
- **Template demos** — the recorded meeting ships inside the
  template's JSON-AD like any other resource. A prospect hits
  `/app/demo?template=…`, gets a fresh local-only instance (all of
  `startDemo.ts` reused: guest agent, aggressive cleanup, local-only
  drive), and the tour plays. The simulated-activity director stays a
  separate, optional theatrical layer for full demos; "show people the
  ropes of my custom CRM" needs only the player.

## The player

A cursor over the meeting's messages sorted by `createdAt`:

- `followEvent` trail entry → navigate the viewer there (reuse
  FollowContext's camera logic, don't duplicate it).
- Regular message → reveal it in the narration panel.
- **Ghost leader**: inject a presence entry for the recorder's real
  agent — real name, real avatar in the facepile, the viewer
  "follows" them through the normal follow path. Requires the one lib
  change in this design: a **local-only flag on
  `DrivePresenceManager.injectEntry`**, excluded from outbound
  ephemeral sync. On a production drive the phantom must never relay
  to the recorder's actual colleagues.
- **Pacing**: replay at recorded pace, but compress dead air — cap
  inter-message gaps at a few seconds (the recorder's thinking pauses
  aren't content), like podcast smart-speed.
- **Resilience**, both patterns pioneered by the demo's
  `getBeatResource`: stop deleted/moved → skip with a small note;
  stop unreadable (403 for this viewer) → skip silently.

### Transport controls are trivially safe

Because replay is presentation-only — no beat *produces* anything —
every control costs nothing: **skip / back / pause / scrub / 2×**.
"Next" = advance the cursor to the next `followEvent`, navigate,
instantly reveal chat up to that point (like scrubbing video). There
is no state to desync. Contrast the demo director, where beats mutate
state and depend on each other, so skipping is structurally hard.

Free affordance: the meeting log doubles as a **table of contents** —
each "Viewing [Deals]" entry is a clickable jump-to-stop.

Navigation hijacking rule (same problem live follow solved): manual
navigation mid-tour **pauses** it and shows a "Resume tour" pill.

## What deliberately does NOT replay: edits

During recording, the author's edits were real commits — the sentence
they typed is *still in the doc*, the card they dragged is *still in
Done*. Re-performing them at replay would either duplicate them or
mutate the viewer's real workspace as theater. So the v1 action set is
**look-don't-touch**: camera + narration only.

This loses less than it seems. Live typing sells "the product is
alive" to a skeptic (the demo's job); onboarding's job is "this is
where you do x and y", which pointing + talking covers. And the
workspace remembers the performance anyway: the tour navigates to the
doc and the recorder's edit is sitting right there, attributed in
history.

If tours feel too static later, two escalation paths, in order:

1. **Sandbox stops** (cheap 80%): a designated scratch doc
   ("Playground — try it here") where the player may safely re-type
   via `SimulatedTypist` into a per-viewer local-only copy — or better,
   the viewer is invited to try it themselves (the demo's "say hi"
   beat proved ask-them-to-do-it lands harder than watch-me).
2. **Shadow replay from history** (ambitious endgame): the CRDT layer
   is already a *second tape* — every recording-window edit is a
   signed, timestamped commit (doc typing in Loro history, card drags
   as status-property commits, canvas strokes as `strokeData`
   commits). A v2 player could check out the doc at window-start
   read-only and animate the historical edits forward as an ephemeral
   overlay, never writing. Real cost: a rendering project per view
   type. The data model guarantees the tape is there whenever we
   choose to build the projector.

## Recording UX

Recording works today (solo meeting). Deltas:

- **Mark as tour**: a flag on the meeting (`isTour`) or a `tours`
  list on the drive — decide (drive list is more discoverable, flag is
  simpler; leaning flag + the Meetings folder as the library).
- **Trail dedupe**: the trail logs each resource once per meeting
  (`trailedRef`), so an intentional revisit doesn't record. Fine for
  v1; a record mode can lift the dedupe later.
- **Editing the tape**: chat messages are editable resources — fix a
  narration line by editing the message. No editor to build.
- **Interactive gates (v2)**: a special message type ("Try creating a
  contact — I'll wait") the player treats as a wait-for-user-action
  gate; Next reads as "skip this exercise", never hangs.

## Impact

**Server: zero changes.** Replay reads existing resources; recording
uses shipped paths.

| Piece | File | Change |
| --- | --- | --- |
| Local-only presence entries | `lib/src/presence.ts` | flag on `injectEntry`: render locally, never broadcast |
| Ontology | `browser/lib` dataBrowser ontology (+ `lib/defaults/chatroom.json`) | `isTour` on Meeting (or drive `tours`) |
| Player | `data-browser/src/chunks/Tour/` (new, lazy) | cursor/scheduler, transport HUD, ghost entry; ~⅓ of `DemoDirector`'s complexity (no mutations, no echo guards, no `selfSaving`) |
| Recording affordance | `components/Presence/FollowContext.tsx` | mark-as-tour; expose camera logic for the player to reuse |
| Entry point | `components/Presence/MeetingBanner.tsx` | fourth state: ended-but-replayable meeting → "▶ Take the tour" |
| Narration reveal | `views/ChatRoom/ChatRoomView.tsx` *or* player overlay | v1: player-owned overlay (zero risk to real chat; full log one click away). Alternative: teach ChatRoomView a render-up-to-timestamp prop |
| Template demos | `chunks/Demo/startDemo.ts` | parameterize by (template, tour); machinery reused as-is |

Untouched (through phase 3): the entire Demo chunk — the player lands
parallel to it, and only the later demo refactor (see "Cleaning up the
demo") re-homes its tour half. Always untouched: commits, outbox,
sync, editors. i18n boundary is clean: player chrome
is app copy (Wuchale); recorded narration is user content, never
translated.

Testing: fully e2e-testable on a local drive with no simulation
infrastructure — record a two-stop meeting in the test, press play,
assert navigation and reveal. Far more deterministic than the demo's
timing-driven scenario.

## Cleaning up the demo (later phase)

The demo splits along the same line as this whole design —
camera/speech vs mutations — so once the player exists, roughly half
of the ~980-line `DemoDirector` migrates onto it:

**Player absorbs** (Mara's tour is pure camera + narration):

- Meeting lifecycle (`startTourMeeting`/`endTourMeeting`): the tour
  meeting ships *pre-recorded in the template* instead of being
  created live — which also deletes the awkward user-signed-genesis
  + `selfSaving` dance mid-scenario.
- `narrate`/`postTrail` + compose pacing: narration becomes revealed
  messages, not live-created resources — so it can no longer echo
  into the reactive `ResourceSaved` triggers either.
- `announceMara` + her heartbeat/session pointer → ghost-leader
  machinery.
- `waitForJoin` polling → player join gating; `waitForUserChat` → an
  interactive gate in the tape.
- The linear `run()` narration beats become **data**: editable as
  chat messages in the app, not TS string literals — reopening the
  localization door (`@wc-ignore-file` scenario copy could become
  per-locale template content).

**Director keeps** the theatrical mutations, legitimate on the
local-only demo drive but inexpressible in a recorded log:
`SimulatedTypist`, Yusuf's strokes/wander, card drags, Pip's chat,
`ensureTeamRow`, the `completeSayHi` payoff.

**Resulting architecture**: the player is the timeline authority; the
director degrades into a *cue-driven effects layer* — it subscribes to
player events ("arrived at stop", "gate passed", per-message reveal)
and fires mutation beats on cue, replacing one interleaved mega-script
of hand-tuned `sleep()`s. The tape is the script; the director becomes
the stagehands.

Caveats: the cue system is new (small) machinery, and
narration-interleaved mutations ("watch — I'll drag this card" → the
drag) need per-message cue granularity. The demo works and is verified
today, so this is a refactor, not a rescue — schedule it after the
player ships, where it doubles as the player's best dogfood.

## Phasing

1. **Player + production tours**: local-only `injectEntry` flag,
   `isTour`, `chunks/Tour/` player (navigate + overlay + transport),
   MeetingBanner entry point, skip-if-missing/403, pause-on-manual-nav.
2. **Template tours**: recorded meeting in template JSON-AD;
   `/app/demo?template=…` runs template + tour on a fresh local-only
   drive (demo machinery parameterized).
3. **Recording polish**: record mode (dedupe lift), invite-attached
   tours ("take the tour" on first join), interactive gates.
4. **Demo refactor**: re-home the demo's tour half onto the player
   (see "Cleaning up the demo"); director becomes cue-driven effects.
5. **Maybe never**: sandbox stops, shadow replay from history.

## Open questions

- `isTour` flag vs drive-level `tours` list (discoverability vs
  simplicity)?
- Where does "Take the tour" surface besides the banner — attached to
  the invite, drive home, both?
- Gap compression default (cap at ~4s?) and whether recorded pace is
  ever wanted verbatim.
- Several tours per drive: does the banner/library need ordering
  ("start here")?
- Should replay progress persist (resume a half-watched tour)?

## Relationship to existing planning

- `planning/meetings.md` — the substrate: meetings made the trail +
  narration addressable and persistent; this design makes that log
  replayable. Its "minutes for free" property is literally the tape.
- `planning/demo-experience.md` — proved the primitives (presence
  injection, typist, skip-if-deleted, visibility pause) and remains
  the theatrical layer for full app demos; the known-gap note there
  about local-only shares applies to template tours too.
- `planning/presence-views.md` — viewport sync ("follow the leader's
  zoom/scroll") would upgrade replay fidelity; still out of scope.
