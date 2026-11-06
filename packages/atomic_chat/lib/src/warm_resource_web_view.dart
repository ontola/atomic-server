import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:atomic_embed/atomic_embed.dart';
import 'package:atomic_flutter/atomic_flutter.dart' show Perf;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import 'assistant_api.dart';
import 'resource_view.dart';
import 'app_sidebar_icons.dart';
import 'app_theme.dart';

/// Keeps one embedded page loaded and hidden (booted, Loro compiled), so
/// opening a resource is a `show(subject)` instead of a 13 MB page load.
///
/// Once ready the spare is also in the widget tree ([WarmPageSlot], under the
/// shell's pages, at the size a resource page gives it, not painted): its
/// Android view is attached to the window and laid out before the tap, so
/// taking it costs no attach (about 450 ms of the main thread on the
/// emulator) and no resize. It notifies its listeners when that changes.
///
/// - [warmUp] starts the spare (once; a second call does nothing).
/// - [take] hands it over when it is ready and starts the next one, so there
///   is always one spare and never more than one (memory). A page that is not
///   ready yet is left alone and [take] returns null: the caller opens cold.
/// - The spare is dropped when the app has been in the background for
///   [backgroundGrace] and warmed again on return.
///
/// Until it is taken the pool answers the page's own calls (the agent, the
/// store's init) from [api].
class WarmResourceWebView with WidgetsBindingObserver, ChangeNotifier {
  WarmResourceWebView({
    required this.api,
    WarmPageBuilder? builder,
    this.rewarmDelay = const Duration(milliseconds: 600),
    this.backgroundGrace = const Duration(minutes: 5),
  }) : _customBuilder = builder {
    WidgetsBinding.instance.addObserver(this);
  }

  /// The pool for this device, or null where there is no web view the app
  /// can warm (tests on the host, desktop).
  static WarmResourceWebView? forPlatform(AssistantApi api) =>
      !kIsWeb && (Platform.isAndroid || Platform.isIOS)
          ? WarmResourceWebView(api: api)
          : null;

  final AssistantApi api;
  final WarmPageBuilder? _customBuilder;

  /// Wait before the next spare starts loading after one was taken, so the
  /// open animation of the resource is not competing with a 13 MB load.
  final Duration rewarmDelay;

  /// How long the app may stay in the background before the spare goes.
  final Duration backgroundGrace;

  WarmPage? _warm;
  bool _starting = false;
  bool _disposed = false;
  int _generation = 0;
  Timer? _rewarm;
  Timer? _trim;

  /// Spares started over the pool's life, and failures (for tests and logs).
  int started = 0;
  int failures = 0;

  /// The resource most likely opened next (the latest of Recents). A ready
  /// spare renders it once while nobody looks, then goes blank again: the
  /// page's code has then run once (a page's first render of a document
  /// took two to three times its next), and that resource is in its store.
  Future<String?> Function()? showAhead;

  /// What a spare rendered ahead, by page ([showAhead]). Whoever takes the
  /// page reloads it before showing anything: it may have changed since.
  static final shownAhead = Expando<String>('shownAhead');

  /// A spare exists (loading or ready).
  bool get hasSpare => _warm != null || _starting;

  /// The spare is loaded and can be taken.
  bool get isReady => _warm?.isReady ?? false;

  /// The ready spare, for [WarmPageSlot] to keep in the tree; null when there
  /// is none, it is still loading, or it was taken.
  WarmPage? get attached => isReady ? _warm : null;

  /// The app's light or dark mode (`light`/`dark`), set by the shell: a new
  /// spare paints its first frame in it (`?scheme=`) and a spare is told when
  /// it changes, so a taken page never flashes the other one.
  String? get colorScheme => _scheme;
  String? _scheme;
  set colorScheme(String? scheme) {
    if (scheme == _scheme) return;
    _scheme = scheme;
    final page = _warm;
    if (page != null && page.isReady) unawaited(_tellScheme(page));
  }

  Future<void> _tellScheme(WarmPage page) async {
    final scheme = _scheme;
    if (scheme == null) return;
    try {
      await page
          .runJavaScript("window.atomicEmbed?.setColorScheme?.('$scheme')");
    } catch (_) {}
  }

  Future<WarmPage> _build(void Function(String message) onMessage) async {
    final custom = _customBuilder;
    if (custom != null) return custom(onMessage);
    final server = await ResourceView.serverFactory();
    final scheme = _scheme;
    return WebViewEmbedPage.create(
        server.page.replace(queryParameters: {
          if (scheme != null) 'scheme': scheme,
          'sidebarIcons': AppSidebarIcons.queryValue,
        }),
        onMessage: onMessage,
        pollReady: true);
  }

  /// Tells [WarmPageSlot] the spare changed. Never while the tree builds (a
  /// page takes the spare in its `initState`): then after that frame.
  void _changed() {
    if (_disposed) return;
    if (SchedulerBinding.instance.schedulerPhase ==
        SchedulerPhase.persistentCallbacks) {
      SchedulerBinding.instance.addPostFrameCallback((_) {
        if (!_disposed) notifyListeners();
      });
    } else {
      notifyListeners();
    }
  }

  /// Starts loading the spare, unless there is one.
  void warmUp() {
    if (_disposed || hasSpare) return;
    _starting = true;
    final generation = ++_generation;
    started++;
    final clock = Stopwatch()..start();
    unawaited(() async {
      WarmPage? page;
      try {
        page = await _build((m) => _answer(page, m));
        if (_disposed || generation != _generation) {
          page.release();
          return;
        }
        _warm = page;
        _starting = false;
        await page.whenReady;
        debugPrint('[warm] spare ready after ${clock.elapsedMilliseconds} ms');
        Perf.once('warm ready');
        if (_disposed || !identical(_warm, page)) return;
        // Into the tree (attached, laid out), in the app's colours.
        _changed();
        await _tellScheme(page);
        await _showAhead(page, generation);
      } catch (e) {
        failures++;
        debugPrint('[warm] spare failed: $e');
        if (generation == _generation) {
          _starting = false;
          if (identical(_warm, page)) {
            _warm = null;
            _changed();
          }
        }
        page?.release();
      }
    }());
  }

  Future<void> _showAhead(WarmPage page, int generation) async {
    final ahead = showAhead;
    if (ahead == null) return;
    String? subject;
    try {
      subject = await ahead();
    } catch (_) {}
    if (subject == null ||
        subject.isEmpty ||
        _disposed ||
        generation != _generation ||
        !identical(_warm, page)) {
      return;
    }
    shownAhead[page] = subject;
    // Rendered, then left for a blank page again: a page attached to the
    // screen paints only what changes, so it must not already show the
    // resource it is asked for (it stayed black).
    try {
      await page.runJavaScript('(function(e){if(!e)return;'
          'e.show(${jsonEncode(subject)});var t=Date.now();(function c(){'
          'var m=document.querySelector("main");'
          'if((m&&m.innerText.trim())||Date.now()-t>8000){'
          'setTimeout(function(){e.show("")},300);return}'
          'setTimeout(c,50)})()})(window.atomicEmbed)');
    } catch (_) {}
  }

  /// The ready spare, now owned by the caller (it must [ReleasablePage.release]
  /// it), or null when there is none or it is not ready: open cold then.
  /// Starts the next spare.
  WarmPage? take() {
    final page = _warm;
    if (_disposed || page == null || !page.isReady) {
      debugPrint('[warm] not ready (spare: ${page != null}), opening cold');
      return null;
    }
    _warm = null;
    _generation++;
    // The taker builds the page in this frame; the slot lets go of it (and
    // learns of the next spare) after it.
    _changed();
    _scheduleRewarm();
    return page;
  }

  /// Takes back a page whose view closed, as the spare, instead of the
  /// caller destroying it: the next open then finds a ready page even when
  /// the spare taken before it is still loading. Returns false when the page
  /// is not accepted (the caller releases it): it is not ready, the pool is
  /// gone, or a ready spare exists already (never more than one, memory).
  /// [subject] is what the page showed, which the taker reloads.
  ///
  /// The caller's widget has let go of the page by now (its view is
  /// disposed), so it moves into the slot after this frame, the way
  /// [take] hands it over in reverse. The web view is attached again there:
  /// that costs the attach, not a page load.
  bool giveBack(WarmPage page, {String? subject}) {
    if (_disposed || !page.isReady) return false;
    if (isReady) {
      debugPrint('[warm] page given back, spare already ready: released');
      return false;
    }
    // A spare still loading (or being made) loses to one that is ready now.
    _generation++;
    _starting = false;
    _rewarm?.cancel();
    _warm?.release();
    // The calls below reach the page in this order, before any taker's.
    page.onMessage = (m) => _answer(page, m);
    page.onLoaded = null;
    shownAhead[page] = subject;
    unawaited(page
        .runJavaScript('(function(e){if(e)e.show("")})(window.atomicEmbed)'));
    unawaited(_tellScheme(page));
    _warm = page;
    debugPrint('[warm] page given back as the spare');
    _changed();
    return true;
  }

  void _scheduleRewarm() {
    _rewarm?.cancel();
    if (rewarmDelay == Duration.zero) {
      warmUp();
    } else {
      _rewarm = Timer(rewarmDelay, warmUp);
    }
  }

  /// The read of a resource started when a finger went down on its row
  /// ([prefetch]), for the page that opens it ([takePrefetched]).
  ({String subject, Future<String> answer, Stopwatch age})? _prefetched;

  /// How long a [prefetch]ed read may be used: a tap opens its page well
  /// within it; a finger that stayed down longer reads again.
  static const prefetchFresh = Duration(milliseconds: 1500);

  static const _read = 'getResourcesWithSnapshots';

  /// Starts reading [subject] the way an opening page asks for it
  /// (`getResourcesWithSnapshots`), as a finger goes down on its row: the
  /// read then runs while the finger lifts and the page slides in, and the
  /// page's call for it is answered at once.
  void prefetch(String subject) {
    if (_disposed || subject.isEmpty) return;
    final last = _prefetched;
    if (last != null &&
        last.subject == subject &&
        last.age.elapsedMilliseconds < 300) {
      return;
    }
    final answer = api.embedCall(
        _read,
        jsonEncode([
          [subject]
        ]));
    // Nobody may take it; a failure is then nobody's.
    answer.ignore();
    _prefetched = (subject: subject, answer: answer, age: Stopwatch()..start());
  }

  /// The answer to the page's call [method] with [argsJson] when it reads
  /// the [prefetch]ed resource (alone or with others, which are read now),
  /// once and while fresh; null otherwise: the caller reads itself.
  Future<String>? takePrefetched(String method, String argsJson) {
    final p = _prefetched;
    if (p == null || method != _read) return null;
    if (!argsJson.contains(jsonEncode(p.subject))) {
      if (!kReleaseMode) {
        final shown =
            argsJson.length > 160 ? argsJson.substring(0, 160) : argsJson;
        debugPrint('[warm] read of $shown, not the prefetched ${p.subject}');
      }
      return null;
    }
    final List<Object?> subjects;
    try {
      final args = jsonDecode(argsJson);
      subjects = (args as List).first as List<Object?>;
    } catch (_) {
      return null;
    }
    final at = subjects.indexOf(p.subject);
    if (at < 0) return null;
    _prefetched = null;
    if (p.age.elapsed > prefetchFresh) return null;
    if (subjects.length == 1) return p.answer;
    return () async {
      try {
        final others = List<Object?>.of(subjects)..removeAt(at);
        final both = await Future.wait([
          p.answer,
          api.embedCall(method, jsonEncode([others])),
        ]);
        // The prefetched row stays text (it can be large); the others are
        // decoded to put it in its place.
        final one = both[0].trim();
        final rows = [
          for (final r in jsonDecode(both[1]) as List) jsonEncode(r),
        ]..insert(at, one.substring(1, one.length - 1).trim());
        return '[${rows.join(',')}]';
      } catch (_) {
        return api.embedCall(method, argsJson);
      }
    }();
  }

  /// Drops the spare (the app left, or memory is short).
  void release() {
    _rewarm?.cancel();
    _generation++;
    _starting = false;
    final page = _warm;
    _warm = null;
    if (page != null) {
      page.release();
      _changed();
    }
  }

  @override
  void dispose() {
    if (_disposed) return;
    _trim?.cancel();
    release();
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      _trim ??= Timer(backgroundGrace, () {
        _trim = null;
        debugPrint('[warm] long in the background, dropping the spare');
        release();
      });
    } else if (state == AppLifecycleState.resumed) {
      _trim?.cancel();
      _trim = null;
      warmUp();
    }
  }

  @override
  void didHaveMemoryPressure() {
    if (!_disposed) release();
  }

  /// A call from the spare while nobody holds it: read through the API like
  /// a screen would; edits cannot happen on a page nobody sees.
  Future<void> _answer(WarmPage? page, String message) async {
    if (page == null) return;
    final Map<String, dynamic> request;
    try {
      request = jsonDecode(message) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    final id = request['id'];
    final method = request['method'];
    if (id is! int || method is! String) return;
    String reply;
    try {
      final args = request['args'];
      // A resource rendered ahead was not opened: not one for Recents.
      if (method == 'opened') {
        await page.runJavaScript('window.__atomicReply($id,true,null)');
        return;
      }
      // A hidden spare opens no native screen over nobody: false makes the
      // page draw the resource itself, if it ever asks. (Nor does it start a
      // call: false hides the page's call button, and no chat: false makes
      // "Fix it" fall back to the page's own handling.)
      if (method == 'openNative' ||
          method == 'joinCall' ||
          method == 'askAssistant') {
        await page.runJavaScript(
            'window.__atomicReply($id,true,${jsonEncode('false')})');
        return;
      }
      // The page reports the saved theme as it boots, before anyone holds it.
      final icons =
          method == 'sidebarIcons' ? AppSidebarIcons.parse(args) : null;
      final answer = icons != null
          ? await AppSidebarIcons.choose(icons).then((_) => 'true')
          : method == 'theme'
              ? await AppThemeMode.choose(
                      args is List && args.isNotEmpty ? '${args.first}' : '')
                  .then((_) => 'true')
              : await api.embedCall(method, jsonEncode(args ?? const []));
      reply = 'true,${jsonEncode(answer)}';
    } catch (e) {
      reply = 'false,${jsonEncode('$e')}';
    }
    try {
      await page.runJavaScript('window.__atomicReply($id,$reply)');
    } catch (_) {}
  }
}

/// Where the pool's ready spare lives until a page takes it: in the tree,
/// laid out where and as large as a resource page shows it (under the status
/// bar, above the keyboard), not painted, not touchable, not read out. The
/// shell puts it under its pages, filling the same box as its navigator.
///
/// Not painted is not gone: the platform view is created by layout, so its
/// Android view is attached and keeps drawing into its texture, and the page
/// that takes it paints that texture in its first frame. (On Android the
/// web view is a texture layer: opacity 0 only leaves the layer out.)
class WarmPageSlot extends StatelessWidget {
  final WarmResourceWebView pool;

  const WarmPageSlot({super.key, required this.pool});

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: pool,
        builder: (context, _) {
          final page = pool.attached;
          if (page == null) return const SizedBox.shrink();
          return IgnorePointer(
            child: ExcludeSemantics(
              child: Opacity(
                opacity: 0,
                child: Padding(
                  // A resource page's Scaffold ends above the keyboard.
                  padding: EdgeInsets.only(
                      bottom: MediaQuery.viewInsetsOf(context).bottom),
                  child: SafeArea(bottom: false, child: page.build()),
                ),
              ),
            ),
          );
        },
      );
}
