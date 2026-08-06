import 'package:flutter/material.dart';

import '../models/meal.dart';
import '../services/app_session.dart';
import '../services/estimation_queue.dart';
import '../services/image_store.dart';
import '../services/meal_store.dart';
import '../services/openrouter.dart';
import '../services/sync_service.dart';
import 'today_screen.dart';

/// The days behind today, and what each of them came to.
///
/// A list rather than the calendar the plan sketched (§7): a calendar grid of
/// four-digit totals is unreadable at phone width, and what someone looking back
/// wants is the run of days — which ones were high, which ones have holes in
/// them. Days with nothing logged are simply not in it; an unbroken grid of
/// zeroes says the app was used and the food wasn't, which is the wrong story.
class HistoryScreen extends StatefulWidget {
  const HistoryScreen({
    super.key,
    required this.session,
    required this.store,
    this.images,
    this.account,
    this.queue,
    this.sync,
  });

  final AppSession session;

  /// The app's store. Read through for the range query, and the source of the
  /// per-day stores a tap opens.
  final MealStore store;

  final ImageStore? images;
  final OpenRouterAccount? account;
  final EstimationQueue? queue;
  final SyncService? sync;

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  /// How far back the first read goes. Enough to cover any use of the app so
  /// far, and short enough to stay one cheap query — [_extend] doubles it when
  /// the user reaches the end.
  static const _initialDays = 90;

  int _days = _initialDays;
  List<MealDay> _history = const [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final today = localDayOf(DateTime.now());
      final meals = await widget.store.mealsAcross(
        today.subtract(Duration(days: _days)),
        today,
      );
      if (!mounted) return;
      setState(() {
        _history = groupByLocalDay(meals);
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = _messageFor(e);
        _loading = false;
      });
    }
  }

  /// Go back further. The window doubles rather than stepping, so reaching the
  /// start of a long history takes a handful of taps rather than a scroll.
  void _extend() {
    _days *= 2;
    _load();
  }

  /// Open one day, on the same screen today uses.
  ///
  /// Its own store over the same backend: the day behind the viewfinder is
  /// still today, and dragging it to 3 March because someone looked at 3 March
  /// would be the wrong total on the wrong screen.
  /// Not disposed on the way back: a day popped before its first read finished
  /// would have a `notifyListeners` land on a disposed notifier, and there is
  /// nothing to release anyway — the screen that listened to it is gone, so the
  /// store goes with it.
  Future<void> _openDay(MealDay day) async {
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => TodayScreen(
        session: widget.session,
        store: widget.store.viewOf(day.day),
        images: widget.images,
        account: widget.account,
        queue: widget.queue,
        sync: widget.sync,
      ),
    ));
    // A day can be edited from in there, and the total on this screen is the
    // one thing that would still be showing what it was.
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('History')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _body(),
      ),
    );
  }

  Widget _body() {
    if (_loading && _history.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    final error = _error;
    if (error != null && _history.isEmpty) {
      return _Centred(
        icon: Icons.cloud_off_outlined,
        title: 'Could not read your history',
        detail: error,
        action: FilledButton(onPressed: _load, child: const Text('Try again')),
      );
    }

    if (_history.isEmpty) {
      return const _Centred(
        icon: Icons.history_toggle_off_outlined,
        title: 'Nothing here yet',
        detail: 'Days you have logged meals on show up here, newest first.',
      );
    }

    return ListView.builder(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      // One row per day, plus the footer.
      itemCount: _history.length + 1,
      itemBuilder: (context, index) {
        if (index == _history.length) return _Footer(onExtend: _extend);
        final day = _history[index];
        return _DayRow(day: day, onTap: () => _openDay(day));
      },
    );
  }

  static String _messageFor(Object e) {
    final text = e.toString();
    return text.startsWith('Exception: ') ? text.substring(11) : text;
  }
}

/// One day: what it came to, and how confident that number is.
class _DayRow extends StatelessWidget {
  const _DayRow({required this.day, required this.onTap});

  final MealDay day;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final summary = day.summary;

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        onTap: onTap,
        title: Text(formatDay(day.day)),
        subtitle: Text(
          [
            '${summary.mealCount} '
                '${summary.mealCount == 1 ? 'meal' : 'meals'}',
            if (summary.hasRange)
              '${summary.lowerBound}–${summary.upperBound} kcal',
            // Said out loud rather than folded into the total: a day still
            // waiting on estimates has a total that is too low, and by an
            // amount nobody knows.
            if (summary.unestimatedCount > 0)
              '${summary.unestimatedCount} not counted',
          ].join(' · '),
          style: theme.textTheme.bodySmall
              ?.copyWith(color: theme.colorScheme.outline),
        ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Text(
              '${summary.calories}',
              style: theme.textTheme.titleLarge
                  ?.copyWith(fontWeight: FontWeight.w600),
            ),
            const SizedBox(width: 4),
            Text('kcal', style: theme.textTheme.bodySmall),
          ],
        ),
      ),
    );
  }
}

class _Footer extends StatelessWidget {
  const _Footer({required this.onExtend});

  final VoidCallback onExtend;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Center(
          child: TextButton(
            onPressed: onExtend,
            child: const Text('Look further back'),
          ),
        ),
      );
}

/// An empty or broken screen, said the same way both times.
class _Centred extends StatelessWidget {
  const _Centred({
    required this.icon,
    required this.title,
    required this.detail,
    this.action,
  });

  final IconData icon;
  final String title;
  final String detail;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    // A ListView rather than a Center so pull-to-refresh still works on it —
    // which is the one thing someone staring at "could not read your history"
    // is going to try.
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 80),
      children: [
        Icon(icon, size: 44, color: theme.colorScheme.outline),
        const SizedBox(height: 16),
        Text(
          title,
          textAlign: TextAlign.center,
          style: theme.textTheme.titleMedium,
        ),
        const SizedBox(height: 8),
        Text(
          detail,
          textAlign: TextAlign.center,
          style: theme.textTheme.bodySmall
              ?.copyWith(color: theme.colorScheme.outline),
        ),
        if (action != null) ...[
          const SizedBox(height: 24),
          Center(child: action),
        ],
      ],
    );
  }
}
