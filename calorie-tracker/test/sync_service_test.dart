import 'package:calorie_tracker/services/sync_service.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_sync_backend.dart';

/// What syncing is allowed to do, and — mostly — what it is not.
///
/// The plan has sync optional and explicit (§2), and the two tests that matter
/// most here are about a phone that has never been paired: it must not reach for
/// the network on its own, and it must not treat "nothing to sync with" as a
/// failure worth showing anybody.
void main() {
  late FakeSyncBackend backend;

  setUp(() => backend = FakeSyncBackend());

  SyncService serviceThat({Future<void> Function()? onImported}) =>
      SyncService(backend: backend, onImported: onImported);

  // ── Staying local ────────────────────────────────────────────────────────

  test('a phone that has never been paired reaches for nothing', () async {
    final sync = serviceThat();

    await sync.autoSync();

    expect(backend.calls, ['deviceCount']);
    expect(sync.hasDevices, isFalse);
    expect(sync.lastSyncedAt, isNull);
  });

  test('the button syncs even with nothing paired — that is somebody asking',
      () async {
    final sync = serviceThat();

    await sync.syncNow();

    expect(backend.calls, contains('reachDevices'));
  });

  // ── Once a device is paired ──────────────────────────────────────────────

  test('a paired phone syncs on its own', () async {
    backend.devices = 1;
    final sync = serviceThat();

    await sync.autoSync();

    expect(backend.calls, contains('reachDevices'));
    expect(sync.hasDevices, isTrue);
    expect(sync.lastSyncedAt, isNotNull);
  });

  test('meals that arrive are read again', () async {
    backend
      ..devices = 1
      ..report = const SyncConnectivityReport(
        imported: 3,
        livePeers: 1,
        message: 'Synced with 1 device',
      );

    var reloads = 0;
    final sync = serviceThat(onImported: () async => reloads++);

    await sync.autoSync();

    expect(sync.importedSomething, isTrue);
    expect(reloads, 1, reason: 'the day on screen is now out of date');
  });

  test('a sync that brought nothing in leaves the day alone', () async {
    backend.devices = 1;
    var reloads = 0;
    final sync = serviceThat(onImported: () async => reloads++);

    await sync.autoSync();

    expect(sync.importedSomething, isFalse);
    expect(reloads, 0);
  });

  // ── The server, which is the optional half of an optional feature ────────

  test('a live session is opened with the configured server first', () async {
    backend
      ..devices = 1
      ..server = 'https://atomic.example';
    final sync = serviceThat();

    await sync.syncNow();

    expect(
      backend.calls,
      containsAllInOrder(['openServer:https://atomic.example', 'reachDevices']),
    );
  });

  test('a server that is switched off does not stop the other devices',
      () async {
    backend
      ..devices = 1
      ..server = 'https://atomic.example'
      ..openError = Exception('connection refused')
      ..report = const SyncConnectivityReport(
        imported: 2,
        livePeers: 1,
        message: 'Synced with 1 device',
      );

    final sync = serviceThat();
    await sync.syncNow();

    expect(backend.calls, contains('reachDevices'));
    expect(sync.importedSomething, isTrue);
    expect(sync.lastMessage, 'Synced with 1 device');
  });

  // ── When it does not work ────────────────────────────────────────────────

  test('an unreachable network is reported in the words it came in', () async {
    backend
      ..devices = 1
      ..reachError = Exception('no route to host');
    final sync = serviceThat();

    await sync.syncNow();

    expect(sync.lastMessage, 'no route to host');
    expect(sync.busy, isFalse, reason: 'a failure still finishes');
  });

  test('two syncs at once are one sync', () async {
    backend.devices = 1;
    final sync = serviceThat();

    await Future.wait([sync.syncNow(), sync.syncNow()]);

    expect(
      backend.calls.where((c) => c == 'reachDevices').length,
      1,
      reason: 'they would race each other over the same store',
    );
  });

  test('counting the devices again is not syncing with them', () async {
    backend.devices = 2;
    final sync = serviceThat();

    await sync.refresh();

    expect(backend.calls, ['deviceCount']);
    expect(sync.devices, 2);
  });
}
