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

## Decision record (proposed)

| Decision | Choice |
|---|---|
| UI framework | Keep Kotlin + Jetpack Compose (SearchLauncher) |
| Atomic binding | uniffi → `atomic-android` AAR (not FRB) |
| Store ownership | Launcher is preferred on-device Atomic host |
| Search UX | Project Atomic into AppSearch; AtomicNode owns graph/FTS |
| Quick-add | Reserved aliases + SmartActionManager; semantics from web `quickAdd` |
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
