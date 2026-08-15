import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'atomic_client.dart';

export 'push_payload.dart';

/// Ontology URLs from `lib/defaults/notifications.json`.
abstract final class PushUrls {
  static const isA = 'https://atomicdata.dev/properties/isA';
  static const devicePushToken = 'https://atomicdata.dev/classes/DevicePushToken';
  static const devicePushAgent =
      'https://atomicdata.dev/properties/devicePushAgent';
  static const pushPlatform = 'https://atomicdata.dev/properties/pushPlatform';
  static const pushToken = 'https://atomicdata.dev/properties/pushToken';
  static const pushAppId = 'https://atomicdata.dev/properties/pushAppId';
  static const pushTokenUpdatedAt =
      'https://atomicdata.dev/properties/pushTokenUpdatedAt';
}

const _tokenSubjectPref = 'device_push_token_subject';

String pushAppIdForThisInstall() {
  if (kIsWeb) return 'web';
  if (Platform.isIOS) return 'com.ontola.atomiccanvasFlutter';
  if (Platform.isAndroid) return 'com.ontola.atomiccanvas_flutter';
  return 'unknown';
}

String pushPlatformForThisInstall() {
  if (kIsWeb) return 'web';
  if (Platform.isIOS) return 'ios';
  if (Platform.isAndroid) return 'android';
  return 'desktop';
}

/// Upsert a DevicePushToken on the active drive so the hub can send APNs/FCM.
Future<String?> registerDevicePushToken({
  required String agentSubject,
  required String token,
  String? parentDrive,
}) async {
  if (token.isEmpty || agentSubject.isEmpty) return null;

  final drive = parentDrive ?? AtomicClient.getActiveDrive();
  if (drive == null || drive.isEmpty) return null;

  final platform = pushPlatformForThisInstall();
  final appId = pushAppIdForThisInstall();
  final now = DateTime.now().millisecondsSinceEpoch.toString();
  final prefs = await SharedPreferences.getInstance();
  final existing = prefs.getString(_tokenSubjectPref);

  Future<void> writeFields(String subject) async {
    await AtomicClient.setProperty(subject, PushUrls.isA, PushUrls.devicePushToken);
    await AtomicClient.setProperty(
      subject,
      PushUrls.devicePushAgent,
      agentSubject,
    );
    await AtomicClient.setProperty(subject, PushUrls.pushPlatform, platform);
    await AtomicClient.setProperty(subject, PushUrls.pushToken, token);
    await AtomicClient.setProperty(subject, PushUrls.pushAppId, appId);
    await AtomicClient.setProperty(subject, PushUrls.pushTokenUpdatedAt, now);
  }

  if (existing != null && existing.isNotEmpty) {
    try {
      await writeFields(existing);
      return existing;
    } catch (e) {
      debugPrint('Push token update failed, creating a new resource: $e');
    }
  }

  final subject = await AtomicClient.createResource(
    parentSubject: drive,
    name: 'Push ($platform)',
  );
  await writeFields(subject);
  await prefs.setString(_tokenSubjectPref, subject);
  return subject;
}
