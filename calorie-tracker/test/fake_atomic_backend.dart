import 'dart:async';

import 'package:calorie_tracker/services/app_session.dart';

/// What survives a relaunch: the redb store on disk.
///
/// The tests model the store and the process separately, because the thing
/// Phase 1 has to prove is exactly the difference between them — onboard, kill
/// the app, come back, and still be the same account with the same meals
/// container. A "relaunch" is a new [FakeAtomicBackend] over the same
/// [FakeStore], which is what a real one is.
class FakeStore {
  /// Drives whose data actually landed here. A drive subject is just a string
  /// until its genesis commit arrives, which is what `needs_sync` means.
  final Set<String> presentDrives = {};

  /// The meals container each drive has, once something has asked for it.
  final Map<String, String> mealsContainers = {};

  /// How many were ever made. A second one for a drive that already had one is
  /// the bug `ensureMealsContainer` exists to prevent, so the tests count.
  int mealsContainersCreated = 0;

  int nextDrive = 1;

  /// The whole account in one string, as a real secret is: it carries the
  /// drive, which is how a phone that has never synced still knows what to ask
  /// the other device for.
  static String secretFor(String drive) => 'secret-of:$drive';

  static String? driveInSecret(String secret) =>
      secret.startsWith('secret-of:') ? secret.substring(10) : null;
}

class FakeAtomicBackend implements AtomicBackend {
  FakeAtomicBackend(this.store);

  final FakeStore store;

  /// Thrown by [open], for the "the database would not open" path.
  Object? openError;

  /// Held [open], for the "what is on screen while the store is opening" path.
  Completer<void>? holdOpen;

  /// Thrown by [setup], for the "signup failed" path.
  Object? setupError;

  /// The drive this "process" is pointed at. Lost on relaunch, like the real
  /// one — it comes back from the secret or the saved session.
  String? _activeDrive;
  String? _secret;

  int setupCalls = 0;
  int ensureMealsCalls = 0;
  int syncCalls = 0;

  /// Whether the next [syncNow] finds the drive on another device.
  bool syncFindsDrive = false;

  @override
  Future<void> open() async {
    if (holdOpen != null) await holdOpen!.future;
    if (openError != null) throw openError!;
  }

  @override
  Future<({String agentSecret, String agentSubject, String driveSubject})>
      setup(String name) async {
    if (setupError != null) throw setupError!;
    setupCalls++;

    final drive = 'did:ad:drive:${store.nextDrive++}';
    store.presentDrives.add(drive);
    _activeDrive = drive;
    _secret = FakeStore.secretFor(drive);

    return (
      agentSecret: _secret!,
      agentSubject: 'did:ad:agent:$drive',
      driveSubject: drive,
    );
  }

  @override
  Future<String> loadAgent(String secret) async {
    final drive = FakeStore.driveInSecret(secret);
    if (drive == null) throw Exception('Invalid secret');

    _secret = secret;
    _activeDrive = drive;

    return store.presentDrives.contains(drive)
        ? 'did:ad:agent:$drive'
        : 'needs_sync';
  }

  @override
  Future<AgentInfo?> activeAgent() async => _secret == null
      ? null
      : AgentInfo(
          secret: _secret!,
          subject: 'did:ad:agent:$_activeDrive',
          publicKey: 'public-key',
          name: 'Me',
        );

  @override
  String? activeDrive() => _activeDrive;

  @override
  Future<void> setActiveDrive(String subject) async => _activeDrive = subject;

  @override
  Future<bool> driveReady() async =>
      _activeDrive != null && store.presentDrives.contains(_activeDrive);

  @override
  Future<String> ensureMealsContainer() async {
    final drive = _activeDrive;
    if (drive == null) throw Exception('No active drive');
    ensureMealsCalls++;

    // Find-or-create, like the bridge: the container belongs to the drive, so
    // it outlives the process that first asked for it.
    return store.mealsContainers.putIfAbsent(drive, () {
      store.mealsContainersCreated++;
      return '$drive/meals-${store.mealsContainersCreated}';
    });
  }

  @override
  Future<SyncConnectivityReport> syncNow() async {
    syncCalls++;
    if (syncFindsDrive && _activeDrive != null) {
      store.presentDrives.add(_activeDrive!);
      return const SyncConnectivityReport(
        imported: 3,
        livePeers: 1,
        message: 'Connected to Old phone',
      );
    }

    return const SyncConnectivityReport(
      imported: 0,
      livePeers: 0,
      message: 'No peers online. Open the other device or pair with QR.',
    );
  }

  @override
  Future<void> forgetAgent() async {
    _secret = null;
    _activeDrive = null;
  }
}
