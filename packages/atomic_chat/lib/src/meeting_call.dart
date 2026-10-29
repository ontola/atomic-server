import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart' show Offset;
import 'package:flutter/services.dart';

import 'assistant_api.dart';
import 'call_permissions.dart';
import 'resource_view.dart';
import 'warm_resource_web_view.dart';

/// The audio/video call of a meeting, in a web view of its own.
///
/// The call is the web app's `ConferenceRoom` (WebRTC over public signaling
/// relays; one implementation), loaded as the embed's call page
/// (`embed.html?call=<meeting>`). It is not one of the resource pages: those
/// are replaced when the app follows a leader and recycled by the warm pool,
/// which would hang up. The shell owns one [MeetingCall]; whoever has a
/// resource page open asks it to [start] (the page's `joinCall`), and
/// [MeetingCallOverlay] shows the call as a floating tile over every screen.
class MeetingCall extends ChangeNotifier {
  MeetingCall({
    required this.api,
    this.permissions = const SystemCallPermissions(),
  });

  final AssistantApi api;

  /// The device's microphone and camera, asked for when the page wants them.
  final CallPermissions permissions;

  /// Makes the call page for [url]. A test swaps in a page that needs no web
  /// view.
  @visibleForTesting
  static Future<WarmPage> Function(
      Uri url, void Function(String message) onMessage)? pageFactory;

  String? _meeting;
  WarmPage? _page;
  bool _expanded = false;
  int _generation = 0;
  Object? _error;

  /// Where the person dragged the small tile (its top left corner); null: the
  /// default corner.
  Offset? tileOffset;

  /// The meeting being called; null when there is no call.
  String? get meeting => _meeting;

  bool get active => _meeting != null;

  /// The call page; null while it loads or when there is no call.
  WarmPage? get page => _page;

  /// The whole screen instead of the small tile.
  bool get expanded => _expanded;

  /// Why the page could not be loaded; the call is over then.
  Object? get error => _error;

  /// Starts the call of [meeting] (showing it expanded), or shows it when it
  /// is already on. Another meeting's call is ended first. [scheme] is the
  /// app's `light` or `dark`, for the page's first paint. Completes when the
  /// page is loading.
  Future<void> start(String meeting, {String scheme = 'light'}) async {
    if (meeting.isEmpty) return;
    if (_meeting == meeting) {
      expand();
      return;
    }
    if (active) leave();
    final generation = ++_generation;
    _meeting = meeting;
    _expanded = true;
    _error = null;
    notifyListeners();
    try {
      final params = {'call': meeting, 'scheme': scheme};
      final factory = pageFactory;
      // The page asks the store for the agent while it boots; its answers go
      // back to it.
      WarmPage? booting;
      void onMessage(String m) => _onMessage(generation, booting, m);
      final WarmPage page;
      if (factory == null) {
        final server = await ResourceView.serverFactory();
        if (generation != _generation) return;
        page = await WebViewEmbedPage.create(
          server.page.replace(queryParameters: params),
          onMessage: onMessage,
          pollReady: true,
          mediaPermissions: permissions,
        );
      } else {
        page = await factory(
            Uri(path: '/embed.html', queryParameters: params), onMessage);
      }
      booting = page;
      if (generation != _generation) {
        page.release();
        return;
      }
      _page = page;
      notifyListeners();
    } catch (e) {
      debugPrint('[call] could not start: $e');
      if (generation == _generation) {
        leave();
        _error = e;
        notifyListeners();
      }
    }
  }

  /// Ends the call and drops its page (its tracks stop with it).
  void leave() {
    if (!active) return;
    _generation++;
    final page = _page;
    _page = null;
    _meeting = null;
    _expanded = false;
    notifyListeners();
    page?.release();
  }

  void expand() => _setExpanded(true);

  void collapse() => _setExpanded(false);

  void _setExpanded(bool expanded) {
    if (!active || _expanded == expanded) return;
    _expanded = expanded;
    notifyListeners();
  }

  bool _immersive = false;

  /// The expanded call covers the whole screen, status bar included, as a
  /// page's own fullscreen does.
  @override
  void notifyListeners() {
    final immersive = active && _expanded;
    if (immersive != _immersive) {
      _immersive = immersive;
      SystemChrome.setEnabledSystemUIMode(
          immersive ? SystemUiMode.immersiveSticky : SystemUiMode.edgeToEdge);
    }
    super.notifyListeners();
  }

  void moveTile(Offset offset) {
    tileOffset = offset;
    notifyListeners();
  }

  /// Calls the page makes that are not the store's: acknowledged without
  /// doing anything (this page shows no resource and has no presence).
  static const _acknowledged = {
    'opened',
    'theme',
    'sidebarIcons',
    'openNative',
    'presence',
    'follow',
    'unfollow',
    'joinCall',
  };

  /// A call of the page: the store's reads and writes go through [api]; its
  /// Leave button ends the call.
  Future<void> _onMessage(
      int generation, WarmPage? page, String message) async {
    if (generation != _generation) return;
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
    if (method == 'leaveCall') {
      reply = 'true,${jsonEncode('true')}';
      leave();
    } else {
      try {
        final answer = _acknowledged.contains(method)
            ? 'false'
            : await api.embedCall(
                method, jsonEncode(request['args'] ?? const []));
        reply = 'true,${jsonEncode(answer)}';
      } catch (e) {
        reply = 'false,${jsonEncode('$e')}';
      }
    }
    try {
      await page?.runJavaScript('window.__atomicReply($id,$reply)');
    } catch (_) {}
  }

  @override
  void dispose() {
    _generation++;
    _page?.release();
    _page = null;
    _meeting = null;
    if (_immersive) {
      SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    }
    super.dispose();
  }
}
