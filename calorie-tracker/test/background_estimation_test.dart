import 'package:calorie_tracker/services/background_estimation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_scheduler.dart';

/// When the app asks the OS to finish the queue for it.
///
/// The drain itself is [EstimationQueue], covered by `estimation_queue_test`,
/// and running one in a background isolate is something only a real device can
/// prove. What is testable here is the policy — and the policy is the part that
/// costs money if it is wrong, because a task that is not withdrawn on the way
/// back in estimates meals the foreground is already estimating.
void main() {
  late FakeScheduler scheduler;

  setUp(() => scheduler = FakeScheduler());

  Future<BackgroundEstimation> started() async {
    final background = BackgroundEstimation(scheduler: scheduler);
    await background.start();
    return background;
  }

  test('leaving with meals in the queue schedules a drain', () async {
    final background = await started();

    await background.whenBackgrounded(waiting: 2);

    expect(scheduler.calls, ['start', 'schedule']);
    expect(background.scheduled, isTrue);
  });

  test('leaving with an empty queue schedules nothing', () async {
    final background = await started();

    await background.whenBackgrounded(waiting: 0);

    expect(scheduler.calls, ['start']);
    expect(background.scheduled, isFalse);
  });

  test('coming back withdraws it — the app is faster than any scheduler',
      () async {
    final background = await started();
    await background.whenBackgrounded(waiting: 1);

    await background.whenForegrounded();

    expect(scheduler.calls, ['start', 'schedule', 'cancel']);
    expect(background.scheduled, isFalse);
  });

  test('coming back with nothing scheduled is not a cancel', () async {
    final background = await started();

    await background.whenForegrounded();

    expect(scheduler.calls, ['start']);
  });

  test('four trips through the app switcher are one scheduled drain', () async {
    final background = await started();

    await background.whenBackgrounded(waiting: 1);
    await background.whenBackgrounded(waiting: 1);
    await background.whenBackgrounded(waiting: 3);

    expect(scheduler.calls.where((c) => c == 'schedule').length, 1);
  });

  test('emptying the queue while away withdraws the request', () async {
    final background = await started();
    await background.whenBackgrounded(waiting: 1);

    // The estimates landed before the app went away for good — Android gives a
    // backgrounded process a while yet.
    await background.whenBackgrounded(waiting: 0);

    expect(scheduler.calls, ['start', 'schedule', 'cancel']);
  });

  // ── When the platform will not play ──────────────────────────────────────

  test('a device with no scheduler falls back to draining on next launch',
      () async {
    scheduler.startError = Exception('MissingPluginException');
    final background = BackgroundEstimation(scheduler: scheduler);

    await background.start();
    await background.whenBackgrounded(waiting: 5);

    expect(scheduler.calls, ['start'], reason: 'nothing was scheduled');
    expect(background.scheduled, isFalse);
  });

  test('a scheduler that refuses the task is not a crash', () async {
    scheduler.scheduleError = Exception('BGTaskScheduler refused');
    final background = await started();

    await background.whenBackgrounded(waiting: 1);

    expect(background.scheduled, isFalse,
        reason: 'nothing to withdraw later, because nothing was accepted');
  });
}
