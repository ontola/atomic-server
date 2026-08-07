import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/meal.dart';
import 'image_store.dart';
import 'meal_encoder.dart';
import 'meal_store.dart';

/// Gives every meal that can have an embedding one.
///
/// **Capture and backfill are the same job here, deliberately.** A meal
/// photographed a second ago and a meal photographed last March differ only in
/// how far down the list they are, so there is one drain rather than an
/// on-capture path and a separate migration. That also means the awkward cases
/// — an app killed mid-encode, a model change, a meal that arrived over sync —
/// are all just "not embedded yet" and get picked up by the same loop, instead
/// of each needing somebody to have thought of them.
///
/// It reads the **embedding source** (`ImageStore.loadSource`), never the photo:
/// the source is square, never evicted, and survives "delete all photos now",
/// which is the whole reason Phase 7.1 wrote it. Encoding the photo instead
/// would give a meal a different vector depending on whether its picture had
/// been evicted yet, which is the same class of bug as the crop mismatch and
/// harder to see.
///
/// Nothing here is on the shutter path and nothing shows a spinner. An
/// un-embedded meal is a meal that does not appear as a suggestion, which is
/// invisible rather than broken.
class EmbeddingQueue {
  EmbeddingQueue({
    required MealEncoder encoder,
    required MealStore meals,
    ImageStore? images,
  })  : _encoder = encoder,
        _meals = meals,
        _images = images;

  final MealEncoder _encoder;
  final MealStore _meals;
  ImageStore? _images;

  /// The encoder itself, for the bring-up readout — which needs the reason the
  /// last encode failed, and a way past the "do not try again" latch. Nothing
  /// in the app proper reaches through here.
  MealEncoder get encoder => _encoder;

  /// Called when a drain wrote at least one embedding, so whoever is holding a
  /// decoded copy of the table can go and get the new one. `main.dart` points it
  /// at `MealIndex.refresh` — without it a meal photographed a minute ago is
  /// embedded and still invisible to the matcher until something else happens.
  VoidCallback? onEmbedded;

  /// The documents directory is found in parallel with the store, so a drain
  /// fired at launch can start before there is anywhere to read a source from —
  /// the same race `EstimationQueue` has. `main.dart` sets this and drains
  /// again when the directory lands.
  set images(ImageStore? value) => _images = value;

  bool _draining = false;

  /// How many meals the last drain could not reach, for a caller that wants to
  /// know whether it is worth running again.
  int get skipped => _skipped;
  int _skipped = 0;

  /// What the last drain did, for the device bring-up. "Nothing to do" and
  /// "everything failed" both left the row empty and looked identical.
  int get lastPending => _lastPending;
  int get lastWrote => _lastWrote;
  bool get lastStalled => _lastStalled;
  int _lastPending = 0;
  int _lastWrote = 0;

  /// Whether the last drain gave up because the encoder returned nothing —
  /// which is the difference between "no photos to encode" and "no encoder".
  bool _lastStalled = false;

  /// Encode every meal that has a source and no current embedding.
  ///
  /// Sequential on purpose. This competes with the estimation queue's network
  /// calls and with a live camera for the same phone, and the work is a
  /// background nicety — finishing a minute later costs nobody anything, while
  /// three concurrent inferences on a mid-range phone are felt immediately.
  Future<void> drain() async {
    if (_draining) return;
    final images = _images;
    if (images == null) return;

    _draining = true;
    _skipped = 0;
    _lastWrote = 0;
    _lastStalled = false;
    var wrote = false;
    try {
      final pending = await _unembedded();
      _lastPending = pending.length;
      for (final meal in pending) {
        if (await images.loadSource(meal.imagePath) == null) {
          // A meal whose photo was taken on the other phone (§4: meals sync,
          // photos do not) or one logged before 7.1 wrote sources at all.
          // Neither is recoverable here and neither is an error — if it synced
          // from a paired device it most likely arrives with an embedding of
          // its own.
          _skipped++;
          continue;
        }

        if (await embed(meal) == null) {
          // No model on this device, or a frame the decoder refused. Either
          // way, stopping is right: if it was the model, every remaining meal
          // fails identically, and grinding through the whole history to find
          // that out wastes exactly as much battery as it sounds like.
          _skipped += pending.length - pending.indexOf(meal);
          _lastStalled = true;
          return;
        }
        wrote = true;
        _lastWrote++;
      }
    } catch (e) {
      debugPrint('EmbeddingQueue: $e');
    } finally {
      _draining = false;
      debugPrint('EmbeddingQueue: ${describeLastDrain()}');
      if (wrote) onEmbedded?.call();
    }
  }

  /// One line saying what the last drain came to, for the log and the account
  /// screen. [lastStalled] is the interesting one: it is the encoder failing,
  /// which every other reading of this queue treats as "not yet".
  String describeLastDrain() {
    if (_lastStalled) {
      return 'stopped after $_lastWrote of $_lastPending — the encoder '
          'returned nothing';
    }
    if (_lastPending == 0) return 'nothing to encode';
    return 'encoded $_lastWrote of $_lastPending'
        '${_skipped > 0 ? ', $_skipped without a source here' : ''}';
  }

  /// Encode one meal now and store the result, jumping the queue.
  ///
  /// What Phase 7.4 calls when it is about to estimate a meal that has no
  /// vector yet: the prior it wants is a similarity search, and there is nothing
  /// to search *with* until this has run. Doing it here rather than in
  /// `MealPriors` is what keeps the work from being done twice — the backfill
  /// would have reached this meal eventually and now does not have to.
  ///
  /// Null when there is nothing to encode (no photo, no source on this device,
  /// no directory yet) or when the encoder could not — all of which every caller
  /// treats as "no embedding", never as an error.
  Future<MealEmbedding?> embed(Meal meal) async {
    final images = _images;
    if (images == null || meal.imagePath.isEmpty) return null;

    final source = await images.loadSource(meal.imagePath);
    if (source == null) return null;

    final embedding = await _encoder.encode(await source.readAsBytes());
    if (embedding == null) return null;

    await _meals.saveEmbedding(meal.subject, embedding);
    return embedding;
  }

  /// Meals worth encoding, newest first.
  ///
  /// **Newest first because the newest meal is the one about to be matched
  /// against.** A backfill running oldest-first on a year of history would
  /// leave the meal just photographed until last, which is precisely backwards
  /// — suggestions are about what this person eats *now*.
  ///
  /// A meal counts as needing one when it has no embedding at all, or when it
  /// carries one from a different encoder. That second case is §9's migration
  /// and it needs no separate code path: change [MealEncoder.modelId] and the
  /// history re-encodes itself from the sources, in the background, oldest
  /// suggestions going quiet for a while rather than going wrong.
  Future<List<Meal>> _unembedded() async {
    final all = await _meals.allMeals();
    final current = _encoder.modelId;
    return all
        .where((m) =>
            m.imagePath.isNotEmpty &&
            (m.embedding.isEmpty || m.embeddedByModel != current))
        .toList()
      ..sort((a, b) => b.consumedAt.compareTo(a.consumedAt));
  }
}
