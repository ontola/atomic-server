import 'package:flutter/material.dart';

import '../../services/app_session.dart';
import '../../services/embedding_queue.dart';
import '../../services/image_store.dart';
import '../../services/live_suggestions.dart';
import '../../services/meal_index.dart';
import '../../services/openrouter.dart';
import '../../services/sync_service.dart';
import '../sync_screen.dart';
import 'account_screen.dart';
import 'ai_screen.dart';
import 'storage_screen.dart';
import 'widgets.dart';

/// Settings: one row per thing that can be changed, and what it says now.
///
/// This screen is Phase 5's, arriving late. Until now everything here was
/// stacked on the account screen — the agent, the secret, the model, the paired
/// devices, the photo budget and a diagnostics card — which was one scroll of
/// unrelated cards where the two destructive buttons in the app sat next to the
/// numbers people came to read. Each group is now a screen, and this is the way
/// in to all of them.
///
/// Every argument is nullable for the same reason it always was: a test, or a
/// boot that has not got that far, has no image store and no OpenRouter
/// account, and a row leading to a screen with nothing behind it is worse than
/// no row.
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({
    super.key,
    required this.session,
    this.images,
    this.account,
    this.sync,
    this.index,
    this.embeddings,
    this.live,
  });

  final AppSession session;

  /// Where the photos are. Null before the documents directory is known, and in
  /// tests — then there is nothing to report and the row is not shown.
  final ImageStore? images;

  /// Who pays for the estimates.
  final OpenRouterAccount? account;

  /// The other devices this account has.
  final SyncService? sync;

  /// The bring-up readout's three inputs, threaded through to [AiScreen]. Only
  /// the viewfinder has them all — see `capture_screen.dart`.
  final MealIndex? index;
  final EmbeddingQueue? embeddings;
  final LiveSuggestions? live;

  bool get _hasAi => account != null || (index != null && embeddings != null);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      // The rows scroll; the licence link does not. It sits on the floor of the
      // screen under everything else, which is both where it belongs and how it
      // stays reachable — see [OpenSourceLink].
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(24),
                child: Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 420),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        // Grouped by what a row is *about* — this account, then
                        // this phone, then the app itself — rather than by how
                        // often it is opened. Cards are the grouping; there are
                        // no headings, because four rows do not need to be told
                        // apart in words.
                        Card(
                          child: Column(
                            children: [
                              SettingsTile(
                                icon: Icons.person_outline,
                                title: 'Account',
                                subtitle: AccountScreen.describe(session),
                                onTap: () => AccountScreen.open(
                                  context,
                                  session: session,
                                ),
                              ),
                              if (sync case final sync?) SyncTile(sync: sync),
                            ],
                          ),
                        ),
                        if (_hasAi || images != null) ...[
                          const SizedBox(height: 16),
                          Card(
                            child: Column(
                              children: [
                                if (_hasAi)
                                  _AiTile(
                                    account: account,
                                    index: index,
                                    embeddings: embeddings,
                                    live: live,
                                  ),
                                if (images case final images?)
                                  _StorageTile(images: images),
                              ],
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ),
            const OpenSourceLink(),
          ],
        ),
      ),
    );
  }
}

/// The account's other devices, and whether there are any.
///
/// Named for what it does rather than for what it lists: the row is the way to
/// pairing, to a sync on demand and to the servers, and "Devices" was also the
/// heading of one list *inside* that screen.
///
/// Live, because pairing happens two screens down inside the canvas app's
/// shared section and there is no callback for it — [SyncScreen] refreshes the
/// count on its way out, and this listens.
class SyncTile extends StatelessWidget {
  const SyncTile({super.key, required this.sync});

  final SyncService sync;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: sync,
      builder: (context, _) => SettingsTile(
        icon: Icons.sync,
        title: 'Sync',
        subtitle: sync.hasDevices
            ? '${sync.devices} paired — your meals travel between them'
            : 'Nothing paired — your meals stay on this phone',
        onTap: () => SyncScreen.open(context, sync: sync),
      ),
    );
  }
}

/// The estimator and the on-device encoder, behind one row.
class _AiTile extends StatelessWidget {
  const _AiTile({this.account, this.index, this.embeddings, this.live});

  final OpenRouterAccount? account;
  final MealIndex? index;
  final EmbeddingQueue? embeddings;
  final LiveSuggestions? live;

  @override
  Widget build(BuildContext context) {
    final connected = account;

    Widget tile(BuildContext context, Widget? _) => SettingsTile(
          icon: Icons.auto_awesome_outlined,
          title: 'AI',
          subtitle: AiScreen.describe(connected),
          onTap: () => AiScreen.open(
            context,
            account: account,
            index: index,
            embeddings: embeddings,
            live: live,
          ),
        );

    // Connecting an account changes this line, and the screen that does it is
    // two taps down rather than a route this one awaits.
    if (connected == null) return tile(context, null);
    return AnimatedBuilder(animation: connected, builder: tile);
  }
}

/// What the photos weigh, against the budget that deletes them.
///
/// The counter rather than a recount: this is a subtitle on a hub, and the
/// screen it leads to recounts. A cached number that is a few kilobytes stale
/// is the right trade for not walking the photo directory every time somebody
/// opens Settings.
class _StorageTile extends StatefulWidget {
  const _StorageTile({required this.images});

  final ImageStore images;

  @override
  State<_StorageTile> createState() => _StorageTileState();
}

class _StorageTileState extends State<_StorageTile> {
  int? _used;
  int? _budget;

  @override
  void initState() {
    super.initState();
    _read();
  }

  Future<void> _read() async {
    final used = await widget.images.totalBytes();
    final budget = await widget.images.budgetBytes();
    if (!mounted) return;
    setState(() {
      _used = used;
      _budget = budget;
    });
  }

  String get _subtitle {
    final used = _used;
    final budget = _budget;
    if (used == null || budget == null) return 'Photos on this device';
    if (budget == ImageStore.unlimitedBudget) {
      return '${formatBytes(used)} — no limit set';
    }
    return '${formatBytes(used)} of ${formatBytes(budget)}';
  }

  @override
  Widget build(BuildContext context) {
    return SettingsTile(
      icon: Icons.photo_library_outlined,
      title: 'Storage',
      subtitle: _subtitle,
      // Recount on the way back: the screen below can delete every photo, and
      // returning to a hub still claiming the old number would read as the
      // deletion not having worked.
      onTap: () async {
        await StorageScreen.open(context, images: widget.images);
        await _read();
      },
    );
  }
}

/// The way to the licence page — a line of small grey text on the floor of the
/// screen, and deliberately the quietest thing here.
///
/// It is not a setting: nothing about it can be changed, and nobody opens
/// Settings to read it. But it cannot be dropped either. Registering a licence
/// with [LicenseRegistry] and never linking to the page that shows it satisfies
/// nothing — Apache 2.0 section 4(a) is about the recipient *getting* a copy,
/// and this app ships 88 MB of Apache 2.0 weights. `main.dart` adds the
/// encoder's entry; this is the door, and `showLicensePage` collects every Dart
/// package's licence behind it too.
///
/// So: quiet, but always present and never scrolled away from. The one thing
/// that must not happen to it is disappearing.
class OpenSourceLink extends StatelessWidget {
  const OpenSourceLink({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: TextButton(
        onPressed: () => showLicensePage(
          context: context,
          applicationName: 'Calorie Tracker',
        ),
        style: TextButton.styleFrom(
          foregroundColor: theme.colorScheme.outline,
          textStyle: theme.textTheme.bodySmall,
          // No ink and no tint: at this weight the splash is the loudest thing
          // about the row.
          backgroundColor: Colors.transparent,
        ),
        child: const Text('Open source licences'),
      ),
    );
  }
}
