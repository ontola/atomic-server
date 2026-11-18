import 'package:flutter/material.dart';

import 'client.dart';
import 'link_dialog.dart';
import 'session_store.dart';

/// How people know an account provider: its host, unless the app names it.
String accountProviderName(Uri provider, [String? label]) =>
    label != null && label.isNotEmpty ? label : provider.host;

/// Signs in with the account at [provider]: a code approved in the system
/// browser, which hands the account's identity back sealed. The session is
/// saved in [store]. Returns the identity to sign the app in with, or null
/// when the person cancelled. Without a handed-back identity it falls back to
/// the provider's assisted recovery, which throws [AtomicNoAssistedRecovery]
/// when the backup cannot be opened here. If the identity cannot be had, the
/// session is cleared again: a half-done sign-in must not look linked.
///
/// [client] is closed when done; pass one only in tests.
Future<AtomicRecoveredIdentity?> signInWithAccountProvider(
  BuildContext context, {
  required Uri provider,
  required AtomicAccountSessionStore store,
  required Future<void> Function(Uri url) openUrl,
  String deviceName = 'App',
  AtomicAccountClient? client,
}) async {
  final c = client ?? AtomicAccountClient(provider.toString());
  try {
    final linked = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (_) => AtomicAccountLinkDialog(
        client: c,
        deviceName: deviceName,
        save: store.save,
        handback: true,
        openInBrowser: openUrl,
      ),
    );
    if (linked != true) return null;
    try {
      return c.takeHandedBackIdentity() ?? await c.recoverIdentity();
    } catch (_) {
      await store.clear();
      rethrow;
    }
  } finally {
    c.close();
  }
}

/// The address of the account saved in [store], or the provider's host when
/// the provider cannot be reached; null when no account is linked.
Future<String?> linkedAccountLabel(AtomicAccountSessionStore store) async {
  final saved = await store.read();
  if (saved == null) return null;
  Uri origin;
  try {
    origin = AtomicAccountClient.sessionOrigin(saved);
  } catch (_) {
    return null;
  }
  final client = AtomicAccountClient(origin.toString())..restoreSession(saved);
  try {
    final me = await client.account().timeout(const Duration(seconds: 8));
    return (me['address'] ?? me['email'] ?? origin.host) as String;
  } catch (_) {
    return origin.host;
  } finally {
    client.close();
  }
}
