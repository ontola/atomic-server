import 'dart:async';

import '../bridge/api/server_receipts.dart' as bridge;

/// A persistent store's drive-scoped identity. Different identities alone do
/// not establish independent hardware, ownership or failure domains.
final class ReplicaIdentity {
  const ReplicaIdentity({required this.storageId, required this.generation});
  final String storageId;
  final String generation;
}

/// A server's applied stored state covered this requested resource frontier
/// when its named barrier completed. This is historical evidence, not retention.
final class ResourceStorageReceipt {
  const ResourceStorageReceipt({
    required this.nonce,
    required this.drive,
    required this.subject,
    required this.version,
    required this.replica,
    required this.barrier,
  });
  final String nonce;
  final String drive;
  final String subject;
  final String version;
  final ReplicaIdentity replica;
  final String barrier;
}

/// Automatically correlated server storage evidence. A missing [source] means
/// no persistent local store identity was established. Acknowledged commits,
/// connection status and an empty receipt stream are not durability evidence.
final class ServerReplicaReceipt {
  const ServerReplicaReceipt({
    required this.receipt,
    this.source,
    required this.serverOrigin,
    required this.connectionId,
    required this.authenticationGeneration,
    required this.authenticatedAgent,
    required this.localAgent,
    required this.agentGeneration,
    required this.observedAt,
  });
  final ResourceStorageReceipt receipt;
  final ReplicaIdentity? source;
  final String serverOrigin;
  final String connectionId;
  final BigInt authenticationGeneration;
  final String authenticatedAgent;
  final String localAgent;
  final BigInt agentGeneration;

  /// When this client observed the evidence (UTC), not a server commit time.
  final DateTime observedAt;
}

ServerReplicaReceipt serverReceiptFromBridge(
    bridge.ServerReplicaReceiptData value) {
  ReplicaIdentity identity(bridge.ReplicaIdentityData id) =>
      ReplicaIdentity(storageId: id.storageId, generation: id.generation);
  return ServerReplicaReceipt(
    receipt: ResourceStorageReceipt(
      nonce: value.receipt.nonce,
      drive: value.receipt.drive,
      subject: value.receipt.subject,
      version: value.receipt.version,
      replica: identity(value.receipt.replica),
      barrier: value.receipt.barrier,
    ),
    source: value.source == null ? null : identity(value.source!),
    serverOrigin: value.serverOrigin,
    connectionId: value.connectionId,
    authenticationGeneration: value.authenticationGeneration,
    authenticatedAgent: value.authenticatedAgent,
    localAgent: value.localAgent,
    agentGeneration: value.agentGeneration,
    observedAt: DateTime.fromMillisecondsSinceEpoch(value.observedAt.toInt(),
        isUtc: true),
  );
}

/// Registers a native subscription synchronously when listening begins. Cancellation
/// closes the native receiver even if no further receipt ever arrives.
/// The injected callbacks keep the bridge boundary testable without native FFI.
Stream<ServerReplicaReceipt> serverReceiptStream({
  required Stream<bridge.ServerReplicaReceiptData> Function() listen,
  required void Function() close,
  required bool Function(bridge.ServerReplicaReceiptData) isCurrent,
}) {
  StreamSubscription<bridge.ServerReplicaReceiptData>? subscription;
  late final StreamController<ServerReplicaReceipt> controller;
  controller = StreamController<ServerReplicaReceipt>(
    sync: true,
    onListen: () {
      subscription = listen().listen((event) {
        if (isCurrent(event)) controller.add(serverReceiptFromBridge(event));
      }, onError: controller.addError, onDone: controller.close);
    },
    onPause: () => subscription?.pause(),
    onResume: () => subscription?.resume(),
    onCancel: () async {
      close();
      await subscription?.cancel();
    },
  );
  return controller.stream;
}
