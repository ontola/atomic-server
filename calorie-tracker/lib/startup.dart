import 'package:flutter/foundation.dart';

/// How long it took to get a live viewfinder.
///
/// Phase 3's acceptance criterion is "cold start → live preview < 1s on
/// mid-range hardware" (`planning/calorie-tracker-plan.md` §7), and a budget
/// nobody measures is a wish. This is the measurement: started as the binding
/// comes up, read the first time the preview has a frame, printed once.
///
/// It undercounts by the engine start that happens before `main` — which is the
/// part no app code can change anyway, so what is left is the part worth
/// watching: opening redb, opening the camera, and finding the documents
/// directory, all three of which run at once by design.
final Stopwatch startupClock = Stopwatch()..start();

bool _reported = false;

/// Called by the viewfinder the first time it draws a live frame.
void reportFirstPreview() {
  if (_reported) return;
  _reported = true;
  startupClock.stop();
  debugPrint(
    'Startup: live camera preview after ${startupClock.elapsedMilliseconds} ms',
  );
}

/// Tests run many launches in one process; without this the second one reports
/// the first one's clock.
@visibleForTesting
void resetStartupClock() {
  _reported = false;
  startupClock
    ..reset()
    ..start();
}
