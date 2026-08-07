import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/app_session.dart';
import '../services/embedding_queue.dart';
import '../services/image_store.dart';
import '../services/live_suggestions.dart';
import '../services/meal_index.dart';
import '../services/meal_priors.dart';
import '../services/openrouter.dart';
import '../services/sync_service.dart';
import 'openrouter_screen.dart';
import 'sync_screen.dart';

/// Who you are signed in as, the secret that is the only way back in, and what
/// the photos are costing.
///
/// This was the placeholder home screen in Phase 1. Now that there is a day to
/// show, it moved behind an icon — and it is standing in for Settings (Phase 5)
/// until there is one, because an account whose secret was never written down
/// anywhere is one bad reinstall from gone.
class AccountScreen extends StatelessWidget {
  const AccountScreen({
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
  /// tests — then there is nothing to report and the section is not shown.
  final ImageStore? images;

  /// Who pays for the estimates. Null in tests, and then the row that leads to
  /// them is not shown.
  final OpenRouterAccount? account;

  /// The other devices this account has. Null in tests, and then the row that
  /// leads to them is not shown.
  final SyncService? sync;

  // ── The bring-up readout (temporary) ─────────────────────────────────────
  //
  // Phase 7 has four links — source written, meal estimated, vector encoded,
  // score over the bar — and from the viewfinder all four failures look like an
  // empty row. These make the chain legible on a phone that is not plugged into
  // anything. Take them out once the thresholds are settled (§11).

  /// The decoded vectors. Null from anywhere that has not got one, and then the
  /// section is absent.
  final MealIndex? index;

  /// Which meals still need one.
  final EmbeddingQueue? embeddings;

  /// The live matcher, when this was opened from the viewfinder — it carries
  /// the last score that was actually measured.
  final LiveSuggestions? live;

  /// Subjects are DIDs and run off the screen; the tail identifies them.
  static String shorten(String? subject) {
    if (subject == null || subject.isEmpty) return '—';
    return subject.length <= 24
        ? subject
        : '…${subject.substring(subject.length - 22)}';
  }

  Future<void> _copySecret(BuildContext context) async {
    final secret = session.agent?.secret;
    final messenger = ScaffoldMessenger.of(context);
    if (secret == null || secret.isEmpty) {
      messenger.showSnackBar(
        const SnackBar(content: Text('No secret to copy')),
      );
      return;
    }

    await Clipboard.setData(ClipboardData(text: secret));
    messenger.showSnackBar(
      const SnackBar(content: Text('Secret copied — keep it somewhere safe')),
    );
  }

  Future<void> _confirmSignOut(BuildContext context) async {
    final navigator = Navigator.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Sign out?'),
        content: const Text(
          'Your secret is the only way back into this account. Copy it first — '
          'there is nobody who can reset it.',
        ),
        actions: [
          TextButton(
            onPressed: () => _copySecret(dialogContext),
            child: const Text('Copy secret'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Sign out'),
          ),
        ],
      ),
    );

    if (confirmed != true) return;
    await session.signOut();
    // Onboarding is what the session gate renders now, and it is not something
    // this screen should be sitting on top of.
    navigator.popUntil((route) => route.isFirst);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Account')),
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
                  Card(
                    child: Column(
                      children: [
                        _Row(
                          label: 'Account',
                          value: session.agent?.name?.isNotEmpty == true
                              ? session.agent!.name!
                              : shorten(session.agent?.subject),
                        ),
                        _Row(label: 'Drive', value: shorten(session.drive)),
                        _Row(
                          label: 'Meals',
                          value: shorten(session.mealsContainer),
                        ),
                      ],
                    ),
                  ),
                  if (account != null) ...[
                    const SizedBox(height: 20),
                    EstimatesSection(account: account!),
                  ],
                  if (sync != null) ...[
                    const SizedBox(height: 20),
                    DevicesSection(sync: sync!),
                  ],
                  if (images != null) ...[
                    const SizedBox(height: 20),
                    PhotoStorageSection(images: images!),
                  ],
                  if (index != null && embeddings != null) ...[
                    const SizedBox(height: 20),
                    RecognitionSection(
                      index: index!,
                      embeddings: embeddings!,
                      live: live,
                    ),
                  ],
                  const SizedBox(height: 20),
                  const OpenSourceSection(),
                  const SizedBox(height: 20),
                  OutlinedButton.icon(
                    onPressed: () => _copySecret(context),
                    icon: const Icon(Icons.key, size: 18),
                    label: const Text('Copy my secret'),
                  ),
                  const SizedBox(height: 8),
                  TextButton(
                    onPressed: () => _confirmSignOut(context),
                    child: const Text('Sign out'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Where the calorie numbers come from, one tap away.
///
/// A row rather than the whole screen: connecting an account and choosing a
/// model is a thing done once, and this screen's job is the account that cannot
/// be recovered if it is lost.
class EstimatesSection extends StatelessWidget {
  const EstimatesSection({super.key, required this.account});

  final OpenRouterAccount account;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Card(
      child: AnimatedBuilder(
        animation: account,
        builder: (context, _) => ListTile(
          onTap: () => OpenRouterScreen.open(context, account: account),
          title: const Text('Estimates'),
          subtitle: Text(
            account.isConnected
                ? account.model
                : 'Not connected — meals wait for their calories',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodySmall
                ?.copyWith(color: theme.colorScheme.outline),
          ),
          trailing: const Icon(Icons.chevron_right),
        ),
      ),
    );
  }
}

/// The account's other devices, one tap away.
///
/// A row for the same reason [EstimatesSection] is one: pairing a phone is done
/// once, and what it is worth saying here is whether it has been done at all.
class DevicesSection extends StatelessWidget {
  const DevicesSection({super.key, required this.sync});

  final SyncService sync;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Card(
      child: AnimatedBuilder(
        animation: sync,
        builder: (context, _) => ListTile(
          onTap: () => SyncScreen.open(context, sync: sync),
          title: const Text('Devices'),
          subtitle: Text(
            sync.hasDevices
                ? '${sync.devices} paired — your meals travel between them'
                : 'Nothing paired — your meals stay on this phone',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodySmall
                ?.copyWith(color: theme.colorScheme.outline),
          ),
          trailing: const Icon(Icons.chevron_right),
        ),
      ),
    );
  }
}

/// What the photos cost, and the two things the user can do about it.
///
/// Eviction itself is silent — it is a cache policy, not a deletion worth
/// interrupting anyone over — so this is the only place the budget is visible.
/// Which is the point of showing it: a number that quietly deletes things is
/// one the user should be able to find and change.
class PhotoStorageSection extends StatefulWidget {
  const PhotoStorageSection({super.key, required this.images});

  final ImageStore images;

  @override
  State<PhotoStorageSection> createState() => _PhotoStorageSectionState();
}

class _PhotoStorageSectionState extends State<PhotoStorageSection> {
  int? _used;
  int? _budget;

  /// The embedding sources, which the budget does not govern and nothing
  /// evicts. Shown apart rather than folded into [_used], because a number the
  /// budget is measured against has to be the number the budget can act on.
  int? _sources;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    // Recount rather than read the counter: this is the screen where a drifted
    // number is visible, so it is the screen that should not be showing one.
    final used = await widget.images.recount();
    final budget = await widget.images.budgetBytes();
    final sources = await widget.images.sourceBytes();
    if (!mounted) return;
    setState(() {
      _used = used;
      _budget = budget;
      _sources = sources;
    });
  }

  Future<void> _setBudget(int bytes) async {
    await widget.images.setBudgetBytes(bytes);
    if (!mounted) return;
    setState(() => _budget = bytes);
    // Not swept here. The new budget applies from the next capture, and a
    // settings screen is not where photos should start disappearing.
  }

  Future<void> _deleteAll() async {
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Delete all photos?'),
        content: const Text(
          'Your meals and their calories stay. Only the pictures go, and they '
          'cannot be brought back. A thumbnail of each is kept so the app can '
          'still recognise a meal you have eaten before.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    final freed = await widget.images.deleteAll();
    await _refresh();
    messenger.showSnackBar(
      SnackBar(content: Text('Freed ${formatBytes(freed)}')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final used = _used;
    final budget = _budget;

    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
            child: Text('Photos', style: theme.textTheme.titleSmall),
          ),
          _Row(
            label: 'On this device',
            value: used == null ? '…' : formatBytes(used),
          ),
          // Only once there is one, so an account with no photos is not told
          // about a directory it has never filled.
          if ((_sources ?? 0) > 0)
            _Row(
              label: 'Kept for recognising meals',
              value: formatBytes(_sources!),
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'When photos pass this, the oldest ones are deleted. Meals, '
                  'calories and thumbnails are kept.',
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: theme.colorScheme.outline),
                ),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 8,
                  children: [
                    for (final option in ImageStore.budgetOptions)
                      ChoiceChip(
                        label: Text(formatBudget(option)),
                        selected: budget == option,
                        onSelected: (_) => _setBudget(option),
                      ),
                  ],
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: used == 0 ? null : _deleteAll,
                icon: const Icon(Icons.delete_outline, size: 18),
                label: const Text('Delete all photos now'),
                style: TextButton.styleFrom(
                  foregroundColor: theme.colorScheme.error,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The way to the licence page.
///
/// Registering a licence with [LicenseRegistry] and never linking to the page
/// that shows it satisfies nothing: Apache 2.0 section 4(a) is about the
/// recipient *getting* a copy. `main.dart` adds the encoder's entry; this is
/// the door. `showLicensePage` collects every Dart package's licence too, so
/// this one row covers all of them.
class OpenSourceSection extends StatelessWidget {
  const OpenSourceSection({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Card(
      child: ListTile(
        onTap: () => showLicensePage(
          context: context,
          applicationName: 'Calorie Tracker',
        ),
        title: const Text('Open source licences'),
        subtitle: Text(
          'Including the image encoder that recognises your meals',
          style: theme.textTheme.bodySmall
              ?.copyWith(color: theme.colorScheme.outline),
        ),
        trailing: const Icon(Icons.chevron_right),
      ),
    );
  }
}

/// Where the suggestion pipeline has got to — **temporary, for the device
/// bring-up** (`../planning/calorie-tracker-embeddings.md` §11).
///
/// The feature is a chain of four links and the viewfinder reports all four
/// failures the same way, by showing nothing: a meal with no source file, a
/// meal never estimated, a meal never encoded, and a meal encoded but scoring
/// under the bar are one silence. This says which.
///
/// Remove it once the thresholds are settled. It is deliberately plain and
/// unlovely — nobody should want to keep it.
class RecognitionSection extends StatefulWidget {
  const RecognitionSection({
    super.key,
    required this.index,
    required this.embeddings,
    this.live,
  });

  final MealIndex index;
  final EmbeddingQueue embeddings;
  final LiveSuggestions? live;

  @override
  State<RecognitionSection> createState() => _RecognitionSectionState();
}

class _RecognitionSectionState extends State<RecognitionSection> {
  @override
  void initState() {
    super.initState();
    // Both are cheap and both are what this section is for: arriving here to
    // find a stale count would be its own red herring.
    unawaited(_refresh());
  }

  Future<void> _refresh() async {
    // Past the latch first: [DinoV2Encoder] remembers a failure for the life of
    // the process so it does not re-attempt once per meal, which also means a
    // retry button that did not do this could only ever report the same failure
    // back.
    await widget.embeddings.encoder.reset();
    await widget.embeddings.drain();
    await widget.index.refresh();
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final live = widget.live;

    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
            child: Text('Recognising meals (diagnostics)',
                style: theme.textTheme.titleSmall),
          ),
          // Stacked rather than [_Row]'s label-and-value line: these values are
          // sentences, and a right-aligned single line ellipsised every one of
          // them at about the point they started saying something.
          _Stacked(label: 'Index', value: widget.index.describeLastLoad()),
          _Stacked(
            label: 'Encoder',
            value: widget.embeddings.describeLastDrain(),
          ),
          // The whole point of the card. Everything above says *that* it
          // failed; this is the only thing that says why, and it is the
          // platform's own words rather than a category this app invented.
          if (widget.embeddings.encoder.lastError case final error?)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
              child: SelectableText(
                error,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.error,
                  fontFamily: 'monospace',
                ),
              ),
            ),
          if (live != null)
            _Stacked(
              label: 'Last look',
              value: live.framesEncoded == 0
                  ? 'no frames scored'
                  : '${live.framesEncoded} frames, ${live.lastEncodeMs}ms each\n'
                      'best ever ${live.bestEver.toStringAsFixed(3)}, '
                      'last ${live.bestSeen.toStringAsFixed(3)}\n'
                      'a chip needs ${LiveSuggestions.suggestThreshold}, '
                      'a prior ${MealPriors.contextThreshold}',
            ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 6, 16, 4),
            child: Text(
              'A meal is suggestible once it has been photographed, estimated '
              'and encoded. "Last look" is what the camera scored the last '
              'time it looked at anything.',
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: theme.colorScheme.outline),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: _refresh,
                icon: const Icon(Icons.refresh, size: 18),
                label: const Text('Encode what is missing'),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// `1.4 MB`. Base 1024, because that is what the budget is counted in.
String formatBytes(int bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  var value = bytes.toDouble();
  var unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  // Whole bytes and kilobytes; a decimal only where it says something.
  final digits = unit >= 2 && value < 100 ? 1 : 0;
  return '${value.toStringAsFixed(digits)} ${units[unit]}';
}

String formatBudget(int bytes) =>
    bytes == ImageStore.unlimitedBudget ? 'No limit' : formatBytes(bytes);

/// A label with a value under it, wrapping freely.
///
/// The diagnostics card's values are sentences and multi-line readings, which
/// [_Row] — built for `1.4 MB` against a label, right-aligned on one line —
/// ellipsised at roughly the character where they began to be useful.
class _Stacked extends StatelessWidget {
  const _Stacked({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: theme.textTheme.bodyMedium),
          const SizedBox(height: 2),
          Text(
            value,
            style: theme.textTheme.bodySmall
                ?.copyWith(color: theme.colorScheme.outline),
          ),
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: theme.textTheme.bodyMedium),
          Flexible(
            child: Text(
              value,
              textAlign: TextAlign.right,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: theme.colorScheme.outline),
            ),
          ),
        ],
      ),
    );
  }
}
