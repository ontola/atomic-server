# Atomic Canvas Flutter — Agent Context

## Sync & onboarding — read first

Canvas uses [`package:atomic_flutter`](../dart/atomic_lib/) for auth, sync,
pairing, and workspaces. Before changing those screens, read
[`../planning/sync-onboarding-ux.md`](../planning/sync-onboarding-ux.md) and
[`../planning/atomic-flutter-sdk.md`](../planning/atomic-flutter-sdk.md).

Change a sync screen in the package → change its browser twin, and update that doc.

## What This Is

A cross-platform infinite drawing canvas app. Flutter targets Android, iOS, and
Web. Atomic plumbing (agent, drive, sync, QR pairing UI) lives in
`dart/atomic_lib`; this folder is the canvas product UI on top.

## Architecture

```
flutter/lib/                 # Canvas-only
├── main.dart                # Atomic.init() + MaterialApp
├── theme.dart               # Canvas AppColors
├── canvas/                  # Infinite canvas, painter, gestures
├── gallery/                 # Canvas list + folders
├── models/                  # StrokeData, CanvasEntry
└── widgets/                 # Toolbars, fans, history scrubber

dart/atomic_lib/         # Reusable SDK
├── lib/src/                 # AtomicClient, session, Atomic facade
├── lib/src/ui/              # Login, Pair, sync settings, drive switcher
└── rust/                    # flutter_rust_bridge over atomic_lib
```

### Storage: atomic-server / local node

Uses **atomic_lib** (Rust) via `flutter_rust_bridge` inside `atomic_lib`.
Authentication uses Ed25519 keypairs (agents). Optional AtomicServer / Iroh for sync.

### Canvas Coordinate System

`screenPos = canvasPos * scale + offset` — same convention as the Kotlin app.

### Gesture Model

- **Stylus** → draw
- **Single finger** → draw (pen tool) or pan (select tool)
- **Two fingers** → pinch zoom + pan (always, regardless of tool)

## Dev Environment

- Flutter 3.44+ (via mise, see `flutter/mise.toml`)
- Rust toolchain for flutter_rust_bridge (needs wasm32 target for web)
- Run: `mise exec -- flutter run -d chrome` (web) or `flutter run` (mobile)

## Gotchas

- Do not edit `dart/atomic_lib/lib/src/rust/` — FRB generated
- After changing the Rust bridge API, regenerate from `dart/atomic_lib/`
- Canvas CRUD helpers (`createCanvas`, `pushStroke`, …) still sit on
  `AtomicClient` until generic query/mutate/blobs land — prefer not to grow them
