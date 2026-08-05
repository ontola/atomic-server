import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:calorie_tracker/atomic/atomic_client.dart';
import 'package:calorie_tracker/atomic/session.dart';
import 'package:calorie_tracker/main.dart';

/// Phase 1's acceptance criterion, on a real device or simulator: onboard, kill
/// the app, relaunch, and still be the same account with the same meals
/// container — through the real Rust bridge, the real redb store and the real
/// Keychain / EncryptedSharedPreferences.
///
/// `test/` covers the same flow against a faked bridge in milliseconds. This is
/// the part it cannot prove: that the library is in the app bundle, that the
/// store survives the process, and that the secret comes back out of platform
/// secure storage.
///
///     flutter test integration_test/bridge_test.dart
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  const nameProperty = 'https://atomicdata.dev/properties/name';
  const parentProperty = 'https://atomicdata.dev/properties/parent';

  testWidgets('an account and its meals container survive a relaunch',
      (tester) async {
    // Whatever a previous run left in secure storage, this starts where a fresh
    // install starts.
    await AtomicSession.clear();

    await tester.pumpWidget(const CalorieTrackerApp());
    await _pumpUntil(tester, find.text('Start tracking'));

    await tester.tap(find.text('Start tracking'));
    await _pumpUntil(tester, find.text('Copy my secret'));

    final agent = await AtomicClient.getActiveAgent();
    expect(agent, isNotNull, reason: 'onboarding must leave an agent behind');
    final drive = AtomicClient.getActiveDrive();
    expect(drive, isNotNull);

    // The container is real, named, and hanging off the drive — not just a
    // subject a screen printed.
    final meals = await AtomicClient.ensureMealsContainer();
    expect(await AtomicClient.getProperty(meals, nameProperty), 'Meals');
    expect(await AtomicClient.getProperty(meals, parentProperty), drive);

    // Relaunch: tear the tree down and build a new one, so a new AppSession
    // boots from storage rather than from anything still in memory.
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    await tester.pumpWidget(const CalorieTrackerApp());
    await _pumpUntil(tester, find.text('Copy my secret'));

    expect(find.text('Start tracking'), findsNothing,
        reason: 'a restored account must not be asked to onboard again');

    final restored = await AtomicClient.getActiveAgent();
    expect(restored?.subject, agent!.subject);
    expect(restored?.secret, agent.secret);
    expect(AtomicClient.getActiveDrive(), drive);
    expect(await AtomicClient.ensureMealsContainer(), meals,
        reason: 'the second launch finds the container, it does not make one');
  });
}

/// Pump until [finder] hits. The work behind these screens touches the
/// filesystem and the Keychain, so the wait is polled rather than guessed — and
/// `pumpAndSettle` is no use here: the loading spinner never settles.
Future<void> _pumpUntil(
  WidgetTester tester,
  Finder finder, {
  Duration timeout = const Duration(seconds: 20),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(milliseconds: 100));
    if (finder.evaluate().isNotEmpty) return;
  }

  // What is on screen instead is the whole diagnosis — every phase of the
  // session has different words on it — and rebuilding this app to find out
  // costs six minutes.
  // SelectableText as well as Text: the failure screens put the reason in one.
  final onScreen = tester.allWidgets
      .map((w) => switch (w) {
            Text(:final data) => data,
            SelectableText(:final data) => data,
            _ => null,
          })
      .whereType<String>()
      .toList();
  fail('timed out waiting for $finder; on screen instead: $onScreen');
}
