import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

/// Somewhere to put a question when nobody is looking at the app.
///
/// A `needs-info` meal is the estimator saying it cannot finish without an
/// answer, and the whole point is that the person who could give one has
/// already put their phone away — a chip in a list they are not looking at is
/// not asking anybody anything.
///
/// A seam for the same reason [CameraFeed] and [ImageCompressor] are: the test
/// VM has no notification centre, and the loop this drives — question asked,
/// question tapped, meal opened — is exactly what wants covering by fast tests.
/// [LocalNotifications] is the real one.
abstract class Notifier {
  /// Get ready, and find out whether this launch came from a tap. Idempotent.
  Future<void> start();

  /// Ask [question] about the meal at [subject]. Tapping it opens that meal.
  ///
  /// Never throws: a question that could not be delivered is a worse day than
  /// one that could, but it is not a reason to fail the estimate that produced
  /// it — the meal keeps the question either way and the list still shows it.
  Future<void> ask(String subject, String question);

  /// Take the question about [subject] back. It has been answered, or the meal
  /// it was about is gone.
  Future<void> withdraw(String subject);

  /// The meal a tap asked to open, or null when nothing is waiting to be
  /// opened. Set by a tap and by a launch that came from one.
  ValueListenable<String?> get opened;

  /// The subject in [opened] has been shown. Clears it, so coming back to this
  /// screen later does not re-open it.
  void handled();
}

/// The real one: iOS's notification centre and Android's shade.
class LocalNotifications implements Notifier {
  LocalNotifications({FlutterLocalNotificationsPlugin? plugin})
      : _plugin = plugin ?? FlutterLocalNotificationsPlugin();

  final FlutterLocalNotificationsPlugin _plugin;

  final ValueNotifier<String?> _opened = ValueNotifier(null);

  @override
  ValueListenable<String?> get opened => _opened;

  bool _started = false;
  bool? _allowed;

  /// One channel, because there is one kind of notification: a question about
  /// a meal. Android shows the description in system settings, so it is written
  /// for whoever finds it there.
  static const _channelId = 'meal_questions';
  static const _channelName = 'Questions about meals';
  static const _channelDescription =
      'Asked when a photo left something open that changes the calorie estimate.';

  /// Wire the plugin up and find out whether this launch came from a tap.
  ///
  /// Deliberately *not* asking for permission: at launch there is nothing to
  /// ask about, and a permission dialog in front of an app someone has not used
  /// yet is the reliable way to be told no forever. [ask] requests it the first
  /// time there is a real question, which is the moment it can be explained.
  @override
  Future<void> start() async {
    if (_started) return;
    _started = true;

    try {
      await _plugin.initialize(
        settings: const InitializationSettings(
          android: AndroidInitializationSettings('@mipmap/ic_launcher'),
          iOS: DarwinInitializationSettings(
            requestAlertPermission: false,
            requestBadgePermission: false,
            requestSoundPermission: false,
          ),
        ),
        onDidReceiveNotificationResponse: _tapped,
      );

      // A tap on a notification while the app was not running launches it, and
      // that tap never reaches the callback above — it happened before there
      // was anything to call.
      final launch = await _plugin.getNotificationAppLaunchDetails();
      if (launch?.didNotificationLaunchApp ?? false) {
        _tapped(launch!.notificationResponse!);
      }
    } catch (e) {
      // No notification centre is not a broken app. Every question is on its
      // meal as well, and the list shows it.
      debugPrint('Notifications are off this session: $e');
    }
  }

  void _tapped(NotificationResponse response) {
    final subject = response.payload;
    if (subject == null || subject.isEmpty) return;
    _opened.value = subject;
  }

  @override
  Future<void> ask(String subject, String question) async {
    try {
      if (!await _permitted()) return;
      await _plugin.show(
        id: _idOf(subject),
        title: 'About that meal',
        body: question,
        payload: subject,
        notificationDetails: const NotificationDetails(
          android: AndroidNotificationDetails(
            _channelId,
            _channelName,
            channelDescription: _channelDescription,
            importance: Importance.defaultImportance,
            priority: Priority.defaultPriority,
          ),
          // Shown even with the app open: the estimate lands ten seconds after
          // the shutter, by which time the viewfinder is usually pointed
          // somewhere else.
          iOS: DarwinNotificationDetails(presentAlert: true, presentBanner: true),
        ),
      );
    } catch (e) {
      debugPrint('Could not ask about $subject: $e');
    }
  }

  @override
  Future<void> withdraw(String subject) async {
    try {
      await _plugin.cancel(id: _idOf(subject));
    } catch (e) {
      debugPrint('Could not withdraw the question about $subject: $e');
    }
  }

  @override
  void handled() => _opened.value = null;

  /// Ask for permission the first time there is something to say, and remember
  /// the answer for the session. A refusal is not retried — the OS would not
  /// show the dialog twice anyway.
  Future<bool> _permitted() async {
    if (_allowed != null) return _allowed!;

    final android = _plugin.resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin>();
    if (android != null) {
      _allowed = await android.requestNotificationsPermission() ?? false;
      return _allowed!;
    }

    final ios = _plugin.resolvePlatformSpecificImplementation<
        IOSFlutterLocalNotificationsPlugin>();
    if (ios != null) {
      _allowed = await ios.requestPermissions(alert: true, sound: true) ?? false;
      return _allowed!;
    }

    // Somewhere with no implementation to resolve — a test host, a desktop
    // build. Nothing will be shown and nothing needs asking.
    _allowed = false;
    return false;
  }

  /// A stable 31-bit id for a meal's question.
  ///
  /// Notification ids are ints and the app's key is a subject, so this is the
  /// map between them. FNV-1a rather than [String.hashCode] because it has to
  /// hold across launches: the notification cancelled after an answer was
  /// usually posted by a different run of the app.
  static int _idOf(String subject) {
    var hash = 0x811c9dc5;
    for (final unit in subject.codeUnits) {
      hash = ((hash ^ unit) * 0x01000193) & 0xffffffff;
    }
    return hash & 0x7fffffff;
  }
}
