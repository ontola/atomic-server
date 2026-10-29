import 'package:atomic_app/atomic/webrtc/peer_identity.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('room', () {
    test('is the web hash of the canonical drive', () {
      // Computed with the web's algorithm: sha256("atomic-browser-drive-v1:" + drive).
      const expected =
          '4abc17fc51bfa4247eb16a98fe07a4ce0e018ce9e2536e4ba9c850893f6b4b51';
      expect(automaticPeerRoom('atomic:abc123'), expected);
    });

    test('both spellings of a drive meet in one room', () {
      expect(automaticPeerRoom('did:ad:abc123'),
          automaticPeerRoom('atomic:abc123'));
      expect(canonicalDrive('did:ad:abc123'), 'atomic:abc123');
      expect(canonicalDrive('atomic:abc123'), 'atomic:abc123');
    });
  });

  group('channel binding', () {
    const local = 'v=0\r\na=fingerprint:sha-256 BB:22\r\nm=application\r\n';
    const remote = 'v=0\r\na=fingerprint:sha-256 AA:11\r\n'
        'a=fingerprint:sha-256 AA:11\r\nm=application\r\n';
    // Hashed as the web does: sorted per-side sets joined by "," and then "|".
    const expected =
        '176d0d65c1e905cd706c8fe461c7e34da2f7723d67e3111f5697beba7b13d91c';

    test('matches the web for the same two descriptions', () {
      expect(channelBinding(local, remote), expected);
    });

    test('is the same from either side', () {
      expect(channelBinding(remote, local), expected);
    });

    test('refuses a description without a certificate fingerprint', () {
      expect(() => channelBinding('v=0\r\n', remote),
          throwsA(isA<FormatException>()));
    });
  });

  group('peer tokens', () {
    test('are 64 lowercase hex characters and not repeated', () {
      final a = randomPeerToken();
      expect(isPeerToken(a), isTrue);
      expect(randomPeerToken(), isNot(a));
    });

    test('isPeerToken refuses anything else', () {
      expect(isPeerToken('A' * 64), isFalse);
      expect(isPeerToken('a' * 63), isFalse);
      expect(isPeerToken(null), isFalse);
    });
  });

  group('signalling address', () {
    test('only wss, or loopback for development', () {
      expect(acceptableSignalingUrl('wss://example.com/webrtc-signal'),
          Uri.parse('wss://example.com/webrtc-signal'));
      expect(acceptableSignalingUrl('https://example.com/s').toString(),
          'wss://example.com/s');
      expect(acceptableSignalingUrl('ws://127.0.0.1:6791/webrtc-signal'),
          isNotNull);
      expect(acceptableSignalingUrl('ws://localhost:6791/x').toString(),
          'ws://localhost:6791/x');
      expect(acceptableSignalingUrl('ws://example.com/s'), isNull);
      expect(acceptableSignalingUrl('http://example.com/s'), isNull);
      expect(acceptableSignalingUrl('not a url'), isNull);
      expect(acceptableSignalingUrl(''), isNull);
    });

    test('a drive names its own service, else the portal', () {
      expect(
        peerSignalingUrl(
            driveSignalingUrl: 'wss://rendezvous.example/signal',
            portalUrl: 'https://atomic.place'),
        Uri.parse('wss://rendezvous.example/signal'),
      );
      expect(
        peerSignalingUrl(portalUrl: 'https://atomic.place'),
        Uri.parse('wss://atomic.place/webrtc-signal'),
      );
    });

    test('a rejected drive value is not replaced silently by dialling it', () {
      // An insecure value falls back to the portal, never to the bad address.
      expect(
        peerSignalingUrl(
            driveSignalingUrl: 'ws://evil.example/s',
            portalUrl: 'https://atomic.place'),
        Uri.parse('wss://atomic.place/webrtc-signal'),
      );
    });

    test('no service and no portal means nothing is contacted', () {
      expect(peerSignalingUrl(), isNull);
      expect(
          peerSignalingUrl(driveSignalingUrl: 'ws://evil.example/s'), isNull);
    });
  });
}
