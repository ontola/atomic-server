# Chat log: messages as entries, not resources

> **Status:** Design (2026-10-09). Joep chose this route ("Chatlog (D)") after
> the measurements in [`chat-message-storage.md`](./chat-message-storage.md).
> Nothing is built yet.

## Why

A chat message is now a resource of its own. On develop it stores 3.3 KB of
rows (commit row, message row, snapshot delta, two indexes, search) and grows
the redb file by 6 to 7 KB, because B-tree pages sit half full. A message is a
few dozen bytes of text.

Prototype (Loro 1.12 via the Python binding, three authors, one Loro change per
message, snapshot deflated):

| entries per log | "hallo" | 48-character sentence |
| --- | --- | --- |
| 50 | 47 B | 57 B |
| 256 | 37 B | 46 B |
| 1000 | 37 B | 46 B |

Add about 12 B per message for the page resource around them (3 KB per 256
messages). So about 50 to 70 B per message, against 6 to 7 KB now: roughly a
hundred times smaller. Ordinary commits are already discarded after apply and
only the latest envelope per resource is kept, so the per-message commit adds
nothing lasting.

## Model

- **`ChatLog`** is a new class: one page of a chat, a child of the chat
  (`parent`). A page holds up to 256 entries; the client appends to the newest
  page that has room and creates a new page when it is full. Two clients that
  both create the next page give two pages, which is harmless: the reader merges
  pages by entry time.
- Entries live in a Loro root map **`entries`**, next to `properties` and
  `datatypes`. They are not materialized into propvals and get no index rows,
  so the page's resource row and indexes stay the size of an empty resource.
- **Entry key:** `<createdAt ms, hex>-<8 random hex>`, so keys sort by time.
- **Entry value:** a plain Loro map value (not a container), replaced whole on
  edit:
  - `a` author agent, `t` text (markdown), `c` createdAt (ms), optional
    `r` reply-to entry key, `e` edited-at, `k` extra kinds (`FollowEvent`).
  - AI chat: `role` and `parts` (the parts that are now child resources).
  - DMs: `s` the sealed payload instead of `t`.
- **Delete:** remove the key.
- **Link to one message:** `<page subject>#<entry key>`.

## Rights: append-only per author

In one document every member would otherwise be able to rewrite every message,
which today only `write = [author]` per message prevents. The server enforces
it per commit:

1. Creating a page needs `append` on the chat (the existing `check_append`).
   A page does **not** give its creator `write` at genesis, unlike other DID
   resources.
2. A commit by a signer **without** `write` on the page (inherited `write` on the
   chat counts, so moderators keep full control) is accepted only if:
   - `properties` and `datatypes` do not change (except at genesis), and
   - for every key in `entries` that the update adds, changes or removes, the
     entry before (if any) and after (if any) has `a` equal to the signer.
3. The check reads `entries` before and after the import, the way
   `import_update_with_diff` already does for `properties`
   (`lib/src/loro.rs`), and rejects before anything is stored.
4. `c` is client time. The server rejects entries whose `c` is more than ten
   minutes ahead of its clock; older times are allowed (offline sending).

## The chats

| chat | parent of the pages | notes |
| --- | --- | --- |
| Group chat | the `ChatRoom` | replaces `Message` with `parent` |
| Comments | the drive's comments folder, page has `about` = the item | one log per commented item, found by `about` (one index row per page, not per comment) |
| AI chat | the AI chat | single author; a message and its parts become one entry, the biggest win per message |
| DMs | the `Conversation` | entries carry the sealed payload; members already have only `append` |
| Follow events, meeting toasts | the follow-sessions `ChatRoom` | they are `Message`s today, one per visited page |

Notifications (`Notification` per message in the inbox) are the other
one-resource-per-event data; they can become an inbox log later, same design.

## What stays the same

- Live updates: a page is an ordinary resource, so its commits fan out as Loro
  deltas over the existing `SUB`/`UPDATE` path; WS and Iroh sync need nothing new.
- Search: the page's search document is the text of its entries; a hit opens
  the page and scrolls to the entry. No per-entry index.
- Mentions, replies and edit keep their UI; they read and write entries.

## Existing messages

Old `Message`, `ai-message` and `SealedMessage` resources stay as they are and
stay readable: views read both the old resources and the log and merge them by
time. They cannot be moved into a log, because every entry must carry its
author's signature and only the author can make that. New messages go to the
log. Released clients that still write `Message` resources keep working; their
messages show up through the same merge.

## Build order (one PR each)

1. `atomic_lib` and `@tomic/lib`: `ChatLog` class, entry read/write helpers
   (Rust and TS), the server rule with tests (author can add, edit and delete
   own entries; cannot touch others'; moderator can; page genesis grants no
   write; future `c` rejected). Storage measured with
   `measure_chat_message_bytes` adapted to the log.
2. Group chat and comments, with the merged reader and pagination per page.
3. AI chat.
4. DMs.
5. Follow events and meeting toasts.

## Open questions

- Page size 256: small enough that loading the newest page is instant, large
  enough that the page overhead stays near 12 B per message.
- Reactions do not exist yet; when they come they fit as a map inside the entry
  owned by... nobody single, so they would need their own rule (one key per
  reacting agent).
