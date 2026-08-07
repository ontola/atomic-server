import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:calorie_tracker/services/square_crop.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// The one geometry, from both directions.
///
/// The index is built from stored JPEGs and the live query is a camera frame
/// that has been through no JPEG at all. If those two are cropped or resampled
/// differently the cosine scores drift and every threshold in Phase 7.3 is
/// measuring the difference between two preprocessors rather than between two
/// meals (`calorie-tracker-embeddings.md` §6) — and it fails silently, because
/// the numbers still look like similarities.
///
/// The integration test makes the same check against the real ONNX model and a
/// real JPEG. This one makes it here, in a second, on every commit.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  /// A synthetic frame with structure in it: a coloured gradient with a few
  /// blobs, which is what tells a crop apart from a shifted crop. A flat colour
  /// would pass every assertion below and mean nothing.
  Future<ui.Image> painted(int width, int height) async {
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    canvas.drawRect(
      Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
      Paint()
        ..shader = ui.Gradient.linear(
          Offset.zero,
          Offset(width.toDouble(), height.toDouble()),
          const [Color(0xFF102030), Color(0xFFE0C0A0)],
        ),
    );
    for (var i = 0; i < 10; i++) {
      canvas.drawCircle(
        Offset((i * 137 % width).toDouble(), (i * 211 % height).toDouble()),
        width / 12,
        Paint()..color = Color(0xFF000000 | (i * 2654435 & 0xFFFFFF)),
      );
    }
    return recorder.endRecording().toImage(width, height);
  }

  Future<Uint8List> rgbaOf(ui.Image image) async =>
      (await image.toByteData(format: ui.ImageByteFormat.rawRgba))!
          .buffer
          .asUint8List();

  Future<Uint8List> pngOf(ui.Image image) async =>
      (await image.toByteData(format: ui.ImageByteFormat.png))!
          .buffer
          .asUint8List();

  /// Mean absolute difference per channel, 0–255.
  double meanDifference(Uint8List a, Uint8List b) {
    var total = 0;
    for (var i = 0; i < a.length; i++) {
      total += (a[i] - b[i]).abs();
    }
    return total / a.length;
  }

  test('a raw frame comes out at exactly the edge asked for', () async {
    final source = await painted(640, 480);
    final square = await squareFromPixels(
      await rgbaOf(source),
      width: 640,
      height: 480,
      edge: 224,
    );
    addTearDown(square.dispose);
    source.dispose();

    expect(square.width, 224);
    expect(square.height, 224,
        reason: 'a model input has one legal size, and "roughly 224" is not '
            'among them — this would fail inside ONNX rather than here');
  });

  test('an encoded image and the same pixels land in the same place', () async {
    final source = await painted(640, 480);
    final pixels = await rgbaOf(source);
    final encoded = await pngOf(source);
    source.dispose();

    final fromPixels = await squareFromPixels(
      pixels,
      width: 640,
      height: 480,
      edge: 224,
    );
    final fromFile = await squareImage(encoded, edge: 224);
    addTearDown(fromPixels.dispose);
    addTearDown(fromFile.dispose);

    final a = await rgbaOf(fromPixels);
    final b = await rgbaOf(fromFile);

    expect(a.length, b.length);
    expect(
      meanDifference(a, b),
      lessThan(3),
      reason: 'the query and the index go through this function from opposite '
          'sides; a crop or a resample that differs between them makes every '
          'similarity score partly a measurement of this function',
    );
  });

  test('it is the centre of the frame that survives, not the corner', () async {
    // One bright column down the middle of a wide frame. Cropped from the left
    // it is gone; cropped from the centre it is still in the centre.
    const width = 400;
    const height = 200;
    final bytes = Uint8List(width * height * 4);
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        final p = (y * width + x) * 4;
        final bright = (x - width ~/ 2).abs() < 6;
        bytes[p] = bytes[p + 1] = bytes[p + 2] = bright ? 255 : 0;
        bytes[p + 3] = 255;
      }
    }

    final square = await squareFromPixels(
      bytes,
      width: width,
      height: height,
      edge: 64,
    );
    addTearDown(square.dispose);
    final out = await rgbaOf(square);

    int redAt(int x, int y) => out[(y * 64 + x) * 4];

    expect(redAt(32, 32), greaterThan(200));
    expect(redAt(4, 32), lessThan(60));
    expect(redAt(60, 32), lessThan(60));
  });

  test('a source smaller than the edge is not upscaled when asked not to be',
      () async {
    // What the embedding source is written with: a copy that exists to be
    // re-encoded should not have pixels invented into it.
    final source = await painted(120, 90);
    final encoded = await pngOf(source);
    source.dispose();

    final square = await squareImage(encoded, edge: 256, upscale: false);
    addTearDown(square.dispose);

    expect(square.width, 90);
    expect(square.height, 90);
  });
}
