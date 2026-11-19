import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The properties of the `https://atomicdata.dev/preferences/v1/` vocabulary
/// the app uses. The web app stores the same ones on the person's private
/// (Personal) drive, so a choice made on either shows up on the other.
abstract final class PreferenceProperty {
  static const _base = 'https://atomicdata.dev/preferences/v1/';
  static const theme = '${_base}theme';
  static const showSidebarIcons = '${_base}show-sidebar-icons';
  static const mainColor = '${_base}main-color';
  static const interfaceLanguage = '${_base}interface-language';
  static const hideTemplates = '${_base}hide-templates';
}

/// Where preferences are kept: the person's private drive, reached through the
/// host's store. Injected so this package never talks to a store itself; the
/// app sets [Preference.drive] at start-up and tests pass a fake.
abstract class PreferenceDrive {
  const PreferenceDrive();

  /// The text of [property] on the private drive: empty when the drive has no
  /// value, null when the drive cannot be read (no agent yet, not on this
  /// device yet), so nothing is carried over to it.
  Future<String?> read(String property);

  /// Writes [value] (`true`/`false` for a boolean, the name for a string) to
  /// the private drive; the host types it by the property's datatype.
  Future<void> write(String property, String value);
}

/// One setting: a property of the preferences vocabulary on the private drive,
/// shown as a [ValueNotifier] so screens follow it.
///
/// Load order: the drive's value, else the value this device saved before
/// preferences synced (the [legacyKey] in SharedPreferences), else
/// [defaultValue]. A [set] shows at once, is saved to SharedPreferences (a
/// cache for the next start) and written to the drive in the background; a
/// failing write is logged, never thrown into the UI. A device that has a
/// non-default old choice and a drive without a value writes it to the drive
/// once.
class Preference<T> extends ValueNotifier<T> {
  Preference({
    required this.property,
    required this.defaultValue,
    required this.legacyKey,
    required this.encode,
    required this.decode,
  }) : super(defaultValue);

  /// The host's way to the private drive; null (tests, before sign-in): the
  /// preference is only kept on this device.
  static PreferenceDrive? drive;

  /// The property's URL in the preferences vocabulary.
  final String property;

  final T defaultValue;

  /// The SharedPreferences key this device used before; still the local cache.
  final String legacyKey;

  /// A value as the drive's text (`true`, `dark`).
  final String Function(T value) encode;

  /// The drive's text as a value; null when it is none of the values.
  final T? Function(String text) decode;

  // One write at a time, so quick changes land in the order they were made.
  Future<void> _writes = Future.value();

  /// The value that was last read from or written to the drive, to tell
  /// whether the drive is behind.
  T? _onDrive;

  /// The drive [_onDrive] was read from or written to: another drive (a
  /// different person signed in) may not hold it yet.
  PreferenceDrive? _onDriveOf;

  /// What the device saved for [legacyKey]: a bool or a string.
  Object _cached(T value) => value is bool ? value : encode(value);

  T? _fromCache(Object? raw) {
    if (raw is T) return raw;
    if (raw is String) return decode(raw);
    return null;
  }

  /// Reads the saved value into [value]: see the load order above. Safe to
  /// call again (the drive may have changed from another device).
  Future<void> load() async {
    SharedPreferences? prefs;
    T? old;
    try {
      prefs = await SharedPreferences.getInstance();
      old = _fromCache(prefs.get(legacyKey));
    } catch (_) {}

    T? onDrive;
    var readable = false;
    try {
      final text = await drive?.read(property);
      readable = text != null;
      if (text != null && text.isNotEmpty) onDrive = decode(text);
    } catch (e) {
      debugPrint('Reading preference $property failed: $e');
    }
    _onDrive = onDrive;
    _onDriveOf = drive;

    final chosen = onDrive ?? old ?? defaultValue;
    if (value != chosen) value = chosen;

    if (onDrive != null) {
      if (prefs != null && old != onDrive) await _cache(prefs, onDrive);
    } else if (readable && old != null && old != defaultValue) {
      // The choice predates synced preferences: carry it over, once.
      unawaited(_save(old));
    }
  }

  /// A choice: shown at once, saved for the next start and written to the
  /// drive in the background.
  Future<void> set(T next) async {
    value = next;
    try {
      await _cache(await SharedPreferences.getInstance(), next);
    } catch (_) {}
    unawaited(_save(next));
  }

  Future<void> _cache(SharedPreferences prefs, T next) async {
    final saved = _cached(next);
    if (saved is bool) {
      await prefs.setBool(legacyKey, saved);
    } else {
      await prefs.setString(legacyKey, saved as String);
    }
  }

  Future<void> _save(T next) {
    final target = drive;
    if (target == null) return Future.value();
    return _writes = _writes.then((_) async {
      if (identical(_onDriveOf, target) && _onDrive == next) return;
      try {
        await target.write(property, encode(next));
        _onDrive = next;
        _onDriveOf = target;
      } catch (e) {
        debugPrint('Saving preference $property failed: $e');
      }
    });
  }
}
