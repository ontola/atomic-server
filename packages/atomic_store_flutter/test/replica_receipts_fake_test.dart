import 'package:flutter_test/flutter_test.dart';
import 'package:atomic_store_flutter/atomic_store_flutter.dart';
import 'package:atomic_store_flutter/testing.dart';
import 'package:atomic_store_flutter/src/replica_receipts.dart'
    show serverReceiptFromBridge;
import 'replica_receipts_test.dart' show event;

void main() {
  test('fake stream emits only explicit evidence from its connected origin',
      () async {
    final sync = FakeServerSync()..servers.add('https://server.test');
    final seen = <ServerReplicaReceipt>[];
    final sub = sync.watchReplicaReceipts().listen(seen.add);
    sync.emitReplicaReceipt(serverReceiptFromBridge(event('offline')));
    await sync.connect('https://server.test');
    expect(seen, isEmpty, reason: 'connection alone proves no storage');
    sync.emitReplicaReceipt(serverReceiptFromBridge(event('A')));
    await Future<void>.delayed(Duration.zero);
    expect(seen.map((e) => e.connectionId), ['A']);
    await sync.disconnect();
    sync.emitReplicaReceipt(serverReceiptFromBridge(event('disconnected')));
    await sync.connect('https://server.test');
    sync.emitReplicaReceipt(serverReceiptFromBridge(event('B')));
    await Future<void>.delayed(Duration.zero);
    expect(seen.map((e) => e.connectionId), ['A', 'B']);
    await sub.cancel();
  });
}
