import 'package:flutter/widgets.dart';
import 'preference.dart';

/// "Show icons in the sidebar" (Appearance): the icons, pictures, emoji and
/// avatars in front of the Home list's rows. On by default.
///
/// One setting for the app and the web app inside it: a [Preference] on the
/// person's private drive, which the page reads through the same store. The
/// settings page (embedded web) still reports a change with the `sidebarIcons`
/// call, and the app passes the value to every page (`?sidebarIcons=` at load,
/// `atomicEmbed.setSidebarIcons` when it changes).
class AppSidebarIcons {
  AppSidebarIcons._();

  /// The `show-sidebar-icons` preference on the private drive, so the web app
  /// (same default, same label) and every device share one choice.
  static final Preference<bool> show = Preference<bool>(
    property: PreferenceProperty.showSidebarIcons,
    defaultValue: true,
    legacyKey: key,
    encode: (v) => '$v',
    decode: (t) => switch (t) {
      'true' => true,
      'false' => false,
      _ => null,
    },
  );

  /// SharedPreferences key (the local cache of the preference).
  static const key = 'show_sidebar_icons';

  /// The saved choice, into [show].
  static Future<void> load() => show.load();

  /// A choice (settings, or the embedded page): shown at once, saved for the
  /// next start and written to the private drive.
  static Future<void> choose(bool value) => show.set(value);

  /// The page's argument of the call: `[true]` or `[false]`.
  static bool? parse(Object? args) =>
      args is List && args.isNotEmpty && args.first is bool
          ? args.first as bool
          : null;

  /// The query parameter a page is loaded with.
  static String get queryValue => show.value ? '1' : '0';
}

/// Tells the [ResourceRow]s below it whether to show their leading icon,
/// picture, emoji or avatar. Home wraps its list in a [SidebarIconsScope] that
/// follows [AppSidebarIcons.show]; a row outside one (search results, the
/// attachment sheet) always shows its leading.
class SidebarIconsScope extends StatelessWidget {
  final Widget child;

  /// Fixed value instead of [AppSidebarIcons.show] (tests).
  final bool? show;

  const SidebarIconsScope({super.key, required this.child, this.show});

  /// Whether rows below [context] show their leading; true outside a scope.
  static bool of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<_SidebarIcons>()?.show ?? true;

  @override
  Widget build(BuildContext context) {
    final fixed = show;
    if (fixed != null) return _SidebarIcons(show: fixed, child: child);
    return ValueListenableBuilder<bool>(
      valueListenable: AppSidebarIcons.show,
      child: child,
      builder: (context, show, child) =>
          _SidebarIcons(show: show, child: child!),
    );
  }
}

class _SidebarIcons extends InheritedWidget {
  final bool show;

  const _SidebarIcons({required this.show, required super.child});

  @override
  bool updateShouldNotify(_SidebarIcons old) => old.show != show;
}
