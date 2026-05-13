import 'dart:async';
import 'package:flutter/foundation.dart';
import 'atomic_client.dart';
import 'resource.dart';
import 'session.dart';

class AtomicStore extends ChangeNotifier {
  AgentInfo? _agent;
  String? _drive;
  bool _initialized = false;

  final Map<String, Resource> _cache = {};
  final Map<String, StreamController<Resource>> _controllers = {};

  AgentInfo? get agent => _agent;
  String? get drive => _drive;
  bool get isInitialized => _initialized;

  Future<void> init(String dbPath) async {
    await AtomicClient.openDb(dbPath);

    // Auto-login
    final session = await AtomicSession.load();
    if (session != null && session.secret.isNotEmpty) {
      await AtomicClient.loadAgent(session.secret);
      _agent = await AtomicClient.getActiveAgent();
      _drive = AtomicClient.getActiveDrive();
    }

    _initialized = true;
    notifyListeners();
  }

  Future<void> signIn(String secret) async {
    await AtomicClient.loadAgent(secret);
    _agent = await AtomicClient.getActiveAgent();
    _drive = AtomicClient.getActiveDrive();

    await AtomicSession.save(serverUrl: '', secret: secret, drive: _drive);

    notifyListeners();
  }

  Future<void> signOut() async {
    await AtomicSession.clear();
    _agent = null;
    _drive = null;
    _cache.clear();
    notifyListeners();
  }

  /// Observe changes to a specific resource.
  Stream<Resource> watch(String subject) {
    if (!_controllers.containsKey(subject)) {
      _controllers[subject] = StreamController<Resource>.broadcast();
      // If we already have it in cache, push it immediately
      if (_cache.containsKey(subject)) {
        Timer.run(() => _controllers[subject]!.add(_cache[subject]!));
      }
    }
    return _controllers[subject]!.stream;
  }

  /// Update a resource in the local cache and notify listeners.
  void notifyResourceChanged(Resource resource) {
    _cache[resource.subject] = resource;
    _controllers[resource.subject]?.add(resource);
  }

  Future<Resource> fetch(String subject) async {
    // For now, wrap the existing client fetch
    // In a real SDK, this would return our Resource object
    // Note: getProperty(subject, "all") doesn't exist yet, we'd need to add it to Rust.

    final resource = Resource(subject: subject);
    _cache[subject] = resource;
    return resource;
  }

  void setDrive(String driveSubject) {
    _drive = driveSubject;
    AtomicClient.setActiveDrive(driveSubject);
    AtomicSession.saveDrive(driveSubject);
    notifyListeners();
  }
}
