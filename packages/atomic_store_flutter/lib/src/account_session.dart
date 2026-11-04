import 'package:atomic_flutter/atomic_flutter.dart' as ui;
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Keeps the linked account's session in the OS keychain / keystore
/// (`flutter_secure_storage`), never in preferences. If the keychain will not
/// take it, the session lives in memory for this run.
///
/// Pass a [storage] to configure the platform options (the app in `flutter/`
/// does) or to fake it in tests.
class SecureAccountSessionStore implements ui.AtomicAccountSessionStore {
  SecureAccountSessionStore(
      {FlutterSecureStorage? storage, this.key = 'atomic_account_session'})
      : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  final String key;
  String? _memory;

  @override
  Future<String?> read() async {
    try {
      return await _storage.read(key: key) ?? _memory;
    } catch (e) {
      debugPrint('Reading the account session failed: $e');
      return _memory;
    }
  }

  @override
  Future<void> save(String session) async {
    _memory = session;
    try {
      await _storage.write(key: key, value: session);
    } catch (e) {
      debugPrint('Saving the account session failed: $e');
    }
  }

  @override
  Future<void> clear() async {
    _memory = null;
    try {
      await _storage.delete(key: key);
    } catch (e) {
      debugPrint('Deleting the account session failed: $e');
    }
  }
}
