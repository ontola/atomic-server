# Habits: a Local-First Tracker Built as an External App

## Status

Proposal (2026-07-13). Not started.

## Goal

Build a habit-tracking app on Atomic: daily checkboxes and counters, linked to
the user's drive, local-first, with an LLM-assisted setup flow, a smartwatch
companion, and trend views (last week at minimum, full history ideally).

Equally important: build it **as an external developer would**. The app must
use only the public surfaces — `@tomic/lib`, `@tomic/react`, `@tomic/cli`,
`@tomic/plugin`, the custom-view iframe interface, and the assistant's
schema-discovery tools. No new `case` in `ResourcePage.tsx`, no ontology added
to `browser/lib/src/ontologies/`, no bespoke server endpoint. Every place where
that constraint hurts is a finding that feeds
[`SDK-API-design.md`](./SDK-API-design.md),
[`llm-wasm-gui-plugins.md`](./llm-wasm-gui-plugins.md), and
[`json-schema-code-first.md`](./json-schema-code-first.md). Habits is the
end-to-end tutorial app that `SDK-API-design.md` says we should design from.

## Product Shape

- A **HabitTracker** resource in the user's drive is the app's home. Visiting
  it in the Data Browser renders the tracker via an installed plugin view.
- Each **Habit** is a daily checkbox ("meditate") or counter ("glasses of
  water", target 8) with an icon and color.
- Tapping an icon records a completion. The main view is a grid of habit icons
  with today's state, plus a week strip and trend charts.
- The **assistant** interviews the user ("what are you trying to change?") and
  creates a personalized tracker with sensible habits, icons, and targets.
- A **watch app** shows the same icon grid; a tap completes or +1s, offline,
  syncing later.

## Ontology

Defined by the app, not by Atomic. Preferred path is code-first
`defineSchema` from [`json-schema-code-first.md`](./json-schema-code-first.md)
so the schema resources land in the drive as signed `did:ad` resources with no
build step. Until that ships, fallback is an HTTP-hosted ontology plus
`@tomic/cli` generation — acceptable for development, but the friction should
be recorded, not worked around.

```text
HabitTracker
  name
  habits          ResourceArray<Habit>   (explicit order = grid order)

Habit
  name
  icon            string (emoji or icon name)
  color           string
  kind            'check' | 'counter'
  dailyTarget     integer (counters; 1 for checks)
  schedule        optional (daily default; later: weekdays, x-per-week)
  archivedAt      optional date

Completion
  habit           Resource<Habit>
  localDate       string 'YYYY-MM-DD' (user-local, decided at write time)
  timestamp       datetime
```

### Completions are an append-only event log, one resource per tap

The tempting model — one day-bucketed entry per `(habit, localDate)` with a
`count` property — is wrong for this app. `count` would be a last-write-wins
register: a +1 on the offline watch and a +1 on the phone merge to 1, not 2.
Counter taps are exactly the kind of commutative operation CRDTs handle well,
and the cheapest CRDT here is no CRDT: each tap creates one tiny immutable
`Completion` resource. Creation events merge trivially across devices, undo is
`destroy`, and a day's count is the number of completions for that
`(habit, localDate)`.

Volume is fine: 10 habits × ~3 taps/day ≈ 11k resources/year. Day counts and
streaks are derived client-side and can be memoized in app-local state; they
are never written back as stored properties.

`localDate` is stored explicitly rather than derived from `timestamp` so that
a 23:30 tap counts for the day the user experienced, regardless of which
timezone later renders it.

## Surfaces

### 1. Data Browser plugin (primary)

A `@tomic/plugin` custom view registered for `HabitTracker`. The iframe
sandbox model fits: the app needs read/write on the tracker subtree and
nothing else. Writes go through RPC `commit` signed by the user's agent; all
completions and habits are children of the tracker resource, which should keep
them inside the host's automatic page-scope grant.

Known friction, all already tracked in `llm-wasm-gui-plugins.md` and now given
a concrete consumer:

- **RPC `query` is "not implemented"** — this is the hard blocker. Trends need
  "completions for these habits, sorted by `localDate` desc". Without query the
  plugin can only walk explicit `ResourceArray` links, which does not scale to
  thousands of completions. Implementing scoped RPC `query` (Phase 0/1 there)
  is a prerequisite for this app.
- **Packages require `plugin.wasm`.** Habits is UI-only; the UI-only release
  format must land first, or we ship a meaningless no-op component.
- **No code splitting, assets inlined.** Charts must be small hand-rolled SVG
  (week heatmap, bar sparkline), not a bundled chart library. That is probably
  the right product call anyway.
- **Offline discovery**: `/plugin-list` is server-dependent, so the tracker
  view disappears offline — unacceptable for a local-first tracker and a good
  forcing function for the local-node discovery item.

### 2. Standalone PWA (development harness and fallback)

The same React components in a minimal `@tomic/lib` + `@tomic/react` app
(started from `create-template`), talking to the store directly instead of
over plugin RPC. This is where development starts — no plugin lifecycle in the
inner loop — and it doubles as the test of whether a standalone external app
can run fully local-first on the WASM `ClientDb`/OPFS stack outside the Data
Browser. Structure the code so the data layer is a thin adapter interface with
two implementations: direct store, and plugin RPC.

### Queries and trends

`CollectionBuilder`/`useCollection` filter on exact property=value; there is
**no range operator**, so "last 7 days" cannot be expressed server-side.
Workable approach: query `isA=Completion` (+ `habit=<subject>` when needed),
`sort_by=localDate` desc, and page until the date boundary passes — for this
data volume that's cheap. Full-history trends aggregate client-side over the
same pages. Record range filtering as a gap for
[`multi-property-filter.md`](./multi-property-filter.md) / the query layer
rather than building a custom endpoint, which the external-developer
constraint forbids anyway.

## Assistant Integration

The setup flow is conversational: the assistant asks about goals, routine, and
capacity, then proposes a tracker (habit names, check vs counter, targets,
icons) and creates the resources on confirmation.

What already works for an external app:

- Once the schema resources exist in the drive, `get_user_classes` /
  `get_schema` let the assistant discover `Habit` and `Completion` without any
  built-in knowledge — a direct payoff of drive-resident code-first schemas.
- `create_resource` / `query` / `edit_atomic_resource` cover the whole flow;
  the compact dialect from [`json-ad-compact.md`](./json-ad-compact.md) keeps
  the tool I/O sane.

What's missing: the coaching quality lives in a **skill** ("interview before
creating; default to 3–5 habits; counters need targets; suggest an icon per
habit; never create duplicates — query first"). Skills exist
(`read_skill`/`create_skill`), but there is no way for an app or plugin to
**ship** one. Proposal: the plugin manifest (or the future `PluginRelease`)
can declare skill resources that get created in the drive on install, shown in
the install-review UI like any other capability. That is a small, high-value
addition to the `llm-wasm-gui-plugins.md` capability manifest.

## Smartwatch

No existing watch target: Tauri doesn't build for watchOS/Wear OS, and the
Data Browser web UI is the wrong shape for a 40 mm screen regardless.

Options considered:

1. **Wear OS app in Flutter, reusing the Canvas app's pattern** (Flutter +
   `flutter_rust_bridge` + Rust atomic lib, `flutter/`). Flutter targets
   Wear OS; the Rust core gives real local-first commits and the existing sync
   work ([`unified-sync.md`](./unified-sync.md) "mobile same as browser")
   applies directly. Enrollment via the
   [`device-pairing.md`](./device-pairing.md) QR flow, scanned from the watch
   or provisioned via the paired phone.
2. **Native Kotlin (Wear OS) / Swift (watchOS) thin client** speaking HTTP to
   the server. Simplest to render, but not local-first: a watch on the wrist
   away from the phone loses taps, which is precisely the moment habit taps
   happen.
3. **Phone-as-gateway complication/tile**: watch UI is dumb, phone app owns
   the data. Least new surface, but requires a phone app we don't otherwise
   need, and ties the watch to phone proximity.

**Recommendation: option 1, Wear OS first.** It exercises the claim that an
external developer can build a native local-first Atomic app from the Flutter
library, and the data model was chosen to make it easy: a tap while offline is
one new `Completion` resource in the local outbox; sync later merges without
conflict by construction. The watch UI is deliberately minimal — icon grid
with today's fill state, tap to complete/+1, long-press to undo (destroy last
completion). Trends stay on phone/browser. watchOS follows only if the Flutter
lib's iOS story is proven; otherwise it waits.

## Milestones

### M1: Ontology + standalone harness

- Define the schema (code-first if available; `@tomic/cli` fallback).
- Standalone PWA: tracker grid, tap to complete, counter targets, week strip.
- Seed script for fixture habits/completions; unit tests for streak/day-count
  derivation (timezone edges: 23:59 taps, DST).

### M2: Trends

- Week heatmap and per-habit history (hand-rolled SVG).
- Completion paging strategy over sorted collections; measure at 2 years of
  fixture data.

### M3: Plugin packaging

- Package the same UI as a `@tomic/plugin` custom view for `HabitTracker`.
- Blocked on: UI-only release format, RPC `query`. Drive those items in
  `llm-wasm-gui-plugins.md` Phase 0/1 rather than working around them.

### M4: Assistant setup flow

- Habits skill (interview → propose → create on confirm).
- Verify schema discovery via `get_user_classes` with zero built-in knowledge.
- Propose and prototype install-time skill registration.

### M5: Watch

- Flutter Wear OS app: pairing, icon grid, offline tap queue, sync.
- Field-test the offline merge story (watch + phone both tapping).

## Findings This Should Produce

The dogfooding output is as important as the app. Track these explicitly:

| Gap | Feeds |
| --- | --- |
| RPC `query`/`search` unimplemented | `llm-wasm-gui-plugins.md` |
| Plugin zip requires `plugin.wasm` for UI-only apps | `llm-wasm-gui-plugins.md` |
| Plugin views unavailable offline (`/plugin-list`) | `llm-wasm-gui-plugins.md` |
| No code-first schema API shipped | `json-schema-code-first.md` |
| No range/date filters in queries | `multi-property-filter.md` / query layer |
| Apps can't ship assistant skills | new capability, `llm-wasm-gui-plugins.md` |
| Standalone local-first client DX (ClientDb outside Data Browser) | `SDK-API-design.md` tutorial |
| Watch-class device pairing + sync | `device-pairing.md`, `unified-sync.md` |

## Open Questions

- Does the page-scope RPC grant actually cover creating child resources
  (completions under the tracker), or does every tap trigger a permission
  prompt? Needs a spike before M3.
- Scheduling beyond daily (weekdays, 3×/week): property design and how streaks
  are defined for partial schedules. Deferred past M1.
- Should old completions be compacted (e.g., yearly rollup resources) once
  history is large, or is 10k+ tiny resources per year genuinely fine on the
  ClientDb? Measure in M2 before designing anything.
- Where does the app live — separate repo (the honest external-dev setup) or a
  workspace folder here for iteration speed? Leaning separate repo with a path
  dependency during development.
