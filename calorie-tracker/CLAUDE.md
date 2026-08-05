# Calorie Tracker

Snap a photo of a meal, get a calorie estimate, store it in a local atomic
database. Flutter + Rust, iOS and Android, no backend server.

Plan: [`../planning/calorie-tracker-plan.md`](../planning/calorie-tracker-plan.md)
(architecture, data model, phases). Product brief:
[`../planning/calorie-tracker-app.md`](../planning/calorie-tracker-app.md).

**Status: Phase 4 (OpenRouter + estimation) complete.** The app onboards — one
tap to a new account, or a pasted secret to restore one — persists the session,
and lands on a viewfinder. The shutter writes a compressed photo and a `pending`
meal and is done; the day's total is on top of the preview and the list is one
tap behind it. A queue drains those pending meals through a vision model on
OpenRouter, on launch, after each capture and on resume, and writes back a name,
a number and a range. Meals can still be typed in by hand — with a number, which
confirms them, or without one, which asks the model instead.

## When writing code

Do not commit changes after you finish a task. The human will do it themselves.

## Layout

```
lib/
  main.dart            app + SessionGate: renders whatever phase the session is in
  startup.dart         the cold-start-to-live-preview stopwatch
  theme.dart
  atomic/              the Atomic Dart SDK — see "Shared SDK" below
  models/meal.dart     Meal, MealStatus, localDayBounds, DaySummary
  services/
    app_session.dart   who is signed in and where their meals go; owns the boot
    meal_store.dart    one day's meals, and the writes to them
    camera_feed.dart   the camera, behind a seam; DeviceCamera is the real one
    image_store.dart   compress, store, count, evict — all of the plan's §6
    openrouter.dart    the key, the model catalogue, and the estimate call
    estimation_queue.dart  drains the pending meals through one of those models
  screens/
    capture_screen.dart    home: the viewfinder, the shutter, the day's total
    today_screen.dart      the day's total and its meals, one tap behind home
    meal_entry_sheet.dart  type a meal, or correct one
    account_screen.dart    the agent, the secret, the photo budget
    openrouter_screen.dart connect or disconnect, and pick the model
    onboarding/        first launch, and the "my data is on the other phone" case
    pair_screen.dart   QR pairing, from the canvas app
  widgets/             error_snack.dart, meal_photo.dart
  src/rust/            flutter_rust_bridge output — generated, never hand-edit
rust/                  the FRB crate, rust_lib_calorie_tracker
  src/api/simple.rs    the generic bridge — copied from the canvas app
  src/api/meals.rs     what this app owns: the container, meal CRUD, day queries
rust_builder/          cargokit build integration (vendored, locally patched)
```

Everything goes through `AppSession` and `MealStore`. No screen calls `setup()`,
opens the store, or touches `AtomicSession` or the bridge itself — the boot
happens once, in one place, and screens render `session.phase`. `main.dart` owns
all of it now: the session, the camera, the image store, **the meal store**, the
OpenRouter account and the queue. The meal store moved up there in Phase 4 for a
concrete reason — there is a second writer, and the day behind the viewfinder,
the day in the list and the day the estimator is filling in have to be one
answer. Every service with a platform behind it has a seam — `AtomicBackend`,
`MealBackend`, `CameraFeed`, `ImageCompressor` — and that is what makes the
flows testable
without a Rust library, a camera or a codec: `test/fake_atomic_backend.dart`
models the store and the process separately, which is exactly the difference a
relaunch tests, `test/fake_meal_backend.dart` models the meals table, and
`test/fake_camera.dart` models the three states a viewfinder is ever in.

## Capture, and why nothing on that path waits

The shutter compresses the frame, writes two files, and creates a meal with no
name and no number. That is the whole path, and it is finished by the time the
"Logged" chip appears — kill the app there and nothing is lost. What the meal is
worth is Phase 4's problem, and `pending` is exactly the queue it will drain.

Three things follow from that and are easy to undo by accident:

- **`calories` is `Option` all the way up.** A capture has no number, and
  "unknown" counted as zero is a day total that is wrong in the direction that
  matters. `DaySummary` keeps the unestimated count separate for the same reason.
- **The sweep runs *after* the meal is written**, never before. It decides what
  to evict from the list of meals, so a photo whose meal does not exist yet is an
  orphan it would delete on its way past.
- **Photos are a cache; meals are the data.** Every read of a photo can come back
  empty, and `ImageStore.load` returns null rather than throwing. Eviction is
  silent by design — the meal, its calories and its thumbnail all survive, so
  there is nothing to interrupt anyone about.

`ImageStore` holds all of the plan's §6: one JPEG at 1024px/q80 plus a 256px
thumbnail, both encoded straight off the camera frame (one lossy pass each, not
two stacked); a byte budget with a `SharedPreferences` counter and a full
recount on every sweep; eviction oldest-first to 10% below the budget, skipping
any meal the estimator still needs and never touching a thumbnail; and an orphan
pass every time. The format and the two sizes are constants in one place, which
is what would make the WebP question (plan §10) a one-line change.

## Estimation, and the four things it must never do

`EstimationQueue` reads `list_pending_meals()`, sends each meal's stored photo
(or the words the user typed) to a vision model on OpenRouter, and writes the
answer back with `update_meal_estimate`. One call in flight at a time; it runs
on launch, after every capture, on resume, and on demand from a `failed` row.
The whole pipeline is `openrouter.dart` (the wire) plus `estimation_queue.dart`
(the policy), and `MealStore` is the only thing either of them writes through.

- **It must not overwrite a `confirmed` meal.** A number a human typed beats an
  estimate that was in flight when they typed it. `update_meal_estimate`
  enforces that in Rust and returns `Ok` — it is two correct behaviours racing,
  not a mistake to report. Do not "fix" it by making it an error.
- **It must not fail a meal it simply cannot reach yet.** The documents
  directory is found in parallel with the store, so a drain can start before
  there is anywhere to read a photo from. Those meals are *skipped*, left
  `pending`, and picked up by the drain `main.dart` fires when the directory
  lands. Failing them would throw away the estimate's only input.
- **It must not retry what will fail again.** A 429, a 5xx or a dead socket gets
  three goes with a doubling backoff; a rejected key, a refused request or an
  answer that is not the JSON the schema asked for gets one. Every attempt is
  billed, and a model that just broke a strict schema will break it again. The
  meal goes `failed`, keeps its photo, and offers the user a retry.
- **It must not lose the user's words.** The estimate replaces every field it
  touches, so `MealEstimate.keeping()` folds what the user typed in front of the
  model's reasoning first. Their words are the more reliable half of the record
  and the only part nobody can reconstruct.

Two more things about the shape:

- **`needs-info` is decided by the question, not by the confidence.** Low
  confidence on its own is a wide range, which `calories-min`/`calories-max`
  already say. A meal is only `needs-info` when the model asked something, and
  that question is stored on the meal — a "needs an answer" chip with nothing
  behind it is a dead end. Phase 5 owns answering it; Phase 4 shows it in the
  edit sheet.
- **`estimating` is a queued status, not an in-flight one.** The only thing that
  sets it is a call in this process, so one found at launch is what a killed app
  left behind. `list_pending_meals` returns it alongside `pending` for exactly
  that reason, and the queue skips subjects it is currently holding itself.

There are two ways to get a key in: OpenRouter's OAuth PKCE flow, and pasting one made by hand on
openrouter.ai/keys. Both end in the same keychain slot, so nothing downstream knows the difference.
A pasted key is checked with `GET /api/v1/key` before it is stored — unverified, a typo is silent
until the next meal, which then fails on a 401 the queue will not retry.

The key lives in the platform keychain next to the agent secret. For
development, `--dart-define=OPENROUTER_API_KEY=…` bakes one in as a *fallback* —
`make ios` / `make android` / `make apk` pass it through from the environment —
and a key someone signed in with on the device always wins, so a dev build never
quietly bills the wrong account.

## The meal vocabulary lives in `atomic_lib`, not here

`Meal`, `consumed-at`, `calories`, `meal-status` and the rest are defined in
`../lib/defaults/calorie-tracker.json`, imported by `populate_default_store`
(`../lib/src/populate.rs`) and named by consts in `../lib/src/urls.rs`. So they
are seeded into *every* atomic store, including this app's local redb one, and
`rust/src/api/meals.rs` writes `atomic_lib::urls::CALORIES` rather than a
string this app made up. `populate::tests::the_meal_ontology_seeds` resolves the
class and every property, which is what turns a JSON-AD typo into a test failure
instead of a failed write on a phone.

Two things about that model are worth knowing before extending it:

- **`meal-status` and `estimate-confidence` are Tags, not strings.** `allowsOnly`
  only accepts subjects — a plain `"pending"` in that list fails the import — so
  each state is a Tag resource under its property
  (`…/properties/mealStatus/pending`). The bridge speaks the shortnames and
  converts at the boundary; nothing above `meals.rs` sees a tag URL.
- **`clarifying-question` was added in Phase 4**, for the reason above: a meal
  that is `needs-info` has to carry what it is waiting on. It is cleared, not
  blanked, when a later estimate has nothing to ask.
- **A meal requires only `consumed-at` and `meal-status`.** It is created the
  instant it is captured, before anyone knows what it was, so the name and the
  numbers cannot be required of it. `calories` is `Option` all the way up for
  the same reason: "not estimated yet" is not "zero calories", and a day total
  that conflates them is wrong in the direction that matters.

## Shared SDK — keep it in step with the canvas app

`lib/atomic/` and `rust/src/api/` were copied from `../flutter` (Atomic Canvas)
and stripped of that app's canvas/stroke/folder/undo code. The two are meant to
be merged into one package once both apps' needs are known
(`calorie-tracker-plan.md` §9). Until then, keep shared code structurally
identical to its twin so the merge stays mechanical, and port fixes both ways.

Fixed in both copies (found here, ported to `../flutter`): **`open_db` turns on
`Db::set_durable_writes(true)`**. redb writes commits at `Durability::None` — no
fsync — and rolls back to the last durable commit when the file is opened again.
`atomic-server` covers that with a periodic flush thread and a clean shutdown; an
app the OS reaps in the background gets neither, so every meal logged since
launch was gone at the next start, and the meals container with it (which is why
a relaunch also minted a fresh one). The store now fsyncs per commit, which on a
phone is a handful of user actions a day. Note that nothing in `test/` or in
`integration_test/` could have caught this: both relaunch inside one process,
where the store is still open and nothing has been rolled back.
`lib/tests/write_durability.rs` in `atomic_lib` is the test that does — it writes
in a child process and `abort()`s it.

Also fixed in both copies: `open_db` and
`initRustBridge` are now idempotent. Both used to throw on a second call, and
`open_db`'s recovery path reads any failure as corruption and **deletes the
database** — so booting the app twice in one process wiped it. Nothing in
either app did that on purpose, but an integration test that relaunches the app
does, and so would a retry after a failed start.

What diverged deliberately:

- `create_resource` takes a `class` argument. The canvas version hardcoded
  `urls::CLASS` — the meta-class for *defining* classes, which requires a
  `shortname` — so every call through it failed. Nothing called it, so nobody
  found out.
- `get_resource_at_version` → `get_property_at_version`, which names the
  property to read. The canvas twin always read stroke data.
- `subscribe_canvas` → `subscribe_resource`; `delete_canvas`/`rename_canvas` →
  `delete_resource`/`rename_resource`.
- `save_and_push` no longer touches a `dateEdited` property (a gallery sort key
  this app has no use for — meals sort by `consumed-at`).
- Web is dropped. Target platforms are iOS and Android only, so
  `atomic_client_web.dart` was not copied.
- `update_meal_estimate` takes a **typed `MealEstimate` struct**, not the
  `estimate_json: String` the plan sketched. Same argument the plan makes for
  `MealItem`: FRB generates the Dart class either way, and Dart has to parse the
  model's JSON regardless — it decides whether there is a question to ask — so
  handing the string on buys nothing and costs a category of typo.
- `state.rs` is `pub(crate)` and `simple.rs` declares `pub(crate) mod state`, so
  `api::meals` can reach the same store handle. `save_and_push` is `pub(crate)`
  for the same reason — meals save through it rather than growing a second,
  subtly different save path. App-specific bridge code goes in `meals.rs`, never
  in `simple.rs` — that is what keeps the merge a copy.

## Commands

`make check` is what every phase has to leave green: `flutter analyze`,
`flutter test`, `cargo test`.

| Command | What |
| --- | --- |
| `make check` | analyze + Dart tests + Rust tests |
| `make ios` / `make android` | run the app, hot reload via `make reload-ios` from any terminal |
| `make apk` | debug APK, one ABI (see below) |
| `make integration-ios` / `make integration-android` | on-device test: onboard, log a meal, relaunch, same account and same meal |
| `make gen` | regenerate FRB bindings — **required after any signature change** in `rust/src/api/` |
| `make clean-build` | wipe the build tree when the disk fills up |

## Build gotchas

These all cost an afternoon once. They are fixed in-tree; this is why.

- **After changing a `pub fn` in `rust/src/api/`, run `make gen`.** The crate
  will not compile until you do — `frb_generated.rs` still calls the old
  signature, and the error points at generated code rather than at your edit.
- **Disk.** A full Android build compiles atomic_lib's ~1500-crate tree once
  *per ABI* — around 15 GB. `make apk` builds one ABI (`ABI=android-arm64` by
  default; `android-x64` for Intel emulators). Xcode's DerivedData grows by
  several GB per iOS build too.
- **iOS needs SystemConfiguration and Security frameworks.** Iroh reaches
  SystemConfiguration to enumerate network interfaces; rustls reaches Security
  for the platform verifier. Declared in
  `rust_builder/ios/rust_lib_calorie_tracker.podspec`. **Run `pod install` in
  `ios/` after editing that podspec** — CocoaPods caches the generated xcconfig,
  and a stale one fails the link at the `rust_lib_calorie_tracker` target with
  `Undefined symbol: _kSCNetworkInterfaceType*`.
- **`rust_builder/cargokit/gradle/plugin.gradle` is locally patched.** Gradle 9
  removed `Project.exec()`; the task uses an injected `ExecOperations`. Re-apply
  when vendoring a newer cargokit.
- **`mobile_scanner` must stay on 7.x.** Version 6 uses ML Kit on iOS, which has
  no arm64 simulator slice — the app builds but will not install on an Apple
  Silicon simulator. 7.x uses Apple Vision instead.
- **iOS deployment target is 15.5**, the floor `mobile_scanner` sets. It is in
  both `ios/Podfile` and `ios/Runner.xcodeproj/project.pbxproj`.
- **Signing lives in `ios/Flutter/Local.xcconfig`**, which is untracked and
  pulled in by an optional `#include?` from `Debug.xcconfig`/`Release.xcconfig`.
  Put your `DEVELOPMENT_TEAM` there. Xcode writes that setting straight into
  `project.pbxproj` when you pick a team in the UI — that file is shared, so a
  committed team ID breaks signing for everyone else. Revert the pbxproj if it
  reappears.
- **`calorie-tracker/rust` is excluded from the root Cargo workspace** (see the
  root `Cargo.toml`), like `flutter/rust`. Build it with
  `cargo test --manifest-path rust/Cargo.toml`, not from the workspace root.
- **A widget test cannot await `dart:io`.** `testWidgets` runs its body in a
  fake-async zone, and a file `Future` completes on the real event loop, which
  that zone never pumps. So anything touching the photo directory — the shutter,
  an `ImageStore` call in a test body — has to go inside `tester.runAsync`, or
  the test hangs half-way through a capture with the shutter spinner still up,
  which reads as an app bug rather than a harness one.
  `test/capture_screen_test.dart` has the two helpers for it. Plain `test()`
  files, like `image_store_test.dart`, are unaffected.
- **`pumpAndSettle` never returns while a `CircularProgressIndicator` is on
  screen**: it is a repeating animation, so there is always another frame
  scheduled. "The camera has not come up yet" is exactly that state, so the
  capture tests count their pumps instead of settling.
- **A test file that touches `AppSession` needs the storage mocks**
  (`SharedPreferences.setMockInitialValues({})` and
  `FlutterSecureStorage.setMockInitialValues({})` in `setUp`). `AtomicSession`
  writes through both, and without the mocks those platform channels never
  answer: the file does not fail, it *hangs* — `flutter test` sits there with no
  output until you kill it, which reads as a broken toolchain rather than a
  missing line.
- **Changing the ontology means running `atomic_lib`'s tests too.**
  `lib/defaults/calorie-tracker.json` is seeded into every store in the repo, so
  `cargo test -p atomic_lib --features db-redb --lib --tests` from the repo root
  is part of the check — `make check` here does not cover it. (Skip
  `--lib --tests` and the run dies compiling `examples/list_sled_trees.rs`,
  which wants the `db-sled` feature; CI uses nextest, which ignores examples.)

- **The OAuth redirect scheme is `caltracker://`**, declared once in
  `android/app/src/main/AndroidManifest.xml` on `flutter_web_auth_2`'s
  `CallbackActivity`. iOS needs no equivalent — `ASWebAuthenticationSession` is
  told the scheme at call time. If you change it, change both that manifest
  entry and `_callbackScheme` in `lib/services/openrouter.dart`.
- **iOS plugins go through Swift Package Manager here, not CocoaPods.**
  `ios/Podfile.lock` has three pods in it and always will; everything else
  (camera, mobile_scanner, flutter_web_auth_2) is a package reference in
  `Runner.xcodeproj`, regenerated by `flutter run`/`flutter build`. So adding a
  plugin needs no `pod install` — the podspec note above is only about
  `rust_lib_calorie_tracker`, which *is* a pod.
- **The iOS simulator has no camera**, and neither does a CI machine. That is a
  supported state, not a broken one: `DeviceCamera` reports it, the capture
  screen says so and offers the keyboard instead, and everything else works. Do
  not "fix" it by making the screen an error page — the simulator is where this
  app is developed.

## Next: Phase 5

The uncertainty loop, history and polish. `needs-info` meals already carry the
question the model asked and show it in the edit sheet; what is missing is the
notification that deep-links to it, the answer being appended and the meal
re-estimated (`EstimationQueue.retry` is the call — it takes a `Meal` and does
the whole thing, so the loop is a screen and a notification, not a new
pipeline). Then `HistoryScreen` over past days, and the empty and error states.

Two loose ends worth knowing about before then:

- **Nothing re-estimates on a model change.** Change the model in Settings and
  the meals already estimated keep the old one's numbers, which is right — but
  there is no way to ask for a second opinion on a settled meal either. The edit
  sheet's "Estimate it again" only appears where there is still something to
  send.
- **`waiting` is what the last drain found.** It is not a live count from the
  database, so a meal synced in from another device does not show up in the
  banner until the next drain. Every path that adds a meal here drains.
