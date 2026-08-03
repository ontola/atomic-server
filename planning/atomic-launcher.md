# Atomic Launcher — SearchLauncher × Atomic merge

> Status: exploration / recommended direction (2026-08-03). No code yet.
> Product idea: one Android home app that is a keyboard-first launcher + browser
> *and* the on-device Atomic node — search your phone *and* your Atomic graph
> from the same bar, with deep quick-actions (`Todo get bread`).

Related plans (do not duplicate; this doc owns the product merge):

- [`android-data-reuse.md`](./android-data-reuse.md) — Binder host / uniffi /
  one store per device (the runtime substrate this product needs).
- [`atomic-lib-runtime.md`](./atomic-lib-runtime.md) — `AtomicNode` as the
  HTTP-optional local runtime; search/query/mutate belong here.
- [`personal-information-suite.md`](./personal-information-suite.md) —
  contacts/calendar/mail + launcher result types / command-palette actions.
- [`actions.md`](./actions.md) — browser ⌘K actions registry (web twin of
  launcher verbs).
- [`social-apps.md`](./social-apps.md) P1.1 — extract generic mobile SDK;
  today Flutter FRB lacks query/search/typed CRUD.
- External repo: [`ontola/searchlauncher`](https://github.com/ontola/searchlauncher)
  (Kotlin + Compose + AppSearch; ~20k LOC main sources).

## Where the real value emerges

The skeptical take is fair: *Atomic can just be another app; SearchLauncher
already finds apps.* If open-Atomic → search-there is enough, a deep merge
is vanity.

**What SearchLauncher already won** (and Atomic-as-an-app never gets for
free): it *is* the home screen. Unlock / Home → keyboard. That slot is why
Alfred/Raycast matter on desktops. One tap (really: zero taps past Home)
away from a verb. We want that for Atomic — but only for the actions that
pay rent at that frequency.

### Two products, different jobs

| Job | Frequency | Needs HOME? | Enough as separate Atomic app? |
|---|---|---|---|
| Capture: `todo get bread`, `note …`, `bm` | Dozens/day | **Yes** — app switch kills it | Weak: open app → navigate → add |
| Find across *phone + graph* in one box | Many/day | **Yes** — two search boxes is the failure mode | Weak: launcher finds the *app*, not `bread` inside your table |
| Browse/edit table, doc, chat, canvas | Fewer, longer | No — full UI anyway | **Yes** — this *is* an app (or warm shell) |
| Sync / collab / multi-device | Background | No | **Yes** — pure Atomic value |
| Widgets / ambient dashboard | Glance | Nice | Optional; easy to overbuild |

**The merge's unique value is capture + unified find at the home bar** —
not "Atomic wallpaper" and not rewriting FancyTable in Compose. Everything
that needs a real editor can stay "just an app" (APK or Atomic Shell).
HOME matters because it deletes *open Atomic* from the hot path for the
verbs you run constantly.

### Three architectures (don't conflate them)

The doubt "if intents get us 80%, why merge?" mixes two different axes:

| | SearchLauncher stays HOME | Atomic is also/instead HOME |
|---|---|---|
| **Two APKs + APIs** | A. Launcher *calls* Atomic (Binder / intents) | Weird — two HOME candidates |
| **One APK embeds `atomic_lib`** | B. Launcher *is* the Atomic node | C. Rebrand: Atomic Launcher |

**Capture + unified find need (A) or (B), not a separate "open Atomic app"
flow.** They do *not* by themselves require renaming the product. The open
question is really: **what does (B)/(C) buy over (A)?** And separately:
**what does owning HOME buy that no Atomic APK can?**

### What intents / Binder already get you (the real ~80%)

If SearchLauncher remains HOME and Atomic (or an `atomic-android` host)
exposes search + commit over Binder — exactly
[`android-data-reuse.md`](./android-data-reuse.md) — you already get:

| Capability | How |
|---|---|
| Search graph from the home bar | `call("query"/"search")` → project into AppSearch / live results |
| `todo get bread` without opening Atomic UI | `call("commit")` / createChild; toast in launcher |
| Open a resource | Intent / shell Activity in either APK |
| Live updates | AIDL subscribe / `ContentObserver` |
| One logical store | Host owns redb; launcher is thin client |
| Sign-in once (first-party) | Cert-bound "act as user" tier |

So yes: **most of the Raycast loop is an API-shape problem, not a merge
problem.** A spike should assume (A) until (A) hurts.

### What owning HOME buys (vs Atomic as a normal app)

These accrue to *whoever is the default launcher* — today SearchLauncher —
whether Atomic is in-process or over Binder. This is the value you feel
("one tap away") and that a beautiful Atomic APK **cannot** buy with
polish:

1. **Default destination** — Home button / gesture / post-unlock lands on
   *your* keyboard, not an icon in a grid. Invocation tax ≈ 0.
2. **You own empty home** — wallpaper, widget host, favorites strip,
   gesture layer (swipe → tabs / drawer / QS). Atomic-the-app only gets a
   widget *on someone else's* home, if the user bothers.
3. **Always-warm interaction process** — users open HOME constantly; the
   process is hot. Great for low-latency search *and* for being the
   Atomic store host (cold-start via ContentProvider is fine; hot host is
   better).
4. **System roles that stack** — SearchLauncher already combines HOME +
   http/https VIEW (browser) + optional `ROLE_BROWSER`. One settings
   dance. A separate Atomic app that also wants browser/share defaults
   competes with the launcher for the same roles.
5. **Browser task split already designed** — browser is a separate task
   affinity so Home *returns to the search surface*. That's the
   capture-loop geometry. A second APK's Activities don't sit in that
   choreography unless carefully integrated.
6. **OS-shaped permissions** — `QUERY_ALL_PACKAGES`, usage stats, contacts,
   status-bar expand: launcher-plausible. A notes app asking for
   `QUERY_ALL_PACKAGES` is sketchy; a launcher isn't.
7. **Psychological slot** — "my phone's front door" vs "an app I use."
   Product narrative and habit formation, not a tech feature — still
   real.

**Net:** wanting Atomic *at* HOME is right. That means Atomic capability
in the HOME app's bar — not that Atomic must replace Nova/SearchLauncher
as a second launcher.

### What one-APK / in-process still buys over Binder intents (the other ~20%)

Honest list — only keep items that survive scrutiny:

| Advantage | Why intents/Binder lose |
|---|---|
| **No second install / pairing** | (A) needs Atomic host installed (or a stub). (B) works on first launcher install. Onboarding death rate matters more than IPC elegance. |
| **No grant / discovery UX** | First-party Binder still needs package presence + election. In-process: no "connect to Atomic." |
| **Keystroke latency** | Per-query Binder + host cold-start can miss the "results as I type" bar. In-process ranks apps+graph on one heap. Mitigations exist (warm host, cache in launcher) but they're work. |
| **Browser ↔ graph with zero seam** | Same process WebView → node: save bookmark, "note this page", agent cookie, warm Atomic Shell — no cross-app identity. Two APKs = grants, two backups, two possible agents. |
| **Uninstall / backup atomicity** | Host APK uninstalled ⇒ store gone (`android-data-reuse` hard problem). Launcher-as-host: uninstalling HOME is a decision users understand; data lifecycle matches the app they face daily. |
| **One default stack** | HOME + browser + graph + share target + widgets from one package. Two APKs fight for VIEW/browser/share and split widgets across packages. |
| **Single privacy / store listing story** | F-Droid/Play: one package that is local-first launcher *with* optional sync. Two packages ⇒ explain a private Binder bridge. |
| **Recents / back-stack choreography** | Home→shell→Home without "wrong task" is easier in one app (SearchLauncher already splits browser task on purpose). |
| **Host election trivial** | Launcher *is* the high-priority host; canvas binds to it. No "which APK owns redb today?" |

Soft / narrative (real for some users, not engineering proof):

- **"My OS is Atomic"** — only credible if the front door *is* Atomic-powered,
  not "my launcher talks to my Atomic app."
- **Distribution** — one viral HOME app carries the graph; a graph app
  rarely becomes HOME later.

### What is *not* an advantage of merging (don't kid yourself)

- Sync, CRDT, collab, rights — independent of launcher.
- FancyTable / TipTap / canvas — still a shell or separate UI.
- "We can search Atomic" — Binder search is enough if latency is fine.
- "We can create todos from search" — `commit` over Binder is enough.
- Ambient dashboard eye candy — optional in (A) or (B).

### Reframed recommendation

1. **Must have:** Atomic actions + search **at HOME** (keep SearchLauncher
   as HOME). This is the product instinct. Don't give it up.
2. **Start with (A):** launcher client + Atomic APIs (Binder preferred over
   flimsy intents for search-as-you-type). Validates the 80%.
3. **Graduate to (B) when (A) hurts** — usually onboarding (second APK),
   typing latency, or browser↔graph identity — by **embedding `atomic_lib`
   in the launcher** so the HOME app *is* the node. That's the meaningful
   "merge": one process owns the store. Not "rewrite SearchLauncher in
   Flutter," and not "Atomic ships a second HOME."
4. **(C) rebrand** when the graph is default-on and the listing should say
   Atomic Launcher — packaging/name, not a third architecture.

### Decision tests

**HOME value (product):**

> Home → `todo get bread` → still on Home.  
> Home → `bread` → grocery row beside Browser.

If that isn't obviously better than opening Atomic, stop.

**(A) vs (B) (engineering):**

> Two-APK Binder prototype: is first-run ("install Atomic companion?") or
> per-keystroke jank bad enough that users feel it?

If no, stay (A) and ship. If yes, embed the node in the launcher (B).

## Why this is a natural fit

SearchLauncher already is the surface Atomic wants on a phone:

| SearchLauncher today | Atomic unlock |
|---|---|
| Keyboard-first HOME search bar | Same bar over Atomic resources + apps |
| Prefix triggers (`g cats`, `cal meeting`) | `todo get bread`, `note …`, `chat …` |
| Built-in WebView browser + bookmarks/history | Bookmarks/notes as Atomic resources; sync + collab |
| AppSearch namespaces (apps, contacts, snippets, web) | New `atomic` namespace projected from the local graph |
| Snippets = clipboard paste | Structured create (table rows, chats, files) |
| No accounts / sync | Agent identity, Iroh/WS sync, multi-device |
| Launcher always present | Natural **elected Atomic host** on Android |

The user's pitch ("one app, stores data in Atomic, instantly search, better
integration for Atomic actions") matches both codebases' trajectories. The
missing piece is not UI invention — it is a **Kotlin-callable Atomic runtime**
and a thin projection of Atomic resources into SearchLauncher's search pipeline.

## What each side brings

### SearchLauncher (keep as the Android shell)

- HOME / LAUNCHER / optional AppWidget search entry.
- Unified search orchestration (`SearchRepository.searchApps`): custom
  shortcuts → smart actions → browser tabs → in-memory AppSearch snapshot →
  live web suggestions → ranking.
- Extension points already used for every local source: new AppSearch
  namespace + indexer, new `SearchResult` variant, `ResultLauncher` branch,
  `SmartActionManager` patterns, `SearchShortcut` aliases.
- WebView browser (not Custom Tabs): tabs, adblock, bookmarks (`web_saved`),
  history (`web_bookmarks`).
- On-device only today: AppSearch + DataStore + SharedPreferences + files.
  No Room, no DI framework, no sync.

Pain points for merge: fat files (`SearchRepository` ~2.2k, `SearchScreen`
~1.9k, `BrowserActivity` ~2k); flat document model; privacy story today is
"no PII to our servers" — Atomic sync must be explicit opt-in UX.

### Atomic (bring the data plane)

- Graph + Loro CRDT + signed commits + agent identity.
- Sync: WS hub and/or Iroh P2P (device pairing already in Flutter).
- Full-text search today is **server tantivy** (`GET /search`); local
  `atomic_lib` has no search feature yet (`atomic-lib-runtime.md` open Q).
- Mobile today: Flutter canvas via `flutter_rust_bridge` over `atomic_lib`
  (`db-redb`, `iroh`, `discovery`, `ws`). FRB surface mixes generic store API
  with canvas domain; **no query/search/blob** on the bridge; `create_resource`
  hardcodes Class.
- Planned Android substrate (`android-data-reuse.md`): **uniffi** Kotlin
  bindings + elected host ContentProvider/AIDL — explicitly *not* FRB, so a
  pure-Kotlin app can own the store without a Flutter engine.

There is **no Kotlin Atomic SDK in this monorepo**. The old Kotlin canvas
(`../atomiccanvas`) is historical / out of tree.

## Merge options (and the recommendation)

### Option A — Rewrite SearchLauncher in Flutter

Port launcher + WebView + AppSearch to Flutter; reuse FRB.

**Reject for this product.** SearchLauncher's value is deep Android platform
integration (HOME, AppWidgetHost, LauncherApps shortcuts, usage stats,
contacts, ROLE_BROWSER, process-isolated private browser). Flutter would fight
that stack. Canvas already chose Flutter for *cross-platform drawing*; the
launcher is Android-native by nature.

### Option B — Embed Flutter Atomic UI inside SearchLauncher

Hybrid: Kotlin launcher shell, Flutter fragments for rich Atomic pages
(tables, chats, documents).

Possible later for heavy editors, but wrong as the *first* bridge: two
runtimes, two store-open stories, and FRB still isn't the multi-app host API.
Defer until a specific screen needs TipTap/canvas-class UI on Android.

### Option C — Kotlin SearchLauncher + Rust Atomic via uniffi (recommended)

Keep SearchLauncher as the Compose UI. Add an `atomic-android` AAR (uniffi
over the generic `atomic_lib` / `AtomicNode` API). SearchLauncher is both:

1. **Host** of the device Atomic store (natural: HOME apps stay installed and
   get opened constantly — better lifecycle than a random secondary app).
2. **Product surface** that indexes Atomic into the same search bar as apps.

This is exactly `android-data-reuse.md` Phase 1's host, with SearchLauncher
(or a renamed Atomic Launcher) as the fixed/high-priority host instead of
(or alongside) the Tauri atomic-server APK.

```
┌──────────────────── Atomic Launcher (Kotlin) ─────────────────────┐
│  Search bar / HOME / WebView / widgets                             │
│         │                                                          │
│         ├─ AppSearch: apps, contacts, shortcuts, web, …            │
│         ├─ AtomicIndexer ──► AppSearch namespace `atomic`           │
│         ├─ AtomicActions ──► todo/note/chat create verbs           │
│         │                                                          │
│         ▼                                                          │
│  atomic-android AAR                                                │
│    Host: AtomicProvider + AtomicService (Binder for other apps)    │
│    Rust: atomic_lib / AtomicNode via uniffi                        │
│    Store: redb · agent · Iroh · (planned) local FTS                │
└───────────────────────────────┬────────────────────────────────────┘
                                │ Iroh / WS
                                ▼
                     other devices / hosted hub / data-browser
```

Canvas / future apps become **clients** of this host over Binder when
installed on the same phone — one store, one NodeID, one agent.

### Option D — Thin HTTP client to a remote Atomic server only

Kotlin talks JSON-AD/HTTP to a hub; no local Rust.

**Useful as a spike** (prove search results + quick-add UX in a week) but
rejects the product promise: offline launcher, instant local search, file
sync, collab without network. Keep as a fallback path inside the SDK
(`Storelike`-shaped remote), never as the architecture.

## Product surface — what "Atomic powering the launcher" means

### 1. Unified search

Query `bread` returns, ranked together:

- Apps / shortcuts (existing)
- Atomic resources: grocery row "Bread", note titled "Sourdough", chat
  mentioning bread, bookmark to a recipe
- Web / contacts (existing)

Projection: each Atomic hit → `SearchResult.AtomicResource` (subject, title,
class shortname, snippet, icon). Indexer listens to resource-change events
from the node and upserts AppSearch documents (same pattern as
`SnippetIndexer` / `ContactIndexer`).

**Search backend choice (phased):**

| Phase | Source of Atomic hits |
|---|---|
| 0 (spike) | Hub `GET /search` when online |
| 1 | Local property scan / name prefix over open drive (good enough for demos) |
| 2 | Local FTS inside `AtomicNode` (tantivy or equivalent) — required for
  "feels instant" offline; same work `atomic-lib-runtime.md` already flags |

AppSearch remains the *launcher* cache/ranker; Atomic FTS is the *source*
that feeds the `atomic` namespace. Do not try to make AppSearch the CRDT store.

### 2. Quick-create verbs ("Todo get bread")

SearchLauncher already has the grammar shape:

- **Prefix shortcut:** `todo get bread` → alias `todo`, remainder `get bread`
  (same as `g cats`, `cal meeting`).
- **Smart action:** whole-query patterns (`call …`, `4m rice`).

Recommended reserved aliases (user-editable like other shortcuts):

| Alias | Action |
|---|---|
| `todo` / `t` | Create row on the user's default Todo / Tasks table |
| `buy` / `grocery` | Create row on Grocery list template |
| `note` / `n` | Create markdown/document with title or first line |
| `bm` | Bookmark current/last browser URL into Atomic |
| `chat` | Open or create a chat; optional first message |

Implementation twin on the web: grocery-list `view-quick-add` +
`createQuickAddRow` in `browser/data-browser` (E2E already types "Bread").
Port that semantics to the node API:

```text
create_child(parent=table, class=rowClass, props={ name: remainder, …presets })
```

Needs the FRB/uniffi gap closed: **generic create** (not Class-only), parent,
typed props. Prefer implementing once on `AtomicNode`, bind via uniffi.

Ambiguity: fuzzy app search will also match "Todo". Mitigations already used
for `call`/`sms`: reserved triggers win *before* in-memory search; document
the reserved list; allow users to rebind aliases.

### 3. Browser as Atomic surface

| Browser feature today | Atomic merge |
|---|---|
| `web_saved` bookmarks | Dual-write / migrate to Atomic Bookmark resources; keep AppSearch projection |
| `web_bookmarks` history | Optional: store as Atomic History items, or leave local-only for privacy |
| Tabs | Stay process-local; optional "save tab set" as Atomic resource |
| Page → note | Action: "Save selection / page as note" → Atomic document + source URL |

Collaboration and sync come for free once bookmarks/notes are resources.
Private browser process (`:incognito`) must **not** write Atomic.

### 4. Files / sync

Launcher is not a file manager, but as Atomic host it owns blobs + Iroh.
Expose:

- Search hits for file resources / attachments.
- Optional `DocumentsProvider` facade later (`android-data-reuse` Phase 3 /
  `virtual-drive.md`) so Atomic files appear in the system picker.
- Pairing QR already designed for Flutter — reuse UX in Kotlin settings.

### 5. Collaboration

Same as data-browser: shared drives, rights, live Loro where editors exist.
Launcher itself mostly **searches and creates**; rich collaborative editing
of docs/tables can deep-link into data-browser (Custom Tab / WebView to the
user's hub) or a future embedded editor. Don't block the launcher MVP on
shipping TipTap-in-Compose.

## Presenting Atomic to the user

SearchLauncher today is almost entirely **launch-and-leave**: icon + title +
subtitle → tap → leave. Empty home is wallpaper + optional Android widgets +
favorites strip — not a content feed. Atomic should respect that grammar and
add depth only where it earns a stay-in-launcher moment.

Think in **layers**, not one mega-surface:

```
Layer 0  Identity crumbs     icon · title · class · snippet
Layer 1  Search hits         same row as apps/contacts
Layer 2  Chrome strip        favorites / recents / pinned Atomic
Layer 3  Verbs               todo/note/bm — create without opening an app
Layer 4  Ambient home        optional glance (dashboard / next actions)
Layer 5  Hosted surfaces     Atomic apps: warm PWA / WebView / plugins
Layer 6  System widgets      AppWidgetProvider(s) for glance + tap-in
```

Layers 0–3 are the MVP. 4–6 are where "Atomic feels like the OS" — and where
PWAs / widgets become first-class.

### A. Resources as search results (foundation)

Match today's `SearchResultItem`: 40dp glyph, title, one subtitle line,
overflow menu. No heavy `ResourceCard` from the web ⌘K overlay — phones need
the compact row (`ResourceRow` / `ResourceInline` shape on web).

| Field | Source |
|---|---|
| Icon | `isA` → class glyph / emoji / cover (same map as `iconMap.ts`) |
| Title | resource name / title |
| Subtitle | class shortname · parent name · snippet hit |
| Overflow | Favorite, Open, Copy link, Share, Open in browser, Quick-add sibling |

**Ranking:** boost Atomic hits that are favorites, recently opened, or match
a reserved verb's default target (Todo table). Cap Atomic rows so they don't
drown apps (e.g. interleaved, max N per namespace) — same discipline as
`LIVE_SEARCH_RESULT_LIMIT = 16`.

**Tap target by class (default):**

| Class | Tap |
|---|---|
| Table row (todo/grocery) | Toggle done / open parent table focused on row |
| Table / Folder | Open Atomic app surface (see E) |
| Document / Chat / Canvas | Open Atomic app surface |
| Bookmark / File | Open URL / viewer (browser or system) |
| Person / Event (later) | Contact/calendar actions |

Stay-in-launcher exception: **toggle done** and **quick-create confirm**
(toast + optional undo) — snippet-copy pattern, not a new detail panel.

### B. Favorites strip & recents

SearchLauncher already has an icon-only favorites/history row when the query
is empty. Atomic favorites should join it:

- Mirror data-browser's `favorites` ResourceArray on the personal drive
  (cross-device), *and* allow launcher-local favorite keys for offline speed.
- Pin high-value Atomic "apps": Todo table, Inbox chat, Today dashboard —
  they appear as icons next to WhatsApp, same muscle memory.
- Recents: data-browser only tracks recent *drives* today; launcher should
  keep a **resource MRU** (local, syncable later) so the strip stays useful.

This is the cheapest "Atomic on the home screen" — no new widgets, no PWA.

### C. Ambient home (empty-query glance) — optional, easy to overbuild

Empty home is currently atmosphere (wallpaper), not a dashboard. Resist
turning it into a Notion home by default.

Ideas, lightest first:

1. **Nothing new** — favorites strip is enough for v1.
2. **One peek chip** above the bar: "3 todos due · Grocery · 2 unread" —
   tap expands a small sheet or fills a search query (`todo `).
3. **Dashboard mode** — if the user pins an Atomic Dashboard resource as
   "home glance", render its *stat/create* blocks as a thin Compose strip
   (not the full web grid). Maps to shipped Dashboard block kinds
   (`view|stat|chart|create|text` in `dashboards.md`).
4. **Full feed** — reject for the launcher; that's the data-browser.

Rule: ambient content must be **dismissible / hideable** like widgets today
(tap wallpaper toggles widget visibility). Keyboard-first identity stays.

### D. Widgets

Two different "widget" concepts — don't conflate them:

#### D1. Host Android AppWidgets (already works)

SearchLauncher's `AppWidgetHost` can show *any* installed provider. If Atomic
Launcher (or a companion) ships `AppWidgetProvider`s, users add them via the
existing `widgets` search shortcut — zero new host UX.

Candidate Atomic AppWidgets:

| Widget | Job |
|---|---|
| **Search** | Existing SearchLauncher widget; keep |
| **Todo / Grocery** | Next N unchecked rows; tap row toggles or opens; " +" → voice/type |
| **Favorites** | Icon grid of pinned Atomic subjects |
| **Stat** | One Dashboard `stat` block (count, sum) |
| **Next event** | Personal-info suite later |

Implementation: widget process talks to the in-app Atomic host (same process
or Binder). Updates via resource watch → `AppWidgetManager.notifyAppWidgetViewDataChanged`.

#### D2. Atomic Dashboard blocks ≠ AppWidgets

Web dashboards are resources laid out in a CSS grid. On Android they should
*feed* AppWidgets (one block → one widget instance) or the ambient strip —
not be reimplemented as a second layout engine inside the launcher.

### E. Preloaded PWA / Atomic apps as first-class citizens

This is the interesting one. Atomic's rich UI (tables, TipTap docs, chats,
plugins, dashboards) already lives in the **data-browser**, which is already
a Vite PWA. The launcher should not rewrite those editors in Compose. Instead
treat **Atomic surfaces as apps** the launcher owns specially.

#### Model: Atomic App = (subject or route) + warm WebView/PWA shell

| Android app | Atomic app |
|---|---|
| APK in package manager | Resource (Table, ChatRoom, Dashboard, Plugin UI, Drive) |
| Launcher icon | Class glyph / emoji / cover |
| `am start` | Open in **Atomic Shell** (privileged WebView) |
| App drawer entry | Indexed as `SearchResult` *and* optional drawer row |

**Atomic Shell** (first-class, not "just another tab"):

- Dedicated WebView (or Custom Tab with warm process) bound to the local
  node / hub — cookies, agent, OPFS/WASM as needed.
- Preload: keep a **warm process** with data-browser assets cached (the PWA
  service worker + a small set of pin routes: `/app`, last N subjects).
- Open animation: from search row / favorite icon → shell expands like
  opening an app (SearchLauncher already does full-bleed tab swipe
  previews — reuse that feel).
- Task affinity: optional separate recents entry per pinned Atomic app
  (`documentLaunchMode` / multiple tasks) so "Todo" and "Notes" feel like
  apps in Android Recents, not browser tabs.
- Offline: shell talks to **in-process Atomic node** (Phase 1+), not only
  the network hub — this is what makes "preloaded PWA" real rather than
  "cached website".

Contrast with ordinary browser tabs: Wikipedia stays a tab; your Todo table
is an **Atomic app** with an icon in favorites and a warm shell.

#### What gets to be an Atomic app?

Ladder from `table-templates-and-mini-apps.md` fits perfectly:

1. **Any resource** — open in shell (baseline).
2. **Pinned / favorited resources** — drawer + favorites strip + warm start.
3. **Templates as installable apps** — "Install Grocery List" creates the
   table *and* pins it as an Atomic app (icon, alias `buy`, widget offer).
4. **Plugins / external mini-apps** — data-browser plugin iframe UI or a
   standalone PWA (`habits-app.md`) registered with a subject + origin;
   launcher indexes them like apps. Sandbox stays the web one; launcher
   only does discovery + open.
5. **True TWA / Play-packaged PWA** — optional later for store distribution;
   not required if the shell WebView is good.

#### Preload strategy (practical)

| When | What to warm |
|---|---|
| Launcher boot (idle) | Shell process + PWA shell assets + agent session |
| Favorite pinned | Prefetch JSON-AD + Loro snapshot for those subjects into node cache |
| User types `todo` | Ensure Todo table shell route is ready before Enter |
| After create verb | Open shell on the new/ parent resource *or* stay with toast — user preference |

Don't preload the entire drive into a WebView. Preload **shell chrome +
pins**; everything else is node-backed and fetched on open.

### F. App drawer parity

SearchLauncher's swipe-up app drawer is currently Android packages only.
Options:

- **A.** Atomic apps appear in the **same drawer**, sectioned ("Atomic" /
  "Apps") or merged by usage ranking.
- **B.** Drawer stays Android-only; Atomic apps are search + favorites only.
- **C.** Typing in drawer search already hits unified search — enough.

Lean **C then A**: unified search first; if pinned Atomic apps feel
second-class next to APKs, merge into the drawer with a clear glyph badge
("A" / Atomic mark) so users know what's local-graph vs Play app.

### G. Browser chrome integration

Because the launcher *is* the browser:

- Address bar / overflow: **Save to Atomic**, **Open related resources**
  (backlinks later), **Share drive link**.
- Bookmarks folder = Atomic Bookmark table (or dual-write).
- A warm Atomic Shell tab can sit in the tab strip like other tabs *or*
  be excluded from the normal tab overview and only appear as an app —
  product choice. Recommendation: **pinned Atomic apps ≠ tabs**; ad-hoc
  "open this resource" may reuse a shell tab.

### H. Presentation anti-patterns

- Recreating TipTap / FancyTable / canvas in Compose for v1.
- Turning empty HOME into a widget-dense dashboard by default.
- Showing full web `ResourceCard` stacks in the results list.
- Treating every resource as an "installed app" (icon explosion) — pin /
  favorite / template-install should be explicit.
- Loading the data-browser from the network on every open with no warm
  shell (feels like a bookmark, not a first-class app).

### I. Suggested presentation roadmap

| Step | Ship |
|---|---|
| P0 | Compact Atomic search rows + overflow Favorite/Open |
| P1 | Favorites strip includes Atomic pins; `todo`/`note` verbs with toast |
| P2 | Atomic Shell WebView (warm PWA) for Open; bookmarks dual-write |
| P3 | Todo/Grocery `AppWidgetProvider`; optional ambient peek chip |
| P4 | "Install as Atomic app" from templates; drawer section; Dashboard→widget |
| P5 | Plugin/mini-app registration; personal-info result types + actions |

### J. Open product questions (presentation)

1. **Open vs stay:** after `todo get bread`, toast-only or jump into the
   Todo Atomic app?
2. **Shell vs tab:** are Atomic apps in the browser tab overview or only in
   Recents/favorites?
3. **Whose UI kit renders tables on phone —** data-browser PWA in shell
   (reuse everything) vs a future native Compose table for the hottest
   paths (Todo)? Recommendation: shell first; native only if shell latency
   fails the "feels like an app" test.
4. **Default pins on first Atomic sign-in:** auto-create Grocery + Tasks
   templates and pin them?
5. **Multi-drive:** favorites strip mixed across drives, or drive switcher
   first?

## Runtime / FFI — answer to "do we need Rust FFI to Kotlin?"

**Yes.** Prefer **uniffi**, not ad-hoc JNI and not `flutter_rust_bridge`.

| Approach | Fits Atomic Launcher? |
|---|---|
| FRB (current Flutter path) | No — requires Flutter engine; canvas-mixed API; wrong host story |
| Hand-written JNI | Possible (old atomiccanvas did this for Loro) — high maintenance |
| **uniffi → Kotlin** | Yes — same recommendation as `android-data-reuse.md` / `virtual-drive.md` |
| Kotlin rewrite of atomic_lib | No — Loro/Iroh/redb stack is Rust |

Work items (aligned with existing plans, ordered for this product):

1. **Extract generic store/node API** from `flutter/rust/src/api/simple.rs`
   into a shared crate / `AtomicNode` surface (db, agent, drive, resource,
   query, search, blobs, sync) — canvas stays a consumer.
2. **`atomic-ffi` + uniffi** generating Kotlin (and later Swift) bindings.
3. **`atomic-android` AAR**: host ContentProvider/AIDL + client SDK +
   SearchLauncher embeds host role.
4. **Local search** on the node (or an Android-side indexer that walks
   resources) so the launcher is not hub-dependent.
5. **Quick-create + watch APIs** for the indexer and verbs.

Pitfalls already known from Android Atomic work: rustls-platform-verifier JNI
init before HTTPS; `store.flush()` after critical writes (host can be killed
when unbound); never put the provider in a separate `android:process`.

## Repo / packaging strategy

Three viable packaging shapes:

| Shape | Pros | Cons |
|---|---|---|
| **A. Monorepo module** — `android/launcher` in atomic-server, depends on `atomic-android` | One CI, shared planning, version lock | SearchLauncher is public/F-Droid-shaped; Atomic core is heavier |
| **B. SearchLauncher stays its repo; depends on published `atomic-android` AAR** | Clean OSS boundary; F-Droid-friendly if AAR is reproducible | Two repos to land features; version skew |
| **C. Soft merge** — Atomic Launcher forks/rebrands SearchLauncher; upstream optional | Clear product name; host priority metadata | Community fork cost |

**Recommendation:** start with **B** (or B→C): keep
`ontola/searchlauncher` as the UI repo; land `atomic-ffi` /
`atomic-android` in this monorepo; publish or path-include the AAR. Rebrand
to "Atomic Launcher" when the Atomic path is default-on, not a settings
toggle. Avoid stuffing Compose UI into `atomic-server` until the FFI crate
is stable.

F-Droid / privacy: SearchLauncher's current promise is local-first with
optional crash reporting. Atomic sync is compatible if: default offline,
hub/Iroh opt-in, clear disclosure, no surprise network on typing.

## Phasing

### Phase 0 — Product spike (no uniffi yet)

Prove the UX inside SearchLauncher against a **remote** hub:

- Settings: agent secret + server URL (paste from data-browser / QR).
- Kotlin HTTP client: `GET /search`, `POST /commit` (or minimal JSON-AD
  create via existing HTTP API).
- `SearchResult.Atomic` + ranking boost.
- Alias `todo` → create grocery/task row via HTTP.

Goal: feel the "Todo get bread" loop on a real phone. Accept online-only.
Throw away or thin-wrap this client once uniffi lands.

### Phase 1 — Local node in-process (uniffi)

- Land `android-data-reuse` Phase 1 extract + uniffi AAR.
- SearchLauncher opens local Db (standalone host); optional hub sync.
- Replace HTTP spike with in-process calls.
- Indexer: watch → AppSearch `atomic` namespace.
- Bookmarks dual-write optional.

### Phase 2 — Host for other Atomic apps

- ContentProvider/AIDL on; election metadata priority high for the launcher.
- Canvas (Flutter) uses `IpcAtomicClient` when launcher is installed.
- One Iroh NodeID for the device.

### Phase 3 — Deep Atomic launcher

- Local FTS; reserved verb pack; browser→Atomic notes; file search;
  personal-info suite result types (people, events, mail) as those ontologies
  land; third-party grants.

## What not to do

- Don't port the launcher to Flutter to "reuse the Dart SDK."
- Don't make AppSearch the source of truth for Atomic resources.
- Don't ship a second Iroh node inside the launcher *and* canvas without
  Binder host election (the duplication `android-data-reuse` exists to kill).
- Don't block MVP on collaborative rich-text in Compose — deep-link to web
  or wait for a shared editor.
- Don't treat "Dart library" as the blocker; the real blocker is **generic
  node API + uniffi**, which Flutter also needs.

## Open questions

1. **Product name / default:** Atomic Launcher as SearchLauncher mode vs
   separate package id (`dev.atomicdata.launcher` vs `com.searchlauncher.app`)?
2. **Default Todo target:** fixed well-known table on the personal drive,
   user-picked table in settings, or create grocery template on first use
   (like data-browser templates)?
3. **History privacy:** keep browse history local-only forever, or offer
   Atomic sync with a hard opt-in?
4. **SearchLauncher OSS relationship:** always-upstreamable feature flags vs
   product fork?
5. **Local FTS engine:** embed tantivy in `atomic_lib` (binary size on
   Android) vs lighter index for launcher projection only?
6. **Does the dedicated daemon APK ever make sense** if the launcher is the
   high-priority host? (`android-data-reuse` OQ — likely "no" if launcher
   is the flagship Android app.)
7. **Presentation** — see §J under "Presenting Atomic to the user"
   (open-vs-stay after create, shell-vs-tab, native Compose vs PWA shell,
   default pins, multi-drive favorites).

## Decision record (proposed)

| Decision | Choice |
|---|---|
| UI framework | Keep Kotlin + Jetpack Compose (SearchLauncher) |
| Atomic binding | uniffi → `atomic-android` AAR (not FRB) |
| Store ownership | Launcher is preferred on-device Atomic host |
| Search UX | Project Atomic into AppSearch; AtomicNode owns graph/FTS |
| Quick-add | Reserved aliases + SmartActionManager; semantics from web `quickAdd` |
| Presentation MVP | Compact search rows + favorites pins + create toasts |
| Rich Atomic UI | Warm **Atomic Shell** (data-browser PWA in privileged WebView), not Compose rewrite |
| Home widgets | Ship real `AppWidgetProvider`s; map Dashboard blocks → widgets later |
| Empty home | Keep atmosphere-first; optional peek chip, not a feed |
| First milestone | Phase 0 HTTP spike for UX; Phase 1 uniffi local node |
| Packaging | FFI in atomic-server monorepo; launcher stays/ evolves in its repo |

## Immediate next steps (when building)

1. Sketch Kotlin interfaces: `AtomicNodeFacade` (search, get, createChild,
   watch) matching the extract from `simple.rs` + gaps (query/search).
2. Phase 0 spike PR on `searchlauncher`: Atomic settings + search results +
   `todo` alias against a dev hub.
3. In this repo: start `android-data-reuse` Phase 1 extract (blockers for
   both canvas multi-app *and* launcher).
4. Update this doc when Phase 0 teaches alias/ranking/privacy lessons.
