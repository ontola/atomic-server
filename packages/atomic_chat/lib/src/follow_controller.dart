import 'package:flutter/foundation.dart';

/// Whom this device is following (the web's follow mode), if anyone. One per
/// app, kept by the [ShellController]: the page that is open follows the
/// leader's pages, and leaving by hand stops it.
class FollowController extends ChangeNotifier {
  String? _agent;
  String? _session;

  /// The session that was tapped: follow the device the person is using, not
  /// whichever of their devices announced last (someone following themselves
  /// has several).
  String? get session => _session;

  /// The agent being followed; null when not following.
  String? get agent => _agent;

  bool isFollowing(String agent) => _agent == agent;

  void follow(String agent, {String? session}) {
    if (_agent == agent && _session == session) return;
    _agent = agent;
    _session = session;
    notifyListeners();
  }

  void stop() {
    if (_agent == null) return;
    _agent = null;
    _session = null;
    notifyListeners();
  }
}
