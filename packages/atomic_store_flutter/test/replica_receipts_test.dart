import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:atomic_store_flutter/bridge/api/server_receipts.dart' as bridge;
import 'package:atomic_store_flutter/src/replica_receipts.dart';

bridge.ServerReplicaReceiptData event(String connection,
        {bridge.ReplicaIdentityData? source}) =>
    bridge.ServerReplicaReceiptData(
      receipt: bridge.StorageReceiptData(
        nonce: 'nonce-$connection',
        drive: 'atomic:drive',
        subject: 'atomic:note',
        version: 'captured-frontier',
        replica: const bridge.ReplicaIdentityData(
            storageId: 'server-store', generation: 'server-generation'),
        barrier: 'atomic-redb-flush-v1',
      ),
      source: source,
      serverOrigin: 'https://server.test',
      connectionId: connection,
      authenticationGeneration: BigInt.from(2),
      authenticatedAgent: 'atomic:agent:alice',
      localAgent: 'atomic:agent:alice',
      agentGeneration: BigInt.from(3),
      observedAt: BigInt.from(1700000000000),
    );

void main() {
  test('maps captured version and provenance without inventing local identity',
      () {
    final receipt = serverReceiptFromBridge(event('A'));
    expect(receipt.source, isNull);
    expect(receipt.receipt.version, 'captured-frontier');
    expect(receipt.receipt.replica.storageId, 'server-store');
    expect(receipt.receipt.replica.generation, 'server-generation');
    expect(receipt.receipt.barrier, 'atomic-redb-flush-v1');
    expect(receipt.authenticationGeneration, BigInt.from(2));
    expect(receipt.agentGeneration, BigInt.from(3));
    expect(receipt.observedAt.millisecondsSinceEpoch, 1700000000000);
    final persistent = serverReceiptFromBridge(event('A',
        source: const bridge.ReplicaIdentityData(
            storageId: 'local-store', generation: 'local-generation')));
    expect(persistent.source!.storageId, 'local-store');
    expect(persistent.source!.generation, 'local-generation');
  });

  test('keeps one stream across reconnect and cancels an idle native receiver',
      () async {
    final native =
        StreamController<bridge.ServerReplicaReceiptData>(sync: true);
    var connection = 'A';
    var registrations = 0;
    var closes = 0;
    final seen = <ServerReplicaReceipt>[];
    final stream = serverReceiptStream(
      listen: () {
        registrations++;
        return native.stream;
      },
      close: () {
        closes++;
      },
      isCurrent: (value) => value.connectionId == connection,
    );
    final sub = stream.listen(seen.add);
    expect(registrations, 1, reason: 'registered before caller can connect');
    native.add(event('A'));
    connection = 'B';
    native.add(event('A'));
    native.add(event('B'));
    expect(seen.map((e) => e.connectionId), ['A', 'B']);
    expect(registrations, 1);
    await sub.cancel();
    expect(closes, 1);
    expect(native.hasListener, isFalse);
    await native.close();
  });

  test('rechecks buffered events after pause and an account replacement',
      () async {
    final native =
        StreamController<bridge.ServerReplicaReceiptData>(sync: true);
    var current = true;
    final seen = <ServerReplicaReceipt>[];
    final sub = serverReceiptStream(
      listen: () => native.stream,
      close: () {},
      isCurrent: (_) => current,
    ).listen(seen.add);
    sub.pause();
    native.add(event('old-account'));
    current = false;
    sub.resume();
    await Future<void>.delayed(Duration.zero);
    expect(seen, isEmpty);
    await sub.cancel();
    await native.close();
  });
}
