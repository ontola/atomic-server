import 'package:flutter/foundation.dart';

import '../models/meal.dart';
import 'meal_encoder.dart';
import 'meal_store.dart';
import 'meal_suggestions.dart';

/// One past meal, and how much the thing in front of the camera looks like it.
@immutable
class ScoredSuggestion {
  const ScoredSuggestion({
    required this.suggestion,
    required this.score,
    required this.notes,
  });

  final MealSuggestion suggestion;

  /// Cosine, in `[-1, 1]`. Meaningless on its own — cosine has no units, which
  /// is why the thresholds that read it are calibrated on a device over real
  /// days (`calorie-tracker-embeddings.md` §11) rather than reasoned about.
  final double score;

  /// The eater's own words about this meal, or empty. Never the model's — see
  /// [MealGroup.notes]. Phase 7.4's prior context is this string and nothing
  /// else.
  final String notes;
}

/// Every meal that can be recognised, decoded once and scanned by brute force.
///
/// **There is no vector database, and there should not be one** (§7). Four meals
/// a day for a year is ~1,500 vectors; 1,500 dot products over 384 floats is
/// well under a millisecond and stays comfortable past 50k, which is an order of
/// magnitude beyond anything this app will hold. A flat list scanned linearly is
/// the whole implementation — no index to corrupt, rebuild or migrate.
///
/// What *would* make it slow is re-reading and re-decoding every meal per frame,
/// which is why this is a thing that is [refresh]ed rather than a query. A table
/// scan per capture is fine; per frame is not.
class MealIndex {
  MealIndex({required MealStore meals, required String modelId})
      : _meals = meals,
        _modelId = modelId;

  final MealStore _meals;

  /// Only vectors from this encoder are comparable to each other, so only these
  /// are loaded. A model change therefore empties the index and suggestions go
  /// quiet until the backfill catches up — which is §9's whole design, and is
  /// what "detectable rather than wrong" buys.
  final String _modelId;

  List<_Entry> _entries = const [];
  Future<void>? _loading;

  /// Whether there is anything to match against. False on a fresh install, on a
  /// phone whose encoder has not run yet, and after a model change.
  bool get isEmpty => _entries.isEmpty;

  /// How many distinct meals are in it. Not how many meals were read — the
  /// forty logs of one breakfast are one entry.
  int get size => _entries.length;

  /// Read the meals again and decode their vectors.
  ///
  /// Called at the moments §7 names — meal write, delete, sync import — which in
  /// this app are: the capture screen appearing, after a capture, after a
  /// one-tap log, on resume, after a sync, and when the embedding queue has
  /// written something. Never per frame.
  ///
  /// Concurrent calls join the one in flight rather than scanning twice.
  Future<void> refresh() => _loading ??= _load().whenComplete(() {
        _loading = null;
      });

  /// What the last [refresh] found, for the device bring-up. Every one of these
  /// is a different reason for an empty row, and from the outside they all look
  /// the same — see [describeLastLoad].
  int get lastMealCount => _lastMeals;
  int get lastCopyableCount => _lastCopyable;
  int get lastEmbeddedCount => _lastEmbedded;
  int get lastOtherModelCount => _lastOtherModel;
  int _lastMeals = 0;
  int _lastCopyable = 0;
  int _lastEmbedded = 0;
  int _lastOtherModel = 0;

  /// One line naming which link is missing, rather than four numbers to hold in
  /// your head. Read by the AI settings screen and by the log below.
  String describeLastLoad() {
    if (_lastMeals == 0) return 'no meals yet';
    if (_lastCopyable == 0) {
      return '$_lastMeals meals, none estimated yet';
    }
    if (_lastEmbedded == 0) {
      return _lastOtherModel > 0
          ? '$_lastCopyable ready, all $_lastOtherModel from another encoder'
          : '$_lastCopyable ready, none encoded — the encoder is not running';
    }
    return '$size recognisable ($_lastEmbedded of $_lastCopyable encoded)';
  }

  Future<void> _load() async {
    try {
      final all = await _meals.allMeals();
      final entries = <_Entry>[];
      var copyable = 0;
      var embedded = 0;
      var otherModel = 0;

      for (final group in MealSuggestions.groupsOf(
          all.where(MealSuggestions.isCopyable))) {
        copyable += group.meals.length;
        final vectors = <Float32List>[];
        for (final meal in group.meals) {
          if (meal.embedding.isEmpty) continue;
          if (meal.embeddedByModel != _modelId) {
            otherModel++;
            continue;
          }
          // Unit already — [DinoV2Encoder.decodeVector] normalizes, which is
          // where that has to happen so the live query and the priors get it
          // too. Scoring is a plain dot product on the strength of it.
          final vector = DinoV2Encoder.decodeVector(meal.embedding);
          if (vector == null || vector.isEmpty) continue;
          embedded++;
          vectors.add(vector);
        }
        // A meal nobody has encoded is not in the index. That is invisible
        // rather than broken: it does not turn up as a match, and the frequency
        // row still offers it.
        if (vectors.isEmpty) continue;

        entries.add(_Entry(
          suggestion: group.suggestion,
          notes: group.notes,
          lineage: group.newest.lineage,
          vectors: vectors,
        ));
      }

      _entries = entries;
      _lastMeals = all.length;
      _lastCopyable = copyable;
      _lastEmbedded = embedded;
      _lastOtherModel = otherModel;
      debugPrint('MealIndex: ${describeLastLoad()}');
    } catch (e) {
      // The viewfinder works without this. Keeping the last good table is
      // better than emptying it over one failed read.
      debugPrint('MealIndex: could not read the history: $e');
    }
  }

  /// The best-matching distinct meals, highest first.
  ///
  /// Synchronous and allocation-light, because this runs a few times a second
  /// while a camera is up. [query] must be L2-normalized — [DinoV2Encoder]
  /// stores them that way and [LiveSuggestions] re-normalizes after smoothing —
  /// so the score is a plain dot product.
  ///
  /// A group scores as its **best** member (§7: "take the best-scoring
  /// representative of each"), and the *suggestion* is still the newest member,
  /// because that is whose numbers a tap takes.
  ///
  /// [without] drops entries by [Meal.lineage] — what a re-estimate passes so a
  /// meal cannot retrieve itself, or the copies that took their words from it,
  /// as prior context about itself.
  List<ScoredSuggestion> nearest(
    Float32List query, {
    int limit = MealSuggestions.limit,
    String without = '',
  }) {
    final scored = <ScoredSuggestion>[];
    for (final entry in _entries) {
      if (without.isNotEmpty && entry.lineage == without) continue;
      final score = entry.bestAgainst(query);
      if (score == null) continue;
      scored.add(ScoredSuggestion(
        suggestion: entry.suggestion,
        score: score,
        notes: entry.notes,
      ));
    }

    scored.sort((a, b) {
      final byScore = b.score.compareTo(a.score);
      if (byScore != 0) return byScore;
      // §7's recency preference, which only ever decides a tie: if a sandwich
      // was 380 kcal last month and 420 last week, last week is the better
      // prior.
      return b.suggestion.lastEatenAt.compareTo(a.suggestion.lastEatenAt);
    });
    return scored.length <= limit ? scored : scored.sublist(0, limit);
  }

}

/// One distinct meal: what a chip would say, and every vector that is it.
class _Entry {
  _Entry({
    required this.suggestion,
    required this.notes,
    required this.lineage,
    required this.vectors,
  });

  final MealSuggestion suggestion;
  final String notes;
  final String lineage;
  final List<Float32List> vectors;

  /// The best of this meal's photographs against [query], or null when none of
  /// them is the right length — a vector from a different encoder that somehow
  /// kept this one's model id, which is a corrupt store rather than a state to
  /// design around.
  double? bestAgainst(Float32List query) {
    double? best;
    for (final vector in vectors) {
      if (vector.length != query.length) continue;
      var dot = 0.0;
      for (var i = 0; i < vector.length; i++) {
        dot += vector[i] * query[i];
      }
      if (best == null || dot > best) best = dot;
    }
    return best;
  }
}
