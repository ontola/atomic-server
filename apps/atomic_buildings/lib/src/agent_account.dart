import 'dart:convert';
import 'dart:typed_data';

import 'package:atomic_chat/atomic_chat.dart' show HostedAi;
import 'package:atomic_flutter/atomic_flutter.dart' show AtomicAccountClient;
import 'package:ed25519_edwards/ed25519_edwards.dart' as ed;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// The portal agents sign in to (the same as the atomic.place app's).
const defaultPortal = 'https://atomic.place';

Uint8List _decode(String input) {
  final standard = input.replaceAll('-', '+').replaceAll('_', '/');
  final rest = standard.length % 4;
  return base64Decode(rest == 0 ? standard : standard + '=' * (4 - rest));
}

/// The signing key and subject in an agent secret (the one-string, base64
/// JSON secret of [Identity.secret]).
class AgentKey {
  const AgentKey(this.subject, this.seed);

  factory AgentKey.fromSecret(String secret) {
    final json = jsonDecode(utf8.decode(_decode(secret))) as Map;
    return AgentKey(
        json['subject'] as String, _decode(json['privateKey'] as String));
  }

  final String subject;
  final Uint8List seed;

  /// The signature of [message], base64url without padding as Atomic writes it.
  String sign(String message) {
    final key = ed.newKeyFromSeed(seed);
    final signature =
        ed.sign(key, Uint8List.fromList(utf8.encode(message))).sublist(0, 64);
    return base64Url.encode(signature).replaceAll('=', '');
  }
}

/// Where the linked account's session is kept between runs.
abstract class SessionStore {
  Future<String?> read();
  Future<void> save(String session);
  Future<void> clear();
}

/// The session in platform secure storage: it is a bearer token for the
/// portal, so it stays out of preferences. A store that cannot be used only
/// means the link is not remembered after this run.
class SecureSessionStore implements SessionStore {
  SecureSessionStore([FlutterSecureStorage? storage])
      : _storage = storage ?? const FlutterSecureStorage();
  static const _key = 'atomic_account_session';
  final FlutterSecureStorage _storage;
  String? _memory;

  @override
  Future<String?> read() async {
    try {
      return await _storage.read(key: _key) ?? _memory;
    } catch (_) {
      return _memory;
    }
  }

  @override
  Future<void> save(String session) async {
    _memory = session;
    try {
      await _storage.write(key: _key, value: session);
    } catch (_) {}
  }

  @override
  Future<void> clear() async {
    _memory = null;
    try {
      await _storage.delete(key: _key);
    } catch (_) {}
  }
}

/// The hosted AI of the atomic.place account of this device: the smallest
/// version of what the atomic.place app does. The account is the one linked
/// with the portal's own sign-in (any way it offers, approved in the browser,
/// see the link dialog), whose session is kept in [sessions]; without one, the
/// agent key signs in to an account that has this device's agent as its
/// identity. No account, or an unreachable portal, gives no AI.
class AgentAccount {
  AgentAccount(this.secret,
      {this.portal = defaultPortal,
      SessionStore? sessions,
      AtomicAccountClient Function(String portal)? client})
      : sessions = sessions ?? SecureSessionStore(),
        _client = client ?? AtomicAccountClient.new;

  final SessionStore sessions;

  /// The agent secret now, or null when signed out.
  final String? Function() secret;
  final String portal;
  final AtomicAccountClient Function(String portal) _client;

  /// The account's AI; null when there is no account for this device. Throws
  /// when the portal cannot be reached.
  Future<HostedAi?> hostedAi() async {
    final saved = await sessions.read();
    if (saved != null) {
      final client = _client(portal);
      try {
        client.restoreSession(saved);
        final ai = await _aiOf(client);
        if (ai != null) return ai;
      } on FormatException {
        client.close();
      } on StateError {
        client.close();
      }
      // Expired, another portal or damaged: the agent may still be an account.
      await sessions.clear();
    }
    final client = _client(portal);
    final secret = this.secret();
    if (secret != null) {
      final key = AgentKey.fromSecret(secret);
      if (await client.signInWithAgent(
          key.subject, (message) async => key.sign(message))) {
        await sessions.save(client.exportSession());
        return _aiOf(client);
      }
    }
    client.close();
    return null;
  }

  Future<HostedAi?> _aiOf(AtomicAccountClient client) async {
    final status = await client.aiStatus();
    if (status == null) {
      client.close();
      return null;
    }
    return HostedAi(
      status: status,
      completions: (messages, model, tools) =>
          client.chatCompletionChunks(messages, model: model, tools: tools),
      enable: client.aiConsent,
      transcribe: (wav, {language}) =>
          client.transcribe(wav, language: language),
      voiceStatus: client.voiceStatus,
      // The building chat sends photos and falls back when the model refuses.
      acceptsImages: true,
      portal: client.origin,
    );
  }
}
