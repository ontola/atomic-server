/// Server URL handling, shared by every screen that takes one from a user.
///
/// Kept in step with `normalizeServerUrl` / `sameOrigin` in the data-browser's
/// SyncRoute: the same URL typed into either client should mean the same thing.
library;

/// A server URL as typed by a person, made into one that can be fetched.
///
/// Requiring a scheme is a papercut — people type `localhost:9883`. Local
/// addresses get `http` (there is no certificate on a dev box), everything
/// else `https`. An explicit scheme is always kept.
String normalizeServerUrl(String input) {
  final trimmed = input.trim().replaceAll(RegExp(r'/+$'), '');

  if (RegExp(r'^https?://', caseSensitive: false).hasMatch(trimmed)) {
    return trimmed;
  }

  if (trimmed.isEmpty) {
    return '';
  }

  final isLocal = RegExp(r'^(localhost|127\.0\.0\.1)(:\d+)?$', caseSensitive: false)
      .hasMatch(trimmed);

  return '${isLocal ? 'http' : 'https'}://$trimmed';
}

/// Whether two server URLs point at the same server — how "is this the one in
/// use?" is decided, tolerant of trailing slashes and paths.
bool sameOrigin(String a, String? b) {
  if (b == null || b.isEmpty) {
    return false;
  }

  try {
    final ua = Uri.parse(a);
    final ub = Uri.parse(b);

    return ua.scheme == ub.scheme && ua.host == ub.host && ua.port == ub.port;
  } catch (_) {
    return false;
  }
}

/// A server URL as shown to a person: the bare authority, keeping the port
/// (which distinguishes two dev servers) and dropping only the scheme.
String serverLabel(String url) {
  try {
    final parsed = Uri.parse(url);

    if (parsed.host.isEmpty) {
      return url;
    }

    return parsed.hasPort ? '${parsed.host}:${parsed.port}' : parsed.host;
  } catch (_) {
    return url;
  }
}
