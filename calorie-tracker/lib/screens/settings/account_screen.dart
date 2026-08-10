import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../services/app_session.dart';
import 'widgets.dart';

/// Who you are signed in as, and the secret that is the only way back in.
///
/// This was the whole of Settings until Phase 5 — everything else that had
/// collected on it now has its own screen, and what is left is the part that
/// cannot be recovered if it is lost: an account whose secret was never written
/// down anywhere is one bad reinstall from gone.
class AccountScreen extends StatelessWidget {
  const AccountScreen({super.key, required this.session});

  final AppSession session;

  static Future<void> open(
    BuildContext context, {
    required AppSession session,
  }) {
    return Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => AccountScreen(session: session),
    ));
  }

  /// Subjects are DIDs and run off the screen; the tail identifies them.
  static String shorten(String? subject) {
    if (subject == null || subject.isEmpty) return '—';
    return subject.length <= 24
        ? subject
        : '…${subject.substring(subject.length - 22)}';
  }

  /// What to call this account in one line — its name, or the tail of its
  /// subject when it has none. The settings hub says it too, so that "signed in
  /// as somebody" does not need a tap to establish.
  static String describe(AppSession session) =>
      session.agent?.name?.isNotEmpty == true
          ? session.agent!.name!
          : shorten(session.agent?.subject);

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
    // this screen — or the settings screen it was opened from — should be
    // sitting on top of.
    navigator.popUntil((route) => route.isFirst);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

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
                        LabeledRow(
                          label: 'Account',
                          value: describe(session),
                        ),
                        LabeledRow(
                          label: 'Drive',
                          value: shorten(session.drive),
                        ),
                        LabeledRow(
                          label: 'Meals',
                          value: shorten(session.mealsContainer),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 20),
                  Text(
                    'There is no password and no way to reset one. Your secret '
                    'is the account — keep a copy of it somewhere you would '
                    'still have it if this phone were gone.',
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
                  const SizedBox(height: 16),
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
