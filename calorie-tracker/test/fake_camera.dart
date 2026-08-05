import 'dart:typed_data';

import 'package:calorie_tracker/services/camera_feed.dart';
import 'package:flutter/material.dart';

/// A camera that is whatever the test needs it to be.
///
/// It models the three states the capture screen actually renders — coming up,
/// live, and "there is no camera" — and counts the frames it was asked for, so
/// a test can tell a shutter that fired from one that only looked like it.
class FakeCamera extends CameraFeed {
  FakeCamera({this.ready = true, String? error}) : _error = error;

  bool ready;
  String? _error;

  int startCount = 0;
  int stopCount = 0;
  int captureCount = 0;

  /// Thrown by the next [capture], for the "the shutter failed" path.
  Object? captureError;

  /// The bytes [capture] hands back. Not a real JPEG — nothing in a Dart test
  /// decodes it; the compressor is faked too.
  Uint8List frame = Uint8List.fromList(List.filled(64, 7));

  @override
  bool get isReady => ready;

  @override
  String? get error => _error;

  @override
  Future<void> start() async {
    startCount++;
  }

  @override
  Future<void> stop() async {
    stopCount++;
  }

  @override
  Widget preview() => const ColoredBox(color: Color(0xFF223322));

  @override
  Future<Uint8List> capture() async {
    captureCount++;
    if (captureError != null) throw captureError!;
    if (!ready) throw StateError('The camera is not ready');
    return frame;
  }

  /// Move it into a state and tell whoever is listening, the way the real one
  /// does when `initialize()` finally returns.
  void becomeReady() {
    ready = true;
    _error = null;
    notifyListeners();
  }

  void fail(String message) {
    ready = false;
    _error = message;
    notifyListeners();
  }
}
