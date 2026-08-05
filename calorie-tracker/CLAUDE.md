# Calorie Tracker

Snap a photo of a meal, get a calorie estimate, store it in a local atomic
database. Flutter + Rust, iOS and Android, no backend server.

Plan: [`../planning/calorie-tracker-plan.md`](../planning/calorie-tracker-plan.md)
(architecture, data model, phases). Product brief:
[`../planning/calorie-tracker-app.md`](../planning/calorie-tracker-app.md).

**Status: Phase 2 (meal model + manual entry) complete.** The app onboards —
one tap to a new account, or a pasted secret to restore one — persists the
session, and lands on a day you can log meals to by hand and add up. There is
no camera and no LLM yet: those are Phases 3 and 4, and the whole data layer is
already testable without either.

## When writing code

Do not commit changes after you finish a task. The human will do it themselves.

## Layout

```
lib/
  main.dart            app + SessionGate: renders whatever phase the session is in
  theme.dart
  atomic/              the Atomic Dart SDK — see "Shared SDK" below
  models/meal.dart     Meal, MealStatus, localDayBounds, DaySummary
  services/
    app_session.dart   who is signed in and where their meals go; owns the boot
    meal_store.dart    one day's meals, and the writes to them
  screens/
    today_screen.dart  home: the day's total and its meals
    meal_entry_sheet.dart  type a meal, or correct one
    account_screen.dart    the agent, and the secret; behind the person icon
    onboarding/        first launch, and the "my data is on the other phone" case
    pair_screen.dart   QR pairing, from the canvas app
  widgets/             error_snack.dart
  src/rust/            flutter_rust_bridge output — generated, never hand-edit
rust/                  the FRB crate, rust_lib_calorie_tracker
  src/api/simple.rs    the generic bridge — copied from the canvas app
  src/api/meals.rs     what this app owns: the container, meal CRUD, day queries
rust_builder/          cargokit build integration (vendored, locally patched)
```

Everything goes through `AppSession` and `MealStore`. No screen calls `setup()`,
opens the store, or touches `AtomicSession` or the bridge itself — the boot
happens once, in one place, and screens render `session.phase`. Both have a
backend seam (`AtomicBackend`, `MealBackend`) and that is what makes the flows
testable without a Rust library: `test/fake_atomic_backend.dart` models the
store and the process separately, which is exactly the difference a relaunch
tests, and `test/fake_meal_backend.dart` models the meals table.

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

## Next: Phase 3

The camera. The `camera` package, an `ImageStore` (JPEG + thumbnail into the
documents dir), and CaptureScreen as home with `TodayScreen` moving behind it.
The shutter writes a file and calls `create_meal` with no calories — which is
already the `pending` state Phase 4's estimator drains — so the app is killable
the instant the picture is taken. Cold start to live preview under a second is
the acceptance criterion, and it is why `main()` does not await the session
(`calorie-tracker-plan.md` §7).
