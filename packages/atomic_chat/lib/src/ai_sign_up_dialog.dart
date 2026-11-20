import 'package:atomic_flutter/atomic_flutter.dart' show ErrorText;
import 'package:flutter/material.dart';

import 'hosted_ai.dart';

/// The dialog the AI notice opens: the email, then "check your email" with
/// Resend and Change email. The portal mails a link that signs this device's
/// identity in to the account with that address, or creates one when there
/// is none. [send] mails it; [onSent] runs after each send (the chat then
/// looks for the account until it is there, and closes this dialog).
class AiSignUpDialog extends StatefulWidget {
  final Future<void> Function(String email) send;
  final VoidCallback onSent;

  const AiSignUpDialog({super.key, required this.send, required this.onSent});

  @override
  State<AiSignUpDialog> createState() => _AiSignUpDialogState();
}

class _AiSignUpDialogState extends State<AiSignUpDialog> {
  final _email = TextEditingController();
  bool _busy = false;
  bool _sent = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final email = _email.text.trim();
    if (email.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.send(email);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _sent = true;
      });
      widget.onSent();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e is StateError ? e.message : HostedAi.errorMessage(e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = TextStyle(
        color: theme.colorScheme.onSurfaceVariant, height: 1.4, fontSize: 14);
    if (_sent) {
      return AlertDialog(
        key: const Key('sign-up-dialog'),
        title: const Text('Check your email'),
        content: Text(
          'Check your email and open the link. Your drives and documents '
          'stay as they are.',
          key: const Key('sign-up-sent'),
          style: muted,
        ),
        actions: [
          if (_error != null) ErrorText(_error!),
          TextButton(
            key: const Key('sign-up-change'),
            onPressed: () => setState(() => _sent = false),
            child: const Text('Change email'),
          ),
          TextButton(
            key: const Key('sign-up-resend'),
            onPressed: _busy ? null : _send,
            child: const Text('Resend'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Close'),
          ),
        ],
      );
    }
    return AlertDialog(
      key: const Key('sign-up-dialog'),
      title: const Text('Your atomic.place account'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Enter its email. We mail you a link that signs this device in, '
            'or creates the account if you have none.',
            style: muted,
          ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('sign-up-email'),
            controller: _email,
            autofocus: true,
            keyboardType: TextInputType.emailAddress,
            autofillHints: const [AutofillHints.email],
            textInputAction: TextInputAction.send,
            decoration: const InputDecoration(hintText: 'Your email address'),
            onSubmitted: (_) => _send(),
          ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            ErrorText(_error!),
          ],
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const Key('sign-up-send'),
          onPressed: _busy ? null : _send,
          child: const Text('Send link'),
        ),
      ],
    );
  }
}
