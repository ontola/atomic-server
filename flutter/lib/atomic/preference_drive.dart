import 'dart:async';
import 'dart:convert';

import 'package:atomic_chat/atomic_chat.dart'
    show
        AppSidebarIcons,
        AppThemeMode,
        Preference,
        PreferenceDrive,
        WebPreferences;
import 'package:flutter/foundation.dart' show debugPrint;

import 'atomic_client.dart';

/// The person's private (Personal) drive as the place settings live: the same
/// resource and properties the web app writes (`preferences/v1`), read and
/// written through the local store like any other resource.
///
/// The drive is the one derived from the agent's key (the web app's
/// `Agent.privateDriveSubject`), which the embed host answers as
/// `privateDrive`. Booleans go over as `true`/`false` text; the bridge's
/// `setProperty` types them by the property's datatype.
class AtomicPreferenceDrive extends PreferenceDrive {
  const AtomicPreferenceDrive();

  Future<String> _drive() async =>
      jsonDecode(await AtomicClient.embedCall('privateDrive', '[]')) as String;

  @override
  Future<String?> read(String property) async {
    try {
      return await AtomicClient.getProperty(await _drive(), property);
    } catch (_) {
      // No agent yet, or the drive is not on this device yet: unreadable,
      // which is not the same as having no value.
      return null;
    }
  }

  @override
  Future<void> write(String property, String value) async =>
      AtomicClient.setProperty(await _drive(), property, value);
}

/// Wires the app's preferences to the private drive. Called once at start.
void usePrivateDrivePreferences() {
  Preference.drive = const AtomicPreferenceDrive();
}

/// Reads the preferences again: after signing in, coming back to the app and
/// after a sync, because another device (the web app) may have changed them.
Future<void> reloadPreferences() async {
  try {
    await Future.wait([
      AppThemeMode.load(),
      AppSidebarIcons.load(),
      WebPreferences.load(),
    ]);
  } catch (e) {
    debugPrint('Reloading preferences failed: $e');
  }
}
