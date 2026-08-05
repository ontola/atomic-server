import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/meal.dart';

/// What a meal sheet was closed with. Null means it was dismissed.
sealed class MealEntry {
  const MealEntry();
}

/// Save these values — to a new meal, or over [MealEntrySheet.meal].
class SaveMeal extends MealEntry {
  const SaveMeal({required this.name, required this.calories});

  final String name;
  final int calories;
}

/// Delete the meal being edited.
class DeleteMeal extends MealEntry {
  const DeleteMeal();
}

/// Type a meal, or correct one.
///
/// The plan's TextEntryScreen (§6), at the size Phase 2 needs it: a name and a
/// number, because there is nothing to estimate with yet. Phase 4 adds the
/// other path through this sheet — describe it and let the model do the
/// arithmetic — and the fields here stay what you fall back to when it is
/// wrong.
class MealEntrySheet extends StatefulWidget {
  const MealEntrySheet({super.key, this.meal});

  /// The meal being corrected, or null when logging a new one.
  final Meal? meal;

  /// Show as a modal sheet. Resolves to null if dismissed.
  static Future<MealEntry?> show(BuildContext context, {Meal? meal}) {
    return showModalBottomSheet<MealEntry>(
      context: context,
      isScrollControlled: true,
      builder: (context) => MealEntrySheet(meal: meal),
    );
  }

  @override
  State<MealEntrySheet> createState() => _MealEntrySheetState();
}

class _MealEntrySheetState extends State<MealEntrySheet> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _name =
      TextEditingController(text: widget.meal?.name ?? '');
  late final TextEditingController _calories = TextEditingController(
    text: widget.meal?.calories?.toString() ?? '',
  );

  bool get _isEdit => widget.meal != null;

  @override
  void dispose() {
    _name.dispose();
    _calories.dispose();
    super.dispose();
  }

  void _save() {
    if (!_formKey.currentState!.validate()) return;
    Navigator.pop(
      context,
      SaveMeal(
        name: _name.text.trim(),
        calories: int.parse(_calories.text.trim()),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Padding(
      // The keyboard is up the whole time this sheet is: without this the
      // calorie field is behind it.
      padding: EdgeInsets.only(
        left: 24,
        right: 24,
        top: 20,
        bottom: MediaQuery.of(context).viewInsets.bottom + 24,
      ),
      child: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              _isEdit ? 'Edit meal' : 'What did you eat?',
              style: theme.textTheme.titleLarge,
            ),
            const SizedBox(height: 20),
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
              validator: (value) => (value ?? '').trim().isEmpty
                  ? 'Say what it was'
                  : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _calories,
              keyboardType: const TextInputType.numberWithOptions(),
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              textInputAction: TextInputAction.done,
              onFieldSubmitted: (_) => _save(),
              decoration: const InputDecoration(
                labelText: 'Calories',
                suffixText: 'kcal',
                border: OutlineInputBorder(),
              ),
              validator: (value) {
                final kcal = int.tryParse((value ?? '').trim());
                if (kcal == null) return 'How many calories?';
                // Zero is a real answer (black coffee); negative is not.
                return kcal < 0 ? 'Not a number of calories' : null;
              },
            ),
            const SizedBox(height: 20),
            FilledButton(
              onPressed: _save,
              child: Text(_isEdit ? 'Save' : 'Log it'),
            ),
            if (_isEdit) ...[
              const SizedBox(height: 4),
              TextButton.icon(
                onPressed: () =>
                    Navigator.pop(context, const DeleteMeal()),
                icon: const Icon(Icons.delete_outline, size: 18),
                label: const Text('Delete'),
                style: TextButton.styleFrom(
                  foregroundColor: theme.colorScheme.error,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
