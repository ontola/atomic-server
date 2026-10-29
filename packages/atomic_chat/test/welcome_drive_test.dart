import 'dart:async';
import 'dart:convert';

import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import 'unimplemented_api.dart';

void main() {
  tearDown(() => WelcomeDriveBuilder.pageFactory = null);

  test(
      'runs the web page\'s startWelcome for the personal drive and returns '
      'the drive and the document to open', () async {
    final api = _StoreApi();
    late _WelcomePage page;
    Uri? loaded;
    WelcomeDriveBuilder.pageFactory = (url, onMessage) async {
      loaded = url;
      return page = _WelcomePage(onMessage);
    };

    final result = await WelcomeDriveBuilder(api: api).build('did:ad:personal');

    expect(result.drive, 'did:ad:welcome');
    expect(result.landing, 'did:ad:welcome-doc');
    expect(loaded!.queryParameters, {'welcome': '1'});
    expect(page.started, [(1, 'did:ad:personal')]);
    // The page read the store while it built; the app answered.
    expect(api.calls, [('getResource', '["did:ad:personal"]')]);
    expect(page.replies, ['window.__atomicReply(7,true,"{\\"x\\":1}")']);
    expect(page.released, isTrue, reason: 'the hidden page is dropped');
  });

  test('a build that fails throws its reason and still drops the page',
      () async {
    late _WelcomePage page;
    WelcomeDriveBuilder.pageFactory = (url, onMessage) async =>
        page = _WelcomePage(onMessage, fail: 'no space left');

    await expectLater(
      WelcomeDriveBuilder(api: _StoreApi()).build('did:ad:personal'),
      throwsA(predicate((e) => '$e'.contains('no space left'))),
    );
    expect(page.released, isTrue);
  });

  test('a page that never answers times out instead of hanging the start',
      () async {
    late _WelcomePage page;
    WelcomeDriveBuilder.pageFactory =
        (url, onMessage) async => page = _WelcomePage(onMessage, silent: true);

    await expectLater(
      WelcomeDriveBuilder(
              api: _StoreApi(), timeout: const Duration(milliseconds: 50))
          .build('did:ad:personal'),
      throwsA(isA<TimeoutException>()),
    );
    expect(page.released, isTrue);
  });

  test('an answer without a document to open is a failure', () async {
    WelcomeDriveBuilder.pageFactory = (url, onMessage) async =>
        _WelcomePage(onMessage, payload: jsonEncode({'drive': 'did:ad:w'}));

    await expectLater(
      WelcomeDriveBuilder(api: _StoreApi()).build('did:ad:personal'),
      throwsA(isA<StateError>()),
    );
  });
}

class _StoreApi extends UnimplementedApi {
  final calls = <(String, String)>[];
  @override
  Future<String> embedCall(String method, String argsJson) async {
    calls.add((method, argsJson));
    return '{"x":1}';
  }
}

/// A page that answers `startWelcome` as the embed does.
class _WelcomePage implements WarmPage {
  _WelcomePage(this._send, {this.fail, this.silent = false, this.payload});
  final void Function(String) _send;
  final String? fail;
  final bool silent;
  final String? payload;
  final replies = <String>[];
  final started = <(int, String)>[];
  bool released = false;

  @override
  bool get isReady => true;
  @override
  Future<void> get whenReady => Future.value();
  @override
  set onMessage(void Function(String message)? handler) {}
  @override
  set onLoaded(VoidCallback? handler) {}
  @override
  void release() => released = true;
  @override
  Widget build() => const SizedBox();
  @override
  Future<Object> runJavaScriptReturningResult(String script) async => '';

  @override
  Future<void> runJavaScript(String script) async {
    final m = RegExp(r'startWelcome\((\d+),(".*")\)$').firstMatch(script);
    if (m == null) {
      replies.add(script);
      return;
    }
    final id = int.parse(m[1]!);
    started.add((id, jsonDecode(m[2]!) as String));
    if (silent) return;
    // The build reads the personal drive through the store first.
    _send(jsonEncode({
      'id': 7,
      'method': 'getResource',
      'args': ['did:ad:personal'],
    }));
    await pumpEventQueue();
    _send(jsonEncode({
      'method': 'welcomeResult',
      'callId': id,
      'ok': fail == null,
      'payload': fail ??
          payload ??
          jsonEncode(
              {'drive': 'did:ad:welcome', 'landing': 'did:ad:welcome-doc'}),
    }));
  }
}
