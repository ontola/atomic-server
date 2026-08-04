# Calorie Tracker

Snap a photo of a meal, get a calorie estimate, store it in a local atomic
database. Flutter + Rust, iOS and Android, no backend server.

Plan: [`../planning/calorie-tracker-plan.md`](../planning/calorie-tracker-plan.md)
(architecture, data model, phases). Product brief:
[`../planning/calorie-tracker-app.md`](../planning/calorie-tracker-app.md).

**Status: Phase 0 (scaffold) complete.** The app boots, opens a redb store
through `flutter_rust_bridge`, and can mint an agent + drive. There is no
camera, no meal model and no LLM yet — those are Phases 2-4.

## When writing code

Do not commit changes after you finish a task. The human will do it themselves.

## Layout

```
lib/
  main.dart          placeholder home; becomes CaptureScreen in Phase 3
  theme.dart
  atomic/            the Atomic Dart SDK — see "Shared SDK" below
  screens/           pair_screen.dart (QR pairing, from the canvas app)
  widgets/           error_snack.dart
  src/rust/          flutter_rust_bridge output — generated, never hand-edit
rust/                the FRB crate, rust_lib_calorie_tracker
  src/api/simple.rs  the whole bridge API; app-agnostic so far
rust_builder/        cargokit build integration (vendored, locally patched)
```

## Shared SDK — keep it in step with the canvas app

`lib/atomic/` and `rust/src/api/` were copied from `../flutter` (Atomic Canvas)
and stripped of that app's canvas/stroke/folder/undo code. The two are meant to
be merged into one package once both apps' needs are known
(`calorie-tracker-plan.md` §9). Until then, keep shared code structurally
identical to its twin so the merge stays mechanical, and port fixes both ways.

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

## Commands

`make check` is what every phase has to leave green: `flutter analyze`,
`flutter test`, `cargo test`.

| Command | What |
| --- | --- |
| `make check` | analyze + Dart tests + Rust tests |
| `make ios` / `make android` | run the app, hot reload via `make reload-ios` from any terminal |
| `make apk` | debug APK, one ABI (see below) |
| `make integration-ios` / `make integration-android` | on-device test: the bridge loads and `setup()` mints an agent |
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

## Next: Phase 1

Onboarding (new agent / import by QR or paste), session persistence, a `meals`
container under the drive. `lib/atomic/widgets/` and `lib/screens/pair_screen.dart`
are already here from the canvas app to build it on.
