# Durable `afterCommit` for user-installed plugins

Status: **design**, 2026-09-29, for
[#1851](https://github.com/ontola/atomic-server/issues/1851). Nothing here is
built. It implements the `afterCommit` half of
[plugin-runtime-convergence.md](plugin-runtime-convergence.md) step 4 for the
**extension** world, as decided by Michiel on
[ontola/atomic-plugins#177](https://github.com/ontola/atomic-plugins/issues/177)
(questions 4–7).

Depends on:

- [#1850](https://github.com/ontola/atomic-server/issues/1850) / PR #1885: the
  per-table change list (`GET /changes`, opaque cursor, `CURSOR_EXPIRED`,
  per-row Loro versions). This design reads it from Rust.
- [#1740](https://github.com/ontola/atomic-server/issues/1740) / PR #1788: the
  app-as-view row grant (`app_row_grant.rs`, `/app-write`'s `under_row_grant`).
- [#1849](https://github.com/ontola/atomic-server/issues/1849): "Allow editing"
  also covers the plugin's provider extras on rows. In progress.
- Independent of, but next to, [#1848](https://github.com/ontola/atomic-server/issues/1848) /
  PR #1882: inline `after_commit` extender errors no longer fail a saved commit.

## The idea in one paragraph

A plugin whose view is installed on a table can export `afterCommit`. When rows
of that table change, the server **wakes** the plugin. The wake-up is a small
persisted marker written in the same database transaction as the change itself.
The **correctness** comes from the change list: the server keeps one durable
cursor per (installation, table), reads the next page of the change list when it
runs the hook, hands that page to the plugin, and moves the cursor only when the
run has been journaled and acknowledged. If the cursor has expired, the plugin is
told to do a full compare instead. "Hook for speed, change list for correctness."

The hook is not a class extender. It never runs inside a commit, never blocks
or fails one, and it proposes writes like every other extension-world run.

## Relation to what exists

| | WASI class-extender `after_commit` (`lib/src/db.rs`, "AFTER APPLY COMMIT HANDLERS") | Plugin query trigger (`server/src/plugins/triggers.rs`) | Durable `afterCommit` (this) |
| --- | --- | --- | --- |
| Who installs | operator (`server-extension` world) | user (`extension`) | user (`extension`) |
| When it runs | inline, after the commit is saved, in the request | worker, after a query-membership edge | worker, after a row of a watched table changes |
| Durable | no: lost on restart or while paused | yes: `plugin-event/v1/` in the commit's batch | yes: same queue, plus a change-list cursor |
| Sees | one resource, the commit, changed props | one subject and an enter/leave edge | a page of `{subject, kind, version}` from the change list |
| Writes | imperatively, signed by the plugin agent | verdict: review, or an `AutoApplyGrant` | verdict: under the view's row grant, or held for review |
| Scope | the class, in the plugin's drive | the watched query | tables where the plugin's view is installed |

- **The WASI hook stays** for operator-installed server extensions, unchanged
  apart from #1882. So does the JS `server-extension` variant planned in
  step 4 (`on-resource-get`, `before-commit`, `after-commit` wrapped with
  `into_class_extender`). Both are inline and participate in the database; the
  extension-world hook never does. That keeps the boundary in
  [extension-architecture.md](extension-architecture.md) ("Server extensions are
  a different trust boundary"): a user plugin gets a **notification with a
  cursor**, not a commit hook.
- **Query triggers stay** for enter/leave on a query. No "changed" trigger kind
  is added: that is what this replaces. The durable hook reuses the trigger
  machinery: the `plugin-event/v1/` queue, the drain worker, the `Journal`, the
  run log, `pending_verdict` review, `record_error`, and the loop guard.
- **`onResourceGet` and `beforeCommit` are not widened.** A manifest in the
  extension world that declares them is refused, as today.

## What "installed as a view" means, in data

Installation `I` has its view installed on table `T` when all of these hold:

1. `T` is a table by #1885's rule: `isA` includes `Table` and it has a
   `classtype`.
2. There is a View `V` with `parent = T`, `V` is in `T`'s `table-views`, and
   `V`'s `view-kind` names an app `A`. This is exactly
   `app_row_grant::view_problem(T, A, V) == None`.
3. `installation::resolve(drive, A)` succeeds and resolves to `I`: active (not
   paused, draft or revoked), identity active, same drive. `A` has its own
   app agent (`signing_as.app == A`), as `/app-write` requires.
4. `I`'s release is JS, `world: extension`, and its manifest declares
   `entrypoints.afterCommit: true`. The source exports `afterCommit`.
5. There is a live **hook subscription** record for `(T, A)` (below), made by a
   signed gesture of someone who can write `T`.

A live row grant is **not** required. It only decides whether the hook's writes
apply or wait for review. A read-only view still gets its hook.

Why 5, if 1–4 already say "the view is there": #1788 established that setting
`view-kind` by hand grants nothing, because anyone who can write the table can
set it. Background delivery reads the table while nobody has it open, so it
needs a recorded consent with a person behind it, like the grant. The
subscription is created by the same gestures as the grant (`add-view`,
`view-type`, `menu`), on **both** dialog answers, Allow editing and Read-only.
Whether that happens implicitly or behind its own switch is product question 1.

One subscription per `(T, A)`, like the grant: two tabs showing the same app on
one table are one subscription. One plugin on two tables is two subscriptions
with two cursors.

The subscription lapses (recorded, not deleted, as with grants) when any of 1–4
stops holding, or when the person who activated it can no longer **read** `T`.
The `View` `after_commit` extender that revokes grants (#1788) also ends the
subscription when its View is destroyed or its kind changes. Pausing the
Installation does **not** end it: delivery just waits (see failure modes).

## Data model

All in `Tree::PluginMeta`, next to the trigger and grant records. Keys use the
JSON-tuple encoding the journal uses, so namespace boundaries are unambiguous.

### Subscription

`after-commit/v1/sub/["<drive>","<app>","<table>"]`

```rust
struct AfterCommitSubscription {
    id: String,                  // ulid
    drive: String,
    app: String,                 // pure id of the app named by view-kind
    installation: String,        // resolved Installation subject, for display
    table: String,               // pure id
    view: String,                // the View whose gesture made it
    activated_by: String,        // signer of the gesture; reads run as this agent
    activated_at: i64,           // server clock
    via: String,                 // "add-view" | "view-type" | "menu" | "grant-backfill"
    /// Opaque #1885 cursor. None until the first delivery claims one.
    cursor: Option<String>,
    /// Paused by the host (poison, loop cap). Not the Installation's pause.
    stopped: Option<Stopped>,    // { reason, at, attempts, event }
    last_error: Option<String>,
    last_delivered_at: Option<i64>,
    /// A proposal waiting for review, as a trigger's pending_verdict.
    pending_verdict: Option<String>,
    ended_at: Option<i64>,
    ended_via: Option<String>,   // same vocabulary as RowGrant::revoked_via
}
```

An in-memory index `table -> [subscription key]` is rebuilt at startup and on
every subscription write, like `plugin_triggers_for_query`.

### Queue entries

Both live under the existing `plugin-event/v1/` prefix so the existing drain
loop, `queued_plugin_events`, `save_plugin_event` and `acknowledge_plugin_event`
see them. `QueuedEvent` gains `#[serde(default)] kind: EventKind`
(`query` for every existing record) and an optional `after_commit` body. The
drain loop branches on `kind`.

**Wake-up marker**, one per subscription, upserted:
`plugin-event/v1/ac-<blake3(drive, app, table)>`

```rust
struct Wake {
    first_at: i64,       // first change since the last claim
    last_at: i64,        // latest change
    count: u32,          // commits coalesced (saturating)
    hint: Vec<String>,   // up to 20 row subjects, for health display only
}
```

It is written by #1885's `apply_with_change_log`, in the **same transaction** as
the change-log entry and the resource itself, for every subscription indexed on
the table. That function already holds the change log's per-store mutex from
sequence allocation to apply, so the read-modify-write of the marker is safe.
The three paths that log changes (`apply_commit`, `persist_resource_projection`,
`remove_applied`) therefore also wake the hook, which covers commits, WS/Iroh
`COMMIT` frames, sync, import and sync-applied removals: an edit on another
device reaches the plugin (Q5 on #177).

**In-flight delivery**, one at most per subscription:
`plugin-event/v1/<now:020>-ac-<random>`

```rust
struct Delivery {
    subscription: String,       // key of the subscription
    from: Option<String>,       // cursor before this page
    to: String,                 // cursor after it
    changes: Vec<Change>,       // the #1885 page, own echoes removed
    has_more: bool,
    reset: Option<Reset>,       // "initial" | "expired" | "requested"
    attempts: u32,
    next_attempt_at: i64,
    // plus QueuedEvent's verdict, waiting_for_review, authorization
}
```

Claiming is one batch: delete the marker, insert the delivery. A change that
lands during the run writes a fresh marker, so nothing is missed and runs for
one table never overlap.

### Own-write records

`after-commit/v1/own/["<drive>","<app>","<table>"]/<row>` →
`{ before: VersionVector?, after: VersionVector, run: String, at: i64 }`

Written when a hook run's write to a row applies (see Loops). Pruned when
consumed, and after 7 days.

### Cursor

The #1885 cursor, stored on the subscription, advanced **only** in the batch
that acknowledges the delivery (removes the in-flight entry). The existing
"journal is terminal, so acknowledge" path in `drain` gets the same step, so a
crash between finishing a run and acknowledging it still advances the cursor
exactly once.

## Sequence

```mermaid
sequenceDiagram
    autonumber
    participant U as Person / device / sync
    participant DB as Db (apply_commit / persist / remove)
    participant CL as Change list (#1885)
    participant Q as plugin-event/v1 queue
    participant W as Delivery worker (triggers.rs drain)
    participant JS as Plugin afterCommit (QuickJS)
    participant G as Row grant (#1788)

    U->>DB: commit to row R of table T
    DB->>CL: entry {R, updated, version}  (same txn)
    DB->>Q: upsert Wake marker for each subscription on T  (same txn)
    DB-->>W: DbEvent wake-up (may be lost; tick recovers)
    Note over W: debounce: claim when last_at + 2s passed, or first_at + 10s
    W->>CL: table_changes(T, since = sub.cursor, limit 100) as activated_by
    alt CURSOR_EXPIRED
        W->>Q: claim: Delivery {reset: expired, changes: []}
    else page
        W->>W: drop own echoes (version == own.after)
        W->>Q: claim: delete Wake, insert Delivery {from, to, changes}
    end
    W->>JS: afterCommit(ctx) with ctx.event
    JS-->>W: verdict {intents, problems, resync?}  (throw = retry)
    W->>W: Journal.plan(verdict)
    alt live grant and intents within grant scope
        W->>G: apply under row grant, signed by app agent
        W->>W: record own writes {before, after}
        W->>Q: ack: remove Delivery, sub.cursor = to  (one batch)
    else no grant, or out of scope
        W->>Q: waiting_for_review; sub.pending_verdict = verdict
        U->>W: review: Apply once / Allow all edits on this table / Decline
        W->>G: (Allow all) grant(via: "hook-review")
        W->>Q: ack: remove Delivery, sub.cursor = to
    end
    opt has_more
        W->>Q: insert Wake so the next page runs next
    end
```

## The JS API

### Manifest

```js
export const manifest = {
  schemaVersion: 2,
  world: 'extension',
  entrypoints: { run: true, view: 'view.js', afterCommit: true },
  // ...
};
```

`Entrypoints` gains `after_commit: bool`. An extension-world manifest may set it;
`classExtender` stays `server-extension` only. Setting it is not a grant: it only
says the source exports the function. The install review mentions it ("Told when
rows change in tables where you add it as a view").

### The export

```ts
export async function afterCommit(ctx: AfterCommitContext): Promise<AfterCommitResult>
```

The runtime component today looks up `run` by name
(`plugin-runtime/src/lib.rs`). It will look up `input.entry ?? 'run'` instead, so
no WIT change is needed; the host sets `entry: "afterCommit"`. A source without
the export fails the run with "the plugin does not export afterCommit()", which
counts as a failed attempt.

`ctx` is the same `__atomic` object `run` gets (frozen clock, seeded random,
`getResource`, `query`, `fetch`, `invoke-action`, config, schemas), plus:

```ts
ctx.trigger = { kind: 'afterCommit', id: string, at: number };

ctx.event = {
  drive: string,
  installation: string,
  app: string,
  table: string,
  rowClass: string,            // the table's classtype
  view: string,
  grant: { status: 'granted', grantedBy: string, grantedAt: number } | { status: 'none' },
  reset: null | 'initial' | 'expired' | 'requested',
  changes: Array<{
    subject: string,
    kind: 'created' | 'updated' | 'deleted',
    version: Record<string, number>,   // Loro version vector, as #1885
    at: number,
  }>,
  hasMore: boolean,
  attempt: number,             // 1 on first delivery of this page
};

// Scoped wrapper over #1885 for full compares. Only `ctx.event.table`.
ctx.changes(table, { since?: string, limit?: number }):
  Promise<{ changes, cursor, hasMore } | { error: 'CURSOR_EXPIRED' }>;
```

`reset` tells the plugin the page is not a delta:

- `initial`: first delivery of a new subscription. The cursor starts at the
  change list's **head**, not at the beginning, so adding a view to a table of
  10 000 rows is one run, not 100. The plugin does its own initial compare
  (it already has one: "compare on open").
- `expired`: the cursor was below the change list's floor (`CURSOR_EXPIRED`,
  tombstones pruned after the retention period). Do a full compare.
- `requested`: the plugin asked for it with `resync: true` last time.

In all three the host sets the stored cursor to the head at claim time, so
changes during the compare are delivered next.

### Result and acknowledgement

```ts
type AfterCommitResult = {
  intents?: Intent[],          // same vocabulary as run()
  problems?: Problem[],
  resync?: boolean,            // next delivery is reset: 'requested'
} | null | undefined;
```

- **Returning** (anything, including nothing) acknowledges the page once its
  intents are applied or held for review. The plugin does not store a cursor.
- **Throwing** (or a trap: out of fuel, memory, time) is a negative
  acknowledgement. The page is redelivered unchanged, with `attempt + 1`.
- Delivery is **at least once**. A page can be delivered again after a crash
  between the plugin's provider call and the journal's receipt. The plugin makes
  its effects idempotent with the row's `version` and the baseline it keeps in
  its provider extras (#177 decision 7; #1849). Uncertain provider effects stay
  uncertain until reconciled, per the journal's existing rule.

Provider calls from the hook use the integration proxy's permissions as today
(#177 decision 8): a connection delegated to the app agent plus a registered
runtime for unattended runs. `integrationWaits` pauses the delivery exactly as
it pauses a trigger.

### Retries, backoff, poison

- Backoff after a failed attempt: 30 s × 2^(attempts − 1), capped at 1 h,
  stored in `next_attempt_at`.
- After **8** failed attempts (about 2 h) the delivery is **poison**: the
  subscription gets `stopped = { reason, attempts, event }` and `last_error`,
  and delivery for that table stops. The cursor does not move, and markers keep
  coalescing. Nothing is lost.
- It restarts when someone presses Retry (attempts reset), or by itself when
  the installation's release changes (a fix was published), with the same page.
- Failures that are the host's own (store error, the change list refusing with
  something other than `CURSOR_EXPIRED`) are logged and retried without
  counting attempts.
- What the person sees is product question 3.

### Limits

| Limit | Value | Why |
| --- | --- | --- |
| Page size | 100 changes (the #1885 default; max 500) | bounds one run's input |
| Debounce | claim 2 s after the last change, or 10 s after the first | a person typing is one run, not forty |
| In flight | one delivery per subscription; the drain loop's existing cap of 100 attempts per pass | order per table; no pile-up |
| Loop cap | the trigger guard's 30 runs per minute per installation, counting only runs woken by a change (not `hasMore` continuations) | a plugin echoing itself is stopped and says so |
| Fuel and memory | the JS run limits in `host_core::limits` (20G / 256 MiB; more with `extended-fuel` / `extended-memory`) | same policy as `run` |
| Wall clock | 60 s per run | a hung `fetch` must not hold the worker |

## Reads and writes

**Reads** run as `activated_by`, intersected with the installation's grants and
declared capabilities (the effective-authority rule in extension-architecture.md),
and limited to `T`, its rows, the row class and its properties, and the app's own
subtree. `ctx.changes` refuses any other table. The per-row read check in
`table_changes` still applies.

**Writes** follow the view grant (#177 decision 6):

- **Live grant** (`app_row_grant::live(T, A)` re-checked now): intents inside
  `check_scope` apply unattended through `StoreApplyHost::*_under_row_grant`,
  signed by the app agent, with the granter's (`grantedBy`) rights as the
  person check. With #1849, that includes the plugin's provider extras. The
  grant's lapse rules run first, so a write never rides on a lapsed grant.
  #1788 noted its grant does not cover unattended runs; this design extends it
  to exactly one unattended path, the hook of the same app on the same table,
  and nothing else.
- **Writes to the app's own subtree** apply under the app's own rights, as the
  ordinary `/app-write` path does, with `activated_by` as the person check.
- **Everything else**, including every write when there is no live grant, is
  held: the delivery waits for review and the verdict is kept on the
  subscription. Review offers:
  - **Apply** this proposal once;
  - **Allow all edits by this view on this table**: records the existing
    "Allow editing" grant (`via: "hook-review"`, a new via next to `request`),
    then applies;
  - **Decline**: acknowledges without applying.
  A write outside grant scope (another table, `parent`, `isA`, rights, destroy)
  can only be applied once, never allowed in general.
- While a proposal waits, delivery for that table pauses, as a trigger does
  today (product question 4).

## Loops

A hook that writes a row changes the table, which would wake it again.

**Engineering choice: dedupe by version, not by signer.** Skipping every commit
signed by the app's agent would also skip edits a person makes in the plugin's
own view (`/app-write` signs those with the app agent too), and those must reach
the hook so they reach the provider. Instead:

1. When a hook run's write applies to row `R`, the host stores an own-write
   record: `before` (R's version before the write) and `after` (after it).
2. When a later page contains `R`, the entry is dropped (the cursor still moves
   past it) only if the entry's `version == after` **and** `before` was already
   delivered to the plugin, which means `before` equals the version of `R` in
   the page that run was given, or `R` did not exist before (the hook created
   it). Otherwise it is delivered, and the record is consumed. A write to a row
   the run was not given is therefore seen once by the plugin, which is harmless:
   writing it again from that page is an echo the next time.
3. So an echo is skipped, but a person's edit that landed just before or after
   the hook's write is not.

**Backstops.** Plugin A's write can wake plugin B and back. Writes that change
nothing produce no commit, so a converged pair stops. A pair that never
converges hits the 30-per-minute cap, and the subscription is stopped with
"its own writes keep waking it" in `last_error`.

## Failure modes

| Situation | What happens |
| --- | --- |
| Plugin paused (Installation not `active`) | `resolve` refuses; the worker skips without counting an attempt. Markers keep coalescing, the cursor stays. On resume, every change since is delivered. |
| Server restart / crash | Markers and deliveries are in redb, written with the commit. A delivery with a terminal journal is acknowledged (cursor advanced) on the next pass; one without is rerun, and its uncertain effects are held by the journal. |
| Wake-up event lost (broadcast lag) | The drain loop's 1 s tick reads the queue anyway. A **sweep** every 10 minutes and at startup compares each subscription's cursor with the change list's head and writes a marker where they differ, so even a missing marker is recovered. |
| Plugin off longer than retention (30 days) | `CURSOR_EXPIRED` → `reset: 'expired'` → full compare. |
| Table's `classtype` changes | #1885 starts a new epoch, the old cursor expires → full compare. |
| View removed, kind changed, activator loses read | Subscription ends (recorded). Its markers and deliveries are dropped. Re-adding the view starts over with `reset: 'initial'`. |
| Installation uninstalled or revoked | Subscriptions, markers, deliveries and own-write records are deleted. |
| Release updated while a proposal waits | Existing rule: "the event's approved source or account changed; resolve its saved proposal before continuing". |
| Hook throws or traps repeatedly | Backoff, then poison (above). Other tables and other plugins keep running. |
| Grant lapses between run and apply | `live()` re-checks at apply time; intents become a proposal for review. |
| Very large backlog | `hasMore` continuations, one page per run, not counted by the loop cap. |
| Two nodes hold the drive | Subscriptions are node-local `PluginMeta`, created on the node that recorded the gesture, which is the node that runs the installation's unattended jobs ("one owner per job", extension-architecture.md). Commits synced to it are logged by `persist_resource_projection`, so they wake it. Other nodes write no markers. |

## Rollout and migration

- **Gate.** A server flag, `--plugin-after-commit` /
  `ATOMIC_PLUGIN_AFTER_COMMIT`, off by default on `develop` and on in the plugin
  candidate line until one real plugin (Clockify or Google Calendar sync) has
  used it. With the flag off, no subscription is created, no marker is written,
  and a manifest with `afterCommit` installs but the entrypoint is inert. The
  manifest field is the per-plugin gate.
- **Order.** #1885 lands first (the marker is written inside its
  `apply_with_change_log`). #1788 is needed for the view/grant records; #1849
  for provider-extras writes. #1882 is independent.
- **Migration.** None of the data needs moving: new keys only, and the
  `QueuedEvent.kind` default keeps existing trigger events readable.
  Existing views: a view with a **live row grant** gets a subscription at
  startup with `activated_by = grantedBy`, `via: "grant-backfill"`, because that
  person already allowed more than this. Existing read-only views get none; the
  tab's menu offers to turn it on, which is the same gesture.
- **Where it lands.** The same self-contained shape as #1885, so it can be
  cherry-picked onto `claude/atomic-plugins-pin-candidate*`: a new
  `server/src/plugins/after_commit.rs` (subscriptions, claim, dedupe), a branch
  in `triggers.rs`'s `drain`, the `Entrypoints` field, the runtime's entry
  lookup, and the marker step in `change_log.rs`.

## Implementation checklist

- [ ] `Entrypoints.after_commit`; refuse `onResourceGet`/`beforeCommit` in the
      extension world (already refused; add a test).
- [ ] `plugin-runtime`: call `input.entry ?? 'run'`.
- [ ] `AfterCommitSubscription` store, index, lapse checks; creation on the
      #1788 gestures; end on the View extender.
- [ ] Marker upsert in `apply_with_change_log`; startup + 10-minute sweep.
- [ ] `QueuedEvent.kind`; claim, deliver, ack-with-cursor in `drain`.
- [ ] Own-write records and echo dropping.
- [ ] Apply under row grant for unattended hook runs; review with Apply / Allow
      all / Decline; `via: "hook-review"`.
- [ ] Backoff, poison, Retry; health on the Installation page and the tab.
- [ ] `ctx.changes` host call, scoped to the event's table.
- [ ] Server flag; grant backfill.
- [ ] Docs: `docs/src/plugins/creating-plugins.md` section; `TESTING_COVERAGE.md`.

## Test plan

Cheapest layer first (AGENTS.md "Debugging process").

**`atomic_lib` unit** (`lib/src/change_log_test.rs` or a sibling):

- a commit to a row of a subscribed table writes a marker in the same batch;
  an unsubscribed table writes none;
- ten commits coalesce into one marker with `count = 10`;
- replicated (`persist_replicated_resource`) and sync-removed rows write markers;
- `QueuedEvent` without `kind` deserializes as a query event.

**`plugin-runtime`**: `entry: "afterCommit"` calls that export; a missing export
is a clear error; `run` is unchanged.

**`atomic-server` lib tests** against a real store, with a fixture JS plugin
(`server/src/plugins/after_commit_test.rs`):

- delivery: an edit produces one run with the right `{subject, kind, version}`;
- durability: pause the installation, edit three rows, resume → all three are
  delivered; edit, drop the `Db` before the worker runs, reopen the redb file →
  delivered;
- ack/cursor: a run that throws is redelivered with the same page and
  `attempt = 2`; after 8 failures the subscription is stopped with an error and
  the cursor unchanged; Retry delivers the same page;
- crash window: a journal marked terminal but not acknowledged is acknowledged
  and the cursor advanced once, without rerunning;
- `CURSOR_EXPIRED` (prune with retention 0) → `reset: 'expired'`; a new
  subscription → `reset: 'initial'` with the cursor at head;
- `hasMore`: 250 changed rows are delivered in three runs, not counted by the
  loop cap;
- loops: a hook writing an extra on each delivered row runs once, not again; a
  person's edit right after the hook's write is delivered; a person's edit just
  before it is delivered; two plugins that never converge are stopped by the cap;
- writes: with a live grant, intents apply signed by the app agent; outside
  `check_scope` (another table, `parent`, destroy) they are held; without a
  grant, everything is held; "Allow all" records a grant with
  `via: "hook-review"` and applies; Decline advances the cursor;
- scope: no subscription for `view-kind` set by hand; subscription ends when the
  View is destroyed, its kind changes, or the activator loses read; a paused
  installation is skipped without counting attempts;
- reads: `ctx.changes` on another table is refused;
- flag off: no markers, no runs.

**`browser/lib` integration** (real server, no UI): an edit through
`store.save` on a table with a subscribed fixture plugin shows up in the
plugin's run log.

**One Playwright spec** (full suite, not `@smoke`): add a fixture plugin as a
view with Allow editing, close the tab, edit a row in the plain table, and see
the plugin's extra appear on the row. Then the Read-only variant: the proposal
bar appears on the tab, and "Allow all edits by this view on this table" applies
it and flips the tab's grant state.

## Product questions for Michiel

1. **Does adding a plugin as a table's view also let it follow changes while the
   tab is closed?**
   - A: Yes, one step. The "Let <App> edit rows?" dialog gains a line: "<App> is
     told when rows change, also when this tab is closed." Both Allow editing and
     Read-only turn it on.
   - B: A separate choice. Adding the view does not turn it on; the tab's menu
     has "Let <App> follow changes".
   - **Recommendation: A.** The view already reads every row when it is open,
     and a sync plugin that only works while its tab is open misses the edits
     made elsewhere, which is what #177 decision 1 asked for.

2. **Where do edits a plugin proposes from the background wait for approval?**
   - A: Per table: a bar on the plugin's tab ("<App> wants to change 3 rows"),
     with Apply, Allow all edits by this view on this table, and Decline.
   - B: Per plugin: one list on the plugin's Installation page, covering every
     table it is a view of.
   - **Recommendation: A**, with a count on the Installation page linking to
     each table. The choice being offered, "Allow all edits by this view on this
     table", is itself per table, so the question should be asked there.

3. **What does someone see when a plugin keeps failing on a table's changes?**
   - A: Quietly: a warning mark on the plugin's tab and on its Installation
     page: "<App> stopped following changes to <table>: <error>", with a Retry
     button. Nothing is lost; it catches up when retried or updated.
   - B: Actively: also a notification to the person who added the view.
   - **Recommendation: A** for now. Nothing is lost while it is stopped, and
     plugins are still in human-in-the-loop testing (#177 decision 3). Add B
     when sending is automatic.

4. **While a proposal waits for approval, does the plugin keep being told about
   new changes to that table?**
   - A: No: it pauses on that table until the proposal is answered, then catches
     up with everything that changed meanwhile. One proposal at a time.
   - B: Yes: proposals pile up and are reviewed in order.
   - **Recommendation: A.** It is how triggers already behave, and a pile of
     proposals made against a table that changed underneath them is harder to
     review correctly.

Engineering calls made here, not questions: dedupe by version rather than by
signer; the host keeps the cursor and hands the plugin the page; a new
subscription starts at the head, not at the beginning; poison after 8 attempts;
backfill subscriptions only for views that already have a live row grant.
