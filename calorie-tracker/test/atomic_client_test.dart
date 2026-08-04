import 'package:flutter_test/flutter_test.dart';

import 'package:calorie_tracker/atomic/atomic_client.dart';

void main() {
  group('normalizeNodeId', () {
    // Node IDs reach this app in three shapes — bare hex from Iroh, a
    // `did:ad:node:` subject from a paired peer's QR, and an `iroh:` prefixed
    // form — and "is this peer live?" compares them against each other. A miss
    // here shows up as a connected device reported as offline.
    const hex =
        'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

    test('leaves a bare hex id alone', () {
      expect(AtomicClient.normalizeNodeId(hex), hex);
    });

    test('strips a did:ad:node: prefix', () {
      expect(AtomicClient.normalizeNodeId('did:ad:node:$hex'), hex);
    });

    test('strips a did prefix and any trailing path segment', () {
      expect(AtomicClient.normalizeNodeId('did:ad:node:$hex:extra'), hex);
    });

    test('strips an iroh: prefix and lowercases', () {
      expect(AtomicClient.normalizeNodeId('iroh:${hex.toUpperCase()}'), hex);
    });

    test('matches a live peer across id shapes', () {
      expect(
        AtomicClient.isLivePeer('did:ad:node:$hex', {hex.toUpperCase()}),
        isTrue,
      );
    });
  });

  group('PeerSyncResult.describe', () {
    // A sync that sent everything and received nothing is a success. Reporting
    // it by import count alone says "0", which reads as failure.
    test('names both directions when both moved', () {
      const result =
          PeerSyncResult(imported: 2, pushed: 3, inSync: false, peerName: 'iPad');
      expect(result.describe(), 'Synced with iPad — sent 3, received 2');
    });

    test('reports a push-only sync as a send, not a zero', () {
      const result = PeerSyncResult(imported: 0, pushed: 4, inSync: false);
      expect(result.describe(), 'Sent 4 resources');
    });

    test('says already in sync when nothing needed to move', () {
      const result = PeerSyncResult(imported: 0, pushed: 0, inSync: true);
      expect(result.describe('Phone'), 'Already in sync with Phone');
    });

    test('falls back to the caller name when the peer did not say', () {
      const result = PeerSyncResult(imported: 1, pushed: 0, inSync: false);
      expect(result.describe('Laptop'), 'Received 1 resource with Laptop');
    });
  });
}
