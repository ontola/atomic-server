# Presence in views: canvas + tables (consolidation plan)

> **Status:** Implemented and verified live (two-session browser test:
> canvas cursors, table cell rings, navbar facepile, sidebar dots).
> Drive-wide presence and document cursor sharing already shipped; this
> doc covers extending presence to canvas and table views on the existing
> `PresenceEntry.data` channel, plus the shared pieces so all surfaces
> stay consistent.

## Where presence lives today

Three layers exist, two of them shipped:

1. **Drive presence channel** (`lib/src/presence.ts`, issue #1229).
   One `DrivePresenceManager` per drive (`store.getPresence(drive)`), a
   Loro `EphemeralStore` where each session writes one key (its
   `sessionId`) holding a `PresenceEntry { agent, resource, following,
   session, allowFollow, data, updatedAt }`. 30s TTL, 10s heartbeat,
   relayed as opaque bytes over `PRESENCE_*` websocket frames.
2. **React bindings** (`react/src/usePresence.ts`):
   - `useDrivePresence()` — all other sessions on the drive (sidebar
     dots via `SidebarPresence`, facepiles).
   - `useResourcePresence(subject)` — announces "this session is viewing
     `subject`" and returns other sessions on the same subject. The
     NavBar's `ResourcePresenceRow` announces for **every** viewed
     resource, so tables and canvases already get the avatar row +
     sidebar dots for free.
   - `setData` — attaches a view-specific payload to our entry. The
     `data` field was designed for "canvas XY, table cell, document
     cursor" but had **zero consumers** until this work.
3. **Document cursors** (`chunks/RTE/useLoroSync.ts`): a *separate*
   per-document `CursorEphemeralStore` (loro-prosemirror) synced over
   `LORO_EPHEMERAL` frames. Deliberately NOT on the drive presence
   channel: cursor anchors are Loro `Cursor` objects tied to the
   document's oplog and update per keystroke. Colored per agent via the
   shared `colorForAgent`.

## Design decisions

- **Canvas and table presence ride the drive presence channel** via
  `useResourcePresence(subject).setData`, not a per-resource ephemeral
  store like documents. Payloads are tiny, low-frequency (throttled
  pointer / discrete cell selection), and don't need CRDT position
  stability — the drive channel is exactly what `data` was designed for.
  Documents stay on their dedicated channel (position mapping through
  concurrent edits needs Loro cursors).
- **Multiple announcers of the same subject compose.** NavBar announces
  the viewed resource; the view page announces the same subject when it
  calls `setData` (a `patchLocal`). Same subject → no conflict; the
  docstring in `usePresence.ts` is updated to say so (it used to warn
  "at most one announcing caller").
- **Identity, not indexes, on the wire (tables).** A remote session's
  sort/filter/view can differ, and session-local `_new:` rows don't
  exist elsewhere. So the payload is `{ row: <row resource subject>,
  column: <property subject> }`. Cells self-match: each `TableCell`
  knows its resolved row subject and column property. `_new:` rows that
  haven't materialized are not announced (other clients can't see them);
  once materialized the store aliases them to their real `did:ad:`
  subject, which is announced.
- **World coordinates on the wire (canvas).** `{ x, y }` in canvas
  world space; each receiver maps through its own `scale`/`offset`.
  Broadcast throttled (trailing) so a pointer sweep costs a few frames
  per second, cleared on pointer-leave. Remote cursors render as a
  colored dot + name tag, `pointer-events: none`, CSS-transitioned so
  the ~throttle-interval updates read as smooth motion.
- **Shared visual identity.** `colorForAgent` (already shared between
  avatars and document cursors) + a new `PresenceUserTag` name pill
  (`components/Presence/PresenceUserTag.tsx`) used by both the canvas
  cursor overlay and the table cell indicator.
- **Grid view only for tables** (kanban/calendar announce nothing —
  there's no cell selection there). Canvas broadcasts whenever the
  pointer is over the drawing surface, including while drawing/panning.

## Wiring (files)

| Piece | File | Role |
| --- | --- | --- |
| Shared name pill | `data-browser/src/components/Presence/PresenceUserTag.tsx` | Agent-colored label used by canvas + table indicators |
| Canvas hook + overlay | `data-browser/src/views/Canvas/CanvasPresence.tsx` | `useCanvasPresence(subject)` → `{ cursors, broadcastPointer, clearPointer }` + `<RemoteCursors>` overlay |
| Canvas integration | `data-browser/src/views/Canvas/CanvasPage.tsx` | broadcast from `onPointerMove`, clear on leave, overlay inside `CanvasArea` |
| Selection callback | `data-browser/src/chunks/TableEditor/TableEditor.tsx` | new optional `onSelectedCellChange(row, column)` prop — TableEditor stays presence-agnostic |
| Table presence | `data-browser/src/chunks/TablePage/TablePresence.tsx` | payload type, context (cell-key → agents map), announce hook (index → subjects resolution, out-of-order guard) |
| Table integration | `data-browser/src/chunks/TablePage/TableResource.tsx` | wires announce + provides the map |
| Cell indicator | `data-browser/src/chunks/TablePage/TableCell.tsx` | inset ring in agent color + `PresenceUserTag` when a remote session sits on this cell |
| Docs | `react/src/usePresence.ts` | same-subject announcers compose; `data` consumers exist now |

## TODO

- [x] Shared `PresenceUserTag` component.
- [x] Canvas: `CanvasPresence.tsx` hook + remote cursor overlay.
- [x] Canvas: integrate into `CanvasPage.tsx` (broadcast on pointermove,
      clear on leave, render overlay mapped through scale/offset).
- [x] Table: `onSelectedCellChange` prop on `FancyTable`.
- [x] Table: `TablePresence.tsx` (payload type, context, announce hook).
- [x] Table: wire into `TableResource.tsx`; indicator in `TableCell.tsx`.
- [x] Update `usePresence.ts` docstrings (multiple same-subject
      announcers OK; point to the canvas/table consumers as examples).
- [x] `pnpm typecheck` + lint + unit tests green.
- [x] Verify live with two sessions (canvas cursors, table cell rings,
      facepile unchanged).

## Lessons from the live verification

- **A cleared `data` payload arrives as `null`, not `undefined`** —
  `patchLocal({ data: undefined })` doesn't survive the Loro ephemeral
  wire encoding as `undefined`. Receivers must validate the payload
  shape (`typeof data?.x === 'number'`), not just its presence; the
  first canvas build crashed `<RemoteCursors>` on exactly this.
- World→screen mapping confirmed exact: a cursor broadcast at world
  (x, y) renders at `x·scale + offset.x` on every peer.

## Follow-up: kanban presence (implemented)

The table payload grew into `TablePresenceData { row, column?,
dragging? }` and the context became row-keyed
(`Map<rowSubject, RowPresence[]>` + a `setActiveCard` announcer):

- **Kanban cards** announce hover (`{ row }`) and drags
  (`{ row, dragging: true }`, sent by the board's dnd handlers); hover
  announcements are suppressed while any drag is live so cards passing
  under the pointer don't clobber the drag entry.
- **Rendering** reuses `RemoteCellPresence` (ring + name tag); the ring
  pulses and the card lifts/tilts while a remote session drags it.
- **Cross-view**: a grid cell selection (`{ row, column }`) renders on
  the matching kanban card too; kanban hovers carry no `column`, so
  they don't light up any grid cell.
- The demo's `moveCard` broadcasts a dragging beat before each move.

## Later / out of scope

- Calendar selection presence (no cell-selection concept yet).
- Multi-select range presence in tables (only the active cell is
  announced; the multi-select corner is not).
- Canvas "who is drawing" stroke preview (remote in-progress strokes
  arrive via Loro sync only on release today; live stroke preview would
  ride `data` with a path buffer — separate effort).
- Follow-mode zoom sync on canvas (follow currently navigates to the
  resource; it does not mirror viewport).
