import 'package:calorie_tracker/models/meal.dart';
import 'package:calorie_tracker/services/meal_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_meal_backend.dart';

/// A meal on [day] at [hour]:[minute], local time — which is the only time
/// that means anything here. Every boundary case below is built this way rather
/// than from epoch milliseconds, so the tests say the same thing in Amsterdam,
/// in UTC and in Chatham Islands, and they say it across a DST change too.
Meal mealAt(
  DateTime day,
  int hour,
  int minute, {
  String name = 'Meal',
  int? calories = 100,
  int? min,
  int? max,
  MealStatus status = MealStatus.confirmed,
  String subject = 'did:ad:meal:seeded',
}) =>
    Meal(
      subject: subject,
      name: name,
      description: '',
      consumedAt: DateTime(day.year, day.month, day.day, hour, minute),
      status: status,
      calories: calories,
      caloriesMin: min,
      caloriesMax: max,
    );

void main() {
  final day = DateTime(2026, 8, 5);

  group('the day a meal belongs to', () {
    test('is the local day it was eaten on, right up to 23:59', () async {
      final backend = FakeMealBackend()
        ..seed(mealAt(day, 23, 59, calories: 700, subject: 'late'))
        ..seed(mealAt(day, 0, 0, calories: 300, subject: 'early'));
      final store = MealStore(backend: backend, day: day);

      await store.load();

      expect(
        store.meals.map((m) => m.subject),
        ['late', 'early'],
        reason: 'both ends of the day are in it, newest first',
      );
      expect(store.summary.calories, 1000);
    });

    test('excludes the midnight that starts the next one', () async {
      final backend = FakeMealBackend()
        ..seed(mealAt(day, 23, 59, calories: 700, subject: 'tonight'))
        ..seed(mealAt(day.add(const Duration(days: 1)), 0, 0,
            calories: 300, subject: 'tomorrow'));
      final store = MealStore(backend: backend, day: day);

      await store.load();

      expect(store.meals.map((m) => m.subject), ['tonight']);
      expect(store.summary.calories, 700);
    });

    /// The last day of a month is where "add 24 hours" and "the next local
    /// midnight" stop agreeing if the arithmetic is done by hand.
    test('is right on the last day of a month', () async {
      final lastOfJuly = DateTime(2026, 7, 31);
      final backend = FakeMealBackend()
        ..seed(mealAt(lastOfJuly, 22, 0, calories: 500, subject: 'july'))
        ..seed(mealAt(DateTime(2026, 8, 1), 1, 0,
            calories: 500, subject: 'august'));
      final store = MealStore(backend: backend, day: lastOfJuly);

      await store.load();

      expect(store.meals.map((m) => m.subject), ['july']);
    });

    /// Days have to tile the timeline: no instant in two of them, none in
    /// none of them. An implementation that took `start + 24h` as the end
    /// passes every other test here and breaks on exactly these dates, in the
    /// zones where they are a clock change — and it breaks by dropping or
    /// double-counting an hour of meals.
    test('tiles the timeline even where a day is 23 or 25 hours long', () {
      const oneHour = 3600 * 1000;
      // The European, US and southern-hemisphere clock changes of 2026, so
      // whichever of those this machine is in, at least one of these is a real
      // one — and in UTC they are ordinary days that must still tile.
      for (final date in [
        DateTime(2026, 3, 8),
        DateTime(2026, 3, 29),
        DateTime(2026, 4, 5),
        DateTime(2026, 10, 4),
        DateTime(2026, 10, 25),
        DateTime(2026, 11, 1),
      ]) {
        final bounds = localDayBounds(date);
        final next = localDayBounds(DateTime(date.year, date.month, date.day + 1));

        expect(bounds.toMs, next.fromMs,
            reason: 'no gap and no overlap after $date');
        expect(bounds.toMs - bounds.fromMs,
            inInclusiveRange(23 * oneHour, 25 * oneHour),
            reason: '$date is a day long, however many hours that is');
      }
    });
  });

  group('the day total', () {
    test('adds up only the meals that have a number', () async {
      final backend = FakeMealBackend()
        ..seed(mealAt(day, 8, 0, calories: 400, subject: 'breakfast'))
        ..seed(mealAt(day, 13, 0,
            calories: null, status: MealStatus.pending, subject: 'photo'));
      final store = MealStore(backend: backend, day: day);

      await store.load();

      expect(store.summary.calories, 400);
      expect(store.summary.mealCount, 2);
      expect(
        store.summary.unestimatedCount,
        1,
        reason: 'a total that quietly counted the unestimated one as 0 '
            'would be a number the user acts on',
      );
    });

    test('carries the range when an estimate had one', () async {
      final backend = FakeMealBackend()
        ..seed(mealAt(day, 8, 0, calories: 400, min: 300, max: 550))
        ..seed(mealAt(day, 13, 0, calories: 200, subject: 'exact'));
      final store = MealStore(backend: backend, day: day);

      await store.load();

      expect(store.summary.calories, 600);
      expect(store.summary.lowerBound, 500);
      expect(store.summary.upperBound, 750);
      expect(store.summary.hasRange, isTrue);
    });

    test('has no range when every meal is one number', () async {
      final backend = FakeMealBackend()..seed(mealAt(day, 8, 0, calories: 400));
      final store = MealStore(backend: backend, day: day);

      await store.load();

      expect(store.summary.hasRange, isFalse);
    });

    test('is zero on a day with nothing in it', () async {
      final store = MealStore(backend: FakeMealBackend(), day: day);

      await store.load();

      expect(store.summary.calories, 0);
      expect(store.summary.mealCount, 0);
      expect(store.meals, isEmpty);
    });
  });

  group('writing', () {
    test('a logged meal lands in today and in the total', () async {
      final backend = FakeMealBackend();
      final store = MealStore(backend: backend, day: DateTime.now());

      await store.logMeal(name: 'Cappuccino', calories: 120);

      expect(store.meals.single.name, 'Cappuccino');
      expect(store.meals.single.status, MealStatus.confirmed);
      expect(store.summary.calories, 120);
    });

    test('an edit replaces what was edited and keeps the rest', () async {
      final backend = FakeMealBackend();
      final store = MealStore(backend: backend, day: DateTime.now());
      await store.logMeal(name: 'Sandwich', calories: 350);
      final subject = store.meals.single.subject;

      await store.editMeal(subject, name: 'Cheese sandwich');

      expect(store.meals.single.name, 'Cheese sandwich');
      expect(store.meals.single.calories, 350);
    });

    test('a deleted meal leaves the day and the total', () async {
      final backend = FakeMealBackend();
      final store = MealStore(backend: backend, day: DateTime.now());
      await store.logMeal(name: 'Regrettable', calories: 900);

      await store.deleteMeal(store.meals.single.subject);

      expect(store.meals, isEmpty);
      expect(store.summary.calories, 0);
    });

    /// A meal typed just after midnight, for something eaten before it, is
    /// still written — it just isn't in the day on screen. Refusing it would
    /// throw away what the user typed.
    test('a meal eaten on another day is saved but not shown', () async {
      final backend = FakeMealBackend();
      final store = MealStore(backend: backend, day: day);

      await store.logMeal(
        name: 'Yesterday\'s dinner',
        calories: 800,
        consumedAt: DateTime(day.year, day.month, day.day - 1, 19),
      );

      expect(store.meals, isEmpty);
      expect(backend.meals.single.name, 'Yesterday\'s dinner');
    });

    test('a failed write is reported and changes nothing', () async {
      final backend = FakeMealBackend();
      final store = MealStore(backend: backend, day: DateTime.now());
      await store.logMeal(name: 'Toast', calories: 200);
      backend.writeError = Exception('No active drive');

      await store.editMeal(store.meals.single.subject, calories: 999);

      expect(store.error, 'No active drive');
      expect(store.meals.single.calories, 200);
    });
  });

  test('showDay moves to another day', () async {
    final backend = FakeMealBackend()
      ..seed(mealAt(day, 12, 0, calories: 500, subject: 'today'))
      ..seed(mealAt(day.subtract(const Duration(days: 1)), 12, 0,
          calories: 900, subject: 'yesterday'));
    final store = MealStore(backend: backend, day: day);
    await store.load();

    await store.showDay(day.subtract(const Duration(days: 1)));

    expect(store.meals.map((m) => m.subject), ['yesterday']);
    expect(store.summary.calories, 900);
    expect(store.isToday, isFalse);
  });
}
