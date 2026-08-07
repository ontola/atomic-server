import 'dart:async';
import 'dart:typed_data';

import 'package:calorie_tracker/services/camera_feed.dart';
import 'package:calorie_tracker/services/camera_frame.dart';
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

  /// Wrapped in an [AspectRatio] like the real one, because that is the half of
  /// the contract the viewfinder's layout leans on: it hands the preview a
  /// width and lets it choose the height.
  @override
  Widget preview() => const AspectRatio(
        aspectRatio: 9 / 16,
        child: ColoredBox(color: Color(0xFF223322)),
      );

  @override
  Future<Uint8List> capture() async {
    captureCount++;
    if (captureError != null) throw captureError!;
    if (!ready) throw StateError('The camera is not ready');
    return frame;
  }

  /// Every preview stream this camera has handed out that is still open — so a
  /// test can [emit] into them and can assert that stopping actually stopped
  /// something.
  final List<StreamController<CameraFrame>> streams = [];

  /// How many times a stream was asked for and how many were cancelled. The
  /// difference is the whole of "the stream stops on `paused` and on navigating
  /// away".
  int frameStreams = 0;
  int frameStreamsCancelled = 0;

  /// The interval the last caller asked for, so the throttle's owner can be
  /// checked without waiting for one.
  Duration? lastInterval;

  @override
  Stream<CameraFrame> frames({required Duration minInterval}) {
    lastInterval = minInterval;
    frameStreams++;
    late final StreamController<CameraFrame> controller;
    controller = StreamController<CameraFrame>(onCancel: () {
      frameStreamsCancelled++;
      streams.remove(controller);
    });
    streams.add(controller);
    return controller.stream;
  }

  /// Hand a frame to whoever is listening. Returns false when nobody is, which
  /// is a state worth failing a test on rather than sleeping through.
  bool emit(CameraFrame frame) {
    if (streams.isEmpty) return false;
    for (final controller in [...streams]) {
      controller.add(frame);
    }
    return true;
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
