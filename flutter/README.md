# Atomic Canvas

- An android app note taking / infinite canvas drawing / vector app with pen & draw support
- Extremely snappy, no-nonsense
- Uses a CRDT (Loro) to sync notes and brush strokes. Full history playback and versioning.
- Uses modern android standards and APIs. research conventions.
- Easy & fast management with folders
- Smart gestures, controls, pen support
  - if using a pencil, fingers pan (single finger drag) & undo (double finger tap) & select (single finger hold)
  - if using fingers, fingers pan, but user can quickly toggle draw mode
  - Manu items have hold & drag interactions for fast gestures
- Simple, clean, minimal UI, a couple of buttons at the buttom:
  - Tutorial (starts tutorial, shows UX)
  - Color selector (drag, a fan pops up, let go to select color. Tap to go back to previous color)
  - Size adjust (same UX: drag & hold to select, tap to go to previous)
  - History scrubber. Tap to undo, scrub to navigate history. You can even open "forgotten" branches of undo history, so nothing is ever lost
  - New canvas button
  - Gallery / back
  - Eraser
  - Reset view /zoom scrubber (tap to fit all content, or tap again to go back to previous view)
  - Place image

## Architecture

Canvas UI lives here. Auth, local store, sync, pairing, and drive switching come
from [`package:atomic_flutter`](../dart/atomic_lib/) — the reusable Atomic
Dart/Flutter SDK. See that package's README for the app-builder API.

```
flutter/          → canvas app (gallery, drawing, theme)
dart/atomic_lib/ → Atomic SDK (Rust bridge + Dart API + reusable UI)
```

## Development

This project uses [mise](https://mise.jdx.dev/) to manage the Flutter SDK (Flutter 3.44+ — see `mise.toml`).

A `Makefile` wraps `dev.sh` which sets up a FIFO pipe so you can trigger hot reload **from any terminal tab** — no need to switch focus or type into the running process.

### Starting dev servers

Run each device in a separate terminal (they share `build/`, so don't start them simultaneously):

```bash
# Terminal 1
make tablet     # Samsung SM X810 tablet

# Terminal 2 (after tablet finishes building)
make phone      # Pixel phone (456cb10b)

make web        # Chrome (separate terminal)
```

### Logs

Output is captured to `logs/<target>.log` (truncated on each launch):

```bash
grep "error" logs/tablet.log
grep "iroh" logs/phone.log
```

### Hot reload (from any terminal)

```bash
make reload-tablet    # Hot reload
make restart-tablet   # Hot restart
make reload-all       # Reload all running targets
make restart-all
```

### Other

```bash
make analyze    # Static analysis
```

To update the Android device IDs, edit `dev.sh` (`ANDROID1_ID` = tablet, `ANDROID2_ID` = phone).

### Sync / Pairing

Devices sync via [Iroh](https://iroh.computer) (QUIC peer-to-peer, works through NAT).

- Open Settings > **Pair with QR Code**
- Device A shows its QR code, Device B scans it (or vice versa)
- Sync is bidirectional — both devices exchange data regardless of who initiates

NodeIDs are persistent (stored in the local DB), so a QR code stays valid across app restarts.

### Zoom / pan

| Input | Action |
|---|---|
| Trackpad pinch | Zoom |
| Ctrl + scroll | Zoom |
| Two-finger scroll | Pan |
| Middle mouse drag | Pan |

### Stylus / pen input

When a stylus or pen is detected, **finger touches pan the canvas** instead of drawing. This matches the behaviour of the Kotlin version: use the pen to draw, fingers to navigate.
