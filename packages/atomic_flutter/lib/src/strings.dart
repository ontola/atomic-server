import 'dart:ui' show PlatformDispatcher;

import 'package:flutter/widgets.dart';

import 'translations.g.dart';

/// Translates an English sentence (the key), filling `{name}` placeholders from
/// [args]: `t('{what} copied', {'what': label})`.
typedef Translate = String Function(String msgid, [Map<String, Object?>? args]);

/// Forces a language for every widget and note, whatever the locale says. An
/// app sets it once (for example from its own language setting) and back to
/// null to follow the locale again: `AtomicLocale.override = 'nl';`.
class AtomicLocale {
  static String? override;
}

/// [msgid] in [language] ('nl', 'de', 'fr', 'es', 'id'; anything else, and any
/// sentence without a translation, stays English), with [args] filled in.
///
/// The sentences live in `locales/*.po` and are compiled into
/// `translations.g.dart` by `node tools/flutter-i18n.mjs`.
String translate(String? language, String msgid,
    [Map<String, Object?>? args]) {
  final text = kTranslations[language]?[msgid] ?? msgid;
  if (args == null) return text;
  return text.replaceAllMapped(
      RegExp(r'\{(\w+)\}'), (m) => '${args[m[1]] ?? m[0]}');
}

/// English; the default where no locale is at hand.
String tEn(String msgid, [Map<String, Object?>? args]) =>
    translate('en', msgid, args);

/// A translator for a language code.
Translate tFor(String? language) =>
    (msgid, [args]) => translate(language, msgid, args);

/// A translator for [context]'s locale (and the device's when the tree has no
/// `Localizations`). Depends on the locale, so a language change rebuilds the
/// caller. [AtomicLocale.override] wins.
Translate tOf(BuildContext context) => tFor(AtomicLocale.override ??
    (Localizations.maybeLocaleOf(context) ?? PlatformDispatcher.instance.locale)
        .languageCode);

/// A stored agent name as shown: the default guest name "Me" is translated,
/// anything else is the person's own text. Display only.
String shownAgentName(Translate t, String name) =>
    name == 'Me' ? t('Me') : name;

/// A stored drive name as shown: the guest's default drive "Me's Drive" is
/// translated. Display only.
String shownDriveName(Translate t, String name) =>
    name == "Me's Drive" ? t("Me's Drive") : name;
