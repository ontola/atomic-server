import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/meal.dart';
import '../services/image_store.dart';
import '../widgets/meal_photo.dart';
import 'today_screen.dart' show formatTime;

/// What a meal sheet was closed with. Null means it was dismissed.
sealed class MealEntry {
  const MealEntry();
}

/// Save these values — to a new meal, or over [MealEntrySheet.meal].
class SaveMeal extends MealEntry {
  const SaveMeal({
    required this.name,
    required this.calories,
    this.notes = '',
    this.reEstimate = false,
  });

  final String name;

  /// Null when the field was left blank, which is the user asking for an
  /// estimate rather than giving one: the meal is written `pending` and the
  /// queue picks it up. A number is a confirmation, and no estimator overwrites
  /// it.
  final int? calories;

  /// What the eater wrote about this meal — on a new one, the words they typed;
  /// on an edit, the answer to whatever the estimator asked. Written to
  /// `meal-notes`, which no estimate overwrites.
  final String notes;

  /// Ask the model again once this is saved.
  ///
  /// The two are one action rather than two, which is the whole clarify loop:
  /// an answer that is saved but not sent leaves the meal exactly as stuck as
  /// it was, and a re-estimate that discards the answer first is worse.
  final bool reEstimate;
}

/// Delete the meal being edited.
class DeleteMeal extends MealEntry {
  const DeleteMeal();
}

/// Type a meal, correct one, or answer the question the estimator asked about
/// one.
///
/// The plan's TextEntryScreen (§7) plus its uncertainty loop (§5). Three shapes,
/// all the same sheet:
///
/// - **A new meal.** A name and an optional number: a number is the user
///   telling us, a blank is them asking.
/// - **A meal to correct.** The same two fields over what is there, plus what
///   the estimate was and what it was made of.
/// - **A meal waiting on an answer.** The estimator's question, and a field
///   under it. Answering re-estimates.
class MealEntrySheet extends StatefulWidget {
  const MealEntrySheet({
    super.key,
    this.meal,
    this.images,
    this.canReEstimate = false,
  });

  /// The meal being corrected, or null when logging a new one.
  final Meal? meal;

  /// Where the photo is, when the meal has one and it is still on disk.
  final ImageStore? images;

  /// Whether there is anything left to ask a model with. The caller decides,
  /// because whether the photo survived the sweep is its question, not this
  /// sheet's — and a sheet that offered a re-estimate with nothing to send
  /// would be offering a failure.
  final bool canReEstimate;

  /// Show as a modal sheet. Resolves to null if dismissed.
  static Future<MealEntry?> show(
    BuildContext context, {
    Meal? meal,
    ImageStore? images,
    bool canReEstimate = false,
  }) {
    return showModalBottomSheet<MealEntry>(
      context: context,
      isScrollControlled: true,
      // Full-height sheets otherwise run their title up under the clock and the
      // notch.
      useSafeArea: true,
      // The handle is both the affordance and the drag target: the fields below
      // are in a scroll view, which wins any vertical drag that starts on it, so
      // the top of the sheet is where a swipe-down can close it.
      showDragHandle: true,
      builder: (context) => MealEntrySheet(
        meal: meal,
        images: images,
        canReEstimate: canReEstimate,
      ),
    );
  }

  @override
  State<MealEntrySheet> createState() => _MealEntrySheetState();
}

class _MealEntrySheetState extends State<MealEntrySheet> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _name =
      TextEditingController(text: widget.meal?.name ?? '');
  late final TextEditingController _notes =
      TextEditingController(text: widget.meal?.notes ?? '');
  late final TextEditingController _calories = TextEditingController(
    text: widget.meal?.calories?.toString() ?? '',
  );

  Meal? get _meal => widget.meal;

  bool get _isEdit => _meal != null;

  /// Whether this sheet is here to answer a question. Decides which button is
  /// the filled one and where the keyboard opens.
  bool get _isAnswering => _meal?.needsAnswer ?? false;

  bool get _canReEstimate => _isEdit && widget.canReEstimate;

  @override
  void dispose() {
    _name.dispose();
    _notes.dispose();
    _calories.dispose();
    super.dispose();
  }

  void _save({bool reEstimate = false}) {
    if (!_formKey.currentState!.validate()) return;

    final name = _name.text.trim();
    Navigator.pop(
      context,
      SaveMeal(
        name: name,
        // A new meal's name *is* what the eater wrote, so it is also their
        // notes — that is the text the estimator is given, and the estimate
        // will replace the name with its own.
        notes: _isEdit ? _notes.text.trim() : name,
        calories: int.tryParse(_calories.text.trim()),
        reEstimate: reEstimate,
      ),
    );
  }

  /// Agree with the estimate as it stands. Saves the number the model gave as
  /// though it had been typed, which is exactly what confirming means.
  void _confirm() {
    final kcal = _meal?.calories;
    if (kcal == null) return;
    Navigator.pop(
      context,
      SaveMeal(
        name: _name.text.trim(),
        notes: _notes.text.trim(),
        calories: kcal,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final meal = _meal;

    return Padding(
      // The keyboard is up the whole time this sheet is: without this the
      // calorie field is behind it.
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Outside the scroll view, so it stays put while the fields move —
            // and so a swipe that starts here drags the sheet away instead of
            // scrolling it.
            _header(theme, meal),
            // Scrollable because the photo can make this taller than what is
            // left of the screen above the keyboard.
            Flexible(
              child: SingleChildScrollView(
                // `useSafeArea` is `bottom: false`, so the home indicator is
                // this sheet's to clear — and only when the keyboard is not
                // already covering it, which is what makes the inset zero.
                padding: EdgeInsets.fromLTRB(
                  24,
                  4,
                  24,
                  24 + MediaQuery.paddingOf(context).bottom,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // Above the fields: it is what the meal is, and on a
                    // photographed meal it is the only thing there is to go on
                    // when filling them in.
                    MealPhoto(
                      images: widget.images,
                      imagePath: meal?.imagePath ?? '',
                    ),
                    if (_isAnswering) ...[
                      _Question(question: meal!.clarifyingQuestion),
                      const SizedBox(height: 12),
                    ],
                    TextFormField(
                      controller: _name,
                      autofocus: !_isEdit,
                      textCapitalization: TextCapitalization.sentences,
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(
                        labelText: 'Meal',
                        hintText: 'Two slices of margherita',
                        border: OutlineInputBorder(),
                      ),
                      validator: (value) {
                        // Required only on a new meal, where it is the only
                        // thing there is. A photographed one can perfectly well
                        // have no name yet — that is what the queue is for.
                        if (_isEdit) return null;
                        return (value ?? '').trim().isEmpty
                            ? 'Say what it was'
                            : null;
                      },
                    ),
                    if (_isEdit) ...[
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: _notes,
                        autofocus: _isAnswering,
                        textCapitalization: TextCapitalization.sentences,
                        // One line, and return means "done with this" rather
                        // than a newline: an answer to the estimator's question
                        // is a phrase, and a note that needs paragraphs is not
                        // what this field is for.
                        textInputAction: TextInputAction.done,
                        onFieldSubmitted: (_) => _dismissKeyboard(),
                        decoration: InputDecoration(
                          labelText: _isAnswering ? 'Your answer' : 'Notes',
                          hintText: _isAnswering
                              ? 'Oat milk'
                              : 'Anything the estimate should know',
                          helperText: _canReEstimate
                              ? 'The model reads this and never overwrites it'
                              : null,
                          border: const OutlineInputBorder(),
                        ),
                      ),
                    ],
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _calories,
                      keyboardType: const TextInputType.numberWithOptions(),
                      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                      textInputAction: TextInputAction.done,
                      // The last field, so accepting it accepts the sheet —
                      // except on a meal whose buttons are a real choice, where
                      // saving would be picking one for the user.
                      onFieldSubmitted: (_) =>
                          _isAnswering ? _dismissKeyboard() : _save(),
                      decoration: const InputDecoration(
                        labelText: 'Calories',
                        // Leaving it blank is a real answer now, and the more
                        // likely one: the estimator can read "two slices of
                        // margherita" as well as it can read a photograph.
                        hintText: 'Leave blank to have it estimated',
                        suffixText: 'kcal',
                        border: OutlineInputBorder(),
                      ),
                      validator: (value) {
                        final text = (value ?? '').trim();
                        if (text.isEmpty) return null;
                        final kcal = int.tryParse(text);
                        // Zero is a real answer (black coffee); negative is not,
                        // and the formatter above means nothing else can get in
                        // here.
                        if (kcal == null || kcal < 0) {
                          return 'Not a number of calories';
                        }
                        return null;
                      },
                    ),
                    if (meal != null) ...[
                      const SizedBox(height: 16),
                      _Estimate(meal: meal),
                    ],
                    const SizedBox(height: 20),
                    ..._actions(theme),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// The title, what it is about, and the way out.
  ///
  /// The close button is here because the drag handle above it is an affordance
  /// people miss, and because a sheet with the keyboard up over it can look like
  /// a screen with no way back.
  Widget _header(ThemeData theme, Meal? meal) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 0, 8, 8),
      child: Row(
        children: [
          Expanded(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  switch (meal) {
                    null => 'What did you eat?',
                    final m when m.needsAnswer => 'One question',
                    _ => 'Edit meal',
                  },
                  style: theme.textTheme.titleLarge,
                ),
                if (meal != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    formatTime(meal.consumedAt),
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
                ],
              ],
            ),
          ),
          IconButton(
            onPressed: () => Navigator.maybePop(context),
            icon: const Icon(Icons.close),
            tooltip: 'Close',
          ),
        ],
      ),
    );
  }

  /// Put the keyboard away without deciding anything. What return means in a
  /// field that is not the last one worth filling in.
  void _dismissKeyboard() => FocusScope.of(context).unfocus();

  /// The buttons, in the order this particular meal wants them.
  ///
  /// Whatever the meal is most stuck on gets the filled button: a question
  /// wants answering, an unchecked estimate wants agreeing with, and everything
  /// else just wants saving.
  List<Widget> _actions(ThemeData theme) {
    final meal = _meal;

    if (meal == null) {
      return [
        FilledButton(onPressed: _save, child: const Text('Log it')),
      ];
    }

    return [
      if (_isAnswering && _canReEstimate) ...[
        FilledButton.icon(
          onPressed: () => _save(reEstimate: true),
          icon: const Icon(Icons.auto_awesome, size: 18),
          label: const Text('Answer and estimate again'),
        ),
        const SizedBox(height: 4),
        TextButton(
          onPressed: _save,
          child: const Text('Just save it'),
        ),
      ] else ...[
        FilledButton(onPressed: _save, child: const Text('Save')),
        if (meal.status == MealStatus.estimated && meal.calories != null) ...[
          const SizedBox(height: 4),
          // An estimated meal has numbers nobody has checked. Agreeing is the
          // cheapest thing the user can do about that, and it takes the meal
          // off the estimator's reach for good.
          TextButton.icon(
            onPressed: _confirm,
            icon: const Icon(Icons.check, size: 18),
            label: const Text('Looks right'),
          ),
        ],
        if (_canReEstimate) ...[
          const SizedBox(height: 4),
          TextButton.icon(
            onPressed: () => _save(reEstimate: true),
            icon: const Icon(Icons.refresh, size: 18),
            label: const Text('Estimate it again'),
          ),
        ],
      ],
      const SizedBox(height: 4),
      TextButton.icon(
        onPressed: () => Navigator.pop(context, const DeleteMeal()),
        icon: const Icon(Icons.delete_outline, size: 18),
        label: const Text('Delete'),
        style: TextButton.styleFrom(foregroundColor: theme.colorScheme.error),
      ),
    ];
  }
}

/// The one thing the estimator could not tell.
///
/// The field under it is the answer, and answering re-estimates — which is what
/// makes this a question rather than a chip with nothing behind it.
class _Question extends StatelessWidget {
  const _Question({required this.question});

  final String question;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Container(
      margin: const EdgeInsets.only(bottom: 4),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.primary.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.help_outline, size: 18, color: theme.colorScheme.primary),
          const SizedBox(width: 8),
          Expanded(
            child: Text(question, style: theme.textTheme.bodyMedium),
          ),
        ],
      ),
    );
  }
}

/// What the estimate was, and what made it.
///
/// The number in the field above is the answer; this is the working behind it —
/// how wide the range was, what the model thought it was looking at, and which
/// model that was. Hidden entirely on a meal nobody has estimated, where every
/// line of it would be empty.
class _Estimate extends StatelessWidget {
  const _Estimate({required this.meal});

  final Meal meal;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final small = theme.textTheme.bodySmall
        ?.copyWith(color: theme.colorScheme.outline);

    final low = meal.lowerBound;
    final high = meal.upperBound;
    final macros = [
      if (meal.proteinGrams != null) '${_round(meal.proteinGrams!)} g protein',
      if (meal.carbsGrams != null) '${_round(meal.carbsGrams!)} g carbs',
      if (meal.fatGrams != null) '${_round(meal.fatGrams!)} g fat',
    ];

    final lines = <Widget>[
      if (low != null && high != null && low != high)
        Text('Somewhere between $low and $high kcal', style: small),
      if (macros.isNotEmpty) Text(macros.join(' · '), style: small),
      if (meal.description.isNotEmpty)
        Text(meal.description, style: theme.textTheme.bodySmall),
      if (meal.estimatedByModel.isNotEmpty)
        Text(
          'Estimated by ${meal.estimatedByModel}'
          '${meal.confidence == null ? '' : ' · ${meal.confidence!.wire} confidence'}',
          style: small,
        ),
    ];
    if (lines.isEmpty) return const SizedBox.shrink();

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var i = 0; i < lines.length; i++) ...[
            if (i > 0) const SizedBox(height: 6),
            lines[i],
          ],
        ],
      ),
    );
  }

  /// Grams to the nearest whole one. Nobody is weighing the difference.
  static String _round(double grams) => grams.round().toString();
}
