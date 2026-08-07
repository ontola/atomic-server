/// The geometry every image goes through before an encoder sees it.
///
/// This is one function rather than one convention because the whole
/// suggestions feature rests on two different code paths agreeing about it
/// exactly. The index is built from stored JPEGs; the query — once Phase 7.3
/// lands — is a live camera frame that has never been through a JPEG at all. If
/// those two are cropped or resampled differently, the cosine scores drift and
/// every threshold calibrated against them is measuring the difference between
/// two preprocessors rather than between two meals
/// (`planning/calorie-tracker-embeddings.md` §6).
///
/// The rule: **centre square of the short edge, scaled to a fixed side.** It was
/// picked by measurement, not by copying the model card — the training-faithful
/// crop (`resize shortest edge to 256`, then `centre crop 224`, which keeps only
/// 87.5% of the short edge) scored slightly *worse* on retrieval than taking the
/// whole square. See `tool/encoder-bench/`.
library;

import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';

/// Decode [encoded] and return its centre square, [edge]×[edge].
///
/// Decoding is done straight to the size needed rather than at full resolution
/// followed by a discard: this runs on the shutter path, where §7's budget
/// lives. Passing both target dimensions proportionally preserves the aspect
/// ratio while landing the short edge exactly on [edge], so the crop below only
/// ever trims the long one.
///
/// With [upscale] false a source whose short edge is already under [edge] is
/// left at its own size and cropped square there, so nothing invents pixels
/// into a file that exists to be re-encoded later. The encoder path passes
/// true, because a model input has one legal size and "slightly smaller" is not
/// among them.
///
/// The caller owns the returned image and must dispose it.
Future<ui.Image> squareImage(
  Uint8List encoded, {
  required int edge,
  bool upscale = true,
}) async {
  final buffer = await ui.ImmutableBuffer.fromUint8List(encoded);
  final descriptor = await ui.ImageDescriptor.encoded(buffer);
  return _square(descriptor, buffer, edge: edge, upscale: upscale);
}

/// The same geometry, off raw pixels rather than an encoded file.
///
/// **This is the whole reason this library exists as one function.** The index
/// is built from stored JPEGs and the live query (Phase 7.3) is a camera frame
/// that has been through no JPEG at all — so the two enter the encoder through
/// the same crop and the same resample, one line of code apart, rather than
/// through two implementations that agree until somebody edits one of them.
///
/// [rgba] is `width * height * 4` bytes, straight RGBA. There is no [upscale]
/// switch: a preview frame is never kept, so there is nothing to protect from
/// invented pixels, and the encoder has exactly one legal input size.
Future<ui.Image> squareFromPixels(
  Uint8List rgba, {
  required int width,
  required int height,
  required int edge,
}) async {
  final buffer = await ui.ImmutableBuffer.fromUint8List(rgba);
  final descriptor = ui.ImageDescriptor.raw(
    buffer,
    width: width,
    height: height,
    pixelFormat: ui.PixelFormat.rgba8888,
  );
  return _square(descriptor, buffer, edge: edge, upscale: true);
}

/// Resample so the short edge lands on [edge], then keep the middle square.
///
/// The final scale is done by the canvas rather than trusted entirely to the
/// codec: a codec that honours `targetWidth`/`targetHeight` leaves this a 1:1
/// blit, and one that does not — raw descriptors are the case worth being
/// careful about — still comes out at [edge] rather than at whatever it felt
/// like. Silently returning a 720px "224px" square would fail inside the model
/// rather than here.
Future<ui.Image> _square(
  ui.ImageDescriptor descriptor,
  ui.ImmutableBuffer buffer, {
  required int edge,
  required bool upscale,
}) async {
  final width = descriptor.width;
  final height = descriptor.height;
  final shortest = width < height ? width : height;
  final scale = (!upscale && shortest <= edge) ? 1.0 : edge / shortest;

  final codec = await descriptor.instantiateCodec(
    targetWidth: (width * scale).round(),
    targetHeight: (height * scale).round(),
  );
  // The codec reads through the descriptor and the descriptor reads through the
  // buffer, so neither may be let go of until the frame is decoded. Disposing
  // them here rather than in the `finally` below only looks tidier; it fails
  // with "codec failed to produce an image", which reads as a corrupt file.
  final frame = await codec.getNextFrame();
  final decoded = frame.image;

  try {
    final side =
        (decoded.width < decoded.height ? decoded.width : decoded.height)
            .toDouble();
    final left = (decoded.width - side) / 2;
    final top = (decoded.height - side) / 2;
    // Never larger than the pixels actually available, which is what
    // `upscale: false` asked for.
    final out = upscale ? edge : (side < edge ? side.round() : edge);

    final recorder = ui.PictureRecorder();
    ui.Canvas(recorder).drawImageRect(
      decoded,
      ui.Rect.fromLTWH(left, top, side, side),
      ui.Rect.fromLTWH(0, 0, out.toDouble(), out.toDouble()),
      ui.Paint()..filterQuality = ui.FilterQuality.high,
    );
    final picture = recorder.endRecording();
    final square = await picture.toImage(out, out);
    picture.dispose();
    return square;
  } finally {
    decoded.dispose();
    codec.dispose();
    descriptor.dispose();
    buffer.dispose();
  }
}

/// Pixel dimensions from the encoded header, without decoding the image.
Future<(int, int)> imageSizeOf(Uint8List bytes) async {
  final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
  final descriptor = await ui.ImageDescriptor.encoded(buffer);
  final size = (descriptor.width, descriptor.height);
  descriptor.dispose();
  buffer.dispose();
  return size;
}
