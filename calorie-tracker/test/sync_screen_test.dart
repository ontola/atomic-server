import 'package:calorie_tracker/screens/account_screen.dart';
import 'package:calorie_tracker/screens/sync_screen.dart';
import 'package:calorie_tracker/services/sync_service.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_sync_backend.dart';

/// The way in to the other devices, and what it says when there are none.
///
/// The screen itself is mostly `ServerSettingsSection`, shared with the canvas
/// app and covered there; what is worth pinning here is that it renders at all
/// without a Rust bridge behind it — a peer list that throws is a settings
/// screen that crashes, and the app is developed on a simulator.
void main() {
  late FakeSyncBackend backend;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    backend = FakeSyncBackend();
  });

  Widget wrap(Widget child) => MaterialApp(home: child);

  testWidgets('an unpaired phone is told its meals stay here', (tester) async {
    final sync = SyncService(backend: backend);

    await tester.pumpWidget(wrap(
      Scaffold(body: ListView(children: [DevicesSection(sync: sync)])),
    ));
    await tester.pumpAndSettle();

    expect(find.textContaining('Nothing paired'), findsOneWidget);
  });

  testWidgets('a paired phone says how many', (tester) async {
    backend.devices = 2;
    final sync = SyncService(backend: backend);
    await sync.refresh();

    await tester.pumpWidget(wrap(
      Scaffold(body: ListView(children: [DevicesSection(sync: sync)])),
    ));
    await tester.pumpAndSettle();

    expect(find.textContaining('2 paired'), findsOneWidget);
  });

  testWidgets('the screen comes up without a bridge behind it', (tester) async {
    final sync = SyncService(backend: backend);

    await tester.pumpWidget(wrap(SyncScreen(sync: sync)));
    await tester.pumpAndSettle();

    expect(find.text('Devices'), findsWidgets);
    expect(find.text('Sync now'), findsOneWidget);
    expect(find.textContaining('Photos stay on the phone that took them'),
        findsOneWidget);
  });

  testWidgets('sync now reports what it came to', (tester) async {
    backend.report = const SyncConnectivityReport(
      imported: 2,
      livePeers: 1,
      message: 'Received 2 resources',
    );
    final sync = SyncService(backend: backend);

    await tester.pumpWidget(wrap(SyncScreen(sync: sync)));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Sync now'));
    await tester.pumpAndSettle();

    expect(find.text('Received 2 resources'), findsOneWidget);
    expect(find.textContaining('Last synced'), findsOneWidget);
  });

  test('how long ago the last sync was, in words', () {
    final at = DateTime(2026, 8, 5, 12);
    expect(formatSyncTime(at, now: DateTime(2026, 8, 5, 12, 0, 30)), 'just now');
    expect(formatSyncTime(at, now: DateTime(2026, 8, 5, 12, 20)), '20m ago');
    expect(formatSyncTime(at, now: DateTime(2026, 8, 5, 15)), '3h ago');
    expect(formatSyncTime(at, now: DateTime(2026, 8, 8, 12)), '3d ago');
  });
}
