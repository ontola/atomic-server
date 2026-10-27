import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The meeting this device leads ("I'm leading meeting X on drive D"). One per
/// app, kept by the [ShellController]: it is the app's, not a web page's,
/// because pages are replaced (following) and recycled, and a page's
/// `sessionStorage` goes with them. Saved in SharedPreferences, so a restart
/// resumes the meeting as well.
///
/// The announced presence entry carries it as `session` while it is set; the
/// resource page learns it through `atomicEmbed.setMeeting`.
class MeetingLead extends ChangeNotifier {
  /// SharedPreferences key of the saved lead.
  static const prefsKey = 'meetingLead';

  String? _drive;
  String? _meeting;
  final _trailed = <String>{};
  bool _disposed = false;

  /// The drive the meeting belongs to; null when not leading.
  String? get drive => _drive;

  /// The meeting being led; null when not leading.
  String? get meeting => _meeting;

  bool get leading => _meeting != null;

  /// The meeting led on [drive], if any. A meeting led on another drive is
  /// not announced on this one.
  String? meetingIn(String drive) => _drive == drive ? _meeting : null;

  /// Reads the saved lead (the app was restarted).
  Future<void> load() async {
    try {
      final p = await SharedPreferences.getInstance();
      if (_disposed || _meeting != null) return;
      final raw = p.getString(prefsKey);
      if (raw == null) return;
      final json = jsonDecode(raw);
      if (json is! Map) return;
      final drive = json['drive'];
      final meeting = json['meeting'];
      if (drive is! String || meeting is! String || meeting.isEmpty) return;
      _drive = drive;
      _meeting = meeting;
      _trailed
        ..clear()
        ..addAll([
          if (json['trailed'] is List)
            for (final s in json['trailed'] as List)
              if (s is String) s
        ]);
      notifyListeners();
    } catch (_) {
      // Not leading.
    }
  }

  /// This device starts leading [meeting] on [drive]. The meeting itself
  /// counts as visited: the web's leader does not trail the meeting page.
  void start(String drive, String meeting) {
    if (_drive == drive && _meeting == meeting) return;
    _drive = drive;
    _meeting = meeting;
    _trailed
      ..clear()
      ..add(meeting);
    _save();
    notifyListeners();
  }

  /// Stops leading; [meeting] given: only when it is the one being led (a
  /// late "ended" for an older meeting must not end a newer one).
  void end([String? meeting]) {
    if (_meeting == null) return;
    if (meeting != null && meeting != _meeting) return;
    _drive = null;
    _meeting = null;
    _trailed.clear();
    _save();
    notifyListeners();
  }

  /// Whether [resource] is new in the meeting's trail; true once per resource
  /// per meeting (the caller then posts its "Viewing" line).
  bool markTrailed(String resource) {
    if (_meeting == null || !_trailed.add(resource)) return false;
    _save();
    return true;
  }

  Future<void> _saving = Future.value();

  /// Writes the lead as it is by the time the write runs; writes go one
  /// after another, so a slow one never overwrites a newer state.
  void _save() {
    _saving = _saving.then((_) async {
      final value = _meeting == null
          ? null
          : jsonEncode({
              'drive': _drive,
              'meeting': _meeting,
              'trailed': _trailed.toList(),
            });
      final p = await SharedPreferences.getInstance();
      if (value == null) {
        await p.remove(prefsKey);
      } else {
        await p.setString(prefsKey, value);
      }
    }).catchError((Object _) {});
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
