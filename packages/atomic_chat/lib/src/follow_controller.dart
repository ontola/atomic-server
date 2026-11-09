import 'package:flutter/foundation.dart';

/// Whom this device is following (the web's follow mode), if anyone. One per
/// app, kept by the [ShellController]: the page that is open follows the
/// leader's pages, and leaving by hand stops it.
class FollowController extends ChangeNotifier {
  String? _agent;
  String? _session;
  String? _meeting;
  String? _name;

  /// The session that was tapped: follow the device the person is using, not
  /// whichever of their devices announced last (someone following themselves
  /// has several).
  String? get session => _session;

  /// The agent being followed; null when not following.
  String? get agent => _agent;

  /// The meeting the followed person leads, when following started from it
  /// (Join on the live strip, an avatar in the meeting).
  String? get meeting => _meeting;

  /// The followed person's name, when known.
  String? get name => _name;

  bool isFollowing(String agent) => _agent == agent;

  void follow(String agent, {String? session, String? meeting, String? name}) {
    if (_agent == agent &&
        _session == session &&
        (meeting == null || _meeting == meeting) &&
        (name == null || _name == name)) {
      return;
    }
    if (_agent != agent) {
      _meeting = null;
      _name = null;
    }
    _agent = agent;
    _session = session;
    _meeting = meeting ?? _meeting;
    _name = name ?? _name;
    notifyListeners();
  }

  void stop() {
    if (_agent == null) return;
    _agent = null;
    _session = null;
    _meeting = null;
    _name = null;
    notifyListeners();
  }
}
