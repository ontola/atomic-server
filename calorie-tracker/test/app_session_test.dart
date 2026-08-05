import 'package:calorie_tracker/services/app_session.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_atomic_backend.dart';

/// Phase 1's acceptance criterion lives here: onboard, kill the app, come back
/// to the same account and the same meals container. The bridge itself is faked
/// (there is no Rust library in the test VM) but the persistence is real — the
/// mocks under `SharedPreferences` and `FlutterSecureStorage` are in-memory
/// stores, so a "relaunch" reads back exactly what onboarding wrote.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeStore store;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    store = FakeStore();
  });

  /// A cold start against whatever the last one left behind.
  Future<({AppSession session, FakeAtomicBackend backend})> launch() async {
    final backend = FakeAtomicBackend(store);
    final session = AppSession(backend: backend);
    await session.start();

    return (session: session, backend: backend);
  }

  test('a fresh install has nothing to restore and asks to onboard', () async {
    final app = await launch();

    expect(app.session.phase, SessionPhase.onboarding);
    expect(app.backend.setupCalls, 0,
        reason: 'nothing may be minted before the user asks for it');
  });

  test('creating an account leaves a drive and a place to put meals', () async {
    final app = await launch();

    await app.session.createAccount();

    expect(app.session.phase, SessionPhase.ready);
    expect(app.session.agent, isNotNull);
    expect(app.session.drive, isNotNull);
    expect(app.session.mealsContainer, isNotNull);
    expect(app.session.busy, isFalse);
  });

  test('a relaunch restores the account without minting another', () async {
    final first = await launch();
    await first.session.createAccount();
    final agent = first.session.agent!;
    final container = first.session.mealsContainer;

    // Kill the app: a new process over the same store.
    final second = await launch();

    expect(second.session.phase, SessionPhase.ready);
    expect(second.session.agent?.subject, agent.subject);
    expect(second.session.agent?.secret, agent.secret);
    expect(second.session.drive, first.session.drive);
    expect(second.session.mealsContainer, container);
    expect(second.backend.setupCalls, 0,
        reason: 'a relaunch restores the account, it does not create one');
    expect(store.mealsContainersCreated, 1,
        reason: 'every launch asks for the container; only the first makes it');
  });

  test('the secret is what a relaunch restores from', () async {
    final first = await launch();
    await first.session.createAccount();

    // Same store, but the saved session is gone — an app whose account lives
    // only in the store's memory would sail through this.
    await AppSession(backend: FakeAtomicBackend(store)).signOut();

    final second = await launch();

    expect(second.session.phase, SessionPhase.onboarding);
  });

  test('a bad secret is refused and onboarding stays put', () async {
    final app = await launch();

    await app.session.importAccount('not-a-secret');

    expect(app.session.phase, SessionPhase.onboarding);
    expect(app.session.error, contains('Invalid secret'));
    expect(app.session.busy, isFalse);
  });

  test('an empty secret says so without calling the bridge', () async {
    final app = await launch();

    await app.session.importAccount('   ');

    expect(app.session.error, 'Paste your secret first');
    expect(app.session.phase, SessionPhase.onboarding);
  });

  test('a secret whose drive is elsewhere waits for it, signed in', () async {
    final app = await launch();
    // Made on another phone: this store has never seen the drive.
    final foreign = FakeStore.secretFor('did:ad:drive:elsewhere');

    await app.session.importAccount(foreign);

    expect(app.session.phase, SessionPhase.needsSync);
    expect(app.session.agent, isNotNull,
        reason: 'the account is restored — only its data is missing');
    expect(app.session.mealsContainer, isNull,
        reason: 'nothing may be created on a drive that is not here yet');

    // And it survives a relaunch from that state, rather than asking for the
    // secret again on every launch until the sync happens.
    final relaunched = await launch();
    expect(relaunched.session.phase, SessionPhase.needsSync);
  });

  test('the meals land once the other device answers', () async {
    final app = await launch();
    await app.session.importAccount(FakeStore.secretFor('did:ad:drive:elsewhere'));
    expect(app.session.phase, SessionPhase.needsSync);

    app.backend.syncFindsDrive = true;
    await app.session.retrySync();

    expect(app.session.phase, SessionPhase.ready);
    expect(app.session.mealsContainer, isNotNull);
  });

  test('a sync that finds nothing says so and keeps waiting', () async {
    final app = await launch();
    await app.session.importAccount(FakeStore.secretFor('did:ad:drive:elsewhere'));

    final message = await app.session.retrySync();

    expect(message, contains('No peers online'));
    expect(app.session.phase, SessionPhase.needsSync);
  });

  test('a store that will not open is its own failure, with the reason',
      () async {
    final backend = FakeAtomicBackend(store)
      ..openError = Exception('redb: permission denied');
    final session = AppSession(backend: backend);

    await session.start();

    expect(session.phase, SessionPhase.failed);
    expect(session.error, 'redb: permission denied');

    // …and the retry the failure screen offers actually recovers.
    backend.openError = null;
    await session.start();

    expect(session.phase, SessionPhase.onboarding);
    expect(session.error, isNull);
  });

  test('a signup that fails leaves onboarding usable', () async {
    final app = await launch();
    app.backend.setupError = Exception('disk full');

    await app.session.createAccount();

    expect(app.session.phase, SessionPhase.onboarding,
        reason: 'a fresh install must not be stranded on an error screen');
    expect(app.session.error, 'disk full');

    app.backend.setupError = null;
    await app.session.createAccount();

    expect(app.session.phase, SessionPhase.ready);
  });

  test('signing out forgets the account but keeps the data', () async {
    final app = await launch();
    await app.session.createAccount();
    final drive = app.session.drive!;

    await app.session.signOut();

    expect(app.session.phase, SessionPhase.onboarding);
    expect(app.session.agent, isNull);
    expect(app.session.mealsContainer, isNull);
    expect(store.presentDrives, contains(drive),
        reason: 'signing out is not a delete — the secret brings it all back');

    // Prove it: the same secret restores the same drive and container.
    final back = await launch();
    await back.session.importAccount(FakeStore.secretFor(drive));

    expect(back.session.phase, SessionPhase.ready);
    expect(back.session.drive, drive);
    expect(store.mealsContainersCreated, 1);
  });
}
