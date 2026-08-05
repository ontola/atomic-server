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

  /// Whether the estimator will pick this meal up on its own. Mirrors
  /// `list_pending_meals` in `rust/src/api/meals.rs` — `estimating` is in it
  /// because the only thing that sets it is a call in this process, so one
  /// found at launch is one an app that was killed left behind.
  bool get isQueued => this == pending || this == estimating;
}

/// How sure an estimator was. The tags of `estimate-confidence` in the
/// ontology; null on a meal nothing has estimated.
enum MealConfidence {
  high('high'),
  medium('medium'),
  low('low');

  const MealConfidence(this.wire);

  final String wire;

  /// Total, and pessimistic: a value this build has never heard of is not a
  /// reason to drop an estimate, but it is no reason to trust it either.
  static MealConfidence fromWire(String wire) => values.firstWhere(
        (c) => c.wire == wire,
        orElse: () => MealConfidence.low,
      );

  /// Null for the empty string, which is what an unestimated meal stores.
  static MealConfidence? maybeFromWire(String wire) =>
      wire.isEmpty ? null : fromWire(wire);
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
    this.confidence,
    this.estimatedByModel = '',
    this.clarifyingQuestion = '',
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

  /// How sure the estimator was, or null when nothing has estimated this.
  final MealConfidence? confidence;
  final String estimatedByModel;

  /// The one thing the estimator could not tell — "was that milk or oat milk?".
  /// Set with [MealStatus.needsInfo] and empty otherwise, so a meal waiting on
  /// an answer carries the question to ask.
  final String clarifyingQuestion;
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
        confidence: MealConfidence.maybeFromWire(item.confidence),
        estimatedByModel: item.estimatedByModel,
        clarifyingQuestion: item.clarifyingQuestion,
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

/// What an estimator worked out about a meal, on its way to being written.
///
/// Distinct from the generated [ffi.MealEstimate] for the same reason [Meal] is
/// distinct from [ffi.MealItem]: the queue, its tests and the OpenRouter client
/// all handle these, and none of them should need the Rust library loaded to do
/// it. [toItem] is the one place the two meet.
class MealEstimate {
  const MealEstimate({
    required this.name,
    required this.description,
    required this.calories,
    required this.confidence,
    required this.model,
    this.caloriesMin,
    this.caloriesMax,
    this.clarifyingQuestion = '',
    this.proteinGrams,
    this.carbsGrams,
    this.fatGrams,
  });

  final String name;

  /// How the estimator got there. Replaces whatever the meal had, so anything
  /// worth keeping — the words the user typed — has to be folded in first; see
  /// [keeping].
  final String description;
  final int calories;
  final int? caloriesMin;
  final int? caloriesMax;
  final MealConfidence confidence;

  /// The OpenRouter model id, so a number can be traced to what made it.
  final String model;

  /// Ask this and the meal becomes [MealStatus.needsInfo]; leave it empty and
  /// the meal is [MealStatus.estimated]. Low confidence on its own does not
  /// make a meal answerable — a question does.
  final String clarifyingQuestion;
  final double? proteinGrams;
  final double? carbsGrams;
  final double? fatGrams;

  /// The same estimate with [words] kept in front of its reasoning.
  ///
  /// A typed meal is the user telling us what they ate, and the estimate
  /// overwrites every field it touches. Their words are the more reliable half
  /// of the record and the only part nobody can reconstruct, so they go first.
  MealEstimate keeping(String words) {
    final trimmed = words.trim();
    if (trimmed.isEmpty || description.contains(trimmed)) return this;
    return MealEstimate(
      name: name,
      description: '$trimmed\n\n$description',
      calories: calories,
      confidence: confidence,
      model: model,
      caloriesMin: caloriesMin,
      caloriesMax: caloriesMax,
      clarifyingQuestion: clarifyingQuestion,
      proteinGrams: proteinGrams,
      carbsGrams: carbsGrams,
      fatGrams: fatGrams,
    );
  }

  ffi.MealEstimate toItem() => ffi.MealEstimate(
        name: name,
        description: description,
        calories: calories,
        caloriesMin: caloriesMin,
        caloriesMax: caloriesMax,
        confidence: confidence.wire,
        model: model,
        clarifyingQuestion: clarifyingQuestion,
        proteinGrams: proteinGrams,
        carbsGrams: carbsGrams,
        fatGrams: fatGrams,
      );
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
