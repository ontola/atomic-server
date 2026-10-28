import 'dart:convert';
import 'dart:math';

import 'package:atomic_app/assistant/sentry_feedback.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('a DSN is read into key, host and project', () {
    final dsn = parseSentryDsn('https://abc123@o1.ingest.sentry.io/456')!;
    expect(dsn.key, 'abc123');
    expect(dsn.host, 'https://o1.ingest.sentry.io');
    expect(dsn.project, '456');
  });

  test('a DSN with a port and a path prefix', () {
    final dsn = parseSentryDsn('http://k@sentry.test:9000/pre/7')!;
    expect(dsn.host, 'http://sentry.test:9000/pre');
    expect(dsn.project, '7');
  });

  test('no DSN, or a broken one, is null', () {
    expect(parseSentryDsn(''), isNull);
    expect(parseSentryDsn('nonsense'), isNull);
    expect(parseSentryDsn('https://host.test/1'), isNull);
    expect(parseSentryDsn('https://k@host.test'), isNull);
  });

  test('the event id is 32 hex digits', () {
    expect(newSentryEventId(Random(1)), matches(RegExp(r'^[0-9a-f]{32}$')));
  });

  test('the envelope has the three lines of a feedback', () {
    final dsn = parseSentryDsn('https://abc@o1.ingest.sentry.io/456')!;
    final lines = sentryFeedbackEnvelope(
      dsn: dsn,
      message: 'it broke',
      email: 'a@b.co',
      source: 'flutter-ai-chat',
      eventId: 'e' * 32,
      now: DateTime.utc(2026, 1, 2, 3, 4, 5),
    ).split('\n');
    expect(lines, hasLength(3));
    final header = jsonDecode(lines[0]) as Map;
    expect(header['event_id'], 'e' * 32);
    expect(header['sent_at'], '2026-01-02T03:04:05.000Z');
    expect(header['dsn'], dsn.dsn);
    expect(jsonDecode(lines[1]), {'type': 'feedback'});
    final event = jsonDecode(lines[2]) as Map;
    expect(event['platform'], 'other');
    expect(event['level'], 'info');
    expect(event['timestamp'], 1767323045);
    expect(event['contexts']['feedback'], {
      'message': 'it broke',
      'contact_email': 'a@b.co',
      'source': 'flutter-ai-chat',
    });
  });

  test('without an email the contact is left out', () {
    final dsn = parseSentryDsn('https://abc@h.test/1')!;
    final lines = sentryFeedbackEnvelope(
      dsn: dsn,
      message: 'm',
      source: 's',
      eventId: 'e' * 32,
      now: DateTime.utc(2026),
    ).split('\n');
    expect(jsonDecode(lines[2])['contexts']['feedback'],
        isNot(contains('contact_email')));
  });

  test('it is posted to the envelope endpoint with the auth header', () async {
    final dsn = parseSentryDsn('https://abc@o1.ingest.sentry.io/456')!;
    late http.Request seen;
    final client = MockClient((req) async {
      seen = req;
      return http.Response('{}', 200);
    });
    await postSentryFeedback(dsn, message: 'm', source: 's', client: client);
    expect(
        seen.url.toString(), 'https://o1.ingest.sentry.io/api/456/envelope/');
    expect(seen.headers['X-Sentry-Auth'], contains('sentry_key=abc'));
    expect(seen.body.split('\n'), hasLength(3));
  });

  test('a refusal throws', () async {
    final dsn = parseSentryDsn('https://abc@h.test/1')!;
    final client = MockClient((_) async => http.Response('no', 429));
    expect(postSentryFeedback(dsn, message: 'm', source: 's', client: client),
        throwsStateError);
  });
}
