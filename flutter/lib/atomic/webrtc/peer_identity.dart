/// The names two peers must agree on without talking: the room, the peer id,
/// the channel binding and the signalling address. Each is the Dart twin of a
/// function in the web app, kept byte for byte (`browser/lib/src/
/// browser-peer-sync.ts`, `browser/lib/src/webrtc-peer.ts`,
/// `browser/data-browser/src/helpers/browserPeerSync.ts`).
library;

import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';

final _hex64 = RegExp(r'^[a-f0-9]{64}$');

bool isPeerToken(Object? value) => value is String && _hex64.hasMatch(value);

/// 256 random bits as 64 hex characters: a peer id, and a challenge nonce.
String randomPeerToken([Random? random]) {
  final rng = random ?? Random.secure();
  final buffer = StringBuffer();
  for (var i = 0; i < 32; i++) {
    buffer.write(rng.nextInt(256).toRadixString(16).padLeft(2, '0'));
  }
  return buffer.toString();
}

/// `did:ad:x` and `atomic:x` name one drive. The web keys everything on the
/// canonical `atomic:` spelling, so the room has to as well.
String canonicalDrive(String drive) =>
    drive.startsWith('did:ad:') ? 'atomic:${drive.substring(7)}' : drive;

/// Whether [drive] can meet its peers: only `atomic:` / `did:ad:` drives, as
/// on the web (`isAtomicIdentifier`). A server drive (`https://…`) syncs
/// through its server, and the peer session refuses it anyway.
bool isPeerDrive(String drive) {
  final d = canonicalDrive(drive);
  if (!d.startsWith('atomic:') || d.contains('#') || d.contains('?')) {
    return false;
  }
  final body = d.substring(7);
  return body.isNotEmpty &&
      !['agent:', 'commit:', 'blob:', 'prop:', 'node:']
          .any((kind) => body.startsWith(kind));
}

/// The rendezvous room of a drive: `sha256("atomic-browser-drive-v1:" +
/// drive)`, hex. Every device of a drive's members lands in the same room, and
/// the signalling service sees a hash, not the drive. Discovery is not
/// authorization: a stranger in the room still has to authenticate against the
/// drive's rights.
String automaticPeerRoom(String drive) => sha256
    .convert(utf8.encode('atomic-browser-drive-v1:${canonicalDrive(drive)}'))
    .toString();

/// What ties a peer link to the two DTLS certificates, independent of the
/// signalling: `sha256` over each side's `a=fingerprint:` values (deduplicated,
/// sorted, comma joined), the two strings sorted and joined with `|`. The
/// signed challenge covers it, so a relay that swaps certificates in the
/// signalling cannot carry an authenticated session.
String channelBinding(String localSdp, String remoteSdp) {
  String fingerprints(String sdp) {
    final values = RegExp(r'^a=fingerprint:(.+)$', multiLine: true)
        .allMatches(sdp)
        .map((m) => m.group(1)!.trim())
        .toSet()
        .toList()
      ..sort();
    if (values.isEmpty) {
      throw const FormatException('Missing WebRTC certificate fingerprint');
    }
    return values.join(',');
  }

  final both = [fingerprints(localSdp), fingerprints(remoteSdp)]..sort();
  return sha256.convert(utf8.encode(both.join('|'))).toString();
}

bool _isLoopback(String host) =>
    host == 'localhost' ||
    host == '127.0.0.1' ||
    host == '[::1]' ||
    host == '::1';

/// The signalling address as a WebSocket URL, or `null` when it is not
/// acceptable: only `wss`/`https`, or loopback for development. Nothing is
/// ever dialled for a rejected value.
Uri? acceptableSignalingUrl(String value) {
  final Uri url;
  try {
    url = Uri.parse(value.trim());
  } on FormatException {
    return null;
  }
  if (!url.hasAuthority || url.host.isEmpty) return null;
  final secure = url.scheme == 'wss' || url.scheme == 'https';
  final loopback =
      (url.scheme == 'ws' || url.scheme == 'http') && _isLoopback(url.host);
  if (!secure && !loopback) return null;
  final scheme = url.scheme == 'https' || url.scheme == 'wss' ? 'wss' : 'ws';
  return url.replace(scheme: scheme);
}

/// Where a drive's peers meet: the drive's own `signalingUrl` first, else
/// the hosted portal's `/webrtc-signal` (what the web app of that portal
/// uses), else nowhere.
Uri? peerSignalingUrl({String? driveSignalingUrl, String? portalUrl}) {
  final named = driveSignalingUrl?.trim() ?? '';
  if (named.isNotEmpty) {
    final url = acceptableSignalingUrl(named);
    if (url != null) return url;
  }
  if (portalUrl == null || portalUrl.isEmpty) return null;
  final portal = Uri.tryParse(portalUrl);
  if (portal == null) return null;
  return acceptableSignalingUrl(portal.resolve('/webrtc-signal').toString());
}
