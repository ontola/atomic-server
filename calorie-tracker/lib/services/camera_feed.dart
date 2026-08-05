import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';

/// The camera, as the capture screen needs it.
///
/// A seam for the same reason `AtomicBackend` and `MealBackend` are ones: the
/// test VM has no camera and no platform channels, and the shutter — press it,
/// get a meal, be safe to kill — is exactly what has to be covered by fast
/// tests. [DeviceCamera] is the real one.
///
/// A [ChangeNotifier] because starting is slow and its outcome is what the
/// screen renders: a preview, a reason there isn't one, or a spinner.
abstract class CameraFeed extends ChangeNotifier {
  /// Open the camera. Idempotent, and safe to call before anything is on
  /// screen — that is the point (see `main.dart`).
  Future<void> start();

  /// Release the hardware. Android takes the camera away from a backgrounded
  /// app whether we let go or not; letting go is what makes coming back work.
  Future<void> stop();

  /// A live preview. Given a width, it takes the height its own aspect ratio
  /// asks for — the sensor's, which is not the screen's, and which the capture
  /// screen scales to cover. Only valid while [isReady].
  Widget preview();

  /// The frame, as the sensor gave it — full resolution, uncompressed.
  /// `ImageStore.save` is what decides how much of it is kept.
  Future<Uint8List> capture();

  /// Whether [preview] and [capture] will work.
  bool get isReady;

  /// Why there is no preview, in words a user can act on. Null while starting
  /// and once ready.
  String? get error;
}

/// The `camera` package, behind [CameraFeed].
class DeviceCamera extends CameraFeed {
  CameraController? _controller;
  Future<void>? _starting;
  String? _error;
  bool _disposed = false;

  @override
  bool get isReady => _controller?.value.isInitialized ?? false;

  @override
  String? get error => _error;

  /// The first call opens the camera; later ones join it. Both the app's warm-up
  /// in `main` and the capture screen's own `initState` call this, and on every
  /// launch after the first they race — one camera has to come out of it.
  @override
  Future<void> start() => _starting ??= _start();

  Future<void> _start() async {
    try {
      final cameras = await availableCameras();
      if (cameras.isEmpty) {
        // The iOS simulator, mostly — which is also where this app gets
        // developed, so it has to degrade into something usable rather than an
        // error screen. The capture screen offers typing instead.
        throw CameraException('NoCamera', 'This device has no camera');
      }

      final back = cameras.firstWhere(
        (c) => c.lensDirection == CameraLensDirection.back,
        orElse: () => cameras.first,
      );

      // `high` (~1280) rather than `max`: the stored image is 1024px on its
      // longest edge, so anything above this is sensor data we compress away —
      // paid for in shutter latency, which is the one budget this screen has.
      final controller = CameraController(
        back,
        ResolutionPreset.high,
        enableAudio: false,
        imageFormatGroup: ImageFormatGroup.jpeg,
      );
      await controller.initialize();

      if (_disposed) {
        await controller.dispose();
        return;
      }
      _controller = controller;
      _error = null;
    } on CameraException catch (e) {
      _error = _explain(e);
    } catch (e) {
      _error = e.toString();
    }
    if (!_disposed) notifyListeners();
  }

  @override
  Future<void> stop() async {
    final controller = _controller;
    // Nothing open yet, so nothing to release — and this is also the
    // permission-dialog case. Asking for the camera makes iOS report the app
    // inactive, which is a lifecycle change the capture screen answers by
    // calling this; tearing down a controller that is still inside
    // `initialize()` would leave `_starting` cleared and the next `start()`
    // would open a second camera behind the first.
    if (controller == null) return;

    _controller = null;
    _starting = null;
    await controller.dispose();
    if (!_disposed) notifyListeners();
  }

  @override
  Widget preview() {
    final controller = _controller;
    if (controller == null || !controller.value.isInitialized) {
      return const SizedBox.shrink();
    }
    return CameraPreview(controller);
  }

  @override
  Future<Uint8List> capture() async {
    final controller = _controller;
    if (controller == null || !controller.value.isInitialized) {
      throw StateError('The camera is not ready');
    }

    final shot = await controller.takePicture();
    final bytes = await shot.readAsBytes();

    // The plugin writes the full-resolution frame to a cache file on its way
    // out. We keep only the compressed copy, so drop it now rather than leave
    // the 2–5 MB original sitting in a directory nothing else prunes.
    unawaited(File(shot.path).delete().catchError((_) => File(shot.path)));

    return bytes;
  }

  @override
  void dispose() {
    _disposed = true;
    _controller?.dispose();
    _controller = null;
    super.dispose();
  }

  /// The plugin's error codes, in words that say what to do about them.
  static String _explain(CameraException e) => switch (e.code) {
        'CameraAccessDenied' ||
        'CameraAccessDeniedWithoutPrompt' ||
        'CameraAccessRestricted' =>
          'Calorie Tracker needs the camera to photograph a meal. '
              'Turn it on in Settings.',
        'NoCamera' => 'This device has no camera',
        _ => e.description ?? e.code,
      };
}
