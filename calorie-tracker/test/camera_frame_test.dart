import 'dart:typed_data';

import 'package:calorie_tracker/services/camera_frame.dart';
import 'package:flutter_test/flutter_test.dart';

/// Turning a preview frame into pixels.
///
/// Worth its own file because it is the one piece of Phase 7.3 that can be
/// wrong without anything looking wrong. A swapped channel or a mis-strided
/// chroma plane produces embeddings that are stable, well-formed, the right
/// length, and measuring a picture nobody took — and every threshold above it
/// then reports similarities that are really an artifact of the conversion. The
/// integration test's "check the channel order before believing any similarity
/// this app reports" is the same warning from the other end.
void main() {
  /// The wire order for the format iOS hands over: blue, green, red, alpha.
  Uint8List bgraOf(
    int width,
    int height,
    (int, int, int) Function(int x, int y) rgb, {
    int padding = 0,
  }) {
    final rowStride = width * 4 + padding;
    final bytes = Uint8List(rowStride * height);
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        final (r, g, b) = rgb(x, y);
        final p = y * rowStride + x * 4;
        bytes[p] = b;
        bytes[p + 1] = g;
        bytes[p + 2] = r;
        bytes[p + 3] = 0xFF;
      }
    }
    return bytes;
  }

  CameraFrame? bgraFrame(
    int width,
    int height,
    (int, int, int) Function(int x, int y) rgb, {
    int padding = 0,
  }) =>
      squareFrameOf(
        width: width,
        height: height,
        format: CameraPixelFormat.bgra8888,
        planes: [
          CameraPlane(
            bytes: bgraOf(width, height, rgb, padding: padding),
            bytesPerRow: width * 4 + padding,
            bytesPerPixel: 4,
          ),
        ],
      );

  /// The three planes Android hands over, from an RGB image. BT.601 forward,
  /// which is the transform `camera_frame.dart` inverts.
  ///
  /// [pixelStride] and [padding] are what make this worth testing at all: the
  /// planes are strided, the chroma ones are half resolution in both directions,
  /// and there is nothing in a frame that says so out loud.
  CameraFrame? yuvFrame(
    int width,
    int height,
    (int, int, int) Function(int x, int y) rgb, {
    int pixelStride = 1,
    int padding = 0,
  }) {
    final yStride = width + padding;
    final y = Uint8List(yStride * height);
    final chromaWidth = width ~/ 2;
    final chromaHeight = height ~/ 2;
    final cStride = chromaWidth * pixelStride + padding;
    final u = Uint8List(cStride * chromaHeight);
    final v = Uint8List(cStride * chromaHeight);

    for (var py = 0; py < height; py++) {
      for (var px = 0; px < width; px++) {
        final (r, g, b) = rgb(px, py);
        y[py * yStride + px] = (0.299 * r + 0.587 * g + 0.114 * b).round();
        // Only the top-left of each 2×2 block is written, so the source has to
        // be flat inside a block for the round trip to be exact — which is what
        // the fixtures below are careful to be.
        if (py.isEven && px.isEven) {
          final at = (py ~/ 2) * cStride + (px ~/ 2) * pixelStride;
          u[at] = (-0.169 * r - 0.331 * g + 0.5 * b + 128).round().clamp(0, 255);
          v[at] = (0.5 * r - 0.419 * g - 0.081 * b + 128).round().clamp(0, 255);
        }
      }
    }

    return squareFrameOf(
      width: width,
      height: height,
      format: CameraPixelFormat.yuv420,
      planes: [
        CameraPlane(bytes: y, bytesPerRow: yStride, bytesPerPixel: 1),
        CameraPlane(bytes: u, bytesPerRow: cStride, bytesPerPixel: pixelStride),
        CameraPlane(bytes: v, bytesPerRow: cStride, bytesPerPixel: pixelStride),
      ],
    );
  }

  (int, int, int) pixelAt(CameraFrame frame, int x, int y) {
    final p = (y * frame.edge + x) * 4;
    return (frame.rgba[p], frame.rgba[p + 1], frame.rgba[p + 2]);
  }

  /// Chroma subsampling and integer arithmetic both cost a few counts. The
  /// question here is whether a channel is the right one, not whether it is
  /// exact.
  void expectNear((int, int, int) actual, (int, int, int) want, {int within = 4}) {
    expect(actual.$1, closeTo(want.$1, within), reason: 'red');
    expect(actual.$2, closeTo(want.$2, within), reason: 'green');
    expect(actual.$3, closeTo(want.$3, within), reason: 'blue');
  }

  group('BGRA, which is what iOS hands over', () {
    test('blue comes off the wire first and red comes out first', () {
      final frame = bgraFrame(8, 8, (x, y) => (200, 40, 10))!;

      expectNear(pixelAt(frame, 0, 0), (200, 40, 10), within: 0);
    });

    test('every pixel is opaque, whatever the alpha said', () {
      final frame = bgraFrame(8, 8, (x, y) => (10, 20, 30))!;

      expect(frame.rgba.length, 8 * 8 * 4);
      for (var i = 3; i < frame.rgba.length; i += 4) {
        expect(frame.rgba[i], 0xFF);
      }
    });

    test('a padded row stride is honoured rather than assumed away', () {
      final frame = bgraFrame(8, 8, (x, y) => (x * 30, 0, 0), padding: 24)!;

      expect(pixelAt(frame, 0, 3).$1, 0);
      expect(pixelAt(frame, 5, 3).$1, 150,
          reason: 'a stride read as width would shear the image sideways, '
              'which looks like a photograph of something else');
    });
  });

  group('YUV420, which is what Android hands over', () {
    test('a colour survives the round trip through Y, U and V', () {
      for (final colour in const [
        (220, 30, 40),
        (30, 200, 60),
        (40, 50, 210),
        (128, 128, 128),
      ]) {
        final frame = yuvFrame(8, 8, (x, y) => colour)!;
        expectNear(pixelAt(frame, 2, 2), colour);
      }
    });

    test('the chroma planes are half resolution, and are read that way', () {
      // Two flat 4×8 halves, so nothing is lost to subsampling and a chroma
      // plane read at full width would put the boundary in the wrong place.
      final frame = yuvFrame(8, 8, (x, y) => x < 4 ? (220, 30, 40) : (30, 200, 60))!;

      expectNear(pixelAt(frame, 1, 4), (220, 30, 40));
      expectNear(pixelAt(frame, 6, 4), (30, 200, 60));
    });

    test('a pixel stride other than one is honoured', () {
      // What a semi-planar frame reports: U and V interleaved in one buffer, so
      // consecutive samples are two bytes apart.
      final frame = yuvFrame(8, 8, (x, y) => (30, 200, 60), pixelStride: 2)!;

      expectNear(pixelAt(frame, 3, 3), (30, 200, 60));
    });

    test('padded chroma and luma rows are honoured', () {
      final frame = yuvFrame(8, 8, (x, y) => (40, 50, 210), padding: 16)!;

      expectNear(pixelAt(frame, 5, 5), (40, 50, 210));
    });
  });

  group('the centre square', () {
    test('a wide frame keeps its middle, at the short edge', () {
      // A single bright column down the middle of a 16×8 frame. If the crop is
      // taken from the left it disappears; if the square is the long edge the
      // frame is the wrong size.
      final frame = bgraFrame(16, 8, (x, y) => x == 8 ? (255, 255, 255) : (0, 0, 0))!;

      expect(frame.edge, 8);
      expect(frame.rgba.length, 8 * 8 * 4);
      expect(pixelAt(frame, 4, 4), (255, 255, 255));
      expect(pixelAt(frame, 3, 4), (0, 0, 0));
    });

    test('a tall frame keeps its middle too', () {
      final frame = bgraFrame(8, 16, (x, y) => y == 8 ? (255, 255, 255) : (0, 0, 0))!;

      expect(frame.edge, 8);
      expect(pixelAt(frame, 4, 4), (255, 255, 255));
    });

    test('a square frame is left alone', () {
      final frame = bgraFrame(8, 8, (x, y) => (x * 8, y * 8, 0))!;

      expect(frame.edge, 8);
      expect(pixelAt(frame, 7, 7), (56, 56, 0));
    });
  });

  group('a frame that makes no sense', () {
    /// Nothing here may throw. This runs inside the camera's own callback, on
    /// the platform thread's turn, several times a second — and the only sane
    /// answer to one bad frame is the next frame.
    test('a plane shorter than the frame claims is skipped, not thrown', () {
      final frame = squareFrameOf(
        width: 64,
        height: 64,
        format: CameraPixelFormat.bgra8888,
        planes: [
          CameraPlane(bytes: Uint8List(16), bytesPerRow: 256, bytesPerPixel: 4),
        ],
      );

      expect(frame, isNull);
    });

    test('YUV with the planes missing is skipped', () {
      final frame = squareFrameOf(
        width: 8,
        height: 8,
        format: CameraPixelFormat.yuv420,
        planes: [CameraPlane(bytes: Uint8List(64), bytesPerRow: 8)],
      );

      expect(frame, isNull);
    });

    test('a frame with no pixels is skipped', () {
      expect(
        squareFrameOf(
          width: 0,
          height: 0,
          format: CameraPixelFormat.bgra8888,
          planes: [CameraPlane(bytes: Uint8List(0), bytesPerRow: 0)],
        ),
        isNull,
      );
    });
  });

  test('luma matches what the Y plane of the same frame would have held', () {
    // The gates read [CameraFrame.lumaAt] and the motion check compares two of
    // them; if this drifted from Rec. 601 the two platforms would gate
    // differently on the same scene.
    final frame = bgraFrame(4, 4, (x, y) => (200, 100, 50))!;

    expect(frame.lumaAt(1, 1), (0.299 * 200 + 0.587 * 100 + 0.114 * 50).round());
  });
}
