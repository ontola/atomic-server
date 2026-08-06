import 'package:calorie_tracker/services/background_estimation.dart';

/// A [TaskScheduler] with no OS behind it: the test VM has neither WorkManager
/// nor BGTaskScheduler, and what wants testing is which calls were made.
class FakeScheduler implements TaskScheduler {
  final List<String> calls = [];

  Object? startError;
  Object? scheduleError;

  @override
  Future<void> start() async {
    calls.add('start');
    if (startError != null) throw startError!;
  }

  @override
  Future<void> scheduleDrain() async {
    calls.add('schedule');
    if (scheduleError != null) throw scheduleError!;
  }

  @override
  Future<void> cancelDrain() async => calls.add('cancel');
}
