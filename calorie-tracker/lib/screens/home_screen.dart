import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/app_session.dart';

/// Stand-in for CaptureScreen (Phase 3).
///
/// Phase 1 has no meals to show yet, so what it shows instead is the thing it
/// built: an account that survives a relaunch, and the container the meals will
/// go in. The secret is here too, because until Settings exists (Phase 5) this
/// is the only place to copy it from — and an account whose secret was never
/// written down anywhere is one bad reinstall from gone.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, required this.session});

  final AppSession session;

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

    if (confirmed == true) await session.signOut();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.photo_camera_outlined,
                      size: 64, color: theme.colorScheme.primary),
                  const SizedBox(height: 16),
                  Text('Calorie Tracker',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.headlineSmall),
                  const SizedBox(height: 8),
                  Text(
                    'You are set up. Camera capture lands in Phase 3.',
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodyMedium
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
                  const SizedBox(height: 28),
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
