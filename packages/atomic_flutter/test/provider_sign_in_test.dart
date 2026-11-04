import 'dart:convert';

import 'package:atomic_flutter/atomic_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('the provider is named by its host unless a label is given', () {
    final p = Uri.parse('https://accounts.example');
    expect(accountProviderName(p), 'accounts.example');
    expect(accountProviderName(p, 'Acme'), 'Acme');
    expect(accountProviderName(p, ''), 'accounts.example');
  });

  test('the memory store saves, reads and clears', () async {
    final store = MemoryAccountSessionStore();
    expect(await store.read(), isNull);
    await store.save('s');
    expect(await store.read(), 's');
    await store.clear();
    expect(await store.read(), isNull);
  });

  test('no linked account has no label; an unreachable one shows its host',
      () async {
    final store = MemoryAccountSessionStore();
    expect(await linkedAccountLabel(store), isNull);
    await store.save('{"origin":"https://accounts.example","token":"t"}');
    expect(await linkedAccountLabel(store), 'accounts.example');
  });

  /// The sign-in's outcome: the identity, null, or the error thrown.
  Future<Object?> run(WidgetTester tester, MemoryAccountSessionStore store,
      MockClientHandler handler,
      {bool cancel = false}) async {
    Object? result;
    await tester.pumpWidget(MaterialApp(
        home: Builder(
            builder: (context) => TextButton(
                onPressed: () => signInWithAccountProvider(context,
                            provider: Uri.parse('https://accounts.example'),
                            store: store,
                            openUrl: (_) async {},
                            client: AtomicAccountClient(
                                'https://accounts.example',
                                client: MockClient(handler)))
                        .then<void>((v) => result = v, onError: (Object e) {
                      result = e;
                    }),
                child: const Text('go')))));
    await tester.tap(find.text('go'));
    await tester.pump();
    await tester.pump();
    if (cancel) {
      await tester.tap(find.text('Cancel'));
    } else {
      await tester.pump(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 3));
    }
    await tester.pumpAndSettle();
    return result;
  }

  Future<http.Response> approvedThenNoIdentity(http.Request r) async {
    if (r.method == 'POST' && r.url.path == '/api/device-link') {
      return http.Response(
          jsonEncode({
            'device_code': 'd',
            'user_code': 'ABCD-1234',
            'interval': 1,
            'expires_in': 600
          }),
          200);
    }
    if (r.url.path.contains('device-link')) {
      return http.Response(
          jsonEncode({'state': 'approved', 'token': 'bearer'}), 200);
    }
    return http.Response('no backup', 500);
  }

  testWidgets('cancelling returns null and saves nothing', (tester) async {
    final store = MemoryAccountSessionStore();
    final found =
        await run(tester, store, approvedThenNoIdentity, cancel: true);
    expect(found, isNull);
    expect(await store.read(), isNull);
  });

  testWidgets('a sign-in whose identity cannot be had does not stay linked',
      (tester) async {
    final store = MemoryAccountSessionStore();
    final found = await run(tester, store, approvedThenNoIdentity);
    expect(found, isA<StateError>());
    expect(await store.read(), isNull);
  });
}
