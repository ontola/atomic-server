import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

/// The pieces of a Sentry DSN (`https://<key>@<host>/<project>`).
typedef SentryDsn = ({String key, String host, String project, String dsn});

/// Reads [dsn]; null when it is empty or not a DSN.
SentryDsn? parseSentryDsn(String dsn) {
  final uri = Uri.tryParse(dsn.trim());
  if (uri == null || !uri.hasScheme || uri.host.isEmpty) return null;
  final key = uri.userInfo.split(':').first;
  final segments = uri.pathSegments.where((s) => s.isNotEmpty).toList();
  if (key.isEmpty || segments.isEmpty) return null;
  final prefix = segments.take(segments.length - 1).map((s) => '/$s').join();
  final host =
      '${uri.scheme}://${uri.host}${uri.hasPort ? ':${uri.port}' : ''}$prefix';
  return (key: key, host: host, project: segments.last, dsn: dsn.trim());
}

/// A random 32 hex digit event id.
String newSentryEventId([Random? random]) {
  final r = random ?? Random.secure();
  return List.generate(32, (_) => r.nextInt(16).toRadixString(16)).join();
}

/// The envelope that carries one user feedback: three JSON lines (envelope
/// header, item header, the feedback event).
String sentryFeedbackEnvelope({
  required SentryDsn dsn,
  required String message,
  String? email,
  required String source,
  required String eventId,
  required DateTime now,
}) {
  final utc = now.toUtc();
  return [
    jsonEncode({
      'event_id': eventId,
      'sent_at': utc.toIso8601String(),
      'dsn': dsn.dsn,
    }),
    jsonEncode({'type': 'feedback'}),
    jsonEncode({
      'event_id': eventId,
      'timestamp': utc.millisecondsSinceEpoch / 1000,
      'platform': 'other',
      'level': 'info',
      'contexts': {
        'feedback': {
          'message': message,
          if (email != null && email.isNotEmpty) 'contact_email': email,
          'source': source,
        },
      },
    }),
  ].join('\n');
}

/// The `X-Sentry-Auth` header value for [dsn].
String sentryAuthHeader(SentryDsn dsn) =>
    'Sentry sentry_version=7, sentry_key=${dsn.key}, '
    'sentry_client=atomic-flutter/1.0';

/// Posts one feedback to the project of [dsn]. Throws when Sentry refuses it.
Future<void> postSentryFeedback(
  SentryDsn dsn, {
  required String message,
  String? email,
  required String source,
  http.Client? client,
}) async {
  final c = client ?? http.Client();
  try {
    final res = await c.post(
      Uri.parse('${dsn.host}/api/${dsn.project}/envelope/'),
      headers: {'X-Sentry-Auth': sentryAuthHeader(dsn)},
      body: sentryFeedbackEnvelope(
        dsn: dsn,
        message: message,
        email: email,
        source: source,
        eventId: newSentryEventId(),
        now: DateTime.now(),
      ),
    );
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw StateError('Sentry answered ${res.statusCode}');
    }
  } finally {
    if (client == null) c.close();
  }
}
