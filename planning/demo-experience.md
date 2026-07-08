# Demo experience: a living workspace for new users (plan)

> **Status:** v1 built and verified live (July 2026). Entry points:
> "Try the live demo" on the logged-out welcome screen (mints a
> throwaway guest agent — no sign-up needed) and the post-onboarding
> choice at `/app/demo`. Lib: local-only drive mode + presence
> injection (`registerLocalOnlyDrive`, `DrivePresenceManager.injectEntry`).
> App: `chunks/Demo/` (workspace creation, director, typist),
> `routes/DemoRoute.tsx`. See "v2 content feedback" below for the next
> iteration.
>
> Original pitch: a fully client-side demo — a template-populated
> drive where scripted teammates join, edit, comment, and share —
> presence, follow-mode, activity — while the user is a full member of
> the team and free to edit anything. No server involvement, no mock
> layer: real resources flowing through the production code paths.

## Why this is cheap here

Three existing properties make "entirely client-side" natural:

1. **Resources don't need a server to exist.** `did:ad:` subjects are
   minted in the browser: `newResource` signs the genesis commit
   locally and the signature *is* the subject
   (`lib/src/store.ts:1755`, `lib/src/genesis.ts`). A demo drive and
   all its contents get fully valid, permanent subjects offline.
2. **The remote-change ingestion path is public and source-agnostic.**
   Everything the websocket delivers converges on
   `store.applyIncoming()` (`lib/src/store.ts:1513`); `source` is just
   a tag. A director calling `applyIncoming` produces UI updates
   byte-identically to real collaboration traffic — same notify, same
   OPFS persistence, same protection of unsaved local edits.
   `parseAndApplyCommit` / `applyCommitToResource`
   (`lib/src/commit.ts:472`, `:454`) are exported and accept commits
   authored by other agents.
3. **Presence is a local Loro `EphemeralStore` the server merely
   relays.** The snapshot is computed from whatever keys are in the
   store (`lib/src/presence.ts:242`); any key that isn't our
   `sessionId` renders as a remote user. Fake sessions give us joins,
   leaves (delete key / 30s TTL), canvas cursors, table cell rings —
   and because `PresenceEntry` carries `following` / `allowFollow` /
   `resource`, **follow-mode works on fake personas for free**: keep
   updating a persona's `resource` and the existing FollowContext
   tours the user around the workspace.

The CRDT consequence of (2): the user editing *the same document* a
persona is "typing in" just works — Loro merges the director's deltas
with concurrent user edits. "You're part of the team" comes from the
data model, not choreography.

## Architecture

Three pieces, one enabling lib change.

### 1. Demo template (starter data)

Extend the existing `Template` system
(`data-browser/src/components/Template/template.ts`, cf. the
`website.tsx` example): a "demo workspace" template whose JSON-AD
`resources` array holds folders, documents (with base64 `lorodoc`
seeds), a table, a canvas, a few files — *and the persona agent
resources* (name + avatar as bundled asset/data URL). Personas only
look real if their agent subjects resolve: `AgentAvatar` does
`useResource(agentSubject)` for name/image, falling back to
`colorForAgent` initials.

Apply **client-side**, not via `store.importJsonAD` (that POSTs to the
server import endpoint, `store.ts:4281`): `JSONADParser`
(`lib/src/parse.ts:11`) already hydrates a JSON-AD array — including
`lorodoc` binaries — into `Resource`s; feed those to
`applyIncoming`/`addResource`.

Rights: the template puts the user's agent in the demo drive's write
hierarchy, or client-side rights checks make everything read-only.

### 2. Demo director (scripted activity)

A lazy-loaded module executing a declarative scenario timeline:

```
join(persona) · leave(persona) · viewResource(persona, subject)
moveCursor(persona, path)            — canvas world XY
selectCell(persona, row, column)     — table presence data
typeInDoc(persona, doc, text)        — real Loro deltas, persona peerId
createResource(persona, jsonad)     · comment(persona, onDoc, text)
```

Every step compiles to one of two primitives:

- **State** → `store.applyIncoming(...)`.
- **Awareness** → a write into the drive's presence `EphemeralStore`.

Decisions:

- **Live-generated, not a recorded tape.** Ed25519 signing is
  sub-millisecond; `signAt` stamps current-relative timestamps (a tape
  says "edited 3 weeks ago" forever); and the director checks a
  resource still exists before each step — user deleted the doc a
  persona was editing → skip gracefully, no ghost-typing.
- **Real attribution.** Document edits are Loro commits under
  per-persona peer IDs with proper author messages, so history
  (`getLoroHistory` per-edit semantics) truthfully shows "Sarah edited
  this".
- **Scripted arc, not a loop.** Busy the first ~2 minutes, then
  personas wrap up and leave one by one. A workspace that goes quiet
  naturally feels more real than one that's suspiciously perpetually
  busy, and it hands the stage to the user.

### 3. Presence injection seam

Today injection would go through `store.__handlePresenceMessage` with
hand-encoded Loro ephemeral bytes. Works, but couples demo code to the
wire encoding. Add a small explicit hook on `DrivePresenceManager`
(e.g. `injectEntry(sessionId, entry)` / `removeEntry(sessionId)`),
used by the director and by tests. Fake entries must be refreshed
inside the 30s `PRESENCE_TTL_MS` (the director owns heartbeats for
its personas).

### 4. Enabling lib change: local-only drives ← the real work

Without it, every demo edit marks subjects dirty in `LocalOutbox`,
drains POST to a server that has never heard of the drive, entries hit
`blocked` after 8 failures, and the network indicator shows sync
errors over a demo that must feel flawless.

A flag — on the drive resource or a store-level set of local-only
drive subjects — that, for the drive's subjects, suppresses:

- outbox enrollment (`markDirty` no-ops → no drains, no error UI),
- websocket subscribe / Loro sync / presence subscribe frames,
- server fetch fallback (`fetchResourceWithLocalFallback` must never
  hit the network for these; everything is in store/OPFS from the
  template).

Everything else (OPFS persistence, offline reads, optimistic edits)
already works for local resources.

**Exit ramp:** `sync-import` machinery (see
`lib/src/sync-import.test.ts`) suggests local→server drive import
exists or is close. "Keep this workspace" then promotes the demo
drive to a real synced drive, user edits included. Verify what's there
before designing the button.

## Scenario v1: "Your first day"

The frame answers the question every demo script must answer: *why is
a stranger allowed to edit this team's stuff?* — you're not a
stranger, you're the new teammate, and they knew you were coming.
The team's actual work is prepping a launch (recognizable, and the
artifacts are feature-dense: checklist table, announcement doc,
moodboard canvas). Meta humor appears exactly twice, as a wink — the
frame stays sincere.

### Cast

Three personas, each owning a surface so their behavior is legible at
a glance. Distinct rhythms matter more than names — one types in
bursts, one's cursor wanders, one appears/disappears. That is what
makes fake presence read as *people*.

| Persona | Archetype | Surface / behavior |
| --- | --- | --- |
| **Mara** | organizer | launch table + welcome doc; tour guide (`allowFollow: true` from the start) |
| **Yusuf** | designer | canvas; cursor always sketching; communicates in comments + emoji |
| **Pip** | engineer | terse doc edits, shares files; vehicle for the history/undo beat |

### Beats (~2.5 min + wind-down)

| Time | Beat | Sells |
| --- | --- | --- |
| 0:00 | Land: facepile shows Mara + Yusuf, sidebar dots on "Launch plan" | presence, inhabited drive |
| 0:05 | **Welcome** doc (open by default) is mid-sentence; Mara types "…and that's the tour. Oh — you're here! 👋" *(reactive: fires on the user's presence join)* | realtime editing; the doc reacts to *you* |
| 0:15 | Mara: "Follow me for 30 seconds, I'll show you where everything lives." | **follow-mode** — hero moment |
| 0:20–0:50 | Tour via follow: launch checklist table (Mara checks off rows, cell rings; Pip's ring on another cell) → moodboard canvas (Yusuf's cursor sketching, a shape appears) → back to Welcome | tables + cell presence, canvas + cursors, navigation |
| 0:55 | Pip joins (facepile grows), drops `launch-banner-v2.png` into Assets, comments on canvas: "v2 attached, less beige" | files, comments, join events |
| 1:10 | Mara adds a checklist row: **"Add yourself to the team page ← that's you"** — team-page doc has two profile cards and an empty third slot | the invitation to edit, explicit and tiny |
| 1:30 | *(reactive: user's first edit, anywhere)* Yusuf comments near it: "nice, it's alive 🎉"; Mara checks off the user's row | collaboration acknowledges you — emotional payoff |
| 1:45 | Pip pastes something wrong into the announcement doc, "oops", reverts it: "restored from history, love that" | **history/versioning** in 5 seconds, no tour |
| 2:00 | Meta wink #1, comment thread on Welcome — Yusuf: "wait, can they edit the welcome doc while we write it?" Mara: "they can edit everything. that's the whole point." | rights model + product philosophy as dialogue |
| 2:15 | Wind-down: Yusuf leaves; Pip: "calling it, launch is tomorrow 🚀", leaves; Mara's final line: "Workspace is yours. Everything here is editable, deletable, yours — poke around." Leaves. | graceful exit, hands over the stage |

Meta wink #2 is buried, not scripted: the last checklist row reads
**"Onboard the new teammate"** — already checked. Noticing it is
optional.

### Reactive triggers (exactly three)

The director already listens to the store; these cost almost nothing
and are the difference between a screensaver and being *seen*. Keep
the rest of the scenario on the fixed timeline so it stays testable.

1. **User joins** (own presence announced) → Mara's "Oh — you're
   here! 👋" line lands in the Welcome doc.
2. **First user edit** (`ResourceUpdated` with local source) →
   Yusuf's "it's alive 🎉" comment near the edited resource + Mara
   checks off the "add yourself" row.
3. **First user delete** → Mara: "bold. I liked that table."

### No-follow fallback

Every beat happens in the workspace whether the user watches or not —
following is just the camera. If ~15s after the offer the user hasn't
followed, Mara comments on whatever resource the *user* is viewing
(their presence entry says which) — the tour comes to them.

### Deliberately not in the script

Search, invites, AI chat: invites need a server, search and chat
don't demo well passively. A demo that sells five features well beats
one that gestures at nine. The final state of the Welcome doc lists
them under "what else is here" as reading material.

## Performance

Human-paced by design — less traffic than one real collaborator, on a
pipeline already tuned for it:

- Ops at conversation speed, a few/second at peak, through
  `applyIncoming → notify → useSyncExternalStore`.
- Typing batched per word/phrase, throttled ~80–150ms — matches real
  remote Loro traffic (canvas presence already throttles at 80ms).
- Pause the director on `visibilitychange`; resume on return so the
  user doesn't miss the show.
- Template stays small (a few dozen resources); OPFS writes are
  per-resource and incremental.
- Persona heartbeat: one tiny ephemeral write per persona per <30s.
- Director + template + scenario ship as one lazy chunk; onboarding
  pays nothing until the user opts in.

## Entry point

Simplest first version: a "Start with a demo team / Start empty"
choice at the end of `GettingStartedFlow`
(`data-browser/src/views/getting-started/GettingStartedFlow.tsx`),
which today drops users into an empty personal drive. Since personas
and the drive are all local, the demo could later run *before*
account creation from the welcome screen — out of scope for v1.

## Rejected alternative

Server-side demo bots (real agents making real commits): avoids the
local-only-drive work but breaks "works instantly, works offline,
user can trash everything", adds server load + bot auth machinery,
and loses the property that the demo ships entirely as static assets.

## Wiring (files)

| Piece | File | Role |
| --- | --- | --- |
| Local-only drive flag | `lib/src/store.ts`, `lib/src/local-outbox.ts` | suppress outbox / WS / server fetch for demo drive subjects |
| Presence inject hook | `lib/src/presence.ts` | `injectEntry` / `removeEntry` on `DrivePresenceManager` |
| Demo template | `data-browser/src/components/Template/templates/demoWorkspace.ts` | JSON-AD starter data + persona agents + lorodoc seeds |
| Client-side apply | `data-browser/src/components/Template/` | JSONADParser → `applyIncoming` path (no server import) |
| Director | `data-browser/src/demo/director.ts` | scenario runner: steps → applyIncoming / presence writes |
| Scenario | `data-browser/src/demo/scenario.ts` | declarative timeline, arc with wind-down |
| Entry point | `data-browser/src/views/getting-started/GettingStartedFlow.tsx` | "demo team vs empty" choice after identity creation |

## TODO

- [ ] Verify `sync-import` state: can a local drive be promoted to a
      server-synced drive today? (shapes the exit ramp)
- [ ] Lib: local-only drive flag (outbox no-op, no WS subscribe, no
      server fetch) + tests.
- [ ] Lib: `DrivePresenceManager.injectEntry`/`removeEntry` + tests.
- [ ] Template: demo workspace JSON-AD (folders, docs with lorodoc
      seeds, table, canvas, files, persona agents, rights for the
      user's agent).
- [ ] Client-side template apply (JSONADParser → applyIncoming),
      demo drive minted via `newResource` genesis.
- [ ] Director + scenario v1 ("Your first day", see Scenario
      section): fixed timeline beats + the three reactive triggers +
      no-follow fallback, wind-down arc, visibility pause.
- [ ] Onboarding choice in `GettingStartedFlow`.
- [ ] Verify live: fresh profile → demo drive feels alive; user can
      edit the doc being typed in; follow a persona; delete things.

## v2 content feedback (Joep, July 2026) — BUILT

- ✅ **Welcome doc shows more features**: Mara appends a live task
  list (`taskList`/`taskItem` JSON) and inline references
  (`atomic-data-resource-inline`) to the board + Team table.
- ✅ **Team = table** (Role column; rows Mara, Yusuf, Pip — the rows
  double as the personas' identities — plus a "You" row for guests,
  whose subject is the guest agent DID so avatars resolve offline).
- ✅ **Launch checklist = kanban board**: Status select
  (Todo/Doing/Done) + default kanban view; beats move cards by
  setting status tags.
- ✅ **Follow + follow-chat session**: Mara's entries carry
  `session` = a "Follow sessions" chatroom (also set as the drive's
  `followSessionsChatroom`); the director plays the followed side —
  "Started/Ended a follow session." + "Viewing […](…)" trail entries
  (as `followEvent` messages) whenever the user's presence entry
  follows her.
- ✅ **Persona-authored chat**: a seeded "Team chat" room + live
  beats. Attribution = the `createdBy` PROPVAL, which `useCreatedBy`
  prefers over the genesis message — legitimate only because the
  drive never reaches a server (the server derives `createdBy` from
  the verified genesis).
- ✅ **No interstitial**: /app/demo auto-starts (guest minted on the
  spot); "Try the live demo" on the welcome screen is one click to
  the live workspace. Post-onboarding demo offer removed.
- ✅ **Exit demo**: fixed blue button bottom-left while the demo
  drive is active (hidden on full-screen routes); guests → sign-up
  (the guest agent gets upgraded by onboarding's profile step),
  account users → their personal drive.
- ✅ **Fresh runs**: every /app/demo visit tears down the previous
  demo drive (children walked via parent-queries, removeResource
  tombstones OPFS, `unregisterLocalOnlyDrive` keeps the persisted set
  bounded) and builds a new one. Guest-ness on re-runs = "agent has
  no personalDrive", not "agent was just minted".
- ⏳ **Moodboard content**: Joep draws human-looking strokes on a real
  canvas; extract the `strokeData` Loro list and bake it into the
  template (and/or replay strokes as a director beat).

## Implementation notes from the v1 build

- **Wuchale ignore comments must be exact**: `// @wc-ignore-file` with
  trailing prose is NOT recognized — the transform then injects its
  `useW…` translation-loader hook into plain functions, which throws
  "Invalid hook call" outside React. Demo modules also carry
  `'use no memo'` (React Compiler) as belt-and-braces.
- **`store.getResource` (async API) was server-first for `did:`
  subjects while online** — cold local-only lookups leaked to a server
  GET ("DID Resource … not found locally"). Fixed: when local-only
  drives exist, OPFS is consulted first; hydration restores the
  `drive` prop that `isLocalOnlySubject` needs.
- **Open editors re-save imported remote ops**: CollaborativeEditor's
  debounced save fires on persona edits too, so the guest signs a
  commit wrapping them, and `ResourceSaved` fires. The director's
  "user edited" trigger suppresses saves of subjects it touched within
  the last 3s (`recentlyTouched`). Worth a deeper look in lib: should
  a save after pure remote imports be a noop? (Cursor semantics.)
- **Persona attribution**: propval edits carry the persona subject as
  the Loro commit message (history-readable). Doc typing rides
  loro-prosemirror's internal commits (message not settable per-op) —
  those ops land in the anonymous bucket; presence makes authorship
  visually obvious. New-resource beats (rows) are signed by the user's
  agent (only it can sign genesis) — fine for rows, blocking for
  persona-authored chat Messages; v2 option: give personas real
  keypairs and apply their commits via `parseAndApplyCommit`.
- **Guest agents**: `did:ad:agent:` fetches 404 against the server in
  the window before the local profile save; harmless (subject = public
  key) and self-heals. The demo requires clientDb (OPFS) — the offer
  page gates on `isClientDbEnabled()`.

## Known gap: sharing from local-only drives

The app lets you create a share invite for a resource in a local-only
drive (observed July 2026: an invite link minted for a demo-drive
canvas — a guaranteed-dead link, since the target exists only in one
browser's OPFS and the invite resource itself never reached a server).
Share/invite affordances should be disabled — or clearly warn — when
`store.isLocalOnlySubject(subject)`. Same likely applies to other
server-dependent actions surfaced in the UI (public link, subdomain,
vector-index settings).

## Later / out of scope

- "Keep this workspace" promotion via sync-import — also the natural
  guest→account upgrade path (verify what sync-import can do today).
- Localized scenario content (Wuchale) — scenario text is
  user-visible copy; files are currently `@wc-ignore-file`.
- Multiple scenario variants; re-running currently re-types into the
  same welcome doc (duplicate content) — a re-run should reset or
  branch the drive.
- No-follow fallback (tour comes to the user's current resource) and
  the "first delete" reactive trigger — specced, not in v1.
