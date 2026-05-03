# Unify the three subscription primitives

> Status: planned 2026-05-28. Cleanup. Server-side scope only.
>
> The browser-side dual ("one subscription channel" replacing
> resources/queries/drives plumbing) lives in the broader
> [`unified-data-layer.md`](./unified-data-layer.md). Landing this
> server-side change first is fine — it doesn't constrain the
> client design.

## Problem

Server offers three subscription registration shapes:

| Registration | Map | Auth gate | Wire format |
|---|---|---|---|
| `SUB <drive>` | `drive_subscriptions: HashMap<String, HashMap<Addr, source_id>>` | `check_read` on drive | binary `0x20` |
| `SUBSCRIBE <subject>` (text) | `subscriptions: HashMap<Subject, HashMap<Addr, source_id>>` | none (!) | text `SUBSCRIBE <s>` |
| `SUBSCRIBE_QUERY <json>` | `query_subscriptions: HashMap<Vec<u8>, HashMap<Addr, source_id>>` | `check_read` on drive | text JSON |

All three produce identical receiver-side output: `UPDATE` /
`DESTROY`. The receiver can't tell which registration caused a delivery,
and doesn't need to. Three actor handlers + three fanout loops on every
`CommitMessage` is overhead that buys nothing.

## Observations

- `SUBSCRIBE <subject>` has **no permission check** today. That's a
  latent issue: any authenticated agent can SUB any subject and receive
  every commit on it.
- The `SUB <drive>` binary tag and the `SUBSCRIBE <subject>` text frame
  are doing nearly the same job. The former is "drive-scoped", the
  latter is "subject-scoped" — both could be a degenerate filter.
- `SUBSCRIBE_QUERY` is currently restricted to `property + value + drive`
  filters; drive-only or property-only filters are explicitly rejected.

## Proposal

Collapse to **one** subscription primitive:

```rust
enum SubscriptionMatch {
    /// Single subject — what `SUBSCRIBE <s>` does today.
    Subject(atomic_lib::Subject),
    /// Drive-wide — what `SUB <drive>` does today (subjects whose URL
    /// prefix-matches the drive, or any DID subject in the workspace).
    Drive(String),
    /// Property/value filter under a drive — what `SUBSCRIBE_QUERY`
    /// does today.
    Filter {
        property: String,
        value: atomic_lib::Value,
        drive: atomic_lib::Subject,
        sort_by: Option<String>,
    },
}

struct Subscription {
    match_kind: SubscriptionMatch,
    addr: Addr<WebSocketConnection>,
    source_id: String,
}
```

One map keyed by `Addr` (the connection) → `Vec<Subscription>`. The
fanout walks all subscriptions once per commit and dispatches based on
`match_kind`. Cheaper for the common case (most connections subscribe to
one drive + a handful of resources).

On the wire, keep binary `SUB` and rename it `SUBSCRIBE_V2`:

```
SUBSCRIBE_V2 (0x20) [match_kind: u8] [payload...]
```

- `match_kind == 0`: subject (UTF-8 string follows)
- `match_kind == 1`: drive (UTF-8 string follows)
- `match_kind == 2`: filter (length-prefixed property, value, drive, sort_by)

Text-frame `SUBSCRIBE_QUERY` becomes a thin compat shim that decodes
JSON and dispatches the same SubscribeQuery actor message, marked
`@deprecated`.

## Auth model

One auth function `check_subscription_authorized(match_kind, agent)`:

- `Subject(s)` → `check_read(s, agent)` (this closes the current
  load-bearing hole)
- `Drive(d)` → `check_read(d, agent)`
- `Filter { drive, .. }` → `check_read(drive, agent)`

## Risk

- Wire-format change. Old clients sending `SUB` (without the match_kind
  byte) need a one-version transition. Acceptable since the protocol is
  versioned `v2` and has no external consumers.
- Adding auth to subject-subscribe could break clients that currently
  subscribe to subjects they don't own. Browser doesn't do this (it
  always SUBs the drive). Audit before landing.

## Effort

- 1 day for the actor refactor + new map.
- 1 day for the wire-format migration (keep both opcodes during the
  switch).
- 1 day to update browser `WSClient` and audit Flutter.

## Concrete steps

1. Introduce `Subscription` struct + single map alongside the existing
   three.
2. Migrate `Handler<CommitMessage>`'s fanout to walk the unified map and
   dispatch by `match_kind`. Leave the three legacy handlers in place.
3. Add auth to subject-subscribe (the current latent gap).
4. Deprecate the three old text frames + binary `SUB`. Add `SUBSCRIBE_V2`.
5. Switch browser to `SUBSCRIBE_V2`.
6. Delete the old handlers in a follow-up PR.
