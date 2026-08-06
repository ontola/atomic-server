import 'package:flutter/material.dart';

import '../models/meal.dart';
import '../services/app_session.dart';
import '../services/estimation_queue.dart';
import '../services/image_store.dart';
import '../services/meal_store.dart';
import '../services/openrouter.dart';
import '../services/sync_service.dart';
import '../widgets/meal_photo.dart';
import 'account_screen.dart';
import 'history_screen.dart';
import 'meal_actions.dart';
import 'openrouter_screen.dart';

/// The day so far: what it adds up to, and what went into it.
///
/// Reached from the capture screen, which is home. The total is the reason the
/// app exists, so it is the biggest thing here and it is above the list.
class TodayScreen extends StatefulWidget {
  const TodayScreen({
    super.key,
    required this.session,
    this.store,
    this.images,
    this.account,
    this.queue,
    this.sync,
  });

  final AppSession session;

  /// Injected by tests, which have no Rust library to talk to. Usually the
  /// capture screen's, so the total behind the viewfinder and the list here are
  /// never two different answers.
  final MealStore? store;

  /// Where the photos are, or null when they are not to be shown.
  final ImageStore? images;

  /// Who pays for the estimates. Null in tests that are not about them.
  final OpenRouterAccount? account;

  /// What fills the numbers in. Null in tests that are not about estimation.
  final EstimationQueue? queue;

  /// The account's other devices. Null in tests that are not about them.
  final SyncService? sync;

  @override
  State<TodayScreen> createState() => _TodayScreenState();
}

class _TodayScreenState extends State<TodayScreen> {
  late final MealStore _store = widget.store ?? MealStore();

  @override
  void initState() {
    super.initState();
    // After the frame, not during it. This screen usually shares the capture
    // screen's store, and `load` notifies as it starts — which, called from
    // here, marks a widget that is already building as needing to build.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _store.load();
    });
  }

  @override
  void dispose() {
    // Only ours to dispose when it was ours to make.
    if (widget.store == null) _store.dispose();
    super.dispose();
  }

  Future<void> _logMeal() =>
      logMealByHand(context, store: _store, queue: widget.queue);

  Future<void> _editMeal(Meal meal) => openMeal(
        context,
        meal,
        store: _store,
        images: widget.images,
        queue: widget.queue,
      );

  void _openHistory() {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => HistoryScreen(
        session: widget.session,
        store: _store,
        images: widget.images,
        account: widget.account,
        queue: widget.queue,
        sync: widget.sync,
      ),
    ));
  }

  void _openAccount() {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => AccountScreen(
        session: widget.session,
        images: widget.images,
        account: widget.account,
        sync: widget.sync,
      ),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      // The estimator changes this day underneath the list, and the banner is
      // about its state rather than the store's.
      animation: Listenable.merge([_store, widget.queue]),
      builder: (context, _) {
        final meals = _store.meals;
        final account = widget.account;

        return Scaffold(
          appBar: AppBar(
            title: Text(_store.isToday ? 'Today' : formatDay(_store.day)),
            actions: [
              // Only from today: a day view reached *from* the history is
              // already inside it, and a second way back in from there is a
              // loop rather than a route.
              if (_store.isToday)
                IconButton(
                  onPressed: _openHistory,
                  icon: const Icon(Icons.calendar_month_outlined),
                  tooltip: 'History',
                ),
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
                if (account != null && widget.queue?.needsKey == true) ...[
                  const SizedBox(height: 16),
                  _ConnectBanner(
                    waiting: widget.queue!.waiting,
                    onConnect: () =>
                        OpenRouterScreen.open(context, account: account),
                  ),
                ],
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
                    _MealRow(
                      meal: meal,
                      images: widget.images,
                      onTap: () => _editMeal(meal),
                      onRetry: meal.status == MealStatus.failed &&
                              widget.queue != null
                          ? () => retryMeal(meal, widget.queue!)
                          : null,
                    ),
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

/// Meals waiting on a key they do not have.
///
/// Only shown when there are some: connecting a payment account is a thing to
/// ask for when it has become worth something, not on an empty day.
class _ConnectBanner extends StatelessWidget {
  const _ConnectBanner({required this.waiting, required this.onConnect});

  final int waiting;
  final VoidCallback onConnect;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Card(
      color: theme.colorScheme.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 12, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              waiting == 1
                  ? 'One meal is waiting to be estimated'
                  : '$waiting meals are waiting to be estimated',
              style: theme.textTheme.titleSmall,
            ),
            const SizedBox(height: 4),
            Text(
              'Connect an OpenRouter account and they get their calories. '
              'They are logged and kept either way.',
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: theme.colorScheme.outline),
            ),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: onConnect,
                child: const Text('Connect OpenRouter'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MealRow extends StatelessWidget {
  const _MealRow({
    required this.meal,
    required this.images,
    required this.onTap,
    this.onRetry,
  });

  final Meal meal;
  final ImageStore? images;
  final VoidCallback onTap;

  /// Offered on a meal that gave up. Three tries in a row is where the queue
  /// stops on its own; a fourth is the user's call, and usually made because
  /// something has changed — the network, the model, the key.
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final kcal = meal.calories;

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        onTap: onTap,
        leading: MealThumbnail(images: images, imagePath: meal.imagePath),
        title: Text(meal.displayName, maxLines: 2, overflow: TextOverflow.ellipsis),
        subtitle: Row(
          children: [
            Text(formatTime(meal.consumedAt),
                style: theme.textTheme.bodySmall),
            if (!meal.status.isSettled) ...[
              const SizedBox(width: 8),
              _StatusChip(status: meal.status),
            ],
            if (onRetry != null) ...[
              const SizedBox(width: 4),
              TextButton(
                onPressed: onRetry,
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  minimumSize: Size.zero,
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  visualDensity: VisualDensity.compact,
                ),
                child: const Text('Try again'),
              ),
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
