import 'dart:io';

import 'package:calorie_tracker/screens/settings/settings_screen.dart';
import 'package:calorie_tracker/services/app_session.dart';
import 'package:calorie_tracker/services/image_store.dart';
import 'package:calorie_tracker/services/sync_service.dart';
import 'package:calorie_tracker/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fake_atomic_backend.dart';
import 'fake_compressor.dart';
import 'fake_sync_backend.dart';

/// The hub, and the two claims that make it one rather than a menu.
///
/// A row leads somewhere, and a row says what is true there without being
/// opened — those are the whole design, and both are the kind of thing that
/// survives a refactor as a row leading to a blank screen or a subtitle that
/// never updates.
///
/// Every argument to [SettingsScreen] is nullable because a boot that has not
/// finished has no image store and no OpenRouter account. That is the case
/// covered here without one: the screen has to come up regardless, since it is
/// also where somebody goes to fix whatever is missing.
void main() {
  late Directory root;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    root = await Directory.systemTemp.createTemp('settings_screen_test');
  });

  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });

  Future<AppSession> readySession() async {
    final session = AppSession(backend: FakeAtomicBackend(FakeStore()));
    await session.start();
    await session.createAccount();
    return session;
  }

  Future<void> pump(
    WidgetTester tester, {
    ImageStore? images,
    SyncService? sync,
  }) async {
    final session = await readySession();
    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(Brightness.dark),
      home: SettingsScreen(session: session, images: images, sync: sync),
    ));
    await tester.pumpAndSettle();
  }

  testWidgets('comes up with nothing behind it but the session',
      (tester) async {
    await pump(tester);

    expect(find.widgetWithText(AppBar, 'Settings'), findsOneWidget);
    expect(find.text('Account'), findsOneWidget);
    expect(find.text('Open source licences'), findsOneWidget);

    // No image store and no sync service: the rows that would lead nowhere are
    // absent rather than dead.
    expect(find.text('Storage'), findsNothing);
    expect(find.text('Sync'), findsNothing);
    expect(find.text('AI'), findsNothing);
  });

  testWidgets('the rows say what is true behind them', (tester) async {
    final sync = SyncService(backend: FakeSyncBackend()..devices = 2);
    await sync.refresh();

    await tester.runAsync(() async {
      await pump(
        tester,
        images: ImageStore(root: root, compressor: FakeCompressor()),
        sync: sync,
      );
      // The subtitles are read off the filesystem, which a widget test's zone
      // does not pump.
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pump();

    expect(find.textContaining('2 paired'), findsOneWidget);
    // Nothing has been photographed, and the default budget is the one the
    // storage screen would show.
    expect(find.textContaining('0 B of'), findsOneWidget);
  });

  testWidgets('the account row leads to the secret', (tester) async {
    await pump(tester);

    await tester.tap(find.text('Account'));
    await tester.pumpAndSettle();

    expect(find.widgetWithText(AppBar, 'Account'), findsOneWidget);
    expect(find.text('Copy my secret'), findsOneWidget);
    expect(find.text('Sign out'), findsOneWidget);
  });

  testWidgets('the storage row leads to the budget', (tester) async {
    final images = ImageStore(root: root, compressor: FakeCompressor());

    await tester.runAsync(() async {
      await pump(tester, images: images);
      await tester.tap(find.text('Storage'));
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.widgetWithText(AppBar, 'Storage'), findsOneWidget);
    expect(find.text('Photos'), findsOneWidget);
    expect(find.text('No limit'), findsOneWidget);
    expect(find.text('Delete all photos now'), findsOneWidget);
  });

  testWidgets('the licences row leads to the page that shows them',
      (tester) async {
    await pump(tester);

    await tester.tap(find.text('Open source licences'));
    await tester.pumpAndSettle();

    expect(find.text('Calorie Tracker'), findsWidgets);
  });
}
