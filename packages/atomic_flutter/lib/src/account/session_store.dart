/// Where a linked account's session is kept. The session is a bearer token or
/// cookie for one provider, so a real app keeps it in platform secure storage
/// (`SecureAccountSessionStore` in `package:atomic_store_flutter`), never in
/// preferences.
abstract class AtomicAccountSessionStore {
  /// The saved session, or null when no account is linked.
  Future<String?> read();

  /// Never throws: storage that is unavailable only means the link is not
  /// remembered after this run.
  Future<void> save(String session);
  Future<void> clear();
}

/// Keeps the session for this run only. For tests, and for hosts that do not
/// want an account link to outlive the process.
class MemoryAccountSessionStore implements AtomicAccountSessionStore {
  String? _session;

  @override
  Future<String?> read() async => _session;
  @override
  Future<void> save(String session) async => _session = session;
  @override
  Future<void> clear() async => _session = null;
}
