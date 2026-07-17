import 'package:flutter_test/flutter_test.dart';
import 'package:atomiccanvas_flutter/atomic/server_url.dart';

void main() {
  group('normalizeServerUrl', () {
    test('does not make people type a scheme', () {
      expect(normalizeServerUrl('localhost:9883'), 'http://localhost:9883');
      expect(normalizeServerUrl('127.0.0.1:9883'), 'http://127.0.0.1:9883');
    });

    test('assumes https off the local machine', () {
      expect(normalizeServerUrl('my.server.com'), 'https://my.server.com');
    });

    test('keeps an explicit scheme, including http on a remote host', () {
      expect(normalizeServerUrl('http://my.server.com'), 'http://my.server.com');
      expect(normalizeServerUrl('https://my.server.com'), 'https://my.server.com');
    });

    test('trims whitespace and trailing slashes, so one server is one entry', () {
      expect(normalizeServerUrl('  localhost:9883/  '), 'http://localhost:9883');
      expect(normalizeServerUrl('https://my.server.com///'), 'https://my.server.com');
    });

    test('empty stays empty — no server is a valid choice here', () {
      expect(normalizeServerUrl(''), '');
      expect(normalizeServerUrl('   '), '');
    });
  });

  group('sameOrigin', () {
    test('ignores trailing slashes and paths', () {
      expect(sameOrigin('http://localhost:9883', 'http://localhost:9883/'), isTrue);
      expect(sameOrigin('http://localhost:9883', 'http://localhost:9883/some/path'), isTrue);
    });

    test('a different port is a different server', () {
      expect(sameOrigin('http://localhost:9883', 'http://localhost:9884'), isFalse);
    });

    test('a different scheme is a different server', () {
      expect(sameOrigin('http://my.server.com', 'https://my.server.com'), isFalse);
    });

    test('no server is never the same as some server', () {
      expect(sameOrigin('http://localhost:9883', null), isFalse);
      expect(sameOrigin('http://localhost:9883', ''), isFalse);
    });
  });

  group('serverLabel', () {
    test('keeps the port, which is what tells two dev servers apart', () {
      expect(serverLabel('http://localhost:9883'), 'localhost:9883');
      expect(serverLabel('http://localhost:6747'), 'localhost:6747');
    });

    test('drops the scheme and the default port', () {
      expect(serverLabel('https://my.server.com'), 'my.server.com');
    });
  });
}
