import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:calorie_tracker/services/meal_encoder.dart';
import 'package:flutter_test/flutter_test.dart';

/// The storage format of §4: L2-normalize, quantize to int8, base64.
///
/// This is the half of the encoder that has no model in it, and it is worth
/// testing on its own because it is what every stored vector passes through —
/// a bug here degrades every comparison the app will ever make, silently and
/// uniformly, which is the hardest kind to notice on a device.
void main() {
  double cosine(Float32List a, Float32List b) {
    var dot = 0.0, na = 0.0, nb = 0.0;
    for (var i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return dot / (math.sqrt(na) * math.sqrt(nb));
  }

  Float32List randomVector(int seed, {int length = 384}) {
    final rng = math.Random(seed);
    return Float32List.fromList(
      [for (var i = 0; i < length; i++) rng.nextDouble() * 2 - 1],
    );
  }

  test('a 384-d vector stores as 384 bytes', () {
    final encoded = DinoV2Encoder.encodeVector(randomVector(1));

    expect(base64Decode(encoded), hasLength(DinoV2Encoder.dimensions));
    expect(encoded.length, lessThanOrEqualTo(520),
        reason: '~512 base64 characters, against a photo\'s ~250 KB — which is '
            'what lets an embedding outlive the picture it came from');
  });

  test('the round trip preserves direction, which is all cosine reads', () {
    final original = randomVector(2);
    final restored = DinoV2Encoder.decodeVector(
      DinoV2Encoder.encodeVector(original),
    );

    expect(restored, isNotNull);
    expect(
      cosine(original, restored!),
      greaterThan(0.999),
      reason: 'int8 quantization is only allowed to cost ranking, and this is '
          'the measurement that says it costs almost nothing',
    );
  });

  test('quantization preserves the ordering between two candidates', () {
    // The property the whole feature rests on: whatever quantization does to
    // the absolute scores, the *ranking* has to survive it.
    final query = randomVector(3);
    final near = Float32List.fromList([
      for (var i = 0; i < query.length; i++) query[i] + (i.isEven ? 0.05 : -0.05)
    ]);
    final far = randomVector(4);

    Float32List round(Float32List v) =>
        DinoV2Encoder.decodeVector(DinoV2Encoder.encodeVector(v))!;

    expect(cosine(query, near), greaterThan(cosine(query, far)));
    expect(
      cosine(round(query), round(near)),
      greaterThan(cosine(round(query), round(far))),
    );
  });

  test('magnitude is not a difference between two meals', () {
    // Cosine is scale-invariant and the quantization scale is deliberately not
    // stored, so the same direction at a different length must encode the same.
    final original = randomVector(5);
    final scaled = Float32List.fromList([for (final v in original) v * 17.3]);

    expect(
      DinoV2Encoder.encodeVector(scaled),
      DinoV2Encoder.encodeVector(original),
    );
  });

  test('a corrupt embedding is a meal that does not suggest, not a crash', () {
    expect(DinoV2Encoder.decodeVector(''), isNull);
    expect(DinoV2Encoder.decodeVector('not base64 at all!!'), isNull);
  });

  test('an all-zero vector does not divide by zero', () {
    final zeros = Float32List(DinoV2Encoder.dimensions);

    final encoded = DinoV2Encoder.encodeVector(zeros);

    expect(base64Decode(encoded), hasLength(DinoV2Encoder.dimensions));
    expect(base64Decode(encoded).every((b) => b == 0), isTrue);
  });

  test('the model id names the pipeline, not just the weights file', () {
    // `embedded-by-model` is what makes an encoder change show up as silence
    // rather than as nonsense (§9). Weights alone are not enough: the pooling
    // and the input geometry decide comparability just as much, so changing
    // either without changing this string would leave old vectors claiming to
    // be comparable when they are noise.
    expect(DinoV2Encoder.modelIdValue, contains('dinov2-small'));
    expect(DinoV2Encoder.modelIdValue, contains('cls'));
    expect(
      DinoV2Encoder.modelIdValue,
      contains('${DinoV2Encoder.inputEdge}'),
    );
  });

  test('the shipped weights and the model id cannot name different things', () {
    // These two drifting apart is the §9 migration silently *not* happening:
    // the asset changes, every vector in the database is now from different
    // weights, and `embedded-by-model` still says the old thing — so nothing
    // re-encodes and the index mixes two vector spaces while claiming they are
    // comparable. int8 → fp16 → fp32 was three consecutive chances at it.
    //
    // `assetKey` is now derived from `modelIdValue`, so this is a property
    // rather than a promise. It is asserted anyway because the derivation is
    // one edit away from being unpicked, and because `tool/export_model.py`
    // has to keep writing this exact filename — that is the half of the
    // agreement Dart cannot enforce.
    expect(
      DinoV2Encoder.assetKey,
      'assets/models/${DinoV2Encoder.modelIdValue}.onnx',
      reason: 'tool/export_model.py writes NAME = MODEL_ID + ".onnx"',
    );
  });
}
