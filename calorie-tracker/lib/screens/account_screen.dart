import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../services/app_session.dart';

/// Who you are signed in as, and the secret that is the only way back in.
///
/// This was the placeholder home screen in Phase 1. Now that there is a day to
/// show, it moved behind an icon — but it does not go away until Settings
/// exists (Phase 5), because an account whose secret was never written down
/// anywhere is one bad reinstall from gone.
class AccountScreen extends StatelessWidget {
  const AccountScreen({super.key, required this.session});

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
