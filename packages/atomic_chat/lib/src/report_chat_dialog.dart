import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;

import 'assistant_api.dart';
import 'chat_parts.dart';

/// The longest report the dialog sends (the web app's limit).
const maxAiChatReportLength = 60000;

String _formatEntry(ChatEntry m, int index) {
  final errors = <String>[];
  final content = [
    for (final p in m.parts)
      switch (p) {
        TextPart() => p.text,
        FilePart() => '[Attachment: ${p.filename ?? 'unnamed'}]',
        // Tool inputs and outputs can contain document data: only the kind of
        // part goes in; the person may describe the rest.
        ToolPart() => () {
            if (p.errorText != null) errors.add(p.errorText!);
            return '[tool-${p.toolName}]';
          }(),
        RawPart() => '[${p.json['type'] ?? 'part'}]',
      },
  ].where((s) => s.isNotEmpty).join('\n');
  final error = errors.isEmpty ? '' : '\nError: ${errors.join('; ')}';
  return '${index + 1}. ${m.role}\n${content.isEmpty ? '[No text]' : content}$error';
}

/// A reviewable transcript of an AI chat, as the web app's
/// `formatAIChatReport` writes it. Tool payloads and files are left out. When
/// it grows past [maxAiChatReportLength] the oldest messages are dropped.
({String text, int omitted}) formatAiChatReport(
    String title, List<ChatEntry> messages) {
  final entries = [for (final (i, m) in messages.indexed) _formatEntry(m, i)];
  final heading =
      'AI chat: ${title.isEmpty ? 'Untitled Chat' : title}\nMessages: ${messages.length}\n\n';
  var omitted = 0;
  var body = entries.join('\n\n');
  while (heading.length + body.length > maxAiChatReportLength &&
      omitted < entries.length - 1) {
    omitted++;
    body = entries.skip(omitted).join('\n\n');
  }
  final omission = omitted > 0
      ? '$omitted earlier messages omitted to fit the report.\n\n'
      : '';
  final available = maxAiChatReportLength - heading.length - omission.length;
  if (body.length > available) {
    final keep = (available - 39).clamp(0, body.length);
    body =
        '[Earlier text in this message omitted]\n${body.substring(body.length - keep)}';
  }
  var text = '$heading$omission$body';
  if (text.length > maxAiChatReportLength) {
    text = text.substring(0, maxAiChatReportLength);
  }
  return (text: text, omitted: omitted);
}

String _reportText(String details, String transcript) =>
    'What went wrong:\n${details.trim().isEmpty ? '(No description)' : details.trim()}\n\n$transcript';

/// "Report AI chat", as the web app has it: what went wrong, the transcript to
/// review and edit, an optional email. Only Send report transmits it.
Future<void> showReportChatDialog(
  BuildContext context, {
  required AssistantApi api,
  required String title,
  required List<ChatEntry> messages,
}) {
  final report = formatAiChatReport(title, messages);
  return showDialog<void>(
    context: context,
    builder: (_) => ReportChatDialog(
        api: api, transcript: report.text, omitted: report.omitted),
  );
}

class ReportChatDialog extends StatefulWidget {
  final AssistantApi api;
  final String transcript;
  final int omitted;

  const ReportChatDialog({
    super.key,
    required this.api,
    required this.transcript,
    this.omitted = 0,
  });

  @override
  State<ReportChatDialog> createState() => _ReportChatDialogState();
}

class _ReportChatDialogState extends State<ReportChatDialog> {
  final _details = TextEditingController();
  late final _transcript = TextEditingController(text: widget.transcript);
  final _email = TextEditingController();
  bool _sending = false;
  bool _sent = false;
  bool _failed = false;
  bool _copied = false;
  bool _badEmail = false;

  @override
  void dispose() {
    _details.dispose();
    _transcript.dispose();
    _email.dispose();
    super.dispose();
  }

  bool get _canSend => widget.api.canSendFeedback;
  bool get _hasText => _transcript.text.trim().isNotEmpty;

  Future<void> _copy() async {
    await Clipboard.setData(
        ClipboardData(text: _reportText(_details.text, _transcript.text)));
    if (mounted) setState(() => _copied = true);
  }

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
        message: _reportText(_details.text, _transcript.text),
        email: email.isEmpty ? null : email,
        source: 'ai-chat',
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
      title: const Text('Report AI chat'),
      content: SizedBox(
        width: 560,
        child: SingleChildScrollView(
          child: _sent
              ? const Text('Thank you. Your AI chat report has been sent.',
                  key: Key('report-sent'))
              : Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                        'Pressing Send report shares the reviewed chat text, '
                        'error messages, and your optional description and '
                        'email with the Atomic team through Sentry. '
                        'Attachments, tool payloads, and reasoning are '
                        'excluded. Remove private information before '
                        'sending.'),
                    const SizedBox(height: 12),
                    TextField(
                      key: const Key('report-details'),
                      controller: _details,
                      enabled: !_sending,
                      minLines: 3,
                      maxLines: 5,
                      maxLength: 2000,
                      decoration: const InputDecoration(
                          labelText: 'What went wrong?',
                          border: OutlineInputBorder()),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      key: const Key('report-transcript'),
                      controller: _transcript,
                      enabled: !_sending,
                      minLines: 6,
                      maxLines: 10,
                      maxLength: maxAiChatReportLength,
                      onChanged: (_) => setState(() {}),
                      decoration: const InputDecoration(
                          labelText: 'Chat transcript (editable)',
                          border: OutlineInputBorder()),
                    ),
                    if (widget.omitted > 0)
                      Text(
                          '${widget.omitted} earlier messages were omitted to '
                          'fit the report. The most recent messages are '
                          'included.',
                          key: const Key('report-omitted')),
                    const SizedBox(height: 12),
                    TextField(
                      key: const Key('report-email'),
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
                            'installation. You can copy the report instead.',
                            key: Key('report-unavailable')),
                      ),
                    if (_copied)
                      const Padding(
                        padding: EdgeInsets.only(top: 8),
                        child: Text('Report copied to clipboard.',
                            key: Key('report-copied')),
                      ),
                    if (_failed)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Text(
                            'The report could not be sent. Your text is '
                            'still here; try again.',
                            key: const Key('report-failed'),
                            style: TextStyle(color: error)),
                      ),
                  ],
                ),
        ),
      ),
      actions: [
        TextButton(
          key: const Key('report-close'),
          onPressed: _sending ? null : () => Navigator.pop(context),
          child: const Text('Close'),
        ),
        if (!_sent) ...[
          TextButton(
            key: const Key('report-copy'),
            onPressed: _sending || !_hasText ? null : _copy,
            child: const Text('Copy report'),
          ),
          FilledButton(
            key: const Key('report-send'),
            onPressed: _sending || !_canSend || !_hasText ? null : _send,
            child: Text(_sending ? 'Sending report' : 'Send report'),
          ),
        ],
      ],
    );
  }
}
