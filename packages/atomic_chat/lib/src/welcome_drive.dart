import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'assistant_api.dart';
import 'resource_view.dart';
import 'warm_resource_web_view.dart';

/// The "Welcome to Atomic" drive built at the first run, and the document to
/// open in it.
class WelcomeDrive {
  const WelcomeDrive({required this.drive, required this.landing});

  final String drive;
  final String landing;
}

/// Builds the "Welcome to Atomic" drive for the identity that was just made.
///
/// The drive is the web app's own (`startWelcomeDrive`, from the hidden
/// `welcome` template): the embedded page runs it in a web view without a
/// screen and writes through [api] into this device's store, as an embedded
/// resource page does. One source of truth for the content; nothing of the
/// template lives in Dart.
///
/// Throws when the page cannot load, the build fails or [timeout] passes. The
/// caller starts the app anyway: the welcome drive is never a reason to block.
class WelcomeDriveBuilder {
  WelcomeDriveBuilder({required this.api, this.timeout});

  final AssistantApi api;

  /// How long the whole build may take; null for the default.
  final Duration? timeout;

  /// Makes the page for [url]. A test swaps it.
  @visibleForTesting
  static Future<WarmPage> Function(
      Uri url, void Function(String message) onMessage)? pageFactory;

  /// How long a build may take before the app starts without it.
  static const defaultTimeout = Duration(seconds: 60);

  Future<WelcomeDrive> build(String personalDrive) async {
    final limit = timeout ?? defaultTimeout;
    final done = Completer<WelcomeDrive>();
    WarmPage? page;

    void onMessage(String message) {
      if (message.contains('"welcomeResult"')) {
        final result = _parseResult(message);
        if (result != null && !done.isCompleted) {
          if (result is WelcomeDrive) {
            done.complete(result);
          } else {
            done.completeError(StateError('$result'));
          }
        }
        return;
      }
      final target = page;
      if (target != null) unawaited(_answer(target, message));
    }

    try {
      final factory = pageFactory;
      final Uri url;
      if (factory == null) {
        final server = await ResourceView.serverFactory();
        url = server.page.replace(queryParameters: {'welcome': '1'});
      } else {
        url = Uri(path: '/embed.html', queryParameters: {'welcome': '1'});
      }
      page = factory != null
          ? await factory(url, onMessage)
          : await WebViewEmbedPage.create(url,
              onMessage: onMessage, pollReady: true);
      // Not `done.future.timeout` alone: a page that never boots must also
      // fail, and its `whenReady` completes with the load error.
      await page.whenReady.timeout(limit);
      await page.runJavaScript(
          'window.atomicEmbed.startWelcome(1,${jsonEncode(personalDrive)})');
      return await done.future.timeout(limit);
    } finally {
      page?.release();
    }
  }

  /// `{method:'welcomeResult', ok, payload}`: the drive, or the error text.
  static Object? _parseResult(String message) {
    final Object? json;
    try {
      json = jsonDecode(message);
    } catch (_) {
      return null;
    }
    if (json is! Map || json['method'] != 'welcomeResult') return null;
    final payload = json['payload'];
    if (json['ok'] != true) return '$payload';
    try {
      final data = jsonDecode('$payload');
      if (data is Map &&
          data['drive'] is String &&
          data['landing'] is String &&
          (data['drive'] as String).isNotEmpty &&
          (data['landing'] as String).isNotEmpty) {
        return WelcomeDrive(
            drive: data['drive'] as String, landing: data['landing'] as String);
      }
    } catch (_) {}
    return 'The welcome drive came back without a document to open';
  }

  /// A call of the page to the store: read or written through [api]. Nothing
  /// is shown or opened, so the page's reports are acknowledged.
  Future<void> _answer(WarmPage page, String message) async {
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
      final answer = const {
        'opened',
        'theme',
        'sidebarIcons',
        'openNative',
        'askAssistant',
      }.contains(method)
          ? 'false'
          : await api.embedCall(
              method, jsonEncode(request['args'] ?? const []));
      reply = 'true,${jsonEncode(answer)}';
    } catch (e) {
      reply = 'false,${jsonEncode('$e')}';
    }
    try {
      await page.runJavaScript('window.__atomicReply($id,$reply)');
    } catch (_) {}
  }
}
