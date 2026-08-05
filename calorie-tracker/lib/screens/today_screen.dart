import 'package:flutter/material.dart';

import '../models/meal.dart';
import '../services/app_session.dart';
import '../services/meal_store.dart';
import 'account_screen.dart';
import 'meal_entry_sheet.dart';

/// The day so far: what it adds up to, and what went into it.
///
/// Home until the camera arrives in Phase 3, which takes the top of the screen
/// and leaves this as what you get to from it. The total is the reason the app
/// exists, so it is the biggest thing on the screen and it is above the list.
class TodayScreen extends StatefulWidget {
  const TodayScreen({super.key, required this.session, this.store});

  final AppSession session;

  /// Injected by tests, which have no Rust library to talk to.
  final MealStore? store;

  @override
  State<TodayScreen> createState() => _TodayScreenState();
}

class _TodayScreenState extends State<TodayScreen> {
  late final MealStore _store = widget.store ?? MealStore();

  @override
  void initState() {
    super.initState();
    _store.load();
  }

  @override
  void dispose() {
    // Only ours to dispose when it was ours to make.
    if (widget.store == null) _store.dispose();
    super.dispose();
  }

  Future<void> _logMeal() async {
    final entry = await MealEntrySheet.show(context);
    if (entry is SaveMeal) {
      await _store.logMeal(name: entry.name, calories: entry.calories);
      _reportFailure();
    }
  }

  Future<void> _editMeal(Meal meal) async {
    final entry = await MealEntrySheet.show(context, meal: meal);
    switch (entry) {
      case SaveMeal(:final name, :final calories):
        await _store.editMeal(meal.subject, name: name, calories: calories);
      case DeleteMeal():
        await _store.deleteMeal(meal.subject);
      case null:
        return;
    }
    _reportFailure();
  }

  /// A write that failed leaves the list as it was, which on its own looks like
  /// nothing happened. Say what did.
  void _reportFailure() {
    final error = _store.error;
    if (error == null || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error)));
  }

  void _openAccount() {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => AccountScreen(session: widget.session),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _store,
      builder: (context, _) {
        final meals = _store.meals;

        return Scaffold(
          appBar: AppBar(
            title: Text(_store.isToday ? 'Today' : formatDay(_store.day)),
            actions: [
              IconButton(
                onPressed: _openAccount,
                icon: const Icon(Icons.person_outline),
                tooltip: 'Account',
              ),
            ],
          ),
          floatingActionButton: FloatingActionButton.extended(
            onPressed: _logMeal,
            icon: const Icon(Icons.add),
            label: const Text('Log a meal'),
          ),
          body: RefreshIndicator(
            onRefresh: _store.load,
            child: ListView(
              // Always scrollable, so pull-to-refresh works on an empty day too.
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
              children: [
                _Total(summary: _store.summary),
                const SizedBox(height: 20),
                if (_store.loading && meals.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 40),
                    child: Center(child: CircularProgressIndicator()),
                  )
                else if (meals.isEmpty)
                  const _EmptyDay()
                else
                  for (final meal in meals)
                    _MealRow(meal: meal, onTap: () => _editMeal(meal)),
              ],
            ),
          ),
        );
      },
    );
  }
}

/// The number the app is for.
class _Total extends StatelessWidget {
  const _Total({required this.summary});

  final DaySummary summary;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Column(
      children: [
        const SizedBox(height: 16),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Text(
              '${summary.calories}',
              style: theme.textTheme.displayMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(width: 6),
            Text('kcal', style: theme.textTheme.titleMedium),
          ],
        ),
        if (summary.hasRange)
          Text(
            '${summary.lowerBound} – ${summary.upperBound}',
            style: theme.textTheme.bodyMedium
                ?.copyWith(color: theme.colorScheme.outline),
          ),
        if (summary.unestimatedCount > 0) ...[
          const SizedBox(height: 8),
          // The total above is a lie by omission while these are outstanding,
          // so say how much of the day it is missing.
          Text(
            '${summary.unestimatedCount} '
            '${summary.unestimatedCount == 1 ? 'meal' : 'meals'} not counted yet',
            style: theme.textTheme.bodySmall
                ?.copyWith(color: theme.colorScheme.tertiary),
          ),
        ],
      ],
    );
  }
}

class _MealRow extends StatelessWidget {
  const _MealRow({required this.meal, required this.onTap});

  final Meal meal;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final kcal = meal.calories;

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        onTap: onTap,
        title: Text(meal.displayName, maxLines: 2, overflow: TextOverflow.ellipsis),
        subtitle: Row(
          children: [
            Text(formatTime(meal.consumedAt),
                style: theme.textTheme.bodySmall),
            if (!meal.status.isSettled) ...[
              const SizedBox(width: 8),
              _StatusChip(status: meal.status),
            ],
          ],
        ),
        trailing: Text(
          kcal == null ? '—' : '$kcal',
          style: theme.textTheme.titleMedium?.copyWith(
            color: kcal == null ? theme.colorScheme.outline : null,
          ),
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});

  final MealStatus status;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (label, color) = switch (status) {
      MealStatus.pending => ('waiting', theme.colorScheme.tertiary),
      MealStatus.estimating => ('estimating', theme.colorScheme.tertiary),
      MealStatus.needsInfo => ('needs an answer', theme.colorScheme.primary),
      MealStatus.failed => ('failed', theme.colorScheme.error),
      MealStatus.estimated || MealStatus.confirmed => ('', null),
    };
    if (label.isEmpty) return const SizedBox.shrink();

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color?.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        label,
        style: theme.textTheme.labelSmall?.copyWith(color: color),
      ),
    );
  }
}

class _EmptyDay extends StatelessWidget {
  const _EmptyDay();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 48),
      child: Column(
        children: [
          Icon(Icons.restaurant_outlined,
              size: 40, color: theme.colorScheme.outline),
          const SizedBox(height: 12),
          Text(
            'Nothing logged yet',
            style: theme.textTheme.bodyMedium
                ?.copyWith(color: theme.colorScheme.outline),
          ),
        ],
      ),
    );
  }
}

const _weekdays = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

const _months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/// `Wednesday 5 August`. Hand-rolled because the app has no `intl` dependency
/// and this is the only date it formats; the day it needs a second locale is
/// the day to add one.
String formatDay(DateTime day) =>
    '${_weekdays[day.weekday - 1]} ${day.day} ${_months[day.month - 1]}';

/// 24-hour `13:45`.
String formatTime(DateTime at) =>
    '${at.hour.toString().padLeft(2, '0')}:${at.minute.toString().padLeft(2, '0')}';
