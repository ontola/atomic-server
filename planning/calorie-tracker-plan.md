# Calorie Tracker — Technical Plan

Companion to [calorie-tracker-app.md](./calorie-tracker-app.md). This document turns the high-level
plan into concrete architecture, a data model, and a phased build plan an AI agent can execute
step by step. The target directory is `calorie-tracker/` at the repo root (already created, empty).

## 1. What already exists in this repo (reuse it)

The `flutter/` directory (Atomic Canvas) is a working Flutter + Rust app that already solves the
hard infrastructure problems this app needs:

| Asset | Location | What it gives us |
| --- | --- | --- |
| Atomic Dart SDK | `flutter/lib/atomic/` | `AtomicClient` (db, agent, drive, resource CRUD, history, peer sync), `AtomicSession` (secure secret storage + prefs), `AtomicStore` (ChangeNotifier cache), auth/QR widgets |
| Rust FRB crate | `flutter/rust/` | Wraps `atomic_lib` (path `../../lib`) via flutter_rust_bridge 2.12 with features `db-redb`, `iroh`, `discovery`, `ws`. Generic API already includes `open_db`, `setup`, `load_agent`, `create_drive`, `create_resource`, `set_property`, `get_property`, resource history, ws sync to atomic-server, and Iroh peer sync |
| Build scaffolding | `flutter/rust_builder/`, `flutter/flutter_rust_bridge.yaml`, `flutter/Makefile`, `flutter/dev.sh` | Cross-platform Rust build integration, FIFO-based hot reload from any terminal, per-target logs |
| Onboarding pattern | `flutter/lib/atomic/widgets/`, `session.dart` | "New agent or import existing secret (QR scan / paste)" flow — exactly what the calorie app onboarding needs |

The Atomic Canvas README already notes that `lib/atomic/` is a general-purpose SDK that should be
extracted into a reusable package. **This project forces that extraction** (see Phase 0, decision below).

What does *not* exist yet and must be built:

- Meal-specific data model + Rust API (`create_meal`, `list_meals`, `update_meal`, day queries).
  The canvas CRUD (`create_canvas`, `list_canvases`, …) is the template to mirror.
- Camera-first UI, capture queue, and the LLM estimation pipeline.
- OpenRouter OAuth (PKCE) + vision chat-completion client (pure Dart, no Rust needed).
- Local notifications, day summary/history screens, Health integration.

## 2. Architecture overview

```
┌────────────────────────── Flutter (Dart) ──────────────────────────┐
│  UI: CaptureScreen (camera) · TextEntryScreen · TodayScreen        │
│      HistoryScreen · SettingsScreen · Onboarding                   │
│                                                                    │
│  State: MealStore (ChangeNotifier)   EstimationQueue (worker)      │
│                    │                        │                      │
│  Services:  AtomicClient (FRB)      OpenRouterClient (http)        │
│             AtomicSession           ImageStore (files)             │
│             NotificationService                                    │
└───────────┬────────────────────────────────────────────────────────┘
            │ flutter_rust_bridge
┌───────────▼───────────── Rust ─────────────────────────────────────┐
│  calorie-tracker/rust → atomic_lib (redb local db, iroh sync, ws)  │
│  Meal CRUD + day-range queries + generic agent/drive/sync API      │
└────────────────────────────────────────────────────────────────────┘
```

Principles:

- **No backend server.** All data local (redb via `atomic_lib`); sync is optional and explicit
  (atomic-server ws sync or Iroh peer sync — both already implemented in the Rust crate).
- **Capture is decoupled from estimation.** Taking a picture only writes a file + a `pending`
  Meal resource. The estimation queue processes pending meals whenever the app is running.
  The user can kill the app immediately after the shutter; the meal is estimated on next launch
  (background execution is a stretch goal, see §10).
- **Photos are local files**, not atomic resources. Meals store a relative file path. Syncing
  images is out of scope for v1 (open question for later).
- **Photos are a cache, meals are the data.** Images are heavily compressed at capture and live
  under a total disk budget; the oldest ones are evicted when it's exceeded (§6). A meal outlives
  its photo — nothing in the record depends on the file still being there.
- **LLM calls happen in Dart**, not Rust — it's a plain HTTPS call to OpenRouter and Dart has
  the better ecosystem for OAuth redirects, and it keeps the Rust crate app-agnostic.

## 3. Project layout

```
calorie-tracker/
  pubspec.yaml                 # name: calorie_tracker
  flutter_rust_bridge.yaml
  Makefile / dev.sh            # copied from flutter/, device ids adjusted
  rust/                        # FRB crate: rust_lib_calorie_tracker
    Cargo.toml                 # atomic_lib = { path = "../../lib", ... }
    src/api/simple.rs          #   generic agent/drive/sync API (copied), stays app-agnostic
    src/api/meals.rs           #   the meal API — everything this app owns
  rust_builder/                # copied from flutter/rust_builder, crate name adjusted
  lib/
    main.dart                  # fast path: init camera first, rust db in parallel
    atomic/                    # the SDK copied from flutter/lib/atomic (see Phase 0 decision)
    models/meal.dart           # Meal, MealStatus, localDayBounds, DaySummary
    services/
      app_session.dart         # who is signed in and where their meals go; owns the boot
      meal_store.dart          # one day's meals + the writes to them, ChangeNotifier
      estimation_queue.dart    # drains pending meals through the LLM
      openrouter.dart          # OAuth PKCE + /chat/completions + /models
      image_store.dart         # save/load capture files, thumbnails, disk budget + eviction
      notifications.dart
    screens/
      capture_screen.dart      # camera-first home
      today_screen.dart        # home until the camera lands
      meal_entry_sheet.dart    # type a meal, or correct one — the plan's TextEntryScreen,
                               #   as a sheet: three fields do not want a screen
      account_screen.dart      # agent + secret, until Settings exists
      history_screen.dart
      settings_screen.dart
      onboarding/
    theme.dart
  integration_test/
  test/
```

**Phase 0 decision — copy, don't extract yet.** Extracting `flutter/lib/atomic/` + the Rust crate
into a shared package first would be the "right" thing, but it blocks all app work behind a
refactor of a working app. Instead: copy the SDK layer into `calorie-tracker/`, delete the
canvas-specific parts (canvas CRUD, strokes, folders, undo), and file the extraction as a
follow-up once both apps' needs are known. Keep the copied files structurally identical to
upstream so the later merge is mechanical.

## 4. Data model (atomic data)

One class, flat, queryable by day. Subjects live under the user's drive (created via the existing
`create_resource(parent, name)` pattern; meals are children of a `meals` container resource).

**Class `Meal`** (`https://atomicdata.dev/classes/Meal`) — properties
(shortname → datatype → notes; subjects are camelCase under `https://atomicdata.dev/properties/`,
shortnames kebab-case, per repo convention):

| Property | Datatype | Notes |
| --- | --- | --- |
| `name` | string | *existing core property* — e.g. "Cappuccino with oat milk"; empty until estimated |
| `description` | string | *existing core property* — LLM's reasoning / user's typed text |
| `calories` | integer | best estimate, kcal |
| `calories-min` (`caloriesMin`) | integer | lower bound |
| `calories-max` (`caloriesMax`) | integer | upper bound |
| `consumed-at` (`consumedAt`) | timestamp | when the picture was taken / entry made |
| `image-path` (`imagePath`) | string | relative path inside app documents dir; empty for text entries |
| `meal-status` (`mealStatus`) | atomicURL, `allows-only` | Tags: `pending` · `estimating` · `estimated` · `confirmed` · `needs-info` · `failed` |
| `estimate-confidence` (`estimateConfidence`) | atomicURL, `allows-only` | Tags: `high` · `medium` · `low` (from the LLM) |
| `estimated-by-model` (`estimatedByModel`) | string | OpenRouter model id used |
| `clarifying-question` (`clarifyingQuestion`) | string | what the estimator could not tell; set with `needs-info`, cleared when a later estimate has nothing to ask (added in Phase 4) |
| `meal-notes` (`mealNotes`) | string | what the *eater* wrote — the answer to a `clarifying-question`, or detail typed by hand. The one text no estimate writes, which is what stops the clarify loop feeding the model its own last answer (added in Phase 5) |
| `protein-grams` / `carbs-grams` / `fat-grams` | float | optional macros, nice-to-have from the same LLM call |

(`status` and `model` get prefixed subjects because bare `https://atomicdata.dev/properties/status`
/ `…/model` are too generic to claim for this app. Confirmed against `lib/src/urls.rs`: `STATUS` is
already the server ontology's endpoint-response status, so the bare name was never available.)

The class **requires only `consumed-at` and `meal-status`**. A meal is created the instant it is
captured, before anyone knows what it was, so nothing else can be required of it — and `calories`
is `Option` all the way up to the UI for the same reason: "not estimated yet" is not "zero
calories", and a day total that conflates them is wrong in the direction that matters.

Implementation notes:

- **The ontology lives in `atomic_lib`, not in the app.** Follow the existing pattern used by
  `meeting.json` / `chatroom.json`:
  1. Create `lib/defaults/calorie-tracker.json` defining every new Property and Class as JSON-AD
     resources: properties with `@id` `https://atomicdata.dev/properties/<camelCase>` (e.g.
     `caloriesMin`, `consumedAt`), `isA: [Class Property]`, `datatype`, `description`,
     `shortname` (kebab-case), `parent: https://atomicdata.dev/properties`; the `Meal` class at
     `https://atomicdata.dev/classes/Meal` with `requires`/`recommends`, `parent:
     https://atomicdata.dev/classes`. Reuse existing core properties where they fit (`name`,
     `description`) instead of minting duplicates.
     **`allows-only` only accepts subjects** — a plain `"pending"` in that list fails the JSON-AD
     import with "Unable to parse string as URL". So the enums are `atomicURL` properties whose
     allowed values are Tag resources hanging under the property itself
     (`…/properties/mealStatus/pending`), following the `role` property in `ai.json`. The Rust
     bridge speaks the shortnames and converts at the boundary, so nothing above `meals.rs` —
     Dart included — ever handles a tag URL.
  2. Register it in `populate_default_store` in `lib/src/populate.rs` with a
     `store.import(include_str!("../defaults/calorie-tracker.json"), …)` block like the others —
     then it's seeded into every store by `bootstrap`, including the app's local redb store.
  3. Add the subject `const`s to `lib/src/urls.rs` (e.g. `pub const CALORIES: &str = "https://atomicdata.dev/properties/calories";`)
     so the app's Rust API uses `atomic_lib::urls::CALORIES` — no app-local ontology module.
  4. The Dart side needs no mirror of the constants: `MealItem` crosses the bridge as a typed
     struct, so the only vocabulary Dart holds is the status shortnames in `MealStatus`.
- Verify the seeding with a `lib` test that runs `bootstrap` on a fresh store and resolves the
  `Meal` class and each property (this also catches JSON-AD typos at test time rather than at
  first app launch).
- **Day queries in Rust**: add `list_meals(from_ms, to_ms) -> Vec<MealItem>` using
  `atomic_lib::storelike::Query` filtered on parent (like `list_canvases`) then filtered/sorted
  by `consumed-at` in Rust. Returning a typed `MealItem` struct (FRB generates the Dart class)
  avoids JSON-in-string plumbing.
- Daily summary = sum over `list_meals(day_start, day_end)` in Dart. No separate summary resource
  (avoids sync conflicts; recomputing is cheap).

**New Rust API surface** — in `rust/src/api/meals.rs`, *not* `simple.rs`: that file is a copy of
the canvas bridge and stays app-agnostic so the two crates can be merged mechanically (§10).

Built in Phase 2:

```rust
pub async fn create_meal(consumed_at_ms: i64, name: String, notes: String, image_path: String, calories: Option<i64>) -> Result<String, String>;
pub async fn update_meal(subject: String, name: Option<String>, notes: Option<String>, calories: Option<i64>) -> Result<(), String>;
pub async fn set_meal_status(subject: String, status: String) -> Result<(), String>;
pub async fn list_meals(from_ms: i64, to_ms: i64) -> Result<Vec<MealItem>, String>;
```

`calories` on `create_meal` decides the status, because those are the same fact: a number somebody
typed is `confirmed` and no estimator may overwrite it, while no number is `pending` — the queue
Phase 4 drains. `update_meal`'s `None` means "leave this alone"; setting `calories` confirms the
meal for the same reason. `list_meals` is half-open, `[from_ms, to_ms)`, so a meal at exactly
midnight belongs to one day and not two; the caller works out where its local midnights fall
(`localDayBounds` in `lib/models/meal.dart`).

Deleting goes through the generic `delete_resource` in `simple.rs` — a `delete_meal` alias would
add nothing.

`create_meal` takes `notes` rather than the `description` this section originally sketched, and
`update_meal` likewise: at the moment a meal is logged nothing has estimated it, so every word about
it is the eater's, and `description` is only ever written by an estimate (see `meal-notes` above).

Phase 4 added:

```rust
pub async fn update_meal_estimate(subject: String, estimate: MealEstimate) -> Result<(), String>; // sets name/calories/bounds/macros/confidence/model/question, status=estimated|needs-info
pub async fn list_pending_meals() -> Result<Vec<MealItem>, String>; // pending + estimating, oldest first
```

Phase 5 added:

```rust
pub async fn get_meal(subject: String) -> Result<Option<MealItem>, String>; // what a notification tap resolves through
```

`Option` rather than an error: a tap arrives holding a subject and nothing else, and the meal it
names may have been deleted or answered on another device while the notification sat on a lock
screen. That is an ordinary outcome, not something to show anybody.

`estimate` is a typed struct rather than the JSON string this section originally sketched, for the
same reason `MealItem` is one. `update_meal_estimate` leaves a `confirmed` meal untouched and
returns `Ok`: a number a human typed beats an estimate that was in flight when they typed it, and
that is two correct behaviours racing rather than anybody's mistake.

## 5. LLM integration (OpenRouter)

**Auth — OAuth PKCE** (no client secret, made for native apps):

1. Generate `code_verifier`, derive S256 `code_challenge`.
2. Open `https://openrouter.ai/auth?callback_url=<redirect>&code_challenge=<c>&code_challenge_method=S256`
   via `flutter_web_auth_2` (handles the custom-scheme redirect on both platforms).
   Redirect: `caltracker://oauth` (register the scheme in Info.plist / AndroidManifest).
3. Exchange: `POST https://openrouter.ai/api/v1/auth/keys` with `{code, code_verifier, code_challenge_method}` → `{key}`.
4. Store the key with `flutter_secure_storage` (same pattern as the agent secret in `AtomicSession`).

**Auth — a pasted key**, the second way in: a field on the Estimates screen for a key made by hand
on openrouter.ai/keys, for anyone who would rather not hand this app an OAuth session, and the only
way in where the browser round trip is awkward (a simulator, a desktop build). It lands in the same
keychain slot, so everything downstream is identical. `useKey` checks it with `GET /api/v1/key`
before storing it: an unchecked typo is silent until the next meal, which then fails on a 401 the
queue will not retry.

**Model selection**: `GET /api/v1/models`, filter to models whose `architecture.input_modalities`
includes `image`, show in Settings with a sane default. Phase 4 settled on `openai/gpt-5.6-luna`
— cheap, fast, good vision, `structured_outputs` — measured at ~$0.0002 a meal against the live
API. The catalogue is public, so the picker works before anyone has signed in.

**Estimation call**: `POST /api/v1/chat/completions` with the photo as a base64 data-URL
`image_url` part — read straight off disk, no resize step here: the stored file is *already* the
compressed ≤1024px version (§6), which is what makes the vision call cheap,
plus `response_format: {type: "json_schema"}` enforcing:

```json
{
  "name": "string",
  "description": "string",
  "calories": "integer",
  "calories_min": "integer",
  "calories_max": "integer",
  "protein_g": "integer", "carbs_g": "integer", "fat_g": "integer",
  "confidence": "high | medium | low",
  "clarifying_question": "string | null"
}
```

The prompt instructs: estimate portion size from visual cues; if genuinely ambiguous (e.g. glass
of white liquid — milk or oat milk?), set `confidence: low` and fill `clarifying_question`.
Text entries use the same schema with the typed description instead of an image.

**Estimation queue** (`estimation_queue.dart`):

- On app start and on every new capture: fetch `list_pending_meals()`, process sequentially
  (one in-flight call; retry with backoff, max 3, then `status=failed` with a tap-to-retry row).
- `confidence: low` → `status=needs-info`, schedule a local notification ("What was in that
  drink?") that deep-links to the meal's detail sheet where the user adds text; the answer is
  appended and the meal re-estimated.
- No API key yet → meals stay `pending`, Today screen shows a "Connect OpenRouter" banner.

## 6. Image storage — compression and disk budget

Photos are the only part of this app that grows without bound, and they cost twice: every pixel
sent to the vision model is billed, and every byte kept is device storage the user never asked us
for. Both problems have the same answer — **store small, and cap the total.**

**These two costs have different levers, and it matters which is which.** Vision models bill by
*pixel dimensions*, not by file size: Claude charges `⌈w/28⌉ × ⌈h/28⌉` visual tokens, OpenAI tiles
at 512px, Gemini tiles similarly. A 1024×768 photo is ~1040 visual tokens whether it arrives as a
40 KB WebP or a 400 KB JPEG. So:

- **Resolution is the token lever.** It's already set at 1024px, which is why the LLM cost is a
  rounding error — ~1040 tokens/meal, ~$0.05/month at 5 meals/day on a cheap vision model. There
  is no compression trick that improves on this; only sending fewer pixels would, at the cost of
  the portion-size detail the estimate depends on.
- **File format and quality are the disk lever, and only that.** Which is what the budget below is
  for.

Worth knowing when tuning quality down: Anthropic's vision guide explicitly warns that lossy
artifacts degrade model accuracy, *especially after multiple compression passes*. q80 in one pass
is the floor for that reason — chasing bytes below it trades estimate quality for storage we're
already capping by other means.

**Compress once, at capture. Keep one copy plus a thumbnail.** The full-resolution frame off the
sensor (2–5 MB) is never written to disk. `ImageStore.save()` takes the camera bytes, re-encodes,
writes the result, and drops the original. There is no "original" to fall back to — deliberately:
a second copy would double storage to serve a use case (re-crop, re-estimate at higher fidelity)
that v1 doesn't have, and the LLM never sees more than the compressed version anyway.

| Artifact | Longest edge | JPEG quality (§6.1) | Typical size | Used for |
| --- | --- | --- | --- | --- |
| Camera capture | `ResolutionPreset.high` (~1280) | — | in memory only | never written |
| Stored image | 1024 px | 80 | 100–200 KB | detail view **and** the LLM call |
| Thumbnail | 256 px | 70 | 10–20 KB | Today/History lists |

Use `flutter_image_compress` (native codecs, ~10× faster than the pure-Dart `image` package —
this runs on the shutter path, where §7's <1s budget lives). Re-encoding also **strips EXIF**,
which drops GPS coordinates from every food photo: a privacy win we get for free.

At ~200 KB per meal and 5 meals/day that's ~1 MB/day, ~360 MB/year — small enough that most users
never hit the cap, which is the point.

### 6.1 Why JPEG and not WebP / AVIF / HEIC

Verified against the vision docs of the three providers that OpenRouter routes most traffic to,
plus Flutter's own decoder support:

| Format | Claude | OpenAI | Gemini | Flutter display | `flutter_image_compress` encode |
| --- | --- | --- | --- | --- | --- |
| **JPEG** | ✅ | ✅ | ✅ | native | ✅ every platform |
| **WebP** | ✅ | ✅ | ✅ | native | Android native; **iOS via SDWebImageWebPCoder, "noticeably slower"** |
| **HEIC** | ❌ | ❌ | ✅ | ✗ | iOS 11+ / Android API 28+ *with* a working hw encoder |
| **AVIF** | ❌ | ❌ | ❌ | ✗ (needs `flutter_avif`) | ✗ |

- **AVIF is out.** No major vision API accepts it, Flutter can't display it without pulling in
  `flutter_avif`/libavif, and no mainstream Flutter encoder produces it. It would mean transcoding
  to JPEG for every LLM call — a second lossy pass, which is exactly what Anthropic warns costs
  accuracy. Best compression of the four, and unusable for us.
- **HEIC is out** for the same shape of reason: Claude and OpenAI both reject it, Flutter can't
  render it, and even the encoder is conditional on device hardware.
- **WebP is genuinely viable** — every provider above takes `image/webp`, Flutter renders it
  natively — and buys ~25–30% at equal quality (~140 KB instead of ~200 KB, stretching the default
  budget from ~8 to ~11 months). Two things keep it out of v1: iOS encoding goes through
  SDWebImageWebPCoder, which the package's own docs call noticeably slower than JPEG, and that
  lands squarely on the shutter path; and the model picker lets users select *any* vision model on
  OpenRouter, including open-weight ones served by third parties whose image handling is
  undocumented. JPEG is the one format nothing refuses.

**Decision: JPEG for v1, held in a single constant.** `ImageStore` names its format and quality in
one place so a switch is a one-line change, and the stored path's extension drives the mime type
sent to OpenRouter — so a mixed-format store (some JPEG, some WebP) is already valid, which is what
makes a later migration a no-op for existing photos. Revisit after Phase 4 with numbers, not
guesses: measure iOS WebP encode time on the shutter path, measure the real byte saving on actual
food photos, and confirm `image/webp` against the two or three models people actually pick. Note
that the tradeoff is entirely about disk — per §6 above, WebP saves zero tokens.

If WebP does land, follow the package's own advice and catch `UnsupportedError` with a JPEG
fallback rather than assuming device support.

**Disk budget.** `ImageStore` enforces a total byte budget over its directory, default **250 MB**
(≈8 months of typical use), configurable in Settings (100 MB / 250 MB / 1 GB / unlimited). The
running total is tracked in a `SharedPreferences` counter updated on every write and delete, with
a full `Directory.list()` recount on app start (cheap for a few thousand files, and it self-heals
drift from crashes).

**Eviction — oldest first, and never something still in flight:**

1. Sweep runs after each capture and once on app start, only when total > budget.
2. Walk meals oldest `consumed-at` first, delete the **full image** of each, stop as soon as the
   total is back under the budget minus a 10% hysteresis margin (so a sweep frees real headroom
   instead of re-triggering on the next shot).
3. **Skip any meal whose status is `pending`, `estimating`, or `needs-info`** — the estimation
   queue still needs that file. A backlog large enough to fill the budget on its own is a bug,
   not a storage problem; log it rather than deleting the queue's input.
4. **Thumbnails are never evicted.** At ~15 KB they're ~7% of the full image, so a decade of
   history costs ~10 MB — keeping them means old days still *look* like meals after their photos
   are gone.
5. Orphan sweep in the same pass: image files not referenced by any meal (crash between file write
   and resource write) are deleted outright.

Eviction is silent — no notification, no confirmation. It's a cache policy, not a deletion the
user needs to weigh in on; the meal, its calories and its thumbnail all survive.

**When a photo is gone**, the meal is untouched (the ontology needs no new property for this —
`image-path` stays, the file just isn't there). The detail sheet shows the thumbnail with a
"photo removed to free up space" note, and *re-estimate is disabled* for that meal. Every read
path must tolerate a missing file; `ImageStore.load()` returns null rather than throwing.

```dart
// services/image_store.dart
Future<StoredImage> save(Uint8List cameraBytes);  // compress → write image + thumb, return paths
Future<File?> load(String relativePath);          // null if evicted
Future<int> totalBytes();
Future<int> sweep({required int budgetBytes});    // returns bytes freed
```

## 7. UX / screens

- **CaptureScreen (home)**: full-screen camera preview, big shutter button. Overlaid: today's
  running kcal total (top), buttons for keyboard entry, history, settings (bottom). Shutter →
  thumbnail flies to a small "logged ✓" chip → user can close the app. No blocking on the LLM.
- **Startup speed is a feature**: `main()` shows the camera preview immediately;
  `AtomicClient.openDb` + queue drain run in parallel behind it. Target < 1s to live preview on
  mid-range hardware. Measure with a startup timeline test before optimizing further.
- **TextEntryScreen**: text field ("2 slices of margherita pizza"), optional amount; same pipeline.
- **TodayScreen**: total + min/max range for today, list of meals with thumbnail, name, kcal,
  status chips for pending/needs-info/failed. Tap → detail sheet (edit, confirm, re-estimate, delete).
- **HistoryScreen**: calendar/list of past days with daily totals; taps into a day view.
- **SettingsScreen**: OpenRouter connect/disconnect + model picker; agent info + secret export
  (QR, reusing the canvas widgets); sync (server URL / peer pairing — reuse canvas UI later);
  photo storage (§6: current usage vs. budget, budget picker, "delete all photos now");
  Health integration toggle.
- **Onboarding** (first launch only): one screen — "Create new agent" (default, zero-input) or
  "Import existing" (QR scan / paste secret). Then straight to CaptureScreen; OpenRouter connect
  is prompted contextually on first capture, not in onboarding, to keep the entry barrier low.

## 8. Phased build plan

Each phase ends green: `flutter analyze`, `flutter test`, and `cargo test` in `rust/` pass, and
the acceptance criteria are demonstrated (integration test or manual run via `make`).

### Phase 0 — Scaffold (the starting point; see §9) ✅ done

Copy the Atomic Canvas skeleton into `calorie-tracker/`, rename crate/app ids, strip canvas code.
**Accept:** app builds & runs on iOS sim + Android, shows a placeholder home screen, Rust FRB
call round-trips (`setup()` creates an agent), `cargo test` + `flutter analyze` pass.

### Phase 1 — Atomic foundation ✅ done

Onboarding flow (new/import agent), `AtomicSession` persistence, drive + `meals` container
created on first run. **Accept:** fresh install → onboard → kill → relaunch restores agent;
integration test covers create-and-restore.

### Phase 2 — Meal model + manual entry (no camera, no LLM yet) ✅ done

Ontology first, in `atomic_lib` (see §4): `lib/defaults/calorie-tracker.json`, its import in
`populate_default_store` (`lib/src/populate.rs`), constants in `lib/src/urls.rs`, plus a seeding
test. Then meal CRUD in the app's Rust crate, `MealStore`, TextEntryScreen with *manual* kcal
input, TodayScreen with real totals. Building the data layer before the camera keeps every later
phase testable without hardware. **Accept:** `cargo test -p atomic_lib` proves the ontology
seeds; add/edit/delete meals; totals correct across day boundaries (test the timezone edge: a
23:59 meal belongs to that local day); Rust unit tests for `list_meals` ranges.

### Phase 3 — Camera capture ✅ done

`camera` package, CaptureScreen as home, `ImageStore` (compress → JPEG + thumbnail, budget
tracking, eviction sweep — all of §6), capture creates a `pending` meal instantly.
**Accept:** cold start → live preview < 1s (measured); snap → meal appears in Today as pending;
app killable right after shutter without data loss; a stored image is ≤1024px and under ~250 KB
with no EXIF; unit tests for the sweep with a fake filesystem — evicts oldest first, respects
hysteresis, never touches a `pending`/`needs-info` meal's file, removes orphans, and a meal whose
file was evicted still renders (thumbnail + note, re-estimate disabled).

Two notes on how it landed:

- **The sweep takes the meals rather than fetching them.** Eviction is a decision about the whole
  history and `MealStore` holds one day, so `ImageStore.sweep({required List<Meal> meals})` is
  pure with respect to the meal table and `MealStore.allMeals()` is what feeds it. That is also
  what makes the sweep tests plain `test()`s over a real temp directory rather than widget tests.
- **The compressor is a seam** (`ImageCompressor`), because the test VM has no native codec.
  Everything §6 pins about the *bytes* — 1024px, <250 KB, JPEG, no EXIF — is therefore asserted in
  `integration_test/bridge_test.dart` against the real encoder, not in `test/`.
- **The camera warms up in parallel with redb**, keyed on `AppSession.resumesAccount`, which is
  known within milliseconds of launch because the stored secret is now read before the store is
  opened. It is deliberately *not* started on a launch that goes to onboarding: that would put the
  OS permission dialog on top of the sign-up screen, and §7 asks for the opposite.

### Phase 4 — OpenRouter + estimation pipeline ✅ done

OAuth PKCE, key storage, model picker, `OpenRouterClient`, `EstimationQueue`, wire text entries
through the LLM too. **Accept:** photo of food → estimated meal with bounds within ~30s;
pending meals from a previous session get estimated on next launch; queue unit tests with a mocked
HTTP client (success, malformed JSON, 429 retry, low confidence).

How it landed, and where it left the plan:

- **The default model is `openai/gpt-5.6-luna`**, not the `google/gemini-2.5-flash` sketched in §5:
  cheap, sees images, follows a strict schema, and ~$0.0002 a meal measured against the real API.
  The picker offers every vision model in the catalogue, cheapest first, and flags the ones that do
  not advertise `structured_outputs` rather than hiding them.
- **`update_meal_estimate` takes a typed struct, not `estimate_json: String`** — the same argument
  §4 makes for `MealItem`. FRB generates the Dart class either way, and Dart parses the model's
  JSON regardless, because it is what decides whether there is a follow-up question.
- **The ontology grew one property: `clarifying-question`.** §5 wants a `needs-info` meal to
  produce a notification asking something, and there was nowhere to keep the something. Folding it
  into `description` would have conflated the model's reasoning with the question, and a
  "needs an answer" chip with nothing behind it is a dead end.
- **The question, not the confidence, is what makes a meal `needs-info`.** §5 said `confidence:
  low` → `needs-info`, but low confidence on its own is a wide range, which the bounds already
  report. Only a question is answerable.
- **`list_pending_meals` returns `estimating` as well as `pending`.** The only thing that sets that
  status is a call in this process, so one found at launch is what a killed app left behind;
  leaving it out would strand the meal forever. The queue skips the subjects it is holding itself.
- **Retries are split by cause, not counted uniformly.** A 429, a 5xx or a dead socket gets three
  goes with a doubling backoff. A rejected key, a refused request or an answer that breaks the
  schema gets one — the same request fails the same way and every attempt is billed.
- **The typed-entry sheet's calorie field became optional**, which is how text entries reach the
  LLM: a number is a confirmation, a blank is a question. Nothing else about that flow changed.
- **`MealStore` moved up to `main.dart`.** There are two writers now, and the day behind the
  viewfinder, the day in the list and the day the estimator is filling in have to be one answer.
- **A drain that starts before the documents directory is known skips photographed meals** rather
  than failing them, and `main.dart` fires another when the directory lands. §7 has those two
  things racing on purpose; failing the meal would delete the estimate's only input.

### Phase 5 — Uncertainty loop + history + polish ✅ done

`needs-info` notifications (flutter_local_notifications) deep-linking to the meal, clarify → re-
estimate flow, HistoryScreen, meal detail editing/confirming, empty/error states, app icon.
**Accept:** low-confidence meal fires a notification; answering it updates the estimate; history
shows correct daily totals.

How it landed, and where it left the plan:

- **The ontology grew `meal-notes`, and that is what makes the loop terminate.** §8 said the answer
  is "appended" to the meal, and the only place to append it was `description` — which is the
  estimator's reasoning and is replaced by every estimate. So round two would have sent the model
  its own round-one output back as "the person who logged it wrote", and round three would have
  sent both. `meal-notes` is the eater's words and *only* theirs: `update_meal_estimate` does not
  write it, `EstimationQueue._words` reads nothing else, and the answer survives however many
  estimates run over the meal. `MealEstimate.keeping()` — Phase 4's fold-the-words-in-first — is
  gone with it, because the property it was working around no longer exists.
- **`create_meal` and `update_meal` speak `notes`, not `description`.** At the moment a meal is
  logged nothing has estimated it, so every word about it is the eater's; and there is no reason
  for a human to edit a model's reasoning. That leaves exactly one writer per text field, which is
  the invariant the loop rests on.
- **Answering and re-estimating are one action, not two.** `SaveMeal` carries a `reEstimate` flag
  and the sheet's filled button on a `needs-info` meal is "Answer and estimate again". An answer
  saved but not sent leaves the meal as stuck as it was; a re-estimate that discards the answer
  first is worse. (Phase 4's "Estimate it again" popped the sheet and threw away whatever had been
  typed into it — same bug, quieter.)
- **The queue owns the question's whole life**, because it is what asked: it posts on `needs-info`,
  withdraws when a later estimate has nothing to ask, and `forget(subject)` covers a meal answered
  by hand or deleted. A question outliving its meal is the one way a notification becomes a dead
  end.
- **Permission is asked for at the first question, not at launch.** There is nothing to notify
  about on a fresh install, and a dialog in front of an app nobody has used yet is the reliable way
  to be told no forever.
- **A tap is resolved against the database, not against what is on screen.** `get_meal(subject)`
  returns `Option` — the meal may have been deleted or answered on another device while the
  notification sat on the lock screen — and `main.dart` listens to the session as well as to the
  tap, because a tap that *launched* the app arrives before there is a store to look anything up in.
- **History is a list of days, not the calendar §7 sketched.** A grid of four-digit totals is
  unreadable at phone width, and days with nothing logged are left out rather than shown as zero —
  an unbroken run of zeroes says the app was used and the food wasn't. One range query, grouped by
  local day in Dart (`groupByLocalDay`), which is the same arithmetic `localDayBounds` already does.
- **`meal_actions.dart` holds what a saved sheet means**, because four things open it now — the
  viewfinder, today's list, a history day, and a notification tap with no screen behind it at all.

### Phase 6 — Integrations (each independently shippable) ✅ done

- **Sync**: surface the existing Rust sync (atomic-server ws sync and/or Iroh peer pairing) in
  Settings, reusing the canvas pairing UI.
- **Background estimation** (open question from the app doc): investigate
  `workmanager` (Android WorkManager is reliable) and iOS `BGProcessingTask` (opportunistic
  only — likely outcome: Android gets true background estimation, iOS drains the queue on next
  launch plus a background task *when granted*). Timebox the investigation; next-launch
  processing is the guaranteed fallback and already works from Phase 4.

How it landed, and where it left the plan:

- **Pairing was already written; what was missing was everything around it.** `PairScreen` and
  `ServerSettingsSection` came over with the SDK in Phase 0 and only the "my data is on the other
  phone" onboarding screen ever opened one. Phase 6 is the `SyncService` above them —
  `services/sync_service.dart`, `screens/sync_screen.dart`, and a Devices row on the account
  screen — plus the two things that make a paired phone stay paired: a sync on launch and on every
  return to the foreground.
- **Auto-sync is gated on having paired something, and that is what keeps §2's "explicit" true.**
  `syncConnectivityNow` starts an Iroh node and asks the network where this account's other devices
  are; doing that on a phone nobody has paired spends battery looking for something that does not
  exist. So the opt-in is the pairing, once, and after that nobody has to remember to press
  anything — a sync you have to remember is a sync that doesn't happen.
- **A meal syncs and its photo does not, which the estimator had to be told about.** A `pending`
  meal from the other phone arrives here with a path to a file that was never written on this
  device, and the queue would have read that as "photo evicted" and marked it `failed` — which
  syncs *back*, and the queue does not pick failures back up. This device would have talked the
  device that actually holds the photo out of ever estimating it. So `EstimationQueue.paired` (kept
  in step with `SyncService` by `main.dart`) decides what a missing photo means: unpaired it can
  only be "delete all photos now" and the meal fails as before; paired it is skipped, and the
  answer arrives by the same sync that brought the meal.
- **`waiting` now counts what *this* phone can do**, since it is the number the drain filters down
  to. A meal whose photo is on the other device is not one this one is waiting to do, and the
  "Connect OpenRouter" banner should not count it.
- **Background estimation ships on both platforms, and is only honest on one.** Android's
  WorkManager persists the request across process death and reboots and runs it on a network
  constraint; iOS's `BGProcessingTask` is scheduled, not promised — iOS decides from usage
  patterns and idle time, and a rarely-opened app may go days without a window. Both are on top of
  the next-launch drain, never instead of it, which is why `drainInBackground` returns `true` for
  "nothing to do" and only `false` where a retry could help.
- **The background drain boots the same objects the foreground does** — `AppSession`, `MealStore`,
  `EstimationQueue` — rather than a second, simpler estimator. The queue has four things it must
  never do (see the app's CLAUDE.md); a parallel implementation would be a place for each of them
  to be got wrong once per platform.
- **The task is registered only on the way out with meals waiting, and withdrawn on the way back
  in.** Every estimate is billed, and the one outcome worth going out of the way to avoid is the
  scheduler and the foreground estimating the same meal.
- **What could not be verified here:** background execution needs a physical device. The policy,
  the wiring and both platforms' build integration are tested and green; that a headless isolate
  really can reach the keychain, the documents directory and the Rust bridge is a claim about
  iOS and Android that only a device can settle.

### Phase 6.1 — Background estimation, on a device

Left over from Phase 6 deliberately, and small: run the app on a real phone, log a meal, background
it, and confirm the drain happens without the app being reopened (`adb shell dumpsys jobscheduler`
on Android; on iOS, the `_simulateLaunchForTaskWithIdentifier` debugger call). If the headless
isolate cannot reach one of the three things it needs, the fallback is unchanged — meals estimate
on next launch — so this is a confirmation, not a dependency.

### Phase 7 — Health

`health` package → write `DIETARY_ENERGY_CONSUMED` (HealthKit / Health Connect) on
estimate/confirm; settings toggle.

## 9. Starting point — first concrete steps for the agent

Work in `calorie-tracker/`. Flutter SDK is managed via mise (see `flutter/.mise.toml` — copy it).

1. `cp` these from `flutter/`: `pubspec.yaml`, `flutter_rust_bridge.yaml`, `analysis_options.yaml`,
   `.mise.toml`, `Makefile`, `dev.sh`, `rust/`, `rust_builder/`, `lib/atomic/`, `lib/rust_init*.dart`.
2. Rename everywhere: app `atomiccanvas_flutter` → `calorie_tracker`, crate
   `rust_lib_atomiccanvas_flutter` → `rust_lib_calorie_tracker` (Cargo.toml files, pubspec,
   flutter_rust_bridge.yaml, rust_builder). Grep for `atomiccanvas` and `canvas` to find stragglers.
3. `flutter create . --platforms=ios,android --org dev.atomicdata` to generate fresh platform
   dirs (don't copy the canvas ones — their bundle ids, icons and manifests are app-specific).
4. Strip canvas-specific Rust API (canvas/stroke/folder/undo functions) from `rust/src/api/`,
   keep: db, agent, drive, generic resource, history, ws sync, peer. Keep `state.rs`, `types.rs`
   (minus canvas types). Run `flutter_rust_bridge_codegen generate` to regenerate bindings; fix
   the Dart SDK copy in `lib/atomic/` to drop canvas methods.
5. Minimal `main.dart`: init rust, `openDb`, `setup("Calorie Tracker")` behind a debug button,
   placeholder home. Verify on both platforms (`make` targets; adjust device ids in `dev.sh`).

Known trap (from repo memory): if you add modules to the *server* crate it must be declared in
both `lib.rs` and `bin.rs` — not relevant here unless you touch `server/`, but the general
lesson applies: after Rust changes, build the actual leaf targets, not just `cargo check` at the
workspace root.

## 10. Open questions (tracked, not blocking)

- Background estimation on iOS (§8 Phase 6) — implemented as a `BGProcessingTask`, which iOS runs
  when it feels like it; the guaranteed fallback is the next-launch drain and is unchanged. Still
  open: whether the headless isolate reaches the keychain, the documents directory and the Rust
  bridge on a real device (§8 Phase 6.1).
- WebP instead of JPEG for stored photos (§6.1) — ~25–30% disk saving, zero token saving, blocked
  on measuring iOS encode time and on how exotic the model picker's models get. Revisit after
  Phase 4; the format constant makes it a one-line change and old JPEGs stay readable.
- Image sync: photos are device-local in v1. Later options: atomic-server file uploads, or
  iroh-blobs alongside the existing peer sync. Note this interacts with §6 eviction — once a photo
  has been uploaded somewhere durable, evicting the local copy becomes free rather than lossy, and
  the budget could drop a lot. Don't design the sync around that, but don't make it impossible.
- Ontology publishing: the classes/properties are seeded into every store via
  `lib/defaults/calorie-tracker.json`; publishing them on the public atomicdata.dev site (so the
  `https://atomicdata.dev/...` subjects actually resolve) can come when the model stabilizes.
- SDK extraction: merge `calorie-tracker/lib/atomic` + `flutter/lib/atomic` into a shared Dart
  package (and the two Rust crates into one) once both apps run on it.
