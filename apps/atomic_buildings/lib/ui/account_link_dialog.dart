import 'dart:async';

import 'package:atomic_flutter/atomic_flutter.dart'
    show AtomicAccountClient, AtomicDeviceLink, AtomicLinkProgress, ErrorText;
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

/// Connects this device to an atomic.place account the way the other apps do:
/// the approval page opens in the browser, where every way of signing in
/// (emailed link, passkey, Google, ...) or creating the account is offered,
/// and the session that comes back is passed to [save]. The identity on this
/// device does not change.
///
/// Pops with true when linked.
class AccountLinkDialog extends StatefulWidget {
  const AccountLinkDialog(
      {super.key,
      required this.client,
      required this.save,
      this.deviceName = 'AtomicBuildings',
      this.open = _openInBrowser});

  final AtomicAccountClient client;
  final Future<void> Function(String session) save;
  final String deviceName;
  final Future<void> Function(Uri url) open;

  static Future<bool> show(BuildContext context,
          {required AtomicAccountClient client,
          required Future<void> Function(String session) save}) async =>
      await showDialog<bool>(
          context: context,
          barrierDismissible: false,
          builder: (_) => AccountLinkDialog(client: client, save: save)) ??
      false;

  @override
  State<AccountLinkDialog> createState() => _AccountLinkDialogState();
}

Future<void> _openInBrowser(Uri url) async {
  if (!await launchUrl(url, mode: LaunchMode.externalApplication)) {
    throw StateError('Could not open the browser');
  }
}

class _AccountLinkDialogState extends State<AccountLinkDialog> {
  AtomicDeviceLink? _request;
  String? _error;
  Timer? _timer;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void dispose() {
    _generation++;
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _start() async {
    _timer?.cancel();
    final generation = ++_generation;
    setState(() {
      _request = null;
      _error = null;
    });
    try {
      final request = await widget.client.requestLink(widget.deviceName);
      if (!mounted || generation != _generation) return;
      setState(() => _request = request);
      _timer = Timer(request.interval, () => _poll(request, generation));
      await _open(request);
    } catch (e) {
      _fail(e, generation);
    }
  }

  Future<void> _open(AtomicDeviceLink request) async {
    try {
      await widget.open(request.approvalUrl);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _poll(AtomicDeviceLink request, int generation) async {
    try {
      switch (await widget.client.pollLink(request)) {
        case AtomicLinkProgress.pending:
          if (mounted && generation == _generation) {
            _timer = Timer(request.interval, () => _poll(request, generation));
          }
        case AtomicLinkProgress.expired:
          _fail('This code expired. Try again to get a new one.', generation);
        case AtomicLinkProgress.approved:
          await widget.save(widget.client.exportSession());
          if (mounted && generation == _generation) {
            Navigator.pop(context, true);
          }
      }
    } catch (e) {
      _fail(e, generation);
    }
  }

  void _fail(Object error, int generation) {
    if (mounted && generation == _generation) {
      setState(() => _error = '$error');
    }
  }

  @override
  Widget build(BuildContext context) {
    final request = _request;
    return AlertDialog(
      title: const Text('Connect your account'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Sign in or create your account in the browser, then '
                'approve this device. Your houses stay on this device.'),
            const SizedBox(height: 16),
            if (request != null) ...[
              SelectableText(request.userCode,
                  key: const Key('link-code'),
                  style: Theme.of(context)
                      .textTheme
                      .headlineMedium
                      ?.copyWith(letterSpacing: 4)),
              const SizedBox(height: 12),
              const Row(children: [
                SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(strokeWidth: 2)),
                SizedBox(width: 8),
                Text('Waiting for approval...'),
              ]),
              TextButton(
                  onPressed: () => _open(request),
                  child: const Text('Open the browser again')),
            ] else if (_error == null)
              const LinearProgressIndicator(),
            if (_error != null) ...[
              const SizedBox(height: 12),
              ErrorText(_error!),
              TextButton(onPressed: _start, child: const Text('Try again')),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel')),
      ],
    );
  }
}
