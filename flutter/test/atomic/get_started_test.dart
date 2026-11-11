import 'package:atomic_app/atomic/get_started.dart';
import 'package:atomic_chat/atomic_chat.dart' show WelcomeDrive;
import 'package:flutter_test/flutter_test.dart';

void main() {
  late List<String> calls;

  Future<({String agentSecret, String agentSubject, String driveSubject})>
      setup(String name) async {
    calls.add('setup $name');
    return (
      agentSecret: 'secret',
      agentSubject: 'did:ad:agent:a',
      driveSubject: 'did:ad:personal',
    );
  }

  Future<NewIdentity> run({
    required Future<WelcomeDrive> Function(String) welcome,
    bool stored = true,
    Future<void> Function(String drive)? activate,
  }) =>
      startNewIdentity(
        setup: setup,
        buildWelcome: (personal) {
          calls.add('welcome $personal');
          return welcome(personal);
        },
        renameDrive: (drive, name) async => calls.add('rename $drive $name'),
        saveSession: (
            {required serverUrl, required secret, String? drive}) async {
          calls.add('save [$serverUrl] $secret $drive');
          return stored;
        },
        activate: activate ??
            (drive) async {
              calls.add('activate $drive');
            },
      );

  setUp(() => calls = []);

  test(
      'makes the identity and personal drive, keeps the secret, then builds '
      'the Welcome drive and lands on its document', () async {
    final made = await run(
      welcome: (_) async =>
          const WelcomeDrive(drive: 'did:ad:welcome', landing: 'did:ad:doc'),
    );

    expect(made.personalDrive, 'did:ad:personal');
    expect(made.drive, 'did:ad:welcome');
    expect(made.landing, 'did:ad:doc');
    expect(made.secretStored, isTrue);
    // The identity is kept on the device before anything slow runs; the app
    // opens the Welcome drive; no server is set, so nothing is local-only
    // flagged or sent.
    expect(calls, [
      'setup Me',
      'rename did:ad:personal My drive',
      'save [] secret did:ad:personal',
      'welcome did:ad:personal',
      'activate did:ad:welcome',
    ]);
  });

  test('a Welcome drive that fails never blocks: land in the personal drive',
      () async {
    final made = await run(welcome: (_) async => throw StateError('no page'));

    expect(made.drive, 'did:ad:personal');
    expect(made.landing, isNull);
    expect(calls, isNot(contains('activate did:ad:welcome')));
  });

  test('a Welcome drive that cannot be opened lands in the personal drive',
      () async {
    final made = await run(
      welcome: (_) async =>
          const WelcomeDrive(drive: 'did:ad:welcome', landing: 'did:ad:doc'),
      activate: (_) async => throw StateError('store busy'),
    );

    expect(made.drive, 'did:ad:personal');
    expect(made.landing, isNull);
  });

  test('says when secure storage refused the secret', () async {
    final made = await run(
      stored: false,
      welcome: (_) async => throw StateError('x'),
    );

    expect(made.secretStored, isFalse);
  });

  test('a failing identity setup throws, so the screen can say why', () async {
    await expectLater(
      startNewIdentity(
        setup: (_) async => throw StateError('no store'),
        buildWelcome: (_) async => throw StateError('unreached'),
      ),
      throwsA(isA<StateError>()),
    );
  });
}
