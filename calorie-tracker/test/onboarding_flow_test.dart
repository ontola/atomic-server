import 'dart:async';

import 'package:calorie_tracker/main.dart';
import 'package:calorie_tracker/services/app_session.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_atomic_backend.dart';
import 'fake_camera.dart';

/// The flow as a thumb meets it: one screen, one tap to an account, and a way
/// back in for someone who already has one. `app_session_test.dart` covers what
/// the same steps do to the store; this covers what is on the screen.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeStore store;
  late FakeCamera camera;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    store = FakeStore();
    camera = FakeCamera();
  });

  /// The camera is injected, and `images` deliberately is not: with no photo
  /// directory the capture screen still logs meals, which is the state these
  /// tests want anyway — they are about the flow that gets you to it.
  Widget app(FakeAtomicBackend backend) => CalorieTrackerApp(
        session: AppSession(backend: backend),
        camera: camera,
      );

  testWidgets('the first frame is up before the store is', (tester) async {
    // Startup speed is a feature (`calorie-tracker-plan.md` §7): opening redb
    // must never be the reason nothing is on screen. The camera comes up
    // alongside it rather than after it — see `resumesAccount`.
    final backend = FakeAtomicBackend(store)..holdOpen = Completer<void>();

    await tester.pumpWidget(app(backend));
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text('Start tracking'), findsNothing);

    backend.holdOpen!.complete();
    await tester.pumpAndSettle();

    expect(find.text('Start tracking'), findsOneWidget);
  });

  testWidgets('one tap makes an account and lands on the app', (tester) async {
    await tester.pumpWidget(app(FakeAtomicBackend(store)));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Start tracking'));
    await tester.pumpAndSettle();

    expect(find.text('kcal today'), findsOneWidget,
        reason: 'a fresh signup lands on the viewfinder, ready to shoot');
    expect(store.mealsContainersCreated, 1);
  });

  testWidgets('an existing account comes back from its secret', (tester) async {
    const drive = 'did:ad:drive:from-the-old-phone';
    store.presentDrives.add(drive);

    await tester.pumpWidget(app(FakeAtomicBackend(store)));
    await tester.pumpAndSettle();

    await tester.tap(find.text('I already have an account'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), FakeStore.secretFor(drive));
    await tester.tap(find.text('Restore'));
    await tester.pumpAndSettle();

    expect(find.text('kcal today'), findsOneWidget);
  });

  testWidgets('a secret that is not one says so, on the screen it was typed on',
      (tester) async {
    await tester.pumpWidget(app(FakeAtomicBackend(store)));
    await tester.pumpAndSettle();

    await tester.tap(find.text('I already have an account'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'my-cat-name');
    await tester.tap(find.text('Restore'));
    await tester.pumpAndSettle();

    expect(find.textContaining('Invalid secret'), findsOneWidget);
    expect(find.text('Restore'), findsOneWidget,
        reason: 'the field it was typed in has to still be there to fix it');
  });

  testWidgets('a phone that has the account but not the meals goes looking',
      (tester) async {
    final backend = FakeAtomicBackend(store)..syncFindsDrive = true;

    await tester.pumpWidget(app(backend));
    await tester.pumpAndSettle();

    await tester.tap(find.text('I already have an account'));
    await tester.pumpAndSettle();

    await tester.enterText(
        find.byType(TextField), FakeStore.secretFor('did:ad:drive:elsewhere'));
    await tester.tap(find.text('Restore'));
    await tester.pumpAndSettle();

    // The sync screen looks on arrival — nobody has to be told to tap "sync".
    expect(backend.syncCalls, 1);
    expect(find.text('kcal today'), findsOneWidget);
  });

  testWidgets('the drive stays waiting when no other device answers',
      (tester) async {
    await tester.pumpWidget(app(FakeAtomicBackend(store)));
    await tester.pumpAndSettle();

    await tester.tap(find.text('I already have an account'));
    await tester.pumpAndSettle();

    await tester.enterText(
        find.byType(TextField), FakeStore.secretFor('did:ad:drive:elsewhere'));
    await tester.tap(find.text('Restore'));
    await tester.pumpAndSettle();

    expect(find.text('Getting your meals'), findsOneWidget);
    expect(find.textContaining('No peers online'), findsOneWidget);
  });
}
