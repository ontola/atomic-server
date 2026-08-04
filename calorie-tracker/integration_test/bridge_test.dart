import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:calorie_tracker/atomic/atomic_client.dart';
import 'package:calorie_tracker/main.dart';

/// Phase 0's acceptance criterion, run on a real device or simulator:
/// the Rust bridge loads, the redb store opens under the app's documents
/// directory, and `setup()` mints an agent and a drive that come back through
/// FFI. Unit tests cover the same calls against a temp directory in a plain
/// cargo process; this is the part they cannot prove — that the library is
/// actually built into the app bundle and callable from the Dart isolate.
///
///     flutter test integration_test/bridge_test.dart
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the bridge opens a store and mints an agent', (tester) async {
    await tester.pumpWidget(const CalorieTrackerApp());

    // Opening redb touches the filesystem, so the button stays disabled for a
    // moment after first frame. Poll rather than guess a duration.
    final button = find.byType(FilledButton);
    var settled = false;
    for (var i = 0; i < 100 && !settled; i++) {
      await tester.pump(const Duration(milliseconds: 100));
      settled = tester.widget<FilledButton>(button).onPressed != null;
    }
    expect(settled, isTrue, reason: 'the store never finished opening');

    await tester.tap(button);
    for (var i = 0; i < 100; i++) {
      await tester.pump(const Duration(milliseconds: 100));
      if (find.textContaining('Agent ').evaluate().isNotEmpty) break;
    }

    expect(find.textContaining('Agent '), findsOneWidget);
    expect(find.textContaining('Drive '), findsOneWidget);

    // Read it back through a second FFI call rather than trusting the string
    // the button rendered: a setup that returns a subject but leaves no active
    // agent behind would still have painted that text.
    final agent = await AtomicClient.getActiveAgent();
    expect(agent, isNotNull);
    expect(agent!.subject, isNotEmpty);
    expect(AtomicClient.getActiveDrive(), isNotNull);
  });
}
