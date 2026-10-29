import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/services.dart';

import 'roomplan.dart';

/// Scans a room with the device (Apple RoomPlan on a LiDAR iPhone or iPad).
abstract class RoomScanner {
  Future<bool> isSupported();

  /// Runs the scan UI; null when the person cancels.
  Future<ScannedRoom?> scan();
}

/// The native plugin (`ios/Runner/RoomScanPlugin.swift`); unsupported elsewhere.
class PlatformRoomScanner implements RoomScanner {
  static const _channel = MethodChannel('io.ontola.atomic_buildings/roomscan');

  @override
  Future<bool> isSupported() async {
    if (kIsWeb || !Platform.isIOS) return false;
    try {
      return await _channel.invokeMethod<bool>('isSupported') ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  @override
  Future<ScannedRoom?> scan() async {
    final json = await _channel.invokeMethod<String>('scan');
    return json == null ? null : ScannedRoom.parse(json);
  }

  /// Starts a fresh native capture session: the next scan gets a new
  /// `sessionId` and ARKit origin. Call it when the person moves to another
  /// storey or building; consecutive scans otherwise share one world.
  Future<void> endSession() async {
    if (kIsWeb || !Platform.isIOS) return;
    try {
      await _channel.invokeMethod<void>('endSession');
    } on MissingPluginException {
      // No native side: nothing to end.
    }
  }

  /// iOS 17+: merges the rooms scanned in the current session with RoomPlan's
  /// `StructureBuilder`; the rooms come back in one shared frame. Null when
  /// unavailable (older iOS, fewer than two rooms, or no plugin).
  Future<List<ScannedRoom>?> mergeRooms() async {
    if (kIsWeb || !Platform.isIOS) return null;
    try {
      final json = await _channel.invokeMethod<String>('mergeRooms');
      return json == null ? null : parseMergedRooms(json);
    } on PlatformException {
      return null;
    } on MissingPluginException {
      return null;
    }
  }
}

/// The `{"rooms": [<scan>, ...]}` JSON `mergeRooms` returns.
List<ScannedRoom> parseMergedRooms(String source) {
  final json = jsonDecode(source) as Map;
  return [
    for (final r in (json['rooms'] as List? ?? const []))
      ScannedRoom.fromJson(r as Map),
  ];
}
