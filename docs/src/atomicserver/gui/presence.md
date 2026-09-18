# Presence & collaboration

AtomicServer shows who else is in a workspace with you — without writing that
information into your data. Presence is ephemeral: it rides a drive-scoped relay
with a short TTL and disappears when someone leaves.

## What you see

- **Avatars / facepile** in the navbar for people viewing the current resource
- **Sidebar dots** on resources others have open
- **Document cursors** while co-editing rich text (colored per agent)
- **Canvas pointers** on collaborative canvases
- **Table cell rings** on the cell another person has selected
- **"Typing…"** in chat rooms and comments
- **Follow-me** — follow someone as they navigate; they can lead a tour through
  the app
- **Meetings** — a meeting resource with agenda, notes, and live presence for
  participants (optional peer-to-peer audio/video in the meeting panel)

## How it works

Each drive has a presence channel. Every session announces a small entry:

- which agent you are
- which resource you are viewing
- optional follow target
- optional view-specific data (selected table cell, canvas coordinates, …)

Entries expire if the heartbeat stops (~30s TTL). The browser and other clients
subscribe over the [WebSocket protocol](../../websockets.md) (`EPHEMERAL` /
presence frames). Document text cursors use a dedicated Loro ephemeral channel
because cursor positions must track the CRDT oplog; canvas and tables attach
lightweight payloads to the drive presence entry instead.

Presence is **not** a Commit. It is never stored in the database and does not
appear in history.

## Follow-me and meetings

From the presence UI you can follow another session: your view tracks theirs as
they open resources. Meetings are first-class resources with agenda/notes and a
prepare-then-start flow; participants show up through the same presence layer.

## Multi-device and P2P

Same-agent presence across your own devices works through the always-on device
(or hub) that relays the drive channel. Direct multi-user presence over Iroh
without a hub is on the roadmap; today collaboration between people typically
shares a workspace on a server or desktop that both can reach.

## Related

- [Sync & pairing](sync-and-pairing.md)
- [WebSocket protocol](../../websockets.md) (`EPHEMERAL` tag)
- [Documents and real-time editing](../gui.md)
