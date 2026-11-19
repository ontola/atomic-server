import 'preference.dart';

/// The Appearance preferences that only the web pages in the app use, kept in
/// the same `preferences/v1` vocabulary on the private drive so the web app and
/// the app read each other's choices. The app edits them on its Settings screen.
class WebPreferences {
  WebPreferences._();

  static bool? _decodeBool(String t) => switch (t) {
        'true' => true,
        'false' => false,
        _ => null,
      };

  /// The accent colour as a hex string (`#1b50d8`).
  static final Preference<String> mainColor = Preference<String>(
    property: PreferenceProperty.mainColor,
    defaultValue: '#1b50d8',
    legacyKey: 'main_color',
    encode: (v) => v,
    decode: (t) => t.isEmpty ? null : t,
  );

  /// The interface language as a locale code (`en`, `nl`). It applies to the
  /// web pages in the app; the native UI is English.
  static final Preference<String> interfaceLanguage = Preference<String>(
    property: PreferenceProperty.interfaceLanguage,
    defaultValue: 'en',
    legacyKey: 'interface_language',
    encode: (v) => v,
    decode: (t) => t.isEmpty ? null : t,
  );

  /// Hide the templates on the new resource page.
  static final Preference<bool> hideTemplates = Preference<bool>(
    property: PreferenceProperty.hideTemplates,
    defaultValue: false,
    legacyKey: 'hide_templates',
    encode: (v) => '$v',
    decode: _decodeBool,
  );

  /// Reads all three.
  static Future<void> load() => Future.wait([
        mainColor.load(),
        interfaceLanguage.load(),
        hideTemplates.load(),
      ]);
}
