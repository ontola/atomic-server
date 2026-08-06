import 'dart:io';
import 'dart:ui';

import 'package:flutter/widgets.dart';
import 'package:path_provider/path_provider.dart';
import 'package:workmanager/workmanager.dart';

import 'app_session.dart';
import 'estimation_queue.dart';
import 'image_store.dart';
import 'meal_store.dart';
import 'notifications.dart';
import 'openrouter.dart';

/// Estimating the meals the app was killed with still in the queue.
///
/// Phase 6's other half (`calorie-tracker-plan.md` §8). Draining on the next
/// launch has worked since Phase 4 and remains the guarantee: everything here
/// is an attempt to be earlier than that, and every path through it is allowed
/// to do nothing.
///
/// What the two platforms actually give us, which is not the same thing:
///
/// - **Android** runs this for real. WorkManager persists the request across
///   process death and reboots, and runs it when the network constraint is met
///   — typically within minutes of the app going away. A meal photographed and
///   then forgotten about has its calories before the phone is picked up again.
/// - **iOS** runs it if it feels like it. `BGProcessingTask` is scheduled, not
///   promised: iOS decides from usage patterns, charge state and how long the
///   app has been idle, and an app that is rarely opened may go days without a
///   window. This is not a bug to fix — it is the API's contract — so iOS is
///   best-effort on top of the next-launch drain rather than instead of it.
///
/// The task is registered only when there is something waiting and cancelled
/// the moment the app comes back, so the two never estimate the same meal from
/// two directions if the OS can help it.
const String estimationTaskName = 'dev.atomicdata.calorieTracker.estimate';

/// How the app talks to the OS scheduler. A seam for the same reason
/// [CameraFeed] and [Notifier] are: the test VM has no WorkManager and no
/// BGTaskScheduler, and the *policy* — schedule when meals are waiting, cancel
/// when they are not — is what wants covering by fast tests.
/// [WorkmanagerTasks] is the real one.
abstract class TaskScheduler {
  /// Tell the OS which Dart entrypoint to call. Once per launch.
  Future<void> start();

  /// Ask for the queue to be drained when the OS next allows it.
  Future<void> scheduleDrain();

  /// Withdraw that request.
  Future<void> cancelDrain();
}

/// The real one: WorkManager on Android, BGTaskScheduler on iOS, via the
/// `workmanager` plugin.
class WorkmanagerTasks implements TaskScheduler {
  const WorkmanagerTasks();

  /// Long enough that the foreground drain the app fires on its way out gets
  /// to finish first, short enough to be the same evening. Android honours it;
  /// on iOS it is an `earliestBeginDate` hint and the system decides.
  static const delay = Duration(minutes: 2);

  @override
  Future<void> start() =>
      Workmanager().initialize(backgroundEstimationDispatcher);

  @override
  Future<void> scheduleDrain() {
    // Both platforms want a network: every meal in the queue is an HTTPS call
    // to OpenRouter, and waking up without one only burns the attempt.
    final constraints = Constraints(networkType: NetworkType.connected);

    if (Platform.isIOS) {
      // A processing task rather than a refresh one: iOS gives refresh tasks
      // ~30 seconds, and a queue of photographed meals is minutes of vision
      // calls. Processing tasks run while the device is idle and can be
      // interrupted, which is exactly the deal we want — an interrupted drain
      // leaves its meals `pending`, which is where they started.
      return Workmanager().registerProcessingTask(
        estimationTaskName,
        estimationTaskName,
        initialDelay: delay,
        constraints: constraints,
      );
    }

    return Workmanager().registerOneOffTask(
      estimationTaskName,
      estimationTaskName,
      initialDelay: delay,
      constraints: constraints,
      // One pending drain, not one per time the app was backgrounded. The
      // queue is read fresh when it runs, so a newer request says nothing the
      // older one didn't.
      existingWorkPolicy: ExistingWorkPolicy.replace,
      backoffPolicy: BackoffPolicy.exponential,
      backoffPolicyDelay: const Duration(minutes: 5),
    );
  }

  @override
  Future<void> cancelDrain() =>
      Workmanager().cancelByUniqueName(estimationTaskName);
}

/// When to ask the OS for a drain, and when to stop asking.
///
/// The policy is one sentence: ask on the way out if meals are waiting, and
/// withdraw on the way back in, because the app itself is faster than any
/// scheduler.
class BackgroundEstimation {
  BackgroundEstimation({TaskScheduler scheduler = const WorkmanagerTasks()})
      : _scheduler = scheduler;

  final TaskScheduler _scheduler;

  bool _started = false;

  /// Whether a drain is currently registered with the OS. Kept so leaving the
  /// app with an empty queue does not cancel a task that was never scheduled,
  /// which on Android is a needless round trip through the WorkManager
  /// database on every single app switch.
  bool _scheduled = false;

  bool get scheduled => _scheduled;

  /// Register the entrypoint. Failures are swallowed: a device where this does
  /// not work is a device that estimates on next launch, which is the
  /// behaviour every version before this one had.
  Future<void> start() async {
    if (_started) return;
    _started = true;
    try {
      await _scheduler.start();
    } catch (e) {
      _started = false;
      debugPrint('Background estimation is off this session: $e');
    }
  }

  /// The app is going away, with [waiting] meals still to estimate.
  Future<void> whenBackgrounded({required int waiting}) async {
    if (!_started) return;
    if (waiting <= 0) return _withdraw();
    if (_scheduled) return;
    try {
      await _scheduler.scheduleDrain();
      _scheduled = true;
    } catch (e) {
      debugPrint('Could not schedule a background drain: $e');
    }
  }

  /// The app is back. Whatever is left in the queue, the foreground drain is
  /// about to do it — see `main.dart` — and doing it twice is billed twice.
  Future<void> whenForegrounded() => _withdraw();

  Future<void> _withdraw() async {
    if (!_started || !_scheduled) return;
    try {
      await _scheduler.cancelDrain();
    } catch (e) {
      debugPrint('Could not cancel the background drain: $e');
    } finally {
      _scheduled = false;
    }
  }
}

/// The entrypoint the OS calls. Top-level and `vm:entry-point` because it is
/// looked up by handle in a fresh isolate, where nothing this app set up
/// exists yet.
@pragma('vm:entry-point')
void backgroundEstimationDispatcher() {
  WidgetsFlutterBinding.ensureInitialized();
  Workmanager().executeTask((task, inputData) => drainInBackground());
}

/// True while a background drain is running in this isolate. The OS is not
/// supposed to overlap two, and on iOS the task may run on the main engine
/// alongside the app itself.
bool _draining = false;

/// Boot enough of the app to estimate, drain the queue, and say whether it is
/// worth trying again.
///
/// Deliberately the *same* objects the foreground uses — [AppSession] opens the
/// store and restores the agent exactly as it does at launch, and
/// [EstimationQueue] applies the same retry rules and writes through the same
/// [MealStore]. A second, simpler estimator that skipped one of the four things
/// the queue must never do would be a bug per platform.
///
/// Returns false only where trying again could help: on Android that is what
/// makes WorkManager retry with backoff. No account, no API key and nothing
/// pending all return true — retrying changes none of them.
Future<bool> drainInBackground() async {
  if (_draining) return true;
  _draining = true;

  final session = AppSession();
  final account = OpenRouterAccount();
  final notifier = LocalNotifications();
  MealStore? meals;
  EstimationQueue? queue;

  try {
    // The isolate is fresh: the plugins this app talks to have to be attached
    // to it before any of them will answer.
    DartPluginRegistrant.ensureInitialized();

    await session.start();
    switch (session.phase) {
      case SessionPhase.ready:
        break;
      case SessionPhase.failed:
        // The store did not open — worth another go later.
        return false;
      case SessionPhase.starting:
      case SessionPhase.onboarding:
      case SessionPhase.needsSync:
        // Nobody is signed in, or their meals are still on another device.
        // Neither is something a background task can move along.
        return true;
    }

    await account.load();
    // Meals stay `pending` and the Today screen keeps asking for a key. That
    // is the foreground's conversation to have.
    if (!account.isConnected) return true;

    await notifier.start();

    meals = MealStore();
    queue = EstimationQueue(
      meals: meals,
      account: account,
      client: OpenRouterClient(account: account),
      notifier: notifier,
    );
    queue.images = ImageStore(root: await getApplicationDocumentsDirectory());

    await queue.drain();

    // A meal that failed on its own has already been marked `failed` and is
    // not worth waking up for again; `error` is the queue itself not getting
    // off the ground.
    return queue.error == null;
  } catch (e) {
    debugPrint('Background estimation failed: $e');
    return false;
  } finally {
    queue?.dispose();
    meals?.dispose();
    account.dispose();
    session.dispose();
    _draining = false;
  }
}
