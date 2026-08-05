import 'package:calorie_tracker/models/meal.dart';
import 'package:calorie_tracker/screens/history_screen.dart';
import 'package:calorie_tracker/screens/today_screen.dart';
import 'package:calorie_tracker/services/meal_store.dart';
import 'package:calorie_tracker/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_meal_backend.dart';
import 'today_screen_test.dart' show readySession;

/// History is a screen with one real job — the totals — and it is the one place
/// the app adds meals up across a day boundary rather than inside one. So these
/// are mostly about the arithmetic and about which day a meal lands on.
void main() {
  late FakeMealBackend backend;
  late MealStore store;

  /// Midday, so nothing here is within twelve hours of a boundary and the
  /// suite means the same thing whatever time it is run at.
  final today = DateTime.now();
  DateTime daysAgo(int days, int hour) => DateTime(
        today.year,
        today.month,
        today.day - days,
        hour,
      );

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    backend = FakeMealBackend();
    store = MealStore(backend: backend, day: today);
  });

  void seed(DateTime at, String name, {int? calories, int? min, int? max}) {
    backend.seed(Meal(
      subject: '$name-${at.millisecondsSinceEpoch}',
      name: name,
      description: '',
      consumedAt: at,
      status: calories == null ? MealStatus.pending : MealStatus.confirmed,
      calories: calories,
      caloriesMin: min,
      caloriesMax: max,
    ));
  }

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(Brightness.dark),
      home: HistoryScreen(session: await readySession(), store: store),
    ));
    await tester.pumpAndSettle();
  }

  testWidgets('each day is one row, with what it came to', (tester) async {
    seed(daysAgo(1, 8), 'Porridge', calories: 300);
    seed(daysAgo(1, 19), 'Pizza', calories: 850);
    seed(daysAgo(3, 13), 'Salad', calories: 220);

    await pump(tester);

    expect(find.text(formatDay(daysAgo(1, 0))), findsOneWidget);
    expect(find.text('1150'), findsOneWidget);
    expect(find.text(formatDay(daysAgo(3, 0))), findsOneWidget);
    expect(find.text('220'), findsOneWidget);
    expect(find.text('2 meals'), findsOneWidget);
    expect(find.text('1 meal'), findsOneWidget);
  });

  /// Days with nothing in them are not rows. An unbroken run of zeroes says
  /// the app was used and the food wasn't, which is the wrong story.
  testWidgets('a day nobody logged anything on is not in the list',
      (tester) async {
    seed(daysAgo(1, 8), 'Porridge', calories: 300);
    seed(daysAgo(4, 8), 'Toast', calories: 200);

    await pump(tester);

    expect(find.byType(Card), findsNWidgets(2));
    expect(find.text(formatDay(daysAgo(2, 0))), findsNothing);
  });

  /// The one thing the boundary arithmetic can get wrong: a late meal is the
  /// day it was eaten on, not the next one.
  testWidgets('a meal at 23:59 belongs to the day it was eaten on',
      (tester) async {
    seed(daysAgo(2, 23).add(const Duration(minutes: 59)), 'Late dinner',
        calories: 600);
    seed(daysAgo(1, 0), 'Midnight snack', calories: 200);

    await pump(tester);

    expect(find.text(formatDay(daysAgo(2, 0))), findsOneWidget);
    expect(find.text('600'), findsOneWidget);
    expect(find.text('200'), findsOneWidget);
  });

  testWidgets('a day still waiting on estimates says how much it is missing',
      (tester) async {
    seed(daysAgo(1, 8), 'Porridge', calories: 300);
    seed(daysAgo(1, 13), '');

    await pump(tester);

    expect(find.text('300'), findsOneWidget,
        reason: 'unestimated is not zero, and must not be added in');
    expect(find.textContaining('1 not counted'), findsOneWidget);
  });

  testWidgets('a range is shown when the estimates have one', (tester) async {
    seed(daysAgo(1, 8), 'Porridge', calories: 300, min: 250, max: 380);

    await pump(tester);

    expect(find.textContaining('250–380 kcal'), findsOneWidget);
  });

  testWidgets('tapping a day opens it', (tester) async {
    seed(daysAgo(1, 8), 'Porridge', calories: 300);

    await pump(tester);
    await tester.tap(find.text(formatDay(daysAgo(1, 0))));
    await tester.pumpAndSettle();

    expect(find.byType(TodayScreen), findsOneWidget);
    expect(find.widgetWithText(AppBar, formatDay(daysAgo(1, 0))),
        findsOneWidget);
    expect(find.text('Porridge'), findsOneWidget);
  });

  testWidgets('an empty history says so rather than showing nothing',
      (tester) async {
    await pump(tester);

    expect(find.text('Nothing here yet'), findsOneWidget);
  });

  testWidgets('a read that fails offers another go', (tester) async {
    backend.readError = Exception('Store is not open');

    await pump(tester);

    expect(find.text('Could not read your history'), findsOneWidget);
    expect(find.text('Store is not open'), findsOneWidget);

    backend.readError = null;
    seed(daysAgo(1, 8), 'Porridge', calories: 300);
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();

    expect(find.text('300'), findsOneWidget);
  });
}
