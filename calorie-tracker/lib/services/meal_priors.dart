import 'package:flutter/foundation.dart';

import '../models/meal.dart';
import 'embedding_queue.dart';
import 'meal_encoder.dart';
import 'meal_index.dart';

/// What this app already knows about a meal like this one.
///
/// The **medium band** of `calorie-tracker-embeddings.md` §3. Above
/// [LiveSuggestions.suggestThreshold] a past meal is offered as a chip and the
/// estimator never runs. Below that but above [contextThreshold] nothing is
/// shown — instead the matched meal's `meal-notes` is handed to the estimator as
/// prior context, so the model is given the answer to the question it was about
/// to ask.
///
/// This is where most of the value of the whole feature is. Someone who eats a
/// cheese sandwich most weeks gets asked "is there anything on it besides the
/// cheese?" every single time, because each meal is estimated from nothing. They
/// answered that weeks ago. The clarify loop terminates (Phase 5), but a loop
/// that terminates is still a loop the user has to walk around.
///
/// **Only `meal-notes`. Never `description`, never `name`.** Phase 5 made
/// `meal-notes` the eater's words and nothing else, to stop the clarify loop
/// feeding the model its own last answer; that invariant is load-bearing again
/// here and more so. If text a model wrote were eligible for retrieval, the
/// fifth cheese sandwich would be estimated from a chain of four of the model's
/// own guesses, each labelled as something a human said. [MealIndex] carries
/// exactly one string per meal for that reason ([ScoredSuggestion.notes]), so
/// there is nothing else here to reach for by mistake.
class MealPriors {
  MealPriors({
    required MealIndex index,
    required EmbeddingQueue embeddings,
    required String modelId,
  })  : _index = index,
        _embeddings = embeddings,
        _modelId = modelId;

  final MealIndex _index;
  final EmbeddingQueue _embeddings;
  final String _modelId;

  /// Below this a match says nothing worth passing on. Well under
  /// [LiveSuggestions.suggestThreshold], because the two bands are answering
  /// different questions: one is "log this meal as that one", which has to be
  /// right, and this is "here is roughly what this person eats", which degrades
  /// harmlessly — a mediocre hint about a different meal is a sentence the model
  /// can ignore, and it cannot make the estimate worse than having no prior at
  /// all in any way that matters.
  ///
  /// Provisional, like every other number in this feature: `tool/encoder-bench/`
  /// puts inter-dish similarity around 0.08, and §11 says the real value comes
  /// off a phone over a week.
  static const contextThreshold = 0.35;

  /// The eater's own words about the nearest thing they have logged before, or
  /// empty when nothing is close enough.
  ///
  /// Never throws. A prior is a nicety on top of an estimate that works without
  /// one, and an estimate that failed because the *hint* could not be worked out
  /// would be an absurd way to lose a meal.
  Future<String> notesFor(Meal meal) async {
    try {
      final query = await _vectorFor(meal);
      if (query == null) return '';

      await _index.refresh();
      // Excluded by lineage rather than by subject: a re-estimate of a settled
      // meal would otherwise retrieve itself, and a meal that has been copied a
      // dozen times would retrieve those copies, which carry its own words back
      // to it. Neither is prior knowledge; both are the meal talking to itself.
      final near = _index.nearest(query, limit: 1, without: meal.lineage);
      if (near.isEmpty) return '';

      final best = near.first;
      if (best.score < contextThreshold) return '';
      return best.notes;
    } catch (e) {
      debugPrint('No prior for ${meal.subject}: $e');
      return '';
    }
  }

  /// This meal's own vector, encoding it now if nobody has yet.
  ///
  /// The embedding queue is asked rather than the encoder directly, so the work
  /// is stored rather than repeated: the backfill would have got to this meal
  /// eventually and now does not have to. It is one local inference — tens of
  /// milliseconds — in front of a network call that takes seconds.
  Future<Float32List?> _vectorFor(Meal meal) async {
    if (meal.embeddedByModel == _modelId && meal.embedding.isNotEmpty) {
      return DinoV2Encoder.decodeVector(meal.embedding);
    }
    // A typed meal has no photograph and so no vector. It is the case this
    // feature would help most and cannot: there is nothing to match on but the
    // words, and the text tower is out of scope (§12).
    final embedding = await _embeddings.embed(meal);
    return embedding == null ? null : DinoV2Encoder.decodeVector(embedding.base64);
  }
}
