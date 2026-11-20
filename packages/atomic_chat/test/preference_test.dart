import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The private drive, in memory: what a host's store would hold.
class _Drive extends PreferenceDrive {
  final Map<String, String> values;
  final List<MapEntry<String, String>> writes = [];

  /// Reading answers null (unreadable) while false.
  bool readable = true;
  bool failWrites = false;

  _Drive([Map<String, String>? values]) : values = values ?? {};

  @override
  Future<String?> read(String property) async =>
      readable ? (values[property] ?? '') : null;

  @override
  Future<void> write(String property, String value) async {
    if (failWrites) throw StateError('offline');
    writes.add(MapEntry(property, value));
    values[property] = value;
  }
}

Preference<bool> _flag() => Preference<bool>(
      property: 'https://atomicdata.dev/preferences/v1/test-flag',
      defaultValue: true,
      legacyKey: 'test_flag',
      encode: (v) => '$v',
      decode: (t) => switch (t) {
        'true' => true,
        'false' => false,
        _ => null,
      },
    );

const _flagProperty = 'https://atomicdata.dev/preferences/v1/test-flag';

void main() {
  group('WebPreferences', () {
    test('properties, defaults and encoding match the web app', () {
      const base = 'https://atomicdata.dev/preferences/v1/';
      expect(WebPreferences.mainColor.property, '${base}main-color');
      expect(WebPreferences.interfaceLanguage.property,
          '${base}interface-language');
      expect(WebPreferences.hideTemplates.property, '${base}hide-templates');
      expect(WebPreferences.mainColor.defaultValue, '#1b50d8');
      expect(WebPreferences.interfaceLanguage.defaultValue, 'en');
      expect(WebPreferences.hideTemplates.defaultValue, isFalse);
      expect(WebPreferences.hideTemplates.encode(true), 'true');
      expect(WebPreferences.hideTemplates.encode(false), 'false');
      expect(WebPreferences.hideTemplates.decode('true'), isTrue);
      expect(WebPreferences.hideTemplates.decode('false'), isFalse);
      expect(WebPreferences.hideTemplates.decode('x'), isNull);
      expect(WebPreferences.mainColor.decode('#4C6FA5'), '#4C6FA5');
      expect(WebPreferences.interfaceLanguage.encode('nl'), 'nl');
    });
  });

  setUp(() => SharedPreferences.setMockInitialValues({}));
  tearDown(() => Preference.drive = null);

  test('the default when neither the drive nor the device has a value',
      () async {
    Preference.drive = _Drive();
    final p = _flag();
    await p.load();
    expect(p.value, isTrue);
  });

  test('the drive wins over the old device key, and refreshes it', () async {
    SharedPreferences.setMockInitialValues({'test_flag': true});
    final drive = _Drive({_flagProperty: 'false'});
    Preference.drive = drive;
    final p = _flag();
    await p.load();
    expect(p.value, isFalse);
    expect((await SharedPreferences.getInstance()).getBool('test_flag'),
        isFalse);
    expect(drive.writes, isEmpty);
  });

  test('without a drive value the old device key is used and carried over once',
      () async {
    SharedPreferences.setMockInitialValues({'test_flag': false});
    final drive = _Drive();
    Preference.drive = drive;
    final p = _flag();
    await p.load();
    await pumpEventQueue();
    expect(p.value, isFalse);
    expect(drive.writes.map((w) => '${w.key}=${w.value}'),
        ['$_flagProperty=false']);

    await p.load();
    await pumpEventQueue();
    expect(drive.writes, hasLength(1));
  });

  test('an old key at the default is not written to the drive', () async {
    SharedPreferences.setMockInitialValues({'test_flag': true});
    final drive = _Drive();
    Preference.drive = drive;
    await _flag().load();
    await pumpEventQueue();
    expect(drive.writes, isEmpty);
  });

  test('an unreadable drive keeps the device value and writes nothing',
      () async {
    SharedPreferences.setMockInitialValues({'test_flag': false});
    final drive = _Drive()..readable = false;
    Preference.drive = drive;
    final p = _flag();
    await p.load();
    await pumpEventQueue();
    expect(p.value, isFalse);
    expect(drive.writes, isEmpty);
  });

  test('without a drive at all it is a device setting', () async {
    final p = _flag();
    await p.set(false);
    expect((await SharedPreferences.getInstance()).getBool('test_flag'),
        isFalse);
    final again = _flag();
    await again.load();
    expect(again.value, isFalse);
  });

  test('a choice shows at once, is cached and written to the drive', () async {
    final drive = _Drive();
    Preference.drive = drive;
    final p = _flag();
    var told = 0;
    p.addListener(() => told++);

    await p.set(false);
    expect(p.value, isFalse);
    expect(told, 1);
    expect((await SharedPreferences.getInstance()).getBool('test_flag'),
        isFalse);
    await pumpEventQueue();
    expect(drive.values[_flagProperty], 'false');
  });

  test('a failing write is not thrown into the UI and the choice stands',
      () async {
    final drive = _Drive()..failWrites = true;
    Preference.drive = drive;
    final p = _flag();
    await p.set(false);
    await pumpEventQueue();
    expect(p.value, isFalse);
    expect(drive.writes, isEmpty);
  });

  test('quick changes are written in the order they were made', () async {
    final drive = _Drive();
    Preference.drive = drive;
    final p = _flag();
    await p.set(false);
    await p.set(true);
    await pumpEventQueue();
    expect(drive.writes.map((w) => w.value), ['false', 'true']);
  });

  group('AppSidebarIcons', () {
    tearDown(() => AppSidebarIcons.show.value = true);

    test('is the show-sidebar-icons preference, on by default', () async {
      expect(AppSidebarIcons.show.property,
          'https://atomicdata.dev/preferences/v1/show-sidebar-icons');
      await AppSidebarIcons.load();
      expect(AppSidebarIcons.show.value, isTrue);
    });

    test('reads the drive and writes booleans as true/false', () async {
      final drive = _Drive({
        'https://atomicdata.dev/preferences/v1/show-sidebar-icons': 'false'
      });
      Preference.drive = drive;
      await AppSidebarIcons.load();
      expect(AppSidebarIcons.show.value, isFalse);

      await AppSidebarIcons.choose(true);
      await pumpEventQueue();
      expect(
          drive.values[
              'https://atomicdata.dev/preferences/v1/show-sidebar-icons'],
          'true');
      expect((await SharedPreferences.getInstance())
          .getBool(AppSidebarIcons.key), isTrue);
    });
  });

  group('AppThemeMode', () {
    tearDown(() => AppThemeMode.mode.value = ThemeMode.system);

    test('maps to the web values auto, dark and light', () {
      expect(AppThemeMode.name(ThemeMode.system), 'auto');
      expect(AppThemeMode.name(ThemeMode.dark), 'dark');
      expect(AppThemeMode.name(ThemeMode.light), 'light');
      expect(AppThemeMode.parse('auto'), ThemeMode.system);
      expect(AppThemeMode.parse('sepia'), isNull);
    });

    test('reads the drive, else the old device key', () async {
      SharedPreferences.setMockInitialValues({AppThemeMode.key: 'light'});
      final drive = _Drive({
        'https://atomicdata.dev/preferences/v1/theme': 'dark',
      });
      Preference.drive = drive;
      await AppThemeMode.load();
      expect(AppThemeMode.mode.value, ThemeMode.dark);

      // The drive's value is now this device's cache too.
      expect((await SharedPreferences.getInstance()).get(AppThemeMode.key),
          'dark');

      // A device that chose before preferences synced: only the old key.
      SharedPreferences.setMockInitialValues({AppThemeMode.key: 'light'});
      drive.values.clear();
      AppThemeMode.mode.value = ThemeMode.system;
      await AppThemeMode.load();
      await pumpEventQueue();
      expect(AppThemeMode.mode.value, ThemeMode.light);
      expect(drive.values['https://atomicdata.dev/preferences/v1/theme'],
          'light');
    });

    test('a choice is written as the web name; an unknown one is ignored',
        () async {
      final drive = _Drive();
      Preference.drive = drive;
      await AppThemeMode.choose('light');
      await pumpEventQueue();
      expect(AppThemeMode.mode.value, ThemeMode.light);
      expect(drive.values['https://atomicdata.dev/preferences/v1/theme'],
          'light');
      expect((await SharedPreferences.getInstance())
          .getString(AppThemeMode.key), 'light');

      await AppThemeMode.choose('sepia');
      expect(AppThemeMode.mode.value, ThemeMode.light);
    });
  });
}
