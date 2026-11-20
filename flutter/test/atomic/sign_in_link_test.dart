import 'dart:convert';

import 'package:atomic_app/atomic/account_store.dart';
import 'package:atomic_app/atomic/sign_in_link.dart';
import 'package:atomic_flutter/atomic_flutter.dart'
    show AtomicAccountClient, MemoryAccountSessionStore;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  final portal = Uri.parse('https://atomic.place');

  group('SignInLink.parse', () {
    test('reads the token and invite of a portal sign-in link', () {
      final link = SignInLink.parse(
          'https://atomic.place/signin?token=abc-DEF_1&invite=xyz',
          portal: portal);
      expect(link?.token, 'abc-DEF_1');
      expect(link?.invite, 'xyz');
    });

    test('an invite is optional', () {
      final link = SignInLink.parse('https://atomic.place/signin?token=t',
          portal: portal);
      expect(link?.token, 't');
      expect(link?.invite, isNull);
    });

    test('anything else is not a sign-in link', () {
      for (final other in [
        'https://evil.example/signin?token=t', // another host
        'https://atomic.place.evil.example/signin?token=t',
        'https://user@atomic.place/signin?token=t',
        'http://atomic.place/signin?token=t', // not https
        'https://atomic.place:8443/signin?token=t', // another port
        'https://atomic.place/?token=t', // old path: the browser handles it
        'https://atomic.place/signin', // no token
        'https://atomic.place/signin?token=',
        'https://atomic.place/signin/more?token=t',
        'did:ad:node:abc',
        'not a url at all',
      ]) {
        expect(SignInLink.parse(other, portal: portal), isNull, reason: other);
      }
    });
  });

  group('AccountStore.redeemSignInLink', () {
    late MemoryAccountSessionStore store;
    setUp(() {
      store = MemoryAccountSessionStore();
      AccountStore.store = store;
    });

    test('redeems the token and saves the session', () async {
      final seen = <http.Request>[];
      final ok = await AccountStore.redeemSignInLink(
        'https://atomic.place/signin?token=link-token',
        client: MockClient((request) async {
          seen.add(request);
          return http.Response('{"email":"a@b.c"}', 200,
              headers: {'set-cookie': 'session_token=s1; Path=/; HttpOnly'});
        }),
      );
      expect(ok, isTrue);
      expect(seen.single.url.toString(), 'https://atomic.place/api/login');
      expect(jsonDecode(seen.single.body), {'token': 'link-token'});
      final saved = await store.read();
      expect(saved, isNotNull);
      expect(jsonDecode(saved!), {'origin': 'https://atomic.place', 'cookie': 's1'});
      expect(AtomicAccountClient.sessionOrigin(saved).host, 'atomic.place');
    });

    test('a link for another host sends nothing and saves nothing', () async {
      var called = false;
      final ok = await AccountStore.redeemSignInLink(
        'https://evil.example/signin?token=t',
        client: MockClient((_) async {
          called = true;
          return http.Response('{}', 200);
        }),
      );
      expect(ok, isFalse);
      expect(called, isFalse);
      expect(await store.read(), isNull);
    });

    test('a spent link throws a sentence to show and saves nothing', () async {
      await expectLater(
        AccountStore.redeemSignInLink(
          'https://atomic.place/signin?token=old',
          client: MockClient((_) async => http.Response('{}', 401)),
        ),
        throwsA(isA<StateError>().having(
            (e) => e.message, 'message', contains('expired or was already'))),
      );
      expect(await store.read(), isNull);
    });
  });
}
