import 'package:flutter/material.dart';

/// A row on the settings hub: where it leads, and the one thing worth knowing
/// about it without going there.
///
/// The subtitle is what keeps this a settings screen rather than a menu.
/// "Not connected", "nothing paired", "1.2 GB of 250 MB" are the answers people
/// open these screens to look up, and a hub that made them tap into each one to
/// find out would be worse than the single long scroll it replaced.
class SettingsTile extends StatelessWidget {
  const SettingsTile({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return ListTile(
      onTap: onTap,
      leading: Icon(icon),
      title: Text(title),
      subtitle: Text(
        subtitle,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style:
            theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.outline),
      ),
      trailing: const Icon(Icons.chevron_right),
    );
  }
}

/// A label with its value on the right of the same line. `1.4 MB` against
/// `On this device`.
class LabeledRow extends StatelessWidget {
  const LabeledRow({super.key, required this.label, required this.value});

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

/// A label with its value under it, wrapping freely.
///
/// The diagnostics card's values are sentences and multi-line readings, which
/// [LabeledRow] — built for `1.4 MB` against a label, right-aligned on one line
/// — ellipsised at roughly the character where they began to be useful.
class StackedRow extends StatelessWidget {
  const StackedRow({super.key, required this.label, required this.value});

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
