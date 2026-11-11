import 'package:atomic_flutter/atomic_flutter.dart' as shared;
import 'package:atomic_store_flutter/atomic_store_flutter.dart'
    show SecureAccountSessionStore;
import 'package:flutter/foundation.dart' show visibleForTesting;

import 'atomic_auth.dart';
import 'atomic_client.dart';
import 'session.dart' show createSecureStorage;

/// What the person's managed account says about one workspace: the address it
/// belongs to, and whether Cloud Vault (encrypted backup) and Cloud Server
/// (a hosted, readable copy) are on for it.
class AccountSummary {
  const AccountSummary({
    required this.address,
    required this.portal,
    this.vault,
    this.server,
  });

  final String address;
  final Uri portal;

  /// The drive's Cloud Vault enrollment as the control plane reports it, or
  /// null when it is off (or could not be read).
  final Map<String, dynamic>? vault;

  /// The drive's Cloud Server enrollment, null when off.
  final Map<String, dynamic>? server;
}

/// The linked account's session, kept by the shared secure store
/// (`SecureAccountSessionStore`): a bearer token or cookie for one portal.
class AccountStore {
  static shared.AtomicAccountSessionStore _store =
      SecureAccountSessionStore(storage: createSecureStorage());

  @visibleForTesting
  static set store(shared.AtomicAccountSessionStore store) => _store = store;

  static shared.AtomicAccountSessionStore get sessionStore => _store;
  static Future<void> save(String session) => _store.save(session);
  static Future<void> clear() => _store.clear();
  static Future<String?> read() => _store.read();

  /// The portal agents sign in to when no portal is linked yet.
  static const defaultPortal = 'https://atomic.place';

  /// The agent the portal last refused to sign in, and when: not asked again
  /// for [_refusalLasts], so every chat opening is not a round trip, yet an
  /// account made since (in a browser, or by a link opened later) is found.
  static String? _attemptedAgent;
  static DateTime? _attemptedAt;
  static const _refusalLasts = Duration(minutes: 2);

  /// Asks the portal to mail [email] a link that creates the account with the
  /// active agent as its identity (no new identity, nothing is switched).
  /// Throws a [StateError] with the portal's words when refused.
  static Future<void> signUpWithAgent(String email,
      {String portal = defaultPortal}) async {
    final info = await AtomicClient.getActiveAgent();
    if (info == null) throw StateError('This device has no identity yet');
    final agent = AtomicAgent.fromSecret(info.secret);
    final client = shared.AtomicAccountClient(portal);
    try {
      await client.signUpWithAgent(email, agent.subject,
          (message) async => signMessage(message, agent.privateKeyB64));
      // Sign-in may have been refused before the account existed; let the
      // next look-up try it again.
      _attemptedAgent = null;
      _attemptedAt = null;
    } finally {
      client.close();
    }
  }

  /// Signs the account in with the active agent when nothing is saved, the way
  /// the web app does, so an agent that is an account identity needs no link
  /// code. True when a session is now saved. Silent otherwise: no account, no
  /// agent or no network all leave things as they were, and a network failure
  /// is tried again on the next start.
  static Future<bool> signInWithAgent({String portal = defaultPortal}) async {
    try {
      if (await read() != null) return true;
      final info = await AtomicClient.getActiveAgent();
      if (info == null) return false;
      final at = _attemptedAt;
      if (_attemptedAgent == info.subject &&
          at != null &&
          DateTime.now().difference(at) < _refusalLasts) {
        return false;
      }
      final agent = AtomicAgent.fromSecret(info.secret);
      final client = shared.AtomicAccountClient(portal);
      try {
        final signedIn = await client.signInWithAgent(agent.subject,
            (message) async => signMessage(message, agent.privateKeyB64));
        // A refusal holds for a while; an unreachable portal throws below.
        _attemptedAgent = info.subject;
        _attemptedAt = DateTime.now();
        if (!signedIn) return false;
        await save(client.exportSession());
        return true;
      } finally {
        client.close();
      }
    } catch (_) {
      return false;
    }
  }

  /// The saved session, if the portal no longer takes it (it expired or was
  /// signed out elsewhere: 401), is dropped and the agent signs in again,
  /// as on a fresh start. True when a new session is saved. A session that
  /// still works, or a portal that cannot be reached, leaves things as
  /// they are.
  static Future<bool> renewExpired() async {
    final saved = await read();
    if (saved == null) return false;
    final Uri origin;
    try {
      origin = shared.AtomicAccountClient.sessionOrigin(saved);
    } catch (_) {
      return false;
    }
    final client = shared.AtomicAccountClient(origin.toString())
      ..restoreSession(saved);
    try {
      await client.account();
      return false;
    } on StateError catch (e) {
      if (e.message != expiredMessage) return false;
    } catch (_) {
      return false;
    } finally {
      client.close();
    }
    await clear();
    _attemptedAgent = null;
    return signInWithAgent(portal: origin.toString());
  }

  /// What the account client says for a 401.
  @visibleForTesting
  static const expiredMessage = 'Sign in again to continue';

  /// The `session_token` cookie that signs a web view in to [portal] as the
  /// active agent, or null when it cannot (no agent, not an account identity,
  /// unreachable). Reuses the saved session when it is a cookie one for this
  /// portal; otherwise does a fresh agent sign-in, because a bearer token from
  /// the link flow cannot become a cookie. Never throws, and never saves the
  /// result as the app's session.
  static Future<String?> portalCookie(Uri portal) async {
    try {
      final origin = shared.AtomicAccountClient.providerOrigin(
          portal.replace(path: '', query: null, fragment: null).toString());
      final saved = await read();
      if (saved != null) {
        try {
          final client = shared.AtomicAccountClient(origin.toString());
          try {
            client.restoreSession(saved);
            final cookie = client.sessionCookie;
            if (cookie != null) return cookie;
          } finally {
            client.close();
          }
        } catch (_) {
          // Another portal or a bearer token: sign in afresh below.
        }
      }
      final info = await AtomicClient.getActiveAgent();
      if (info == null) return null;
      final agent = AtomicAgent.fromSecret(info.secret);
      final client = shared.AtomicAccountClient(origin.toString());
      try {
        final ok = await client.signInWithAgent(agent.subject,
            (message) async => signMessage(message, agent.privateKeyB64));
        return ok ? client.sessionCookie : null;
      } finally {
        client.close();
      }
    } catch (_) {
      return null;
    }
  }

  /// The linked account's portal origin; null when none is linked.
  static Future<Uri?> portal() async {
    final saved = await read();
    return saved == null
        ? null
        : shared.AtomicAccountClient.sessionOrigin(saved);
  }

  /// The linked account's AI credits; null when no account is linked or the
  /// portal offers no included AI. Throws when the portal cannot be reached,
  /// so the caller can keep showing the last known balance.
  static Future<shared.AtomicAiCredits?> aiCredits() async {
    final saved = await read();
    if (saved == null) return null;
    final origin = shared.AtomicAccountClient.sessionOrigin(saved);
    final client = shared.AtomicAccountClient(origin.toString())
      ..restoreSession(saved);
    try {
      return await client.aiCredits();
    } finally {
      client.close();
    }
  }

  /// The linked account's AI usage this period; null when no account is
  /// linked or the portal has no usage report (older portals). Throws when
  /// the portal cannot be reached.
  static Future<shared.AtomicAiUsage?> aiUsage() async {
    final saved = await read();
    if (saved == null) return null;
    final origin = shared.AtomicAccountClient.sessionOrigin(saved);
    final client = shared.AtomicAccountClient(origin.toString())
      ..restoreSession(saved);
    try {
      return await client.aiUsage();
    } finally {
      client.close();
    }
  }

  /// Every model the linked account may choose; null when no account is
  /// linked or the portal has no list (older portals). Throws when the portal
  /// cannot be reached.
  static Future<List<shared.AtomicAiModel>?> aiModels() async {
    final saved = await read();
    if (saved == null) return null;
    final origin = shared.AtomicAccountClient.sessionOrigin(saved);
    final client = shared.AtomicAccountClient(origin.toString())
      ..restoreSession(saved);
    try {
      return await client.aiModels();
    } finally {
      client.close();
    }
  }

  /// The linked account's state for [drive]; null when no account is linked.
  /// Throws when it is linked but the portal cannot be read, so a failed read
  /// is not shown as "not linked".
  static Future<AccountSummary?> summary(String? drive) async {
    final saved = await read();
    if (saved == null) return null;
    final origin = shared.AtomicAccountClient.sessionOrigin(saved);
    final client = shared.AtomicAccountClient(origin.toString())
      ..restoreSession(saved);
    try {
      final me = await client.account();
      Future<Map<String, dynamic>?> forDrive(
          Future<List<Map<String, dynamic>>> list) async {
        try {
          final all = await list;
          return all
              .where((e) => e['drive_subject'] == drive)
              .where((e) => e['status'] != 'Disabled')
              .firstOrNull;
        } catch (_) {
          return null;
        }
      }

      return AccountSummary(
        address: (me['address'] ?? me['email']) as String,
        portal: origin,
        vault: await forDrive(client.vaultDrives()),
        server: await forDrive(client.enrollments()),
      );
    } finally {
      client.close();
    }
  }
}
