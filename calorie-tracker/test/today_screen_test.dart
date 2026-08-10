import 'package:calorie_tracker/models/meal.dart';
import 'package:calorie_tracker/screens/today_screen.dart';
import 'package:calorie_tracker/services/app_session.dart';
import 'package:calorie_tracker/services/meal_store.dart';
import 'package:calorie_tracker/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_atomic_backend.dart';
import 'fake_meal_backend.dart';

/// A session already past onboarding, so the screen under test has an account
/// to show behind its settings icon.
///
/// The session persists as it really does — [AtomicSession] writes through
/// `SharedPreferences` and `FlutterSecureStorage`, and without their mocks
/// those channels never answer in the test VM and the whole file hangs.
Future<AppSession> readySession() async {
  final session = AppSession(backend: FakeAtomicBackend(FakeStore()));
  await session.start();
  await session.createAccount();
  return session;
}

Future<MealStore> pump(
  WidgetTester tester,
  FakeMealBackend backend, {
  DateTime? day,
}) async {
  final session = await readySession();
  final store = MealStore(backend: backend, day: day ?? DateTime.now());

  await tester.pumpWidget(MaterialApp(
    theme: buildTheme(Brightness.dark),
    home: TodayScreen(session: session, store: store),
  ));
  await tester.pumpAndSettle();

  return store;
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
  });

  testWidgets('an empty day says so, and shows a zero', (tester) async {
    await pump(tester, FakeMealBackend());

    expect(find.text('Today'), findsOneWidget);
    expect(find.text('0'), findsOneWidget);
    expect(find.text('Nothing logged yet'), findsOneWidget);
  });

  testWidgets('the total and the meals are on the screen', (tester) async {
    final now = DateTime.now();
    final backend = FakeMealBackend()
      ..seed(Meal(
        subject: 'a',
        name: 'Cappuccino',
        description: '',
        consumedAt: DateTime(now.year, now.month, now.day, 8, 30),
        status: MealStatus.confirmed,
        calories: 120,
      ))
      ..seed(Meal(
        subject: 'b',
        name: 'Pizza',
        description: '',
        consumedAt: DateTime(now.year, now.month, now.day, 19, 5),
        status: MealStatus.confirmed,
        calories: 850,
      ));

    await pump(tester, backend);

    expect(find.text('970'), findsOneWidget);
    expect(find.text('Cappuccino'), findsOneWidget);
    expect(find.text('08:30'), findsOneWidget);
    expect(find.text('Pizza'), findsOneWidget);
    expect(find.text('19:05'), findsOneWidget);
  });

  /// The row for a meal nobody has estimated has to read as a queue rather
  /// than as a broken row: no name, no number, and neither is an error.
  testWidgets('a meal with no estimate says what it is waiting for',
      (tester) async {
    final now = DateTime.now();
    final backend = FakeMealBackend()
      ..seed(Meal(
        subject: 'a',
        name: '',
        description: '',
        consumedAt: DateTime(now.year, now.month, now.day, 12),
        status: MealStatus.pending,
      ));

    await pump(tester, backend);

    expect(find.text('Not estimated yet'), findsOneWidget);
    expect(find.text('waiting'), findsOneWidget);
    expect(find.text('—'), findsOneWidget);
    expect(find.text('1 meal not counted yet'), findsOneWidget);
  });

  testWidgets('logging a meal puts it in the list and in the total',
      (tester) async {
    final store = await pump(tester, FakeMealBackend());

    await tester.tap(find.text('Log a meal'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextFormField, 'Meal'), 'Toast');
    await tester.enterText(
        find.widgetWithText(TextFormField, 'Calories'), '250');
    await tester.tap(find.text('Log it'));
    await tester.pumpAndSettle();

    expect(find.text('Toast'), findsOneWidget);
    expect(find.text('250'), findsNWidgets(2), reason: 'the row and the total');
    expect(store.meals.single.status, MealStatus.confirmed);
  });

  testWidgets('a meal with nothing typed in it is refused', (tester) async {
    final backend = FakeMealBackend();
    await pump(tester, backend);

    await tester.tap(find.text('Log a meal'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Log it'));
    await tester.pumpAndSettle();

    expect(find.text('Say what it was'), findsOneWidget);
    expect(find.text('Log it'), findsOneWidget,
        reason: 'the sheet stays open on what it is asking for');
    expect(backend.meals, isEmpty);
  });

  /// The other half of that: the calorie field is optional now, and leaving it
  /// blank is the ordinary way to log a typed meal — it is the user asking the
  /// estimator for a number rather than giving it one.
  testWidgets('a meal typed without a number is logged, and waits', (tester) async {
    final backend = FakeMealBackend();
    await pump(tester, backend);

    await tester.tap(find.text('Log a meal'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.widgetWithText(TextFormField, 'Meal'), 'Two slices of margherita');
    await tester.tap(find.text('Log it'));
    await tester.pumpAndSettle();

    final meal = backend.meals.single;
    expect(meal.name, 'Two slices of margherita');
    expect(meal.calories, isNull);
    expect(meal.status, MealStatus.pending);
    expect(
      meal.notes,
      'Two slices of margherita',
      reason: 'their words are what the estimator gets, and the estimate is '
          'about to replace the name with its own',
    );
  });

  testWidgets('tapping a meal edits it', (tester) async {
    final backend = FakeMealBackend();
    final store = await pump(tester, backend);
    await store.logMeal(name: 'Sandwich', calories: 350);
    await tester.pumpAndSettle();

    await tester.tap(find.text('Sandwich'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.widgetWithText(TextFormField, 'Calories'), '500');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(find.text('Sandwich'), findsOneWidget);
    expect(find.text('500'), findsNWidgets(2));
  });

  testWidgets('a meal can be deleted from its edit sheet', (tester) async {
    final backend = FakeMealBackend();
    final store = await pump(tester, backend);
    await store.logMeal(name: 'Regrettable', calories: 900);
    await tester.pumpAndSettle();

    await tester.tap(find.text('Regrettable'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();

    expect(find.text('Regrettable'), findsNothing);
    expect(find.text('Nothing logged yet'), findsOneWidget);
    expect(backend.meals, isEmpty);
  });

  testWidgets('a write that fails says why', (tester) async {
    final backend = FakeMealBackend()..writeError = Exception('No active drive');
    await pump(tester, backend);

    await tester.tap(find.text('Log a meal'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextFormField, 'Meal'), 'Toast');
    await tester.enterText(
        find.widgetWithText(TextFormField, 'Calories'), '250');
    await tester.tap(find.text('Log it'));
    await tester.pumpAndSettle();

    expect(find.text('No active drive'), findsOneWidget);
  });

  testWidgets('settings is one tap away, and the secret two', (tester) async {
    await pump(tester, FakeMealBackend());

    await tester.tap(find.byIcon(Icons.settings_outlined));
    await tester.pumpAndSettle();

    expect(find.widgetWithText(AppBar, 'Settings'), findsOneWidget);
    expect(find.text('Today'), findsNothing);

    // The secret moved a tap further away, which is the point of the hub —
    // but it is still reachable without knowing where it went.
    await tester.tap(find.text('Account'));
    await tester.pumpAndSettle();

    expect(find.widgetWithText(AppBar, 'Account'), findsOneWidget);
    expect(find.text('Copy my secret'), findsOneWidget);
  });
}
