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
  (background execution is a stretch goal, see §9).
- **Photos are local files**, not atomic resources. Meals store a relative file path. Syncing
  images is out of scope for v1 (open question for later).
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
    src/api/simple.rs          #   generic agent/drive/sync API (copied) + meal API (new)
  rust_builder/                # copied from flutter/rust_builder, crate name adjusted
  lib/
    main.dart                  # fast path: init camera first, rust db in parallel
    atomic/                    # the SDK copied from flutter/lib/atomic (see Phase 0 decision)
    models/meal.dart
    services/
      meal_store.dart          # CRUD + day queries via AtomicClient, ChangeNotifier
      estimation_queue.dart    # drains pending meals through the LLM
      openrouter.dart          # OAuth PKCE + /chat/completions + /models
      image_store.dart         # save/load capture files, thumbnails
      notifications.dart
    screens/
      capture_screen.dart      # camera-first home
      text_entry_screen.dart
      today_screen.dart
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
| `meal-status` (`mealStatus`) | string, `allows-only` | `pending` · `estimating` · `estimated` · `confirmed` · `needs-info` · `failed` |
| `estimate-confidence` (`estimateConfidence`) | string, `allows-only` | `high` · `medium` · `low` (from the LLM) |
| `estimated-by-model` (`estimatedByModel`) | string | OpenRouter model id used |
| `protein-grams` / `carbs-grams` / `fat-grams` | float | optional macros, nice-to-have from the same LLM call |

(`status` and `model` get prefixed subjects because bare `https://atomicdata.dev/properties/status`
/ `…/model` are too generic to claim for this app — check `lib/src/urls.rs` for collisions before
finalizing names.)

Implementation notes:

- **The ontology lives in `atomic_lib`, not in the app.** Follow the existing pattern used by
  `meeting.json` / `chatroom.json`:
  1. Create `lib/defaults/calorie-tracker.json` defining every new Property and Class as JSON-AD
     resources: properties with `@id` `https://atomicdata.dev/properties/<camelCase>` (e.g.
     `caloriesMin`, `consumedAt`), `isA: [Class Property]`, `datatype`, `description`,
     `shortname` (kebab-case), `parent: https://atomicdata.dev/properties`; the `Meal` class at
     `https://atomicdata.dev/classes/Meal` with `requires`/`recommends`, `parent:
     https://atomicdata.dev/classes`. Enum-like properties (`status`, `confidence`) use
     `allows-only`. Reuse existing core properties where they fit (`name`, `description`) instead
     of minting duplicates.
  2. Register it in `populate_default_store` in `lib/src/populate.rs` with a
     `store.import(include_str!("../defaults/calorie-tracker.json"), …)` block like the others —
     then it's seeded into every store by `bootstrap`, including the app's local redb store.
  3. Add the subject `const`s to `lib/src/urls.rs` (e.g. `pub const CALORIES: &str = "https://atomicdata.dev/properties/calories";`)
     so the app's Rust API uses `atomic_lib::urls::CALORIES` — no app-local ontology module.
  4. Mirror the constants in a hand-written `lib/models/ontology.dart` for the Dart side.
- Verify the seeding with a `lib` test that runs `bootstrap` on a fresh store and resolves the
  `Meal` class and each property (this also catches JSON-AD typos at test time rather than at
  first app launch).
- **Day queries in Rust**: add `list_meals(from_ms, to_ms) -> Vec<MealItem>` using
  `atomic_lib::storelike::Query` filtered on parent (like `list_canvases`) then filtered/sorted
  by `consumed-at` in Rust. Returning a typed `MealItem` struct (FRB generates the Dart class)
  avoids JSON-in-string plumbing.
- Daily summary = sum over `list_meals(day_start, day_end)` in Dart. No separate summary resource
  (avoids sync conflicts; recomputing is cheap).

**New Rust API surface** (in `rust/src/api/simple.rs`, mirroring the canvas functions):

```rust
pub async fn create_meal(consumed_at_ms: i64, image_path: String, description: String) -> Result<String, String>; // returns subject, status=pending
pub async fn update_meal_estimate(subject: String, estimate_json: String) -> Result<(), String>; // sets name/calories/bounds/macros/confidence/model, status=estimated|needs-info
pub async fn set_meal_status(subject: String, status: String) -> Result<(), String>;
pub async fn list_meals(from_ms: i64, to_ms: i64) -> Result<Vec<MealItem>, String>;
pub async fn list_pending_meals() -> Result<Vec<MealItem>, String>;
pub async fn delete_meal(subject: String) -> Result<(), String>;
```

## 5. LLM integration (OpenRouter)

**Auth — OAuth PKCE** (no client secret, made for native apps):

1. Generate `code_verifier`, derive S256 `code_challenge`.
2. Open `https://openrouter.ai/auth?callback_url=<redirect>&code_challenge=<c>&code_challenge_method=S256`
   via `flutter_web_auth_2` (handles the custom-scheme redirect on both platforms).
   Redirect: `caltracker://oauth` (register the scheme in Info.plist / AndroidManifest).
3. Exchange: `POST https://openrouter.ai/api/v1/auth/keys` with `{code, code_verifier, code_challenge_method}` → `{key}`.
4. Store the key with `flutter_secure_storage` (same pattern as the agent secret in `AtomicSession`).

**Model selection**: `GET /api/v1/models`, filter to models whose `architecture.input_modalities`
includes `image`, show in Settings with a sane default (e.g. `google/gemini-2.5-flash` — cheap,
fast, good vision; verify current catalog at build time).

**Estimation call**: `POST /api/v1/chat/completions` with the photo as a base64 data-URL
`image_url` part (downscale to ≤1024px longest edge before encoding — cuts tokens and latency),
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

## 6. UX / screens

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
  Health integration toggle.
- **Onboarding** (first launch only): one screen — "Create new agent" (default, zero-input) or
  "Import existing" (QR scan / paste secret). Then straight to CaptureScreen; OpenRouter connect
  is prompted contextually on first capture, not in onboarding, to keep the entry barrier low.

## 7. Phased build plan

Each phase ends green: `flutter analyze`, `flutter test`, and `cargo test` in `rust/` pass, and
the acceptance criteria are demonstrated (integration test or manual run via `make`).

### Phase 0 — Scaffold (the starting point; see §8)

Copy the Atomic Canvas skeleton into `calorie-tracker/`, rename crate/app ids, strip canvas code.
**Accept:** app builds & runs on iOS sim + Android, shows a placeholder home screen, Rust FRB
call round-trips (`setup()` creates an agent), `cargo test` + `flutter analyze` pass.

### Phase 1 — Atomic foundation

Onboarding flow (new/import agent), `AtomicSession` persistence, drive + `meals` container
created on first run. **Accept:** fresh install → onboard → kill → relaunch restores agent;
integration test covers create-and-restore.

### Phase 2 — Meal model + manual entry (no camera, no LLM yet)

Ontology first, in `atomic_lib` (see §4): `lib/defaults/calorie-tracker.json`, its import in
`populate_default_store` (`lib/src/populate.rs`), constants in `lib/src/urls.rs`, plus a seeding
test. Then meal CRUD in the app's Rust crate, `MealStore`, TextEntryScreen with *manual* kcal
input, TodayScreen with real totals. Building the data layer before the camera keeps every later
phase testable without hardware. **Accept:** `cargo test -p atomic_lib` proves the ontology
seeds; add/edit/delete meals; totals correct across day boundaries (test the timezone edge: a
23:59 meal belongs to that local day); Rust unit tests for `list_meals` ranges.

### Phase 3 — Camera capture

`camera` package, CaptureScreen as home, `ImageStore` (save JPEG + thumbnail), capture creates a
`pending` meal instantly. **Accept:** cold start → live preview < 1s (measured); snap → meal
appears in Today as pending; app killable right after shutter without data loss.

### Phase 4 — OpenRouter + estimation pipeline

OAuth PKCE, key storage, model picker, `OpenRouterClient`, `EstimationQueue`, wire text entries
through the LLM too. **Accept:** photo of food → estimated meal with bounds within ~30s;
pending meals from a previous session get estimated on next launch; queue unit tests with a mocked
HTTP client (success, malformed JSON, 429 retry, low confidence).

### Phase 5 — Uncertainty loop + history + polish

`needs-info` notifications (flutter_local_notifications) deep-linking to the meal, clarify → re-
estimate flow, HistoryScreen, meal detail editing/confirming, empty/error states, app icon.
**Accept:** low-confidence meal fires a notification; answering it updates the estimate; history
shows correct daily totals.

### Phase 6 — Integrations (each independently shippable)

- **Health**: `health` package → write `DIETARY_ENERGY_CONSUMED` (HealthKit / Health Connect) on
  estimate/confirm; settings toggle.
- **Sync**: surface the existing Rust sync (atomic-server ws sync and/or Iroh peer pairing) in
  Settings, reusing the canvas pairing UI.
- **Background estimation** (open question from the app doc): investigate
  `workmanager` (Android WorkManager is reliable) and iOS `BGProcessingTask` (opportunistic
  only — likely outcome: Android gets true background estimation, iOS drains the queue on next
  launch plus a background task *when granted*). Timebox the investigation; next-launch
  processing is the guaranteed fallback and already works from Phase 4.

## 8. Starting point — first concrete steps for the agent

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

## 9. Open questions (tracked, not blocking)

- Background estimation on iOS (§7 Phase 6) — guaranteed fallback exists.
- Image sync: photos are device-local in v1. Later options: atomic-server file uploads, or
  iroh-blobs alongside the existing peer sync.
- Ontology publishing: the classes/properties are seeded into every store via
  `lib/defaults/calorie-tracker.json`; publishing them on the public atomicdata.dev site (so the
  `https://atomicdata.dev/...` subjects actually resolve) can come when the model stabilizes.
- SDK extraction: merge `calorie-tracker/lib/atomic` + `flutter/lib/atomic` into a shared Dart
  package (and the two Rust crates into one) once both apps run on it.
