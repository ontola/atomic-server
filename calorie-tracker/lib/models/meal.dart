import '../src/rust/api/meals.dart' as ffi;

/// How far a meal has got through estimation.
///
/// The wire names are the shortnames of the status tags in the ontology
/// (`lib/defaults/calorie-tracker.json`), which is the only place they are
/// defined — [fromWire] is deliberately total so a status this build has never
/// heard of arrives as [MealStatus.pending] rather than crashing a list.
enum MealStatus {
  /// Captured; nothing has looked at it yet. The estimator's queue.
  pending('pending'),

  /// An estimate is in flight.
  estimating('estimating'),

  /// Has numbers, which nobody has checked.
  estimated('estimated'),

  /// Has numbers a human agreed with, or typed.
  confirmed('confirmed'),

  /// Too ambiguous to estimate — waiting on an answer.
  needsInfo('needs-info'),

  /// Estimation was tried and gave up.
  failed('failed');

  const MealStatus(this.wire);

  final String wire;

  static MealStatus fromWire(String wire) => values.firstWhere(
        (s) => s.wire == wire,
        orElse: () => MealStatus.pending,
      );

  /// Whether this meal's numbers are still expected to change.
  bool get isSettled => this == confirmed || this == estimated;
}

/// One meal, as the app thinks about it.
///
/// Distinct from the generated [ffi.MealItem] so screens and their tests never
/// need the Rust library loaded, and so the epoch milliseconds the bridge
/// speaks become a [DateTime] exactly once, here.
class Meal {
  const Meal({
    required this.subject,
    required this.name,
    required this.description,
    required this.consumedAt,
    required this.status,
    this.calories,
    this.caloriesMin,
    this.caloriesMax,
    this.imagePath = '',
    this.confidence = '',
    this.estimatedByModel = '',
    this.proteinGrams,
    this.carbsGrams,
    this.fatGrams,
  });

  final String subject;
  final String name;
  final String description;

  /// Local time — [DateTime.fromMillisecondsSinceEpoch] without `isUtc`, so
  /// "which day was this" is asked in the timezone the phone is in.
  final DateTime consumedAt;
  final MealStatus status;

  /// Null means nobody has worked out what this was yet, which is not zero.
  final int? calories;
  final int? caloriesMin;
  final int? caloriesMax;
  final String imagePath;
  final String confidence;
  final String estimatedByModel;
  final double? proteinGrams;
  final double? carbsGrams;
  final double? fatGrams;

  factory Meal.fromItem(ffi.MealItem item) => Meal(
        subject: item.subject,
        name: item.name,
        description: item.description,
        consumedAt:
            DateTime.fromMillisecondsSinceEpoch(item.consumedAtMs.toInt()),
        status: MealStatus.fromWire(item.status),
        calories: item.calories?.toInt(),
        caloriesMin: item.caloriesMin?.toInt(),
        caloriesMax: item.caloriesMax?.toInt(),
        imagePath: item.imagePath,
        confidence: item.confidence,
        estimatedByModel: item.estimatedByModel,
        proteinGrams: item.proteinGrams,
        carbsGrams: item.carbsGrams,
        fatGrams: item.fatGrams,
      );

  /// What to call this meal in a list. A photo logged and not yet estimated has
  /// no name at all, and a blank row reads as a bug rather than as a queue.
  String get displayName {
    if (name.isNotEmpty) return name;
    if (description.isNotEmpty) return description;
    return status == MealStatus.failed ? 'Could not estimate' : 'Not estimated yet';
  }

  /// The low end of what this might have been: its own lower bound, or the one
  /// number it has.
  int? get lowerBound => caloriesMin ?? calories;

  int? get upperBound => caloriesMax ?? calories;
}

/// The UTC millisecond bounds of the local day [day] falls in, as
/// `list_meals` wants them: `[start, end)`.
///
/// Built from local midnights rather than by adding 24 hours, which is the
/// whole point — a day with a DST change is 23 or 25 hours long, and a meal at
/// 23:59 belongs to the day it was eaten on either way.
({int fromMs, int toMs}) localDayBounds(DateTime day) {
  final start = DateTime(day.year, day.month, day.day);
  // Day + 1 rather than +24h, and DateTime normalises the overflow, so this is
  // also right on the 31st and on the 28th of February.
  final end = DateTime(day.year, day.month, day.day + 1);
  return (
    fromMs: start.millisecondsSinceEpoch,
    toMs: end.millisecondsSinceEpoch,
  );
}

/// A day's meals, added up.
///
/// The uncertain part is kept separate rather than folded in: a total of 1,800
/// that is really "1,800 plus two meals nobody has estimated" is a number the
/// user would act on and shouldn't.
class DaySummary {
  const DaySummary({
    required this.calories,
    required this.lowerBound,
    required this.upperBound,
    required this.mealCount,
    required this.unestimatedCount,
  });

  factory DaySummary.of(Iterable<Meal> meals) {
    var calories = 0;
    var lower = 0;
    var upper = 0;
    var count = 0;
    var unestimated = 0;

    for (final meal in meals) {
      count++;
      final kcal = meal.calories;
      if (kcal == null) {
        unestimated++;
        continue;
      }
      calories += kcal;
      lower += meal.lowerBound ?? kcal;
      upper += meal.upperBound ?? kcal;
    }

    return DaySummary(
      calories: calories,
      lowerBound: lower,
      upperBound: upper,
      mealCount: count,
      unestimatedCount: unestimated,
    );
  }

  /// Best estimate, in kcal, of everything that has a number.
  final int calories;
  final int lowerBound;
  final int upperBound;
  final int mealCount;

  /// Meals in the day with no number at all — not counted in [calories].
  final int unestimatedCount;

  /// Whether the bounds say anything the total does not.
  bool get hasRange => lowerBound != upperBound;
}
