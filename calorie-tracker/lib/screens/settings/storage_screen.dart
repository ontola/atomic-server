import 'package:flutter/material.dart';

import '../../services/image_store.dart';
import 'widgets.dart';

/// What the photos cost, and the two things the user can do about it.
///
/// Eviction itself is silent — it is a cache policy, not a deletion worth
/// interrupting anyone over — so this is the only place the budget is visible.
/// Which is the point of showing it: a number that quietly deletes things is
/// one the user should be able to find and change.
class StorageScreen extends StatelessWidget {
  const StorageScreen({super.key, required this.images});

  final ImageStore images;

  static Future<void> open(
    BuildContext context, {
    required ImageStore images,
  }) {
    return Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => StorageScreen(images: images),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('Storage')),
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
                  // Said before the numbers rather than after them: everything
                  // on this screen deletes pictures, and none of it touches a
                  // meal. That is the sentence that makes the buttons safe to
                  // press.
                  Text(
                    'Photos are a cache. Your meals, their calories and your '
                    'notes are the data, and nothing here deletes any of them.',
                    style: theme.textTheme.bodyMedium
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
                  const SizedBox(height: 20),
                  PhotoStorageSection(images: images),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The used-against-budget readout, the budget itself, and the delete button.
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
          LabeledRow(
            label: 'On this device',
            value: used == null ? '…' : formatBytes(used),
          ),
          // Only once there is one, so an account with no photos is not told
          // about a directory it has never filled.
          if ((_sources ?? 0) > 0)
            LabeledRow(
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
