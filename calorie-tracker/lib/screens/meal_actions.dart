import 'dart:async';

import 'package:flutter/material.dart';

import '../models/meal.dart';
import '../services/estimation_queue.dart';
import '../services/image_store.dart';
import '../services/meal_store.dart';
import 'meal_entry_sheet.dart';

/// Opening the meal sheet and doing what it comes back with.
///
/// Here rather than on a screen because four places open it — the viewfinder,
/// the day's list, the history's day view, and a notification tap that arrives
/// with no screen at all — and the rules about what a saved sheet *means* are
/// the same every time: a typed number ends the estimator's interest in the
/// meal, an answer goes back to the model, and a deleted meal takes its
/// question with it.

/// Log a new meal from the keyboard.
///
/// A number in the sheet is the user telling us and the meal is `confirmed`; a
/// blank is them asking, and the drain below is what asks.
Future<void> logMealByHand(
  BuildContext context, {
  required MealStore store,
  EstimationQueue? queue,
}) async {
  final entry = await MealEntrySheet.show(context);
  if (entry is! SaveMeal) return;

  await store.logMeal(
    name: entry.name,
    notes: entry.notes,
    calories: entry.calories,
  );
  if (!context.mounted) return;
  if (_reportFailure(context, store)) return;

  if (entry.calories == null) unawaited(queue?.drain());
}

/// Open [meal] for editing, answering or deleting.
Future<void> openMeal(
  BuildContext context,
  Meal meal, {
  required MealStore store,
  ImageStore? images,
  EstimationQueue? queue,
}) async {
  // Asked before the sheet is built, because whether the photo is still on disk
  // is a question for the filesystem and the sheet is not going to wait on one.
  final canReEstimate = await _canReEstimate(meal, images: images, queue: queue);
  if (!context.mounted) return;

  final entry = await MealEntrySheet.show(
    context,
    meal: meal,
    images: images,
    canReEstimate: canReEstimate,
  );
  if (!context.mounted) return;

  switch (entry) {
    case SaveMeal(:final name, :final notes, :final calories, :final reEstimate):
      await store.editMeal(
        meal.subject,
        name: name,
        notes: notes,
        calories: calories,
      );
      if (!context.mounted) return;
      if (_reportFailure(context, store)) return;

      // A number somebody typed is the answer the question was asking for.
      // Leaving the notification up would be asking again.
      if (calories != null) unawaited(queue?.forget(meal.subject));

      if (reEstimate && queue != null) {
        // Re-read rather than re-using the meal this sheet was opened with: the
        // answer that was just written is the entire input to the estimate, and
        // the copy in hand predates it.
        final fresh = await store.mealAt(meal.subject);
        if (fresh != null) unawaited(queue.retry(fresh));
      }

    case DeleteMeal():
      await store.deleteMeal(meal.subject);
      unawaited(queue?.forget(meal.subject));
      if (context.mounted) _reportFailure(context, store);

    case null:
      return;
  }
}

/// Ask the model about [meal] again, with nothing changed. The tap on a
/// `failed` row.
void retryMeal(Meal meal, EstimationQueue queue) => unawaited(queue.retry(meal));

/// Whether there is anything left to ask a model with.
///
/// A photographed meal whose picture the sweep evicted has nothing to send —
/// the 256px thumbnail is not a substitute — so re-estimating it is not offered
/// rather than offered and failed.
Future<bool> _canReEstimate(
  Meal meal, {
  required ImageStore? images,
  required EstimationQueue? queue,
}) async {
  if (queue == null) return false;
  if (meal.imagePath.isEmpty) {
    return meal.name.isNotEmpty || meal.notes.isNotEmpty;
  }
  return await images?.stateOf(meal.imagePath) == PhotoState.stored;
}

/// A write that failed leaves the list as it was, which on its own looks like
/// nothing happened. Say what did, and report whether it did.
bool _reportFailure(BuildContext context, MealStore store) {
  final error = store.error;
  if (error == null) return false;
  ScaffoldMessenger.of(context)
    ..clearSnackBars()
    ..showSnackBar(SnackBar(content: Text(error)));
  return true;
}
