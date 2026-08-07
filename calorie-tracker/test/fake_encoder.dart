import 'dart:convert';
import 'dart:typed_data';

import 'package:calorie_tracker/services/meal_encoder.dart';

/// An encoder, minus the 88 MB of weights and the platform channel.
///
/// What the tests around it care about is the policy, not the arithmetic: which
/// meals get picked, in what order, what happens when a source is missing, and
/// what a device with no model does. So this returns a vector derived from the
/// input bytes — same bytes, same embedding — and records what it was asked to
/// encode.
class FakeEncoder implements MealEncoder {
  FakeEncoder({this.modelId = 'fake-encoder-v1'});

  @override
  final String modelId;

  /// The bytes of every image handed over, in order.
  final List<int> encodedLengths = [];

  /// How many preview frames were handed over — the number the throttle, the
  /// blur gate and the motion gate are all about.
  int framesEncoded = 0;

  /// Set to make every call fail the way a phone with no model file does.
  bool unavailable = false;

  /// Fails only the nth call, for the "gave up part way" case.
  int? failAt;

  /// What [encodePixels] should answer with, when a test wants to choose which
  /// meal the camera is looking at. Null derives one from the pixels, as
  /// [encode] does.
  Float32List? frameVector;

  /// How long an inference takes. Zero by default; a test sets it when what it
  /// is about is what happens to the frames that arrive *during* one, which on
  /// a phone is most of them.
  Duration frameDelay = Duration.zero;

  /// The same, for [encode] — what a *stored* photo comes out as. Separate from
  /// [frameVector] because the two paths are separate, and a test that meant one
  /// of them should not be able to accidentally set the other.
  Float32List? imageVector;

  int _calls = 0;

  @override
  Future<MealEmbedding?> encode(Uint8List imageBytes) async {
    final call = _calls++;
    if (unavailable || call == failAt) return null;
    encodedLengths.add(imageBytes.length);

    final vector = imageVector;
    if (vector != null) {
      return MealEmbedding(
        base64: DinoV2Encoder.encodeVector(vector),
        modelId: modelId,
      );
    }

    // Deterministic in the input, so a test can assert that two encodes of the
    // same source agree and two of different sources do not.
    return MealEmbedding(
      base64: base64Encode(
        Uint8List.fromList([for (final b in imageBytes.take(8)) b]),
      ),
      modelId: modelId,
    );
  }

  @override
  Future<MealEmbedding?> encodePixels(
    Uint8List rgba, {
    required int width,
    required int height,
  }) async {
    if (unavailable) return null;
    // Counted before the wait, because the question every caller asks is how
    // many frames were *sent* to a model, not how many came back.
    framesEncoded++;
    if (frameDelay > Duration.zero) await Future<void>.delayed(frameDelay);

    final vector = frameVector;
    if (vector != null) {
      return MealEmbedding(
        base64: DinoV2Encoder.encodeVector(vector),
        modelId: modelId,
      );
    }
    return encode(rgba);
  }

  @override
  String? get lastError => unavailable ? 'no session (fake)' : null;

  @override
  Future<void> reset() async {
    _calls = 0;
  }

  @override
  Future<void> dispose() async {}
}
