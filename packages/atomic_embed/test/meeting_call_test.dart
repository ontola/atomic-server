import 'dart:convert';

import 'package:atomic_embed/atomic_embed.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// A call page that needs no web view; keeps what the call sends back.
class _Page implements WarmPage {
  final scripts = <String>[];
  @override
  bool get isReady => true;
  @override
  Future<void> get whenReady async {}
  @override
  set onMessage(void Function(String)? handler) {}
  @override
  set onLoaded(VoidCallback? handler) {}
  @override
  Future<void> runJavaScript(String script) async => scripts.add(script);
  @override
  Future<Object> runJavaScriptReturningResult(String script) async => false;
  @override
  Widget build() => const SizedBox();
  @override
  void release() {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late _Page page;
  late void Function(String) send;

  setUp(() {
    MeetingCall.pageFactory = (url, onMessage) async {
      send = onMessage;
      return page = _Page();
    };
  });
  tearDown(() => MeetingCall.pageFactory = null);

  Future<String> ask(String method, List args) async {
    send(jsonEncode({'id': 7, 'method': method, 'args': args}));
    await pumpEventQueue();
    return page.scripts.last;
  }

  final room = 'ab' * 32;

  test('the page gets the LiveKit grant of the source', () async {
    final asked = <List<String>>[];
    final call = MeetingCall(
      call: (m, a) async => 'null',
      livekitToken: (room, name) async {
        asked.add([room, name]);
        return (url: 'wss://lk', token: 'jwt');
      },
    );
    await call.start('did:ad:meeting');
    final reply = await ask('livekitToken', [room, 'did:ad:agent:x']);
    expect(asked, [
      [room, 'did:ad:agent:x']
    ]);
    expect(reply,
        'window.__atomicReply(7,true,${jsonEncode(jsonEncode({'url': 'wss://lk', 'token': 'jwt'}))})');
    call.dispose();
  });

  test('no source, no grant or a failing source: null, peer-to-peer',
      () async {
    final sources = <LivekitTokenSource?>[
      null,
      (room, name) async => null,
      (room, name) async => throw StateError('offline'),
    ];
    for (final source in sources) {
      final call =
          MeetingCall(call: (m, a) async => 'null', livekitToken: source);
      await call.start('did:ad:meeting');
      expect(await ask('livekitToken', [room, '']),
          'window.__atomicReply(7,true,${jsonEncode('null')})');
      call.dispose();
    }
  });

  test('the page tells how the call is carried', () async {
    final call = MeetingCall(call: (m, a) async => 'null');
    await call.start('did:ad:meeting');
    expect(call.transport, isNull);
    await ask('callTransport', ['livekit']);
    expect(call.transport, CallTransport.livekit);
    await ask('callTransport', ['mesh']);
    expect(call.transport, CallTransport.mesh);
    call.leave();
    expect(call.transport, isNull);
    call.dispose();
  });
}
