import 'package:flutter/material.dart';
import 'preference.dart';

/// The person's light/dark choice for the whole app, made on the settings
/// page or the app's own Appearance section (Auto, Dark, Light), a [Preference]
/// shared with the web app. The host app's `MaterialApp` listens to [mode];
/// without a choice the app follows the system.
class AppThemeMode {
  AppThemeMode._();

  /// The `theme` preference on the private drive (`auto`, `dark`, `light`,
  /// the web app's values), so a choice on the phone shows on the web and the
  /// other way round.
  static final Preference<ThemeMode> mode = Preference<ThemeMode>(
    property: PreferenceProperty.theme,
    defaultValue: ThemeMode.system,
    legacyKey: key,
    encode: name,
    decode: parse,
  );

  /// SharedPreferences key (the local cache of the preference).
  static const key = 'app_theme_mode';

  /// The page's name of a choice ('auto', 'dark', 'light'), null for anything
  /// else.
  static ThemeMode? parse(Object? name) => switch (name) {
        'auto' => ThemeMode.system,
        'dark' => ThemeMode.dark,
        'light' => ThemeMode.light,
        _ => null,
      };

  /// The page's name of [mode].
  static String name(ThemeMode mode) => switch (mode) {
        ThemeMode.system => 'auto',
        ThemeMode.dark => 'dark',
        ThemeMode.light => 'light',
      };

  /// The saved choice, into [mode].
  static Future<void> load() => mode.load();

  /// A choice (from the page or the settings): shown at once, saved for the
  /// next start and written to the private drive.
  static Future<void> choose(String name) async {
    final chosen = parse(name);
    if (chosen == null) return;
    await mode.set(chosen);
  }
}
