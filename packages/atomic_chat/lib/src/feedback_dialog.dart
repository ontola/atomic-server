import 'package:flutter/material.dart';

import 'assistant_api.dart';

/// "Send feedback", as the web app's sidebar has it (`useFeedbackDialog`): a
/// message and an optional email, sent to the team through Sentry with
/// [AssistantApi.sendFeedback]. [source] says where it was opened.
Future<void> showFeedbackDialog(BuildContext context,
        {required AssistantApi api, String source = 'app'}) =>
    showDialog<void>(
      context: context,
      builder: (_) => FeedbackDialog(api: api, source: source),
    );

class FeedbackDialog extends StatefulWidget {
  final AssistantApi api;
  final String source;

  const FeedbackDialog({super.key, required this.api, this.source = 'app'});

  @override
  State<FeedbackDialog> createState() => _FeedbackDialogState();
}

class _FeedbackDialogState extends State<FeedbackDialog> {
  final _message = TextEditingController();
  final _email = TextEditingController();
  bool _sending = false;
  bool _sent = false;
  bool _failed = false;
  bool _badEmail = false;

  @override
  void dispose() {
    _message.dispose();
    _email.dispose();
    super.dispose();
  }

  bool get _canSend => widget.api.canSendFeedback;

  Future<void> _send() async {
    final email = _email.text.trim();
    if (email.isNotEmpty && !RegExp(r'^\S+@\S+\.\S+$').hasMatch(email)) {
      setState(() => _badEmail = true);
      return;
    }
    setState(() {
      _badEmail = false;
      _sending = true;
      _failed = false;
    });
    try {
      await widget.api.sendFeedback(
        message: _message.text.trim(),
        email: email.isEmpty ? null : email,
        source: widget.source,
      );
      if (mounted) setState(() => _sent = true);
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final error = Theme.of(context).colorScheme.error;
    return AlertDialog(
      title: const Text('Send feedback'),
      content: SizedBox(
        width: 560,
        child: SingleChildScrollView(
          child: _sent
              ? const Text('Thank you. Your feedback has been received.',
                  key: Key('feedback-sent'))
              : Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Report a bug or suggest an improvement. Your '
                        'message and optional email go to the Atomic team '
                        'through Sentry. Please leave out private workspace '
                        'content.'),
                    const SizedBox(height: 12),
                    TextField(
                      key: const Key('feedback-message'),
                      controller: _message,
                      enabled: !_sending,
                      autofocus: true,
                      minLines: 4,
                      maxLines: 8,
                      maxLength: 10000,
                      onChanged: (_) => setState(() {}),
                      decoration: const InputDecoration(
                          labelText: 'Feedback',
                          border: OutlineInputBorder()),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      key: const Key('feedback-email'),
                      controller: _email,
                      enabled: !_sending,
                      keyboardType: TextInputType.emailAddress,
                      decoration: InputDecoration(
                          labelText: 'Email for a reply (optional)',
                          errorText:
                              _badEmail ? 'Enter a valid email address' : null,
                          border: const OutlineInputBorder()),
                    ),
                    if (!_canSend)
                      const Padding(
                        padding: EdgeInsets.only(top: 8),
                        child: Text(
                            'Feedback reporting is unavailable on this '
                            'installation. Email info@ontola.io.',
                            key: Key('feedback-unavailable')),
                      ),
                    if (_failed)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(
                            'Your feedback could not be sent. Your text is '
                            'still here; try again.',
                            key: const Key('feedback-failed'),
                            style: TextStyle(color: error)),
                      ),
                  ],
                ),
        ),
      ),
      actions: [
        TextButton(
          key: const Key('feedback-close'),
          onPressed: _sending ? null : () => Navigator.pop(context),
          child: Text(_sent ? 'Close' : 'Cancel'),
        ),
        if (!_sent)
          FilledButton(
            key: const Key('feedback-send'),
            onPressed: _sending || !_canSend || _message.text.trim().isEmpty
                ? null
                : _send,
            child: Text(_sending ? 'Sending' : 'Send'),
          ),
      ],
    );
  }
}
