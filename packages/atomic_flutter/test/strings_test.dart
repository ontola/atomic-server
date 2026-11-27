import 'dart:io';

import 'package:atomic_flutter/atomic_flutter.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// Material's English-only strings for any locale, so a test can run the app in
/// Dutch without the `flutter_localizations` package.
class _AnyMaterial extends LocalizationsDelegate<MaterialLocalizations> {
  const _AnyMaterial();
  @override
  bool isSupported(Locale locale) => true;
  @override
  Future<MaterialLocalizations> load(Locale locale) =>
      SynchronousFuture(const DefaultMaterialLocalizations());
  @override
  bool shouldReload(_AnyMaterial old) => false;
}

class _AnyCupertino extends LocalizationsDelegate<CupertinoLocalizations> {
  const _AnyCupertino();
  @override
  bool isSupported(Locale locale) => true;
  @override
  Future<CupertinoLocalizations> load(Locale locale) =>
      SynchronousFuture(const DefaultCupertinoLocalizations());
  @override
  bool shouldReload(_AnyCupertino old) => false;
}

class _Backend extends AtomicSettingsBackend {
  @override
  Future<AtomicIdentity?> getActiveAgent() async =>
      const AtomicIdentity(subject: 'did:ad:test', name: 'Me');
  @override
  Future<String> exportSecret() async => 'secret';
  @override
  Future<List<String>> listDrives() async => ['a', 'b'];
  @override
  String? getActiveDrive() => 'a';
  @override
  Future<String> getDriveName(String drive) async =>
      drive == 'a' ? "Me's Drive" : 'Recepten';
  @override
  Future<void> createDrive(String name) async {}
  @override
  Future<void> switchDrive(String drive) async {}
  @override
  Future<String?> getPeerId() async => 'peer';
  @override
  Future<String> getDeviceName() async => 'Telefoon';
  @override
  Future<void> setDeviceName(String name) async {}
  @override
  Future<List<Map<String, String>>> getKnownPeers() async => const [];
  @override
  Future<Set<String>> livePeerIds() async => {};
  @override
  Future<void> removeKnownPeer(String nodeId) async {}
  @override
  Future<void> pair(BuildContext context) async {}
  @override
  Future<void> Function()? get signOut => () async {};
  @override
  Future<String> Function(String secret)? get signInWithSecret =>
      (secret) async => strings.addedToAccount(['"Notities"', '"Recepten"']);
}

Future<void> openPanel(WidgetTester tester, Locale locale) async {
  tester.binding.defaultBinaryMessenger
      .setMockMethodCallHandler(SystemChannels.platform, (call) async => null);
  addTearDown(() => tester.binding.defaultBinaryMessenger
      .setMockMethodCallHandler(SystemChannels.platform, null));
  await tester.binding.setSurfaceSize(const Size(600, 2400));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(MaterialApp(
    locale: locale,
    supportedLocales: [locale],
    localizationsDelegates: const [_AnyMaterial(), _AnyCupertino()],
    home: Builder(
      builder: (context) => Scaffold(
        body: TextButton(
          onPressed: () => showAtomicUserDialog(context, backend: _Backend()),
          child: const Text('open'),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('open'));
  await tester.runAsync(() => Future<void>.delayed(Duration.zero));
  await tester.pumpAndSettle();
}

void main() {
  tearDown(() => AtomicStrings.override = null);

  testWidgets('the panel is Dutch when the locale is Dutch', (tester) async {
    await openPanel(tester, const Locale('nl'));
    expect(find.text('Gebruiker'), findsOneWidget);
    expect(find.text('Geheime sleutel kopiëren'), findsOneWidget);
    expect(find.text('Uitloggen'), findsOneWidget);
    expect(find.text('Inloggen met een geheime sleutel'), findsOneWidget);
    expect(find.text('Dit apparaat'), findsOneWidget);
    // The default guest name and drive read as Dutch; stored data is not
    // renamed.
    expect(find.text('Ik'), findsOneWidget);
    expect(find.text('Mijn drive'), findsWidgets);
    expect(find.text('Sign out'), findsNothing);
    expect(find.textContaining('orkspace'), findsNothing);

    // The drive list.
    await tester.tap(find.text('Mijn drive').first);
    await tester.pumpAndSettle();
    expect(find.text('Nieuwe drive'), findsOneWidget);
    expect(find.text('Recepten'), findsOneWidget);
  });

  testWidgets('the panel is English for every other locale, and says Drive',
      (tester) async {
    await openPanel(tester, const Locale('fr'));
    expect(find.text('Sign out'), findsOneWidget);
    expect(find.text('Copy secret key'), findsOneWidget);
    expect(find.text('Me'), findsOneWidget);
    expect(find.text("Me's Drive"), findsWidgets);
    expect(find.textContaining('orkspace'), findsNothing);
  });

  testWidgets('an app can force a language', (tester) async {
    AtomicStrings.override = AtomicStrings.nl;
    await openPanel(tester, const Locale('en'));
    expect(find.text('Uitloggen'), findsOneWidget);
  });

  test('the sign-in line is Dutch and names the drives', () {
    expect(AtomicStrings.nl.addedToAccount(['"Notities"', '"Recepten"']),
        'Toegevoegd aan je account: "Notities" en "Recepten".');
    expect(AtomicStrings.nl.addedToAccount(['"A"', '"B"', '"C"']),
        'Toegevoegd aan je account: "A", "B" en "C".');
    expect(AtomicStrings.en.addedToAccount(['"Notes"', '"Recipes"']),
        'Added to your account: "Notes" and "Recipes".');
    expect(AtomicStrings.en.addedToAccount(['"Notes"']),
        'Added to your account: "Notes".');
  });

  test('Dutch text has no em dash and no en dash used as a dash', () {
    final source = File('lib/src/strings.dart').readAsStringSync();
    expect(source.contains('—'), isFalse);
    expect(source.contains(' – '), isFalse);
    // The same for what the strings produce.
    final nl = AtomicStrings.nl;
    final samples = [
      nl.signOutBody,
      nl.inviteCopiedPeer,
      nl.driveNotOnDevice,
      nl.someoneElsesDevice,
      nl.addDeviceBody,
      nl.noOtherDevicesOrServer,
      nl.signedIn,
      nl.driveNotHereYet(3),
      nl.syncedToServer(2, 'x'),
      nl.relationReplica,
    ];
    for (final text in samples) {
      expect(text.contains('—'), isFalse, reason: text);
      expect(text.contains(' – '), isFalse, reason: text);
    }
  });

  test('English says Drive, never Workspace', () {
    final source = File('lib/src/strings.dart').readAsStringSync();
    expect(source.toLowerCase().contains('workspace'), isFalse);
  });
}
