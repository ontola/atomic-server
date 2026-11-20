import 'dart:async';

import 'package:flutter/foundation.dart';

/// Tells the screens which resources changed in the store, as soon as they
/// change: an update the server sent over the sync session (a message added
/// to an AI chat in the browser, say) shows in the open page at once.
///
/// Before, only WebRTC peers named the subjects they changed. The server's
/// updates landed in the store silently, and an open page re-read just its
/// own resource every 20 s. An AI chat's messages live in ChatLog pages
/// under the chat, so they never showed until the chat was opened again.
///
/// Reads the store's events through [poll] (blocks until one arrives, null on
/// timeout) and hands the subjects to [onChanged] in batches, at most one
/// batch per [batchWindow]: a sync can change hundreds of resources at once.
class StoreChanges {
  StoreChanges({
    required this.poll,
    required this.onChanged,
    this.batchWindow = const Duration(milliseconds: 100),
  });

  final Future<Map<String, dynamic>?> Function() poll;
  final void Function(List<String> subjects) onChanged;
  final Duration batchWindow;

  final _pending = <String>{};
  Timer? _flush;
  bool _running = false;

  /// Starts reading events until [stop]. A second call does nothing.
  void start() {
    if (_running) return;
    _running = true;
    unawaited(_loop());
  }

  void stop() {
    _running = false;
    _flush?.cancel();
    _flush = null;
    _pending.clear();
  }

  Future<void> _loop() async {
    while (_running) {
      Map<String, dynamic>? event;
      try {
        event = await poll();
      } catch (e) {
        // No store yet (signing in) or it closed: try again shortly.
        debugPrint('[store] reading changes failed: $e');
        await Future<void>.delayed(const Duration(seconds: 2));
        continue;
      }
      if (event != null) add(event);
    }
  }

  /// One event of the store (`{kind, subject}`).
  @visibleForTesting
  void add(Map<String, dynamic> event) {
    final kind = event['kind'];
    final subject = event['subject'];
    if (kind != 'changed' && kind != 'destroyed') return;
    if (subject is! String || subject.isEmpty) return;
    _pending.add(subject);
    _flush ??= Timer(batchWindow, _send);
  }

  void _send() {
    _flush = null;
    if (_pending.isEmpty || !_running) return;
    final subjects = _pending.toList();
    _pending.clear();
    onChanged(subjects);
  }
}
