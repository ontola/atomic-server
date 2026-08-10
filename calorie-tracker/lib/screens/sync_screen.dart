import 'package:flutter/material.dart';

import '../atomic/widgets/server_settings_section.dart';
import '../services/sync_service.dart';

/// The other devices this account has, and what they last agreed on.
///
/// Phase 6's half of the plan (§8): the sync itself has existed in Rust since
/// the app was scaffolded — Iroh peer pairing and an atomic-server websocket
/// session — and there was simply no way to reach it from here. This is that
/// way, and it deliberately reuses the canvas app's `ServerSettingsSection` and
/// `PairScreen` rather than growing a second pairing UI: the two apps are meant
/// to become one package (`calorie-tracker-plan.md` §10), and the merge stays a
/// copy for exactly as long as nobody forks the shared parts.
class SyncScreen extends StatefulWidget {
  const SyncScreen({super.key, required this.sync});

  final SyncService sync;

  static Future<void> open(BuildContext context, {required SyncService sync}) {
    return Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => SyncScreen(sync: sync)),
    );
  }

  @override
  State<SyncScreen> createState() => _SyncScreenState();
}

class _SyncScreenState extends State<SyncScreen> {
  @override
  void initState() {
    super.initState();
    // Not a sync — just a count. Arriving on this screen should not start
    // reaching for the network; the button is what does that.
    widget.sync.refresh();
  }

  /// And once more on the way out, because pairing happens *inside* the shared
  /// section below and there is no callback for it — so this is what stops the
  /// settings screen still saying "nothing paired" after a device was just
  /// paired.
  @override
  void dispose() {
    widget.sync.refresh();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      // 'Sync' rather than 'Devices': the shared section below has a list under
      // that heading, and a screen whose title repeats one of its own headings
      // reads as the whole screen being that list.
      appBar: AppBar(title: const Text('Sync')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    'Your meals live on this device. Pair another one and each '
                    'keeps the other up to date, directly — there is no server '
                    'in between unless you add one.',
                    style: theme.textTheme.bodyMedium
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
                  const SizedBox(height: 6),
                  // Said here rather than discovered later: a meal that arrives
                  // from another phone arrives without its picture, and that is
                  // a design decision (plan §10), not a sync that half worked.
                  Text(
                    'Photos stay on the phone that took them. Meals, calories '
                    'and notes travel.',
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
                  const SizedBox(height: 20),
                  AnimatedBuilder(
                    animation: widget.sync,
                    builder: (context, _) => _SyncNowCard(sync: widget.sync),
                  ),
                  const SizedBox(height: 20),
                  // Servers, paired devices, the QR pairing dialog and "connect
                  // by address", all of it shared with the canvas app.
                  ServerSettingsSection(onServerChanged: widget.sync.refresh),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Sync on demand, and what the last one came to.
class _SyncNowCard extends StatelessWidget {
  const _SyncNowCard({required this.sync});

  final SyncService sync;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final message = sync.lastMessage;

    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            FilledButton.icon(
              onPressed: sync.busy ? null : sync.syncNow,
              icon: sync.busy
                  ? const SizedBox(
                      height: 18,
                      width: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.sync, size: 18),
              label: Text(sync.busy ? 'Looking…' : 'Sync now'),
            ),
            if (message != null) ...[
              const SizedBox(height: 10),
              Text(
                message,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: theme.colorScheme.outline),
              ),
            ],
            if (sync.lastSyncedAt != null) ...[
              const SizedBox(height: 4),
              Text(
                'Last synced ${formatSyncTime(sync.lastSyncedAt!)}',
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: theme.colorScheme.outline),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// `just now` / `12m ago` / `3h ago` / `2d ago`. Coarse on purpose: the exact
/// second of the last sync has never been what anybody wanted to know.
String formatSyncTime(DateTime at, {DateTime? now}) {
  final delta = (now ?? DateTime.now()).difference(at);
  if (delta.inSeconds < 60) return 'just now';
  if (delta.inMinutes < 60) return '${delta.inMinutes}m ago';
  if (delta.inHours < 24) return '${delta.inHours}h ago';
  return '${delta.inDays}d ago';
}
