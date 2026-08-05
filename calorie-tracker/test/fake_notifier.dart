import 'package:calorie_tracker/services/notifications.dart';
import 'package:flutter/foundation.dart';

/// The notification centre, as far as anything above it can tell.
///
/// It models the only two things the app depends on: a question is outstanding
/// until it is withdrawn, and a tap names a meal. [asked] is a map rather than a
/// list so "the question about this meal" is a thing a test can ask about —
/// which is the property the clarify loop turns on.
class FakeNotifier implements Notifier {
  final Map<String, String> asked = {};

  /// Every subject ever asked about, in order, kept after a withdrawal — so a
  /// test can tell "asked once and withdrawn" from "never asked".
  final List<String> history = [];

  bool started = false;

  final ValueNotifier<String?> _opened = ValueNotifier(null);

  @override
  ValueListenable<String?> get opened => _opened;

  @override
  Future<void> start() async => started = true;

  @override
  Future<void> ask(String subject, String question) async {
    asked[subject] = question;
    history.add(subject);
  }

  @override
  Future<void> withdraw(String subject) async => asked.remove(subject);

  @override
  void handled() => _opened.value = null;

  /// Somebody taps the question about [subject].
  void tap(String subject) => _opened.value = subject;
}
