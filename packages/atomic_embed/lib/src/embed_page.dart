import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;
import 'dart:math' show Random;

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

import 'call_permissions.dart';

/// What a screen needs of the embedded page: run a script in it, and show it.
abstract class EmbedPage {
  Future<void> runJavaScript(String script);
  Future<Object> runJavaScriptReturningResult(String script);
  Widget build();
}

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
