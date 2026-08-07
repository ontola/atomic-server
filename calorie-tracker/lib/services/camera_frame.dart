import 'dart:typed_data';

/// One preview frame, in the only form anything above the camera wants it.
///
/// The pixel formats a camera hands out are platform detail — three loosely
/// strided planes of YUV on Android, one plane of BGRA on iOS — and every one of
/// them is a different way to get the channel order wrong. That conversion
/// happens once, here, and everything downstream sees plain RGBA.
///
/// **It is already the centre square.** The encoder wants the centre square of
/// the short edge (`square_crop.dart`), the blur gate wants the middle of the
/// frame rather than the edges of the table, and nothing else looks at a preview
/// frame at all — so converting the parts that get thrown away is work with no
/// consumer. On a 1280×720 stream that is 44% of the pixels not touched, three
/// times a second, on the phone that is also running a camera.
class CameraFrame {
  const CameraFrame({required this.edge, required this.rgba});

  /// The side of the square, in pixels — the sensor frame's short edge, at
  /// whatever resolution the preview is running.
  final int edge;

  /// `edge * edge * 4` bytes, RGBA, opaque.
  final Uint8List rgba;

  /// Perceived brightness at (x, y), 0–255.
  ///
  /// Rec. 601 weights, which is what the luma plane of a YUV frame already is —
  /// so this and a YUV Y sample mean the same thing, and the gates below read
  /// the same on both platforms.
  int lumaAt(int x, int y) {
    final p = (y * edge + x) * 4;
    return (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) ~/ 1000;
  }
}

/// How the pixels arrived. Only the two formats this app asks for: everything
/// else is rejected rather than guessed at, because a wrong guess about channel
/// order produces embeddings that look like similarities and are noise.
enum CameraPixelFormat {
  /// Three planes: full-resolution Y, then half-resolution U and V, each with
  /// its own row and pixel stride. Android.
  yuv420,

  /// One plane, four interleaved bytes per pixel, blue first. iOS.
  bgra8888,
}

/// One plane of a camera frame, without the `camera` package's types — so the
/// conversion below can be tested against bytes a test wrote by hand rather
/// than against a device.
class CameraPlane {
  const CameraPlane({
    required this.bytes,
    required this.bytesPerRow,
    this.bytesPerPixel,
  });

  final Uint8List bytes;
  final int bytesPerRow;

  /// Null on the luma plane and on packed formats, where it is 1 and 4.
  final int? bytesPerPixel;
}

/// The centre square of a camera frame, as RGBA.
///
/// Returns null for anything malformed — a plane short of the rows it claims, a
/// frame with no pixels — because the caller is a preview stream and the only
/// sane response to one bad frame is the next frame. Nothing here is allowed to
/// throw on the camera's thread.
CameraFrame? squareFrameOf({
  required int width,
  required int height,
  required CameraPixelFormat format,
  required List<CameraPlane> planes,
}) {
  if (width <= 0 || height <= 0 || planes.isEmpty) return null;

  final side = width < height ? width : height;
  final left = (width - side) ~/ 2;
  final top = (height - side) ~/ 2;
  final out = Uint8List(side * side * 4);

  try {
    switch (format) {
      case CameraPixelFormat.bgra8888:
        _fromBgra(planes.first, left, top, side, out);
      case CameraPixelFormat.yuv420:
        if (planes.length < 3) return null;
        _fromYuv420(planes, left, top, side, out);
    }
  } on RangeError {
    // A frame whose planes are smaller than its dimensions claim. Seen when a
    // stream is torn down mid-callback; the next frame is fine.
    return null;
  }

  return CameraFrame(edge: side, rgba: out);
}

void _fromBgra(CameraPlane plane, int left, int top, int side, Uint8List out) {
  final bytes = plane.bytes;
  final rowStride = plane.bytesPerRow;
  final pixelStride = plane.bytesPerPixel ?? 4;

  var o = 0;
  for (var y = 0; y < side; y++) {
    var p = (top + y) * rowStride + left * pixelStride;
    for (var x = 0; x < side; x++) {
      // Blue first on the wire, red first in the output. This one line is the
      // whole of what "check the channel order" means.
      out[o] = bytes[p + 2];
      out[o + 1] = bytes[p + 1];
      out[o + 2] = bytes[p];
      out[o + 3] = 0xFF;
      o += 4;
      p += pixelStride;
    }
  }
}

void _fromYuv420(
  List<CameraPlane> planes,
  int left,
  int top,
  int side,
  Uint8List out,
) {
  final y0 = planes[0];
  final u0 = planes[1];
  final v0 = planes[2];
  final uStride = u0.bytesPerPixel ?? 1;
  final vStride = v0.bytesPerPixel ?? 1;

  var o = 0;
  for (var y = 0; y < side; y++) {
    final sy = top + y;
    final yRow = sy * y0.bytesPerRow;
    // The chroma planes are half resolution in both directions, so a row of
    // luma and a row of chroma advance at different rates. Getting this wrong
    // tints the image in horizontal bands, which a similarity score reports as
    // a perfectly ordinary meal.
    final uvRow = (sy >> 1) * u0.bytesPerRow;
    final vvRow = (sy >> 1) * v0.bytesPerRow;

    for (var x = 0; x < side; x++) {
      final sx = left + x;
      final luma = y0.bytes[yRow + sx * (y0.bytesPerPixel ?? 1)];
      final u = u0.bytes[uvRow + (sx >> 1) * uStride] - 128;
      final v = v0.bytes[vvRow + (sx >> 1) * vStride] - 128;

      // BT.601, in fixed point: the coefficients are 1.402, 0.344136, 0.714136
      // and 1.772, scaled by 1024.
      out[o] = _clamp8(luma + ((1436 * v) >> 10));
      out[o + 1] = _clamp8(luma - ((352 * u + 731 * v) >> 10));
      out[o + 2] = _clamp8(luma + ((1815 * u) >> 10));
      out[o + 3] = 0xFF;
      o += 4;
    }
  }
}

int _clamp8(int v) => v < 0 ? 0 : (v > 255 ? 255 : v);
