import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:atomiccanvas_flutter/atomic/server_url.dart';

/// Shared with `browser/data-browser/src/helpers/serverUrl.ts`.
Map<String, dynamic> loadServerUrlFixture() {
  final file = File('../testdata/server-url.json');
  return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
}

void main() {
  final fixture = loadServerUrlFixture();

  group('normalizeServerUrl', () {
    test('matches the shared fixture (browser TS must too)', () {
      for (final case_ in fixture['normalize'] as List<dynamic>) {
        final row = case_ as Map<String, dynamic>;
        expect(normalizeServerUrl(row['input'] as String), row['normalized']);
      }
    });

    test('empty stays empty — no server is a valid choice here', () {
      // Intentionally not in the shared fixture: TypeScript currently
      // returns `https://` for the same input.
      expect(normalizeServerUrl(''), '');
      expect(normalizeServerUrl('   '), '');
    });
  });

  group('isLocalAddress', () {
    test('matches the shared fixture', () {
      for (final case_ in fixture['isLocal'] as List<dynamic>) {
        final row = case_ as Map<String, dynamic>;
        expect(isLocalAddress(row['authority'] as String), row['local']);
      }
    });
  });

  group('sameOrigin', () {
    test('matches the shared fixture', () {
      for (final case_ in fixture['sameOrigin'] as List<dynamic>) {
        final row = case_ as Map<String, dynamic>;
        expect(sameOrigin(row['a'] as String, row['b'] as String?), row['same']);
      }
    });
  });

  group('serverLabel', () {
    test('matches the shared fixture', () {
      for (final case_ in fixture['serverLabel'] as List<dynamic>) {
        final row = case_ as Map<String, dynamic>;
        expect(serverLabel(row['url'] as String), row['label']);
      }
    });
  });
}
