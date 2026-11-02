import 'dart:io' show Platform;

import 'package:permission_handler/permission_handler.dart';
import 'package:webview_flutter/webview_flutter.dart'
    show WebViewPermissionResourceType;

/// What a call may use of the device.
enum CallMedia { microphone, camera }

/// The device's permission layer, behind a small seam so tests need no
/// plugin.
abstract interface class CallPermissions {
  /// Whether every one of [media] may be used, asking the person when it is
  /// not decided yet.
  Future<bool> request(Set<CallMedia> media);
}

/// The system's permissions. Android's web view grants the page a camera or
/// microphone only when the app holds the runtime permission, so it is asked
/// here first. iOS needs nothing before: the web view's grant makes the
/// system ask (the Info.plist texts), and a refusal there reaches the page as
/// a denied `getUserMedia`.
class SystemCallPermissions implements CallPermissions {
  const SystemCallPermissions();

  @override
  Future<bool> request(Set<CallMedia> media) async {
    if (!Platform.isAndroid) return true;
    final asked = [
      if (media.contains(CallMedia.microphone)) Permission.microphone,
      if (media.contains(CallMedia.camera)) Permission.camera,
    ];
    if (asked.isEmpty) return false;
    final result = await asked.request();
    return result.values.every((status) => status.isGranted);
  }
}

/// The device resources a page asked for, or null when it asked for anything
/// else (a call page needs only these two).
Set<CallMedia>? callMediaOf(Set<WebViewPermissionResourceType> types) {
  if (types.isEmpty) return null;
  final media = <CallMedia>{};
  for (final type in types) {
    if (type == WebViewPermissionResourceType.microphone) {
      media.add(CallMedia.microphone);
    } else if (type == WebViewPermissionResourceType.camera) {
      media.add(CallMedia.camera);
    } else {
      return null;
    }
  }
  return media;
}

/// Answers a page's permission request: grants it when it is only for the
/// microphone and camera and the person allows them (asking first through
/// [permissions]), denies it otherwise. A request that fails is denied.
Future<void> answerPermissionRequest({
  required Set<WebViewPermissionResourceType> types,
  required Future<void> Function() grant,
  required Future<void> Function() deny,
  required CallPermissions permissions,
}) async {
  final media = callMediaOf(types);
  var allowed = false;
  if (media != null) {
    try {
      allowed = await permissions.request(media);
    } catch (_) {}
  }
  await (allowed ? grant() : deny());
}
