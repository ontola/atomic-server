import 'package:atomic_flutter/atomic_flutter.dart';
import 'package:atomic_flutter/src/translations.g.dart';
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
      (secret) async =>
          t('Added to your account: {names}.', {'names': '"Notities"'});
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
  tearDown(() => AtomicLocale.override = null);

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

  testWidgets('the panel is English for a locale without a catalog',
      (tester) async {
    await openPanel(tester, const Locale('ja'));
    expect(find.text('Sign out'), findsOneWidget);
    expect(find.text('Copy secret key'), findsOneWidget);
    expect(find.text('Me'), findsOneWidget);
    expect(find.text("Me's Drive"), findsWidgets);
    expect(find.textContaining('orkspace'), findsNothing);
  });

  testWidgets('an app can force a language', (tester) async {
    AtomicLocale.override = 'nl';
    await openPanel(tester, const Locale('en'));
    expect(find.text('Uitloggen'), findsOneWidget);
  });

  test('placeholders are filled, and a missing translation stays English', () {
    expect(translate('nl', '{what} copied', {'what': 'Link'}),
        'Link gekopieerd');
    expect(translate('en', '{what} copied', {'what': 'Link'}), 'Link copied');
    // A language without an entry for the sentence (or without a catalog).
    expect(translate('ja', 'Sign out'), 'Sign out');
    expect(translate('nl', 'Not in any catalog {x}', {'x': 1}),
        'Not in any catalog 1');
    // A placeholder without an argument is left as it is.
    expect(translate('en', '{a} and {b}', {'a': 1}), '1 and {b}');
  });

  test('the Dutch comes from the catalog', () {
    expect(
        translate('nl', 'Added to your account: {names}.',
            {'names': '"Notities" en "Recepten"'}),
        'Toegevoegd aan je account: "Notities" en "Recepten".');
    expect(translate('nl', '{n} more drives not on this device yet', {'n': 3}),
        '3 andere drives staan nog niet op dit apparaat');
    expect(shownDriveName(tFor('nl'), "Me's Drive"), 'Mijn drive');
    expect(shownDriveName(tFor('nl'), 'Recepten'), 'Recepten');
    expect(shownAgentName(tFor('en'), 'Me'), 'Me');
    expect(shownAgentName(tFor('nl'), 'Me'), 'Ik');
  });

  test('every translation keeps its placeholders', () {
    final holes = RegExp(r'\{(\w+)\}');
    String of(String s) =>
        (holes.allMatches(s).map((m) => m[1]!).toList()..sort()).join(',');
    kTranslations.forEach((lang, table) {
      table.forEach((en, text) {
        expect(of(text), of(en), reason: '$lang: $en');
      });
    });
  });

  test('Dutch text has no em dash and no en dash', () {
    for (final MapEntry(key: en, value: nl) in kTranslations['nl']!.entries) {
      expect(nl.contains('—') || nl.contains('–'), isFalse, reason: nl);
      expect(en.contains('—'), isFalse, reason: en);
    }
  });

  test('English says Drive, never Workspace', () {
    for (final en in kTranslations['nl']!.keys) {
      expect(en.toLowerCase().contains('workspace'), isFalse, reason: en);
    }
  });
}
