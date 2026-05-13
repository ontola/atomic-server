import 'dart:convert';
import 'dart:typed_data';
import 'package:ed25519_edwards/ed25519_edwards.dart' as ed;
import 'package:http/http.dart' as http;
import 'atomic_client.dart';

String? _serverUrl;
String? _privateKeyB64;
String? _publicKeyB64;
String? _agentSubject;
String? _driveSubject;

const _strokeDataProp = 'https://atomicdata.dev/ontology/canvas/strokeData';
const _canvasClass = 'https://atomicdata.dev/ontology/canvas/Canvas';
const _isA = 'https://atomicdata.dev/properties/isA';
const _name = 'https://atomicdata.dev/properties/name';
const _parent = 'https://atomicdata.dev/properties/parent';
const _subject = 'https://atomicdata.dev/properties/subject';
const _createdAt = 'https://atomicdata.dev/properties/createdAt';
const _signer = 'https://atomicdata.dev/properties/signer';
const _signature = 'https://atomicdata.dev/properties/signature';
const _isGenesis = 'https://atomicdata.dev/properties/isGenesis';
const _previousCommit = 'https://atomicdata.dev/properties/previousCommit';
const _lastCommit = 'https://atomicdata.dev/properties/lastCommit';
const _destroy = 'https://atomicdata.dev/properties/destroy';
const _read = 'https://atomicdata.dev/properties/read';
const _write = 'https://atomicdata.dev/properties/write';
const _publicAgent = 'https://atomicdata.dev/agents/publicAgent';
const _driveClass = 'https://atomicdata.dev/classes/Drive';

// ── Agent ──────────────────────────────────────────────────────────────────

AgentInfo createAgent(String name) {
  final keyPair = ed.generateKey();
  final privateKeyB64 = base64Encode(ed.seed(keyPair.privateKey));
  final publicKeyB64 = base64Encode(keyPair.publicKey.bytes);
  final subject = 'did:ad:agent:$publicKeyB64';
  final secret = base64Encode(utf8.encode(jsonEncode({
    'privateKey': privateKeyB64,
    'subject': subject,
  })));
  return AgentInfo(
      secret: secret, subject: subject, publicKey: publicKeyB64, name: name);
}

AgentInfo agentFromSecret(String secret) {
  final decoded =
      jsonDecode(utf8.decode(base64Decode(secret))) as Map<String, dynamic>;
  final privKey = decoded['privateKey'] as String;
  final subject = decoded['subject'] as String;
  final seedBytes = Uint8List.fromList(base64Decode(privKey));
  final privateKey = ed.newKeyFromSeed(seedBytes);
  final publicKeyB64 = base64Encode(ed.public(privateKey).bytes);
  return AgentInfo(
      secret: secret, subject: subject, publicKey: publicKeyB64, name: null);
}

// ── Signing ────────────────────────────────────────────────────────────────

String _signMessage(String message, String privateKeyB64, String publicKeyB64) {
  final seedBytes = Uint8List.fromList(base64Decode(privateKeyB64));
  final privateKey = ed.newKeyFromSeed(seedBytes);
  final msgBytes = Uint8List.fromList(utf8.encode(message));
  final sig = ed.sign(privateKey, msgBytes);
  // ed.sign returns signature (64 bytes) + message. Take first 64 bytes.
  return base64Encode(sig.sublist(0, 64));
}

/// Serialize a map with sorted keys (JCS-like).
String _jcs(Map<String, dynamic> map) {
  final sorted = Map.fromEntries(
      map.entries.toList()..sort((a, b) => a.key.compareTo(b.key)));
  return jsonEncode(sorted);
}

int _now() => DateTime.now().millisecondsSinceEpoch;

/// Post a genesis commit (creates a new DID resource). Returns the subject.
Future<String> _postGenesisCommit(Map<String, dynamic> properties) async {
  final commitMap = <String, dynamic>{
    _signer: _agentSubject,
    _createdAt: _now(),
    _isGenesis: true,
  };

  // Add all properties
  for (final e in properties.entries) {
    commitMap[e.key] = e.value;
  }

  // Serialize without @id and signature for signing
  final toSign = _jcs(commitMap);
  final sig = _signMessage(toSign, _privateKeyB64!, _publicKeyB64!);
  final did = 'did:ad:$sig';

  commitMap[_subject] = did;
  commitMap[_signature] = sig;
  commitMap['@id'] = did;

  // Post without @id (server derives it)
  final body = Map<String, dynamic>.from(commitMap)..remove('@id');

  final resp = await http.post(
    Uri.parse('$_serverUrl/commit'),
    headers: {'Content-Type': 'application/json'},
    body: _jcs(body),
  );
  if (resp.statusCode != 200) {
    throw Exception('Commit failed (${resp.statusCode}): ${resp.body}');
  }
  return did;
}

/// Post a commit to an existing resource.
Future<void> _postCommit(String subject, Map<String, dynamic> setProps) async {
  // Get previous commit
  String? previousCommit;
  try {
    final res = await _getResource(subject);
    previousCommit = res[_lastCommit] as String?;
  } catch (_) {}

  final commitMap = <String, dynamic>{
    _subject: subject,
    _signer: _agentSubject,
    _createdAt: _now(),
    if (previousCommit != null) _previousCommit: previousCommit,
  };
  for (final e in setProps.entries) {
    commitMap[e.key] = e.value;
  }

  // Sign (without signature field)
  final toSign = _jcs(commitMap);
  final sig = _signMessage(toSign, _privateKeyB64!, _publicKeyB64!);
  commitMap[_signature] = sig;

  final body = Map<String, dynamic>.from(commitMap)..remove('@id');

  final resp = await http.post(
    Uri.parse('$_serverUrl/commit'),
    headers: {'Content-Type': 'application/json'},
    body: _jcs(body),
  );
  if (resp.statusCode != 200) {
    throw Exception('Commit failed (${resp.statusCode}): ${resp.body}');
  }
}

Future<Map<String, dynamic>> _getResource(String subject) async {
  final resp = await http.get(
    Uri.parse(subject),
    headers: {'Accept': 'application/ad+json'},
  );
  if (resp.statusCode != 200) throw Exception('Failed: ${resp.statusCode}');
  return jsonDecode(resp.body) as Map<String, dynamic>;
}

// ── Connection ─────────────────────────────────────────────────────────────

Future<String> connect(String serverUrl, String agentSecret) async {
  final info = agentFromSecret(agentSecret);
  _serverUrl = serverUrl;
  _privateKeyB64 = (jsonDecode(utf8.decode(base64Decode(agentSecret)))
      as Map<String, dynamic>)['privateKey'] as String;
  _publicKeyB64 = info.publicKey;
  _agentSubject = info.subject;
  return info.subject;
}

Future<String> createDrive(String name) async {
  final did = await _postGenesisCommit({
    _isA: [_driveClass],
    _name: name,
    _write: [_agentSubject],
    _read: [_publicAgent],
  });
  _driveSubject = did;
  return did;
}

void setDrive(String subject) => _driveSubject = subject;
String? getDrive() => _driveSubject;

// ── Canvas CRUD ────────────────────────────────────────────────────────────

Future<String> createCanvas(String name) async {
  final parent = _driveSubject ?? _serverUrl!;
  return _postGenesisCommit({
    _isA: [_canvasClass],
    _name: name,
    _parent: parent,
    _strokeDataProp: '[]',
  });
}

Future<String> loadCanvasStrokes(String subject) async {
  final res = await _getResource(subject);
  return res[_strokeDataProp]?.toString() ?? '[]';
}

Future<List<CanvasListItem>> listCanvases() async {
  if (_driveSubject == null) return [];
  try {
    await _getResource(_driveSubject!);
    // Children are listed in the drive's subResources or we query
    // For now return empty — server doesn't expose children list easily via JSON-AD
    return [];
  } catch (_) {
    return [];
  }
}

Future<void> deleteCanvas(String subject) async {
  await _postCommit(subject, {_destroy: true});
}

Future<void> renameCanvas(String subject, String name) async {
  await _postCommit(subject, {_name: name});
}
