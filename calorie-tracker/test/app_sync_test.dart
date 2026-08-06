import 'package:calorie_tracker/main.dart';
import 'package:calorie_tracker/models/meal.dart';
import 'package:calorie_tracker/services/app_session.dart';
import 'package:calorie_tracker/services/background_estimation.dart';
import 'package:calorie_tracker/services/estimation_queue.dart';
import 'package:calorie_tracker/services/meal_store.dart';
import 'package:calorie_tracker/services/openrouter.dart';
import 'package:calorie_tracker/services/sync_service.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_atomic_backend.dart';
import 'fake_camera.dart';
import 'fake_meal_backend.dart';
import 'fake_notifier.dart';
import 'fake_scheduler.dart';
import 'fake_sync_backend.dart';

/// The app's half of Phase 6: what happens around a sync, and what happens on
/// the way out of the app.
///
/// `sync_service_test` covers when a sync runs; this is about what the app does
/// with one. Meals that arrive from another phone have to reach the screen —
/// nothing else in the app would ever notice them — and the estimator has to be
/// told this account has a second device, because that changes what a photo it
/// cannot find means.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeStore store;
  late FakeMealBackend meals;
  late FakeSyncBackend syncBackend;
  late FakeScheduler scheduler;
  late FakeCamera camera;
  late MealStore mealStore;
  late EstimationQueue queue;

  const drive = 'did:ad:drive:mine';

  setUp(() {
    SharedPreferences.setMockInitialValues({
      'atomic_server_url': '',
      'atomic_drive': drive,
    });
    FlutterSecureStorage.setMockInitialValues(
      {'atomic_agent_secret': FakeStore.secretFor(drive)},
    );
    store = FakeStore()..presentDrives.add(drive);
    meals = FakeMealBackend();
    syncBackend = FakeSyncBackend();
    scheduler = FakeScheduler();
    camera = FakeCamera();
    mealStore = MealStore(backend: meals, day: DateTime.now());
    // No key, so nothing is ever sent anywhere: what this file is about is the
    // queue's *count*, not its calls.
    final account = OpenRouterAccount();
    queue = EstimationQueue(
      meals: mealStore,
      account: account,
      client: OpenRouterClient(account: account),
      notifier: FakeNotifier(),
    );
  });

  SyncService buildSync(Future<void> Function() onImported) =>
      SyncService(backend: syncBackend, onImported: onImported);

  Widget app() {
    late final SyncService sync;
    sync = SyncService(
      backend: syncBackend,
      onImported: () async {
        await mealStore.load();
        await queue.drain();
      },
    );
    return CalorieTrackerApp(
      session: AppSession(backend: FakeAtomicBackend(store)),
      camera: camera,
      meals: mealStore,
      queue: queue,
      notifier: FakeNotifier(),
      sync: sync,
      background: BackgroundEstimation(scheduler: scheduler),
    );
  }

  /// A meal logged on the other phone, which "arrives" the moment this device
  /// reaches it.
  void arrivesOnSync({String subject = 'did:ad:meal:elsewhere'}) {
    final now = DateTime.now();
    syncBackend
      ..devices = 1
      ..report = const SyncConnectivityReport(
        imported: 4,
        livePeers: 1,
        message: 'Synced with 1 device',
      )
      ..onReach = () async => meals.seed(Meal(
            subject: subject,
            name: 'Pizza on the other phone',
            description: '',
            consumedAt: DateTime(now.year, now.month, now.day, 13),
            status: MealStatus.estimated,
            calories: 850,
          ));
  }

  testWidgets('meals from another device reach the screen', (tester) async {
    arrivesOnSync();

    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    expect(mealStore.meals.map((m) => m.name), contains('Pizza on the other phone'));
    expect(find.text('850'), findsOneWidget, reason: "today's total");
  });

  testWidgets('an unpaired phone does not sync on launch', (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    expect(syncBackend.calls, ['deviceCount']);
  });

  testWidgets('the estimator is told this account has another device',
      (tester) async {
    syncBackend.devices = 1;

    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    expect(queue.paired, isTrue,
        reason: 'a photo it cannot find may be on the other phone');
  });

  testWidgets('an unpaired phone leaves the estimator as it was',
      (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    expect(queue.paired, isFalse);
  });

  // ── Leaving and coming back ──────────────────────────────────────────────

  testWidgets('leaving with meals waiting asks the OS to finish them',
      (tester) async {
    final now = DateTime.now();
    meals.seed(Meal(
      subject: 'did:ad:meal:pending',
      name: '',
      description: '',
      consumedAt: DateTime(now.year, now.month, now.day, 12),
      status: MealStatus.pending,
    ));

    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(queue.waiting, 1);

    await _goAway(tester);
    expect(scheduler.calls, contains('schedule'));

    await _comeBack(tester);
    expect(scheduler.calls, contains('cancel'));
  });

  testWidgets('leaving with nothing waiting asks the OS for nothing',
      (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    await _goAway(tester);

    expect(scheduler.calls, ['start']);
  });

  testWidgets('coming back asks the other devices what they have been up to',
      (tester) async {
    syncBackend.devices = 1;

    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    syncBackend.calls.clear();

    await _goAway(tester);
    await _comeBack(tester);

    expect(syncBackend.calls, contains('reachDevices'));
  });

  test('the service is what the app hands its meals to', () async {
    // A guard on the wiring above rather than a behaviour of its own: the
    // callback is the only thing that tells anybody a sync happened.
    var called = 0;
    final sync = buildSync(() async => called++);
    syncBackend
      ..devices = 1
      ..report = const SyncConnectivityReport(
        imported: 1,
        livePeers: 1,
        message: 'Synced',
      );

    await sync.autoSync();

    expect(called, 1);
  });
}

/// The app switcher, then home. Flutter insists on the whole descent — a jump
/// straight to `paused` is rejected as an impossible transition.
Future<void> _goAway(WidgetTester tester) async {
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
  await tester.pumpAndSettle();
}

Future<void> _comeBack(WidgetTester tester) async {
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  await tester.pumpAndSettle();
}
