import 'dart:convert';

import 'package:atomic_buildings/src/agent_account.dart';
import 'package:atomic_buildings/ui/account_link_dialog.dart';
import 'package:atomic_flutter/atomic_flutter.dart' show AtomicAccountClient;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'chat_helpers.dart';

class MemorySessions implements SessionStore {
  String? value;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> save(String session) async => value = session;
  @override
  Future<void> clear() async => value = null;
}

const portal = 'https://provider.example';
const session = '{"origin":"$portal","token":"t"}';

AtomicAccountClient clientAnswering(Map<String, http.Response> answers,
        [List<String>? seen]) =>
    AtomicAccountClient(portal, client: MockClient((request) async {
      seen?.add('${request.method} ${request.url.path}');
      return answers[request.url.path] ?? http.Response('', 404);
    }));

void main() {
  group('AgentAccount', () {
    test('uses the linked session, with no agent', () async {
      final sessions = MemorySessions()..value = session;
      final seen = <String>[];
      final account = AgentAccount(() => null,
          portal: portal,
          sessions: sessions,
          client: (_) => clientAnswering({
                '/api/ai/status': http.Response(
                    jsonEncode({'enabled': true, 'consent': true}), 200)
              }, seen));
      expect(await account.hostedAi(), isNotNull);
      expect(seen, ['GET /api/ai/status']);
      expect(sessions.value, session);
    });

    test('a session the portal refuses is dropped; no agent, no AI', () async {
      final sessions = MemorySessions()..value = session;
      final account = AgentAccount(() => null,
          portal: portal,
          sessions: sessions,
          client: (_) => clientAnswering({}));
      expect(await account.hostedAi(), isNull);
      expect(sessions.value, isNull);
    });

    test('a session of another portal is dropped', () async {
      final sessions = MemorySessions()
        ..value = '{"origin":"https://other.example","token":"t"}';
      final account = AgentAccount(() => null,
          portal: portal,
          sessions: sessions,
          client: (_) => clientAnswering({}));
      expect(await account.hostedAi(), isNull);
      expect(sessions.value, isNull);
    });
  });

  group('AccountLinkDialog', () {
    testWidgets('opens the approval page and saves the session',
        (tester) async {
      final opened = <Uri>[];
      String? saved;
      final client = clientAnswering({
        '/api/device-link': http.Response(
            jsonEncode({
              'device_code': 'secret',
              'user_code': 'ABCD-EFGH',
              'expires_in': 300,
              'interval': 1
            }),
            200),
        '/api/device-link/secret':
            http.Response('{"state":"approved","token":"tok"}', 200),
      });
      bool? result;
      await tester.pumpWidget(chatApp(Builder(
          builder: (context) => TextButton(
              onPressed: () async => result = await showDialog<bool>(
                  context: context,
                  builder: (_) => AccountLinkDialog(
                      client: client,
                      save: (s) async => saved = s,
                      open: (url) async => opened.add(url))),
              child: const Text('go')))));
      await tester.tap(find.text('go'));
      await tester.pump();
      await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
      expect(find.text('ABCD-EFGH'), findsOneWidget);
      expect(opened.single.toString(), '$portal/link?code=ABCD-EFGH');

      await tester.pump(const Duration(seconds: 1));
      await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pumpAndSettle();
      expect(result, true);
      expect(jsonDecode(saved!)['token'], 'tok');
    });

    testWidgets('shows why it failed and offers another try', (tester) async {
      final client = clientAnswering({});
      await tester.pumpWidget(chatApp(AccountLinkDialog(
          client: client, save: (_) async {}, open: (_) async {})));
      await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
      expect(find.text('Try again'), findsOneWidget);
    });
  });
}
