# Platform requirements for social apps

**Status: Requirements analysis (2026-07-17).** What the platform must grow for
social-network-shaped apps (feed, follow, share, comment, like/rate). Driving
example: a recipes app (Flutter, separate repo, hub-topology v1) — but these
are platform gaps, not app features; like [`habits-app.md`](./habits-app.md),
the app is the dogfooding vehicle. The authorization/sync side of this lives in
[`zones.md`](./zones.md); this doc covers everything else.

Topology decision (recorded): v1 runs **one hub server** with each user's
Flutter app as an embedded local-first node. The hub is two separable roles —
*always-on replica* (availability, delivery target) and *indexer* (counts,
feed, search) — both recomputable from user-signed data, hence replaceable.
"Speech" (recipes, comments, likes) is always signed resources in the author's
own zone; "reach" (counts, feeds, ranking) is derived hub state. Centralizing
a like *count* is fine; centralizing the *like* is not.

## P1 — blocks any app

### 1. Generic Flutter/Dart SDK (extract from Atomic Canvas)

**Started:** package lives at `dart/atomic_flutter/` (see `atomic-flutter-sdk.md`). Remaining: generic query/fetch/blob bridge APIs.

`dart/atomic_flutter/rust/src/api/simple.rs` is canvas-shaped: `push_stroke`,
`list_canvases`, hardcoded internal queries. Missing for any generic app:

- **Query from Dart**: property/value + filters, `sort_by`, pagination —
  the `Query` struct exists in lib (`lib/src/storelike.rs:711`); it's just not
  bridged.
- **Fetch remote resources**: read another user's public zone over HTTP
  (`lib/src/client/helpers.rs` exists; not bridged).
- **Typed-ish CRUD**: today's `set_property(String, String, String)` forces
  stringly-typed app code.
- **Search** passthrough (hub `/search`).

Deliverable: an `atomic_flutter` package (bridge + Dart layer from
`dart/atomic_flutter/`) with Canvas as its first consumer. Aligns with
[`atomic-lib-runtime.md`](./atomic-lib-runtime.md) and
[`SDK-API-design.md`](./SDK-API-design.md).

### 2. Blobs on mobile

The bridge exposes **zero** blob/file/image functions; a photo-first app is
impossible. Protocol (`BLOB_*` frames) and server storage exist
([`s3-blob-storage.md`](./s3-blob-storage.md)). Needed: pick/downscale/upload
from Dart, blob references from resources, thumbnail fetch + cache for feeds.

## P2 — blocks the social loop

### 3. Push notifications

There is no out-of-band notification path at all (no FCM/APNS/web-push/email;
realtime is WS to connected clients only). Social retention requires it.
Minimal scope: hub-side FCM/APNS integration hanging off the existing commit
fan-out (`server/src/commit_monitor.rs`), device-token registry per agent,
events = comment/like targeting one of your resources. Offline-first framing:
a notification is a *hint to sync*, payload comes from the store.

### 4. Feed primitives

Recorded v1 approach: **client-side fan-out** — query each followed user's
public zone (`sort_by=createdAt desc`, small pages, the chatroom pattern in
`server/src/plugins/chatroom.rs`), merge and cache in the embedded node.
Platform gaps behind it, in eventual order of need:

- **Server-side multi-zone feed endpoint** on the hub (all zones are local to
  it; fan-out server-side is cheap) once follows > ~hundreds.
- **Query subscriptions** are single `property=value` per zone, no sorted-window
  maintenance (`commit_monitor.rs:398`) — live feeds re-query today.
- **Aggregation**: counts are O(hits) (`query_index.rs:201`, #286/#290); no
  group-by / top-N. Ratings need client-side averaging until a maintained
  counter or small aggregation endpoint exists.
- **Numeric sort is lexicographic** (#287) — blocks "top rated" server-side.

### 5. Invite-link onboarding

The growth loop is "join me" links. Stateless invite tokens
(`server/src/invite_token.rs`) grant rights to an *existing* agent; the missing
piece is the app flow: open link → create agent → redeem → auto-follow
inviter. Also still missing: one-time / usage-capped invites (vocabulary
exists, no live code). Relates to [`device-pairing.md`](./device-pairing.md)
(same QR/deep-link envelope family).

### 6. Web view for shared links

A shared recipe link lands non-users on the generic data-browser resource view.
Needed: a presentable per-class public view — either a data-browser view or a
plugin view ([`llm-wasm-gui-plugins.md`](./llm-wasm-gui-plugins.md),
[`website-templates.md`](./website-templates.md)). This is the app's front
door; generic-resource-JSON is not.

## P3 — quality of the social model

### 7. Groups

Still the biggest ACL gap after zones: no way to grant "my friends" as a unit,
so followers-only audiences are unviable (v1 visibility = private / link /
public). A `Group` resource resolvable one level deep in `check_rights` serves
every app. Tracked as zones.md OQ3.

### 8. Agent profiles & discovery

Agent-as-resource works as a profile (name/description public); missing:
avatar convention, and person-level discovery. Hub v1: profile search +
invite links. P2P later: one opt-in pkarr record per agent (zones.md).

### 9. Moderation surface

Allow-lists only; no block/mute. Recorded direction (zones.md OQ1): foreign
social content lives in its author's zone; threads are assembled by
index/crawl; moderation is display-time filtering (per-agent blocklist applied
by hub indexer + client). Needs a blocklist convention, no ACL change.

## Deliberately not platform work

- **LLM recipe generation**: in-app with the user's own key; schema validation
  against the ontology is the quality gate. No crate changes.
- **Typed Dart schema codegen**: nice-to-have;
  [`json-schema-code-first.md`](./json-schema-code-first.md) is TS-first, a
  Dart generator can follow the app's hand-written ontology constants.
- **Search**: hub tantivy suffices (caveat #597: resource-array links aren't
  indexed).
- **Private drives default**: `create_drive` seeds `read=[PublicAgent]`
  (`lib/src/db.rs:725`) — app must strip it, or add an opt-out param (tiny fix,
  fold into zones migration).

## Build order (recipe app as driver)

1. SDK extraction (P1.1) — unblocks everything, benefits Canvas too.
2. Recipe ontology + local CRUD + LLM generation — single-user value, zero
   server changes.
3. Blobs (P1.2).
4. Social loop on today's drive mechanics (zones-lite): follow, client-merged
   feed, append-based comments, likes with client-side counts.
5. Push notifications (P2.3) + invite onboarding (P2.5) + web share view
   (P2.6).
6. Feed endpoint / aggregation / groups (P2.4, P3.7) when scale or product
   demands.

Steps 1–3 are independent of [`zones.md`](./zones.md) and can start first.
