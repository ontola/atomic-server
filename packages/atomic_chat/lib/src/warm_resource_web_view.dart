import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;
import 'dart:math' show Random;

import 'package:atomic_flutter/atomic_flutter.dart' show Perf;
import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

import 'assistant_api.dart';
import 'call_permissions.dart';
import 'resource_view.dart';
import 'app_sidebar_icons.dart';
import 'app_theme.dart';

/// A page that can be released once nobody needs it any more (its web view
/// dropped). Cold pages and warm pages are both released.
abstract interface class ReleasablePage {
  void release();
}

/// An embedded page that is loaded without a screen: whoever takes it
/// becomes the one the page's messages go to.
///
/// Its [build] gives the same [GlobalKey]ed subtree every time, so the web
/// view moves from the pool's hidden slot ([WarmPageSlot]) to the page that
/// takes it without being made again.
abstract class WarmPage implements EmbedPage, ReleasablePage {
  /// True once the page said it is up (`window.atomicEmbed` exists).
  bool get isReady;

  /// Completes when [isReady]; completes with an error when the load fails.
  Future<void> get whenReady;

  /// Where the page's calls go. Set by whoever holds the page.
  set onMessage(void Function(String message)? handler);

  /// Called each time the page finished loading.
  set onLoaded(VoidCallback? handler);
}

/// A fresh secret for one web view's channel: 128 random bits, in hex.
String newChannelToken([Random? random]) {
  final r = random ?? Random.secure();
  return [
    for (var i = 0; i < 16; i++)
      r.nextInt(256).toRadixString(16).padLeft(2, '0')
  ].join();
}

/// [url] with `ch=[token]` in its fragment (next to anything already there).
/// The page reads it once and removes it (`lockFlutterChannel`).
Uri withChannelToken(Uri url, String token) => url.replace(
    fragment: url.fragment.isEmpty ? 'ch=$token' : '${url.fragment}&ch=$token');

/// True when [raw] comes from the page that was given [expected]: its
/// messages are JSON objects that start with `"token"`. Android hands the
/// channel to every frame of the web view, so an embedded app's frame can
/// post to it too, but it was never given the token.
bool acceptsChannelMessage(String expected, String raw) =>
    expected.isNotEmpty && raw.startsWith('{"token":${jsonEncode(expected)},');

/// The page's own "I am up" (`{"method":"ready"}`) as [acceptsChannelMessage]
/// accepts it.
String channelReadyMessage(String token) =>
    '{"token":${jsonEncode(token)},"method":"ready"}';

/// Makes a [WarmPage] that sends its messages to [onMessage] from the start
/// (the page asks the store for the agent while it boots).
typedef WarmPageBuilder = Future<WarmPage> Function(
    void Function(String message) onMessage);

/// The embedded renderer in a real web view. [create] starts the load; the
/// cold path of a [ResourceView] and the [WarmResourceWebView] both use it.
class WebViewEmbedPage implements WarmPage {
  WebViewEmbedPage._(this.controller);

  final WebViewController controller;

  /// Keeps the web view's platform view (its Android view, attached to the
  /// window, and its texture) when [build] moves from the pool's hidden slot
  /// to the page that takes it: Flutter moves a [GlobalKey]'s subtree
  /// instead of making it again.
  final _hostKey = GlobalKey(debugLabel: 'embed page');
  final _ready = Completer<void>();

  /// What the page shows full screen (Android hands the web view's own
  /// fullscreen view to the host); null when it is not. [FullscreenHost]
  /// puts it over the app.
  final fullscreen = ValueNotifier<Widget?>(null);
  VoidCallback? _onHidden;
  final _created = Stopwatch()..start();
  void Function(String message)? _onMessage;
  VoidCallback? _onLoaded;
  bool _released = false;

  @override
  set onMessage(void Function(String message)? handler) => _onMessage = handler;

  @override
  set onLoaded(VoidCallback? handler) => _onLoaded = handler;

  @override
  bool get isReady => _ready.isCompleted && !_released;

  @override
  Future<void> get whenReady => _ready.future;

  /// Milliseconds since the load started.
  int get age => _created.elapsedMilliseconds;

  /// Loads [url] (the bundled page) into a new web view. Only pages of
  /// [url]'s own origin are ever shown in it. With [mediaPermissions] the
  /// page may ask for the microphone and camera (the call page).
  static Future<WebViewEmbedPage> create(
    Uri url, {
    void Function(String message)? onMessage,
    VoidCallback? onLoaded,
    bool pollReady = false,
    CallPermissions? mediaPermissions,
  }) async {
    late final WebViewEmbedPage page;
    final origin = url.origin;
    final token = newChannelToken();
    // Only the call page gets a microphone and camera (and, on iOS, plays
    // video inline and without a tap).
    final media = mediaPermissions;
    final controller = (media == null
        ? WebViewController()
        : WebViewController.fromPlatformCreationParams(
            Platform.isIOS || Platform.isMacOS
                ? WebKitWebViewControllerCreationParams(
                    allowsInlineMediaPlayback: true,
                    mediaTypesRequiringUserAction: const {},
                  )
                : const PlatformWebViewControllerCreationParams(),
            onPermissionRequest: (request) => answerPermissionRequest(
              types: request.types,
              grant: request.grant,
              deny: request.deny,
              permissions: media,
            ),
          ))
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel('AtomicFlutter', onMessageReceived: (m) {
        // Not from the page: a frame in it (an app) has no token.
        if (!acceptsChannelMessage(token, m.message)) return;
        // The page's own "I am up" is not a call.
        if (m.message == channelReadyMessage(token)) {
          page._markReady();
          return;
        }
        page._onMessage?.call(m.message);
      })
      ..setOnConsoleMessage((m) => debugPrint('[embed:js] ${m.message}'))
      ..setNavigationDelegate(NavigationDelegate(
        onNavigationRequest: (request) {
          // Frames in the page (an app's sandboxed srcdoc) stay inline.
          if (!request.isMainFrame) {
            return request.url == 'about:srcdoc' || request.url == 'about:blank'
                ? NavigationDecision.navigate
                : NavigationDecision.prevent;
          }
          return request.url.startsWith(origin)
              ? NavigationDecision.navigate
              : NavigationDecision.prevent;
        },
        onPageFinished: (_) {
          debugPrint('[embed] page loaded after ${page.age} ms');
          page._onLoaded?.call();
          if (pollReady) unawaited(page._pollReady());
        },
        onWebResourceError: (e) {
          if (e.isForMainFrame ?? true) page._fail(e.description);
        },
      ));
    // macOS' WKWebView has no opaque setting and throws for a background
    // color, which surfaced as "opaque is not implemented on macOS".
    if (!Platform.isMacOS) {
      unawaited(controller.setBackgroundColor(Colors.transparent));
    }
    page = WebViewEmbedPage._(controller)
      .._onMessage = onMessage
      .._onLoaded = onLoaded;
    // Debug and profile builds can be inspected from chrome://inspect (the
    // perf script drives and times the page through it).
    if (!kReleaseMode && controller.platform is AndroidWebViewController) {
      await AndroidWebViewController.enableDebugging(true);
    }
    // Android's WebView only shows HTML fullscreen (an app's
    // `requestFullscreen()`) when the host brings the view up itself.
    final platform = controller.platform;
    if (platform is AndroidWebViewController) {
      unawaited(platform.setCustomWidgetCallbacks(
        onShowCustomWidget: (widget, onHidden) {
          page._onHidden = onHidden;
          page.fullscreen.value = widget;
        },
        onHideCustomWidget: () {
          page._onHidden = null;
          page.fullscreen.value = null;
        },
      ));
    }
    unawaited(controller.loadRequest(withChannelToken(url, token)));
    return page;
  }

  void _markReady() {
    if (!_ready.isCompleted) _ready.complete();
  }

  void _fail(Object error) {
    if (!_ready.isCompleted) {
      _ready.future.ignore();
      _ready.completeError(error);
    }
  }

  /// A bundle without the `ready` message: look for `window.atomicEmbed`.
  Future<void> _pollReady() async {
    for (var i = 0; i < 100 && !_ready.isCompleted && !_released; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 200));
      try {
        final r = await controller
            .runJavaScriptReturningResult("typeof window.atomicEmbed");
        if ('$r'.contains('object')) {
          _markReady();
          return;
        }
      } catch (_) {}
    }
  }

  @override
  Future<void> runJavaScript(String script) => controller.runJavaScript(script);

  @override
  Future<Object> runJavaScriptReturningResult(String script) =>
      controller.runJavaScriptReturningResult(script);

  // The page owns every touch on it (scrolling a long menu or document must
  // not be taken over by the swipe back when a finger drifts sideways).
  @override
  Widget build() => KeyedSubtree(
        key: _hostKey,
        child: FullscreenHost(
          fullscreen: fullscreen,
          onExit: () => _onHidden?.call(),
          child: WebViewWidget(
            controller: controller,
            gestureRecognizers: const {
              Factory<OneSequenceGestureRecognizer>(EagerGestureRecognizer.new),
            },
          ),
        ),
      );

  @override
  void release() {
    if (_released) return;
    _released = true;
    _onMessage = null;
    _onLoaded = null;
    _onHidden = null;
    fullscreen.value = null;
    _fail('released');
    // webview_flutter has no dispose: leave the page empty so its memory
    // (the store, the WASM) can go.
    unawaited(controller
        .setNavigationDelegate(NavigationDelegate())
        .then((_) => controller.loadHtmlString(''))
        .catchError((_) {}));
  }
}

/// Shows [child], and whatever [fullscreen] holds on a black route over the
/// whole app (root navigator, immersive). Back calls [onExit] (the page's
/// `onHidden`); when [fullscreen] goes null again (the page left fullscreen
/// itself) the route is closed without it.
class FullscreenHost extends StatefulWidget {
  const FullscreenHost({
    super.key,
    required this.fullscreen,
    required this.onExit,
    required this.child,
  });

  final ValueListenable<Widget?> fullscreen;
  final VoidCallback onExit;
  final Widget child;

  @override
  State<FullscreenHost> createState() => _FullscreenHostState();
}

class _FullscreenHostState extends State<FullscreenHost> {
  Route<void>? _route;
  NavigatorState? _navigator;

  @override
  void initState() {
    super.initState();
    widget.fullscreen.addListener(_changed);
  }

  @override
  void didUpdateWidget(FullscreenHost old) {
    super.didUpdateWidget(old);
    if (old.fullscreen != widget.fullscreen) {
      old.fullscreen.removeListener(_changed);
      widget.fullscreen.addListener(_changed);
    }
  }

  @override
  void dispose() {
    widget.fullscreen.removeListener(_changed);
    _close();
    super.dispose();
  }

  void _changed() {
    if (widget.fullscreen.value == null) {
      _close();
    } else if (_route == null && mounted) {
      _open();
    }
  }

  void _open() {
    final navigator = Navigator.of(context, rootNavigator: true);
    final route = PageRouteBuilder<void>(
      pageBuilder: (_, __, ___) => Scaffold(
        backgroundColor: Colors.black,
        body: ValueListenableBuilder<Widget?>(
          valueListenable: widget.fullscreen,
          builder: (_, view, __) => view ?? const SizedBox.shrink(),
        ),
      ),
    );
    _navigator = navigator;
    _route = route;
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    unawaited(navigator.push(route).then((_) {
      SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
      // Popped by back, not by the page leaving fullscreen: tell the page.
      if (identical(_route, route)) {
        _route = null;
        widget.onExit();
      }
    }));
  }

  void _close() {
    final route = _route;
    if (route == null) return;
    _route = null;
    if (route.isActive) _navigator?.removeRoute(route);
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

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
      // call: false hides the page's call button.)
      if (method == 'openNative' || method == 'joinCall') {
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
