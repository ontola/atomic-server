import 'package:atomic_chat/atomic_chat.dart' show WelcomeDrive;
import 'package:flutter/foundation.dart';

import 'atomic_client.dart';
import 'session.dart';

/// What "Get started" made.
class NewIdentity {
  const NewIdentity({
    required this.personalDrive,
    required this.drive,
    this.landing,
    this.secretStored = true,
  });

  /// The identity's personal drive.
  final String personalDrive;

  /// The drive the app opens in: the Welcome drive, else [personalDrive].
  final String drive;

  /// The Welcome document to open on landing; null when the Welcome drive
  /// could not be made and the person lands in the personal drive.
  final String? landing;

  /// False when secure storage refused the secret: the person is in, but has
  /// to sign in again on the next start.
  final bool secretStored;
}

/// "Get started" as the web app does it (`startLocalIdentity` +
/// `startWelcomeDrive`): no name, no email and no secret to read first. A real
/// identity is minted on this device, its personal drive made at once, and a
/// "Welcome to Atomic" drive built on top; the person lands on its Welcome
/// document.
///
/// The identity lives on the app's own Rust node, so it needs no local-only
/// flag: with no server set, nothing here is sent anywhere (a server can be
/// added in the settings later and then hosts it).
///
/// Starting never waits on the Welcome drive: when it fails, the person lands
/// in the personal drive, as on the web.
Future<NewIdentity> startNewIdentity({
  required Future<WelcomeDrive> Function(String personalDrive) buildWelcome,
  Future<({String agentSecret, String agentSubject, String driveSubject})>
          Function(String name)
      setup = AtomicClient.setup,
  Future<void> Function(String drive, String name) renameDrive = _renameDrive,
  Future<bool> Function(
          {required String serverUrl, required String secret, String? drive})
      saveSession = _saveSession,
  Future<void> Function(String drive) activate = _activate,
}) async {
  // The Rust node wants a name for the agent and the drive it makes; the
  // profile is the person's to fill in later, as on the web. The drive gets
  // the web's name for a personal drive at once.
  final made = await setup(_placeholderName);
  final personal = made.driveSubject;
  try {
    await renameDrive(personal, 'My drive');
  } catch (e) {
    debugPrint('Naming the personal drive failed: $e');
  }
  // Before anything slow: from here the identity must not be lost.
  final stored = await saveSession(
    serverUrl: '',
    secret: made.agentSecret,
    drive: personal,
  );

  WelcomeDrive? welcome;
  try {
    welcome = await buildWelcome(personal);
  } catch (e) {
    debugPrint('Welcome drive not made, landing in the personal drive: $e');
  }
  if (welcome != null) {
    try {
      await activate(welcome.drive);
    } catch (e) {
      debugPrint('Opening the Welcome drive failed: $e');
      welcome = null;
    }
  }
  return NewIdentity(
    personalDrive: personal,
    drive: welcome?.drive ?? personal,
    landing: welcome?.landing,
    secretStored: stored,
  );
}

const _placeholderName = 'Me';

Future<void> _renameDrive(String drive, String name) =>
    AtomicClient.setProperty(
        drive, 'https://atomicdata.dev/properties/name', name);

Future<bool> _saveSession(
        {required String serverUrl, required String secret, String? drive}) =>
    AtomicSession.save(serverUrl: serverUrl, secret: secret, drive: drive);

Future<void> _activate(String drive) async {
  await AtomicClient.setActiveDrive(drive);
  await AtomicSession.saveDrive(drive);
}
