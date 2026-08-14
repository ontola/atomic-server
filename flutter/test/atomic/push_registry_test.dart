import 'package:atomiccanvas_flutter/atomic/push_payload.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('visiblePushCopy', () {
    test('is generic per type', () {
      expect(visiblePushCopy('mention').title, 'Atomic');
      expect(visiblePushCopy('mention').body, 'Someone mentioned you');
      expect(visiblePushCopy('message').body, 'You have a new message');
      expect(
        visiblePushCopy('access-request').body,
        'Someone requested access',
      );
    });
  });

  group('push data bag', () {
    test('reads about and type', () {
      expect(
        aboutFromPushData({'about': 'did:ad:doc1', 'type': 'mention'}),
        'did:ad:doc1',
      );
      expect(
        typeFromPushData({'about': 'did:ad:doc1', 'type': 'watch-content'}),
        'watch-content',
      );
      expect(aboutFromPushData({}), isNull);
      expect(typeFromPushData(null), 'mention');
    });
  });
}
