import 'dart:typed_data';

import 'package:calorie_tracker/services/image_store.dart';

/// Compression, minus the codec.
///
/// The real one goes through native encoders the test VM does not have. What
/// the tests here care about is everything around it — that both sizes get
/// written, that the counter tracks them, that the sweep picks the right files
/// — so this returns a block of bytes whose *length* is what the test asked
/// for, and records what it was asked to do.
class FakeCompressor implements ImageCompressor {
  FakeCompressor({this.bytesPerEdge = 200});

  /// Output size, in bytes, per pixel of the longest edge. The default makes a
  /// 1024px image ~200 KB and its 256px thumbnail ~50 KB, which is close enough
  /// to the real ratio that budget arithmetic in tests reads like the real
  /// thing.
  final int bytesPerEdge;

  /// What was asked for, in order. [square] is what tells the embedding source
  /// apart from the photo and the thumbnail — it is the only one whose geometry
  /// is load-bearing, so it is the only one worth being able to assert on.
  final List<({int maxEdge, int quality, bool square})> calls = [];

  @override
  Future<Uint8List> compress(
    Uint8List source, {
    required int maxEdge,
    required int quality,
  }) async {
    calls.add((maxEdge: maxEdge, quality: quality, square: false));
    return Uint8List(maxEdge * bytesPerEdge);
  }

  @override
  Future<Uint8List> compressSquare(
    Uint8List source, {
    required int edge,
    required int quality,
  }) async {
    calls.add((maxEdge: edge, quality: quality, square: true));
    return Uint8List(edge * bytesPerEdge);
  }
}
