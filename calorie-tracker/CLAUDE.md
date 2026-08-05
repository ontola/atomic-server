# Calorie Tracker

Snap a photo of a meal, get a calorie estimate, store it in a local atomic
database. Flutter + Rust, iOS and Android, no backend server.

Plan: [`../planning/calorie-tracker-plan.md`](../planning/calorie-tracker-plan.md)
(architecture, data model, phases). Product brief:
[`../planning/calorie-tracker-app.md`](../planning/calorie-tracker-app.md).

**Status: Phase 3 (camera capture) complete.** The app onboards — one tap to a
new account, or a pasted secret to restore one — persists the session, and lands
on a viewfinder. The shutter writes a compressed photo and a `pending` meal and
is done; the day's total is on top of the preview and the list is one tap
behind it. Meals can still be typed in by hand. No LLM yet — that is Phase 4,
and `pending` is already the queue it drains.

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
  screens/
    capture_screen.dart    home: the viewfinder, the shutter, the day's total
    today_screen.dart      the day's total and its meals, one tap behind home
    meal_entry_sheet.dart  type a meal, or correct one
    account_screen.dart    the agent, the secret, the photo budget
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
happens once, in one place, and screens render `session.phase`. Every service
with a platform behind it has a seam — `AtomicBackend`, `MealBackend`,
`CameraFeed`, `ImageCompressor` — and that is what makes the flows testable
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

Fixed in both copies (found here, ported to `../flutter`): `open_db` and
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

- **The iOS simulator has no camera**, and neither does a CI machine. That is a
  supported state, not a broken one: `DeviceCamera` reports it, the capture
  screen says so and offers the keyboard instead, and everything else works. Do
  not "fix" it by making the screen an error page — the simulator is where this
  app is developed.

## Next: Phase 4

OpenRouter. OAuth PKCE and key storage, a model picker, `OpenRouterClient`, and
the `EstimationQueue` that drains `list_pending_meals()` — which is what every
capture has been writing into since Phase 3. Two Rust functions are still to
come (`update_meal_estimate`, `list_pending_meals`, plan §4), so it starts with
`make gen`. `ImageStore.stateOf` is what decides whether a meal can be
re-estimated at all: without the full image there is nothing to send, and the
256px thumbnail is not a substitute.
