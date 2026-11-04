import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'embed_page.dart';
import 'embed_server.dart';

/// Answers one call of the page to the store: a method and its arguments (a
/// JSON array), as JSON. `AtomicStore.embedCall` of `atomic_store_flutter`.
typedef EmbedStoreCall = Future<String> Function(String method, String argsJson);

/// Calls of the page that ask the host app for something of its own (open a
/// native screen, start a call, follow someone). A plain document view has
/// none of that: they are answered without doing anything.
const embedHostOnlyMethods = {
  'openNative',
  'askAssistant',
  'joinCall',
  'meetingStarted',
  'meetingEnded',
  'presence',
  'follow',
  'unfollow',
  'sidebarIcons',
  'theme',
};

/// Messages of the page about its own drawing, which need no answer.
const _notices = {'menuState', 'gestures', 'header', 'revealed', 'painted'};

/// One resource (a document, a table, a folder) as the web app draws and
/// edits it, without the web app around it: the bundled renderer in a web
/// view, reading from and writing to this device's store through [call]. No
/// server and no sign-in: edits are signed by the store's agent and sync like
/// any other write of the app, so people on other devices see them live.
///
/// Edits still in the page are handed over when this view goes away (back,
/// the app paused); see [flushTimeout].
class AtomicDocumentView extends StatefulWidget {
  const AtomicDocumentView({
    super.key,
    required this.subject,
    required this.call,
    this.pageFactory,
  });

  /// The resource shown.
  final String subject;

  /// Where the page's store calls go.
  final EmbedStoreCall call;

  /// Makes the page for a URL. A test passes a fake that needs no web view.
  @visibleForTesting
  final Future<EmbedPage> Function(Uri url, void Function(String) onMessage)?
      pageFactory;

  /// How long leaving waits for the page to hand over its last edits.
  static Duration flushTimeout = const Duration(seconds: 2);

  @override
  State<AtomicDocumentView> createState() => AtomicDocumentViewState();
}

class AtomicDocumentViewState extends State<AtomicDocumentView>
    with WidgetsBindingObserver {
  EmbedPage? _page;
  Object? _error;
  int _flushes = 0;
  final _flushed = <int, Completer<void>>{};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _start());
  }

  Future<void> _start() async {
    try {
      final scheme =
          Theme.of(context).brightness == Brightness.dark ? 'dark' : 'light';
      final make = widget.pageFactory ??
          (url, onMessage) async {
            final server = await EmbedServer.instance();
            return WebViewEmbedPage.create(
                server.page.replace(queryParameters: {
                  'subject': widget.subject,
                  'scheme': scheme,
                  // Only this resource: no breadcrumbs, no way out of it.
                  'lock': '1',
                }),
                onMessage: onMessage,
                pollReady: true);
          };
      final page = await make(
          Uri(queryParameters: {
            'subject': widget.subject,
            'scheme': scheme,
            'lock': '1',
          }),
          _onMessage);
      if (!mounted) {
        if (page is ReleasablePage) (page as ReleasablePage).release();
        return;
      }
      setState(() => _page = page);
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused) unawaited(flush());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    final page = _page;
    // The page keeps answering (and is answered) until its edits are in.
    unawaited(flush(leaving: true).whenComplete(() {
      if (page is ReleasablePage) (page as ReleasablePage).release();
    }));
    super.dispose();
  }

  /// Asks the page to hand over every edit it still holds, and waits for its
  /// `flushed` answer, at most [AtomicDocumentView.flushTimeout].
  Future<void> flush({bool leaving = false}) {
    final page = _page;
    if (page == null) return Future.value();
    final id = ++_flushes;
    final done = Completer<void>();
    _flushed[id] = done;
    final reply = "AtomicFlutter.postMessage(JSON.stringify("
        "{method:'flushed',flush:$id}))";
    page
        .runJavaScript('Promise.resolve(window.atomicEmbed && '
            'window.atomicEmbed.flush && window.atomicEmbed.flush($leaving))'
            '.catch(function(){}).then(function(){$reply})')
        .catchError((_) {
      if (!done.isCompleted) done.complete();
    });
    return done.future
        .timeout(AtomicDocumentView.flushTimeout, onTimeout: () {})
        .whenComplete(() => _flushed.remove(id));
  }

  Future<void> _onMessage(String message) async {
    final request = jsonDecode(message) as Map<String, dynamic>;
    final method = request['method'];
    if (method == 'flushed') {
      final done = _flushed[request['flush']];
      if (done != null && !done.isCompleted) done.complete();
      return;
    }
    if (_notices.contains(method) || request['id'] is! int) return;
    final id = request['id'] as int;
    String reply;
    if (embedHostOnlyMethods.contains(method)) {
      reply = 'true,${jsonEncode('true')}';
    } else {
      final args = jsonEncode(request['args'] is List ? request['args'] : []);
      try {
        final answer = await widget.call('$method', args);
        reply = 'true,${jsonEncode(answer)}';
        // What the page reads and writes, to follow in logcat.
        if (kDebugMode) {
          debugPrint('[embed] $method(${_short(args)}) -> '
              '${answer.length} chars');
        }
      } catch (e) {
        debugPrint('[embed] $method(${_short(args)}) failed: $e');
        reply = 'false,${jsonEncode('$e')}';
      }
    }
    try {
      await _page?.runJavaScript('window.__atomicReply($id,$reply)');
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final error = _error;
    if (error != null) {
      return Center(
          child: Padding(
              padding: const EdgeInsets.all(24), child: Text('$error')));
    }
    final page = _page;
    if (page == null) return const Center(child: CircularProgressIndicator());
    return page.build();
  }
}

String _short(String s) => s.length <= 120 ? s : '${s.substring(0, 120)}…';
