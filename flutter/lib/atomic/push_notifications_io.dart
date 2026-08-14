import 'dart:io' show Platform;

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'atomic_client.dart';
import 'push_payload.dart';
import 'push_registry.dart';

const androidPushChannelId = 'atomic_notifications';
const androidPushChannelName = 'Atomic notifications';

final FlutterLocalNotificationsPlugin _local = FlutterLocalNotificationsPlugin();

/// Top-level isolate entry for FCM when the app is backgrounded/killed.
/// Visible `notification` payloads are already shown by the OS; this is a
/// no-op hook so the plugin is registered.
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  // Intentionally empty: hub sends a visible notification+data payload.
}

/// True iOS/Android lock-screen notifications via FCM (Android) and APNs
/// (through FCM on iOS). No-ops when Firebase project files are missing
/// (`google-services.json` / `GoogleService-Info.plist`).
class AtomicPush {
  static bool _started = false;

  static Future<void> start() async {
    if (kIsWeb || _started) return;
    if (!(Platform.isAndroid || Platform.isIOS)) return;

    try {
      await Firebase.initializeApp();
    } catch (e) {
      debugPrint('Push: Firebase not configured ($e)');
      return;
    }

    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);

    const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');
    const iosInit = DarwinInitializationSettings(
      requestAlertPermission: false,
      requestBadgePermission: false,
      requestSoundPermission: false,
    );
    await _local.initialize(
      const InitializationSettings(android: androidInit, iOS: iosInit),
    );

    if (Platform.isAndroid) {
      await _local
          .resolvePlatformSpecificImplementation<
              AndroidFlutterLocalNotificationsPlugin>()
          ?.createNotificationChannel(
            const AndroidNotificationChannel(
              androidPushChannelId,
              androidPushChannelName,
              description: 'Mentions, messages, and lists you follow',
              importance: Importance.high,
            ),
          );
    }

    _started = true;

    FirebaseMessaging.onMessage.listen(_onForeground);
    FirebaseMessaging.onMessageOpenedApp.listen(_onOpened);
    final initial = await FirebaseMessaging.instance.getInitialMessage();
    if (initial != null) {
      _onOpened(initial);
    }
  }

  /// Request OS permission (not on cold start — call after sign-in) and
  /// upsert the FCM/APNs token onto the personal drive.
  static Future<void> registerAfterSignIn() async {
    if (kIsWeb) return;
    await start();
    if (!_started) return;

    final settings = await FirebaseMessaging.instance.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );
    if (settings.authorizationStatus == AuthorizationStatus.denied) {
      debugPrint('Push: permission denied');
      return;
    }

    if (Platform.isIOS) {
      await FirebaseMessaging.instance
          .setForegroundNotificationPresentationOptions(
        alert: false,
        badge: true,
        sound: false,
      );
    }

    final token = await FirebaseMessaging.instance.getToken();
    await _upsertToken(token);
    FirebaseMessaging.instance.onTokenRefresh.listen(_upsertToken);
  }

  static Future<void> _upsertToken(String? token) async {
    if (token == null || token.isEmpty) return;
    final agent = await AtomicClient.getActiveAgent();
    if (agent == null) return;
    try {
      await registerDevicePushToken(
        agentSubject: agent.subject,
        token: token,
      );
    } catch (e) {
      debugPrint('Push: DevicePushToken register failed: $e');
    }
  }

  static void _onForeground(RemoteMessage message) {
    final type = typeFromPushData(message.data);
    final copy = visiblePushCopy(type);
    final title = message.notification?.title ?? copy.title;
    final body = message.notification?.body ?? copy.body;
    _local.show(
      message.hashCode,
      title,
      body,
      const NotificationDetails(
        android: AndroidNotificationDetails(
          androidPushChannelId,
          androidPushChannelName,
          importance: Importance.high,
          priority: Priority.high,
        ),
        iOS: DarwinNotificationDetails(),
      ),
    );
  }

  static void _onOpened(RemoteMessage message) {
    final about = aboutFromPushData(message.data);
    debugPrint(
      'Push: opened about=$about type=${typeFromPushData(message.data)}',
    );
  }
}
