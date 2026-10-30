import 'dart:convert';

import 'package:atomic_app/atomic/own_ai.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  http.Response json(Object body, [int status = 200]) =>
      http.Response(jsonEncode(body), status,
          headers: {'content-type': 'application/json'});

  test('reads the key’s spending and the account’s balance', () async {
    final seen = <String>[];
    final client = MockClient((request) async {
      seen.add('${request.url.path} ${request.headers['Authorization']}');
      return switch (request.url.path) {
        '/api/v1/key' => json({
            'data': {'usage': 4.5, 'usage_monthly': 1.2, 'limit_remaining': null}
          }),
        '/api/v1/credits' => json({
            'data': {'total_credits': 10, 'total_usage': 4.5}
          }),
        _ => json({}, 404),
      };
    });
    final usage = await OwnAi.keyUsage(key: 'sk-key', client: client);
    expect(seen, containsAll(
        ['/api/v1/key Bearer sk-key', '/api/v1/credits Bearer sk-key']));
    expect(usage!.used, 4.5);
    expect(usage.thisMonth, 1.2);
    expect(usage.left, 5.5);
    expect(usage.line, '\$1.20 this month · \$5.50 left');
  });

  test('a key with its own limit says what that limit leaves', () async {
    final client = MockClient((request) async => switch (request.url.path) {
          '/api/v1/key' => json({
              'data': {'usage': 2, 'limit_remaining': 3}
            }),
          _ => json({}, 403),
        });
    final usage = await OwnAi.keyUsage(key: 'sk-key', client: client);
    expect(usage!.line, '\$2.00 used · \$3.00 left');
  });

  test('nothing when OpenRouter answers neither', () async {
    final client = MockClient((_) async => json({}, 401));
    expect(await OwnAi.keyUsage(key: 'sk-key', client: client), isNull);
  });
}
