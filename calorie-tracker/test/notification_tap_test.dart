import 'dart:async';

import 'package:calorie_tracker/main.dart';
import 'package:calorie_tracker/models/meal.dart';
import 'package:calorie_tracker/screens/meal_entry_sheet.dart';
import 'package:calorie_tracker/services/app_session.dart';
import 'package:calorie_tracker/services/meal_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_atomic_backend.dart';
import 'fake_camera.dart';
import 'fake_meal_backend.dart';
import 'fake_notifier.dart';

/// What a tap on "About that meal" does.
///
/// The interesting case is the cold one: the tap *launches* the app, so it
/// arrives before there is a store to look the meal up in and before there is a
/// navigator to put a sheet on. Both orders are here, because the app is
/// listening to two things that can land either way round.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeStore store;
  late FakeMealBackend meals;
  late FakeNotifier notifier;
  late FakeCamera camera;

  /// An account already on the device, so every launch below resumes it and
  /// lands on the viewfinder rather than on onboarding — which is the only kind
  /// of launch a notification tap can happen on.
  const drive = 'did:ad:drive:mine';

  setUp(() {
    SharedPreferences.setMockInitialValues({
      'atomic_server_url': '',
      'atomic_drive': drive,
    });
    FlutterSecureStorage.setMockInitialValues(
      {'atomic_agent_secret': FakeStore.secretFor(drive)},
    );
    store = FakeStore()..presentDrives.add(drive);
    meals = FakeMealBackend();
    notifier = FakeNotifier();
    camera = FakeCamera();
  });

  /// A meal that was asked about, on today so the list behind the sheet has it.
  String asked() {
    final now = DateTime.now();
    meals.seed(Meal(
      subject: 'did:ad:meal:asked',
      name: 'Glass of something white',
      description: '',
      consumedAt: DateTime(now.year, now.month, now.day, 9),
      status: MealStatus.needsInfo,
      calories: 140,
      clarifyingQuestion: 'Was that milk or oat milk?',
    ));
    return 'did:ad:meal:asked';
  }

  Widget app(FakeAtomicBackend backend) => CalorieTrackerApp(
        session: AppSession(backend: backend),
        camera: camera,
        meals: MealStore(backend: meals, day: DateTime.now()),
        notifier: notifier,
      );

  testWidgets('a tap opens the meal it was about', (tester) async {
    final subject = asked();

    await tester.pumpWidget(app(FakeAtomicBackend(store)));
    await tester.pumpAndSettle();
    expect(notifier.started, isTrue);

    notifier.tap(subject);
    await tester.pumpAndSettle();

    expect(find.byType(MealEntrySheet), findsOneWidget);
    expect(find.text('Was that milk or oat milk?'), findsOneWidget);
  });

  /// The cold launch. The tap is known before the store is open, and opening a
  /// sheet then would mean querying a database that is not there — so it has to
  /// wait for the session and then still happen.
  testWidgets('a tap that launched the app waits for the store', (tester) async {
    final subject = asked();
    final backend = FakeAtomicBackend(store)..holdOpen = Completer<void>();

    await tester.pumpWidget(app(backend));
    notifier.tap(subject);
    await tester.pump();

    expect(find.byType(MealEntrySheet), findsNothing,
        reason: 'there is nothing to look the meal up in yet');

    backend.holdOpen!.complete();
    await tester.pumpAndSettle();

    expect(find.byType(MealEntrySheet), findsOneWidget);
    expect(find.text('Was that milk or oat milk?'), findsOneWidget);
  });

  /// The meal can be deleted, or answered on another device, while its question
  /// sits on a lock screen. Nothing to open, and nothing worth saying about it.
  testWidgets('a tap about a meal that is gone does nothing', (tester) async {
    await tester.pumpWidget(app(FakeAtomicBackend(store)));
    await tester.pumpAndSettle();

    notifier.tap('did:ad:meal:deleted');
    await tester.pumpAndSettle();

    expect(find.byType(MealEntrySheet), findsNothing);
    expect(find.text('kcal today'), findsOneWidget);
  });
}
