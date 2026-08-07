import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter_onnxruntime/flutter_onnxruntime.dart';

import 'square_crop.dart';

/// Turning a food photo into a vector two photos of the same dish can be
/// compared by.
///
/// A seam for the same reason [ImageCompressor] and `CameraFeed` are ones: the
/// real implementation reaches an 88 MB model through a platform channel, and
/// the test VM has neither. [DinoV2Encoder] is the real one; everything above
/// this interface — the queue, the backfill, eventually the live preview — is
/// testable without a model file.
abstract class MealEncoder {
  /// Encode one image. Null when this device cannot (no model, no codec, a
  /// frame the decoder refused) — which every caller treats as "not yet",
  /// never as an error worth telling anybody about. A meal without an embedding
  /// is a meal that does not turn up as a suggestion, and nothing else.
  Future<MealEmbedding?> encode(Uint8List imageBytes);

  /// Encode raw RGBA — a live preview frame, which has been through no JPEG at
  /// all (`CameraFrame`).
  ///
  /// Separate from [encode] only because the pixels arrive already decoded; it
  /// is the *same* crop, the same resample and the same normalization, which is
  /// the point. A query preprocessed differently from the index scores against
  /// it in a way that looks like similarity and is the difference between two
  /// preprocessors.
  Future<MealEmbedding?> encodePixels(
    Uint8List rgba, {
    required int width,
    required int height,
  });

  /// What goes in `embedded-by-model`. See [DinoV2Encoder.modelId] for why it
  /// names more than the weights.
  String get modelId;

  /// Why the last encode came back null, in the platform's own words, or null
  /// if nothing has failed.
  ///
  /// **Temporary, for the device bring-up.** Every caller of [encode] correctly
  /// treats null as "not yet" and says nothing, which is right in the app and
  /// useless on a phone that is failing for a reason nobody can see. Four
  /// distinct failures — no session, a frame the decoder refused, an output of
  /// the wrong shape, an inference that threw — reach the user as one empty
  /// row. This is the string that separates them.
  String? get lastError;

  /// Try again on a device that has already failed.
  ///
  /// [DinoV2Encoder] latches its failure so a phone that cannot run this does
  /// not re-attempt for every meal in its history — correct, and it also means
  /// nothing can recover without a relaunch. The diagnostics screen's retry
  /// needs a way through that; nothing else calls it.
  Future<void> reset();

  /// Let go of the model. The session holds tens of megabytes of weights.
  Future<void> dispose();
}

/// A finished embedding, in the form the meal stores it.
@immutable
class MealEmbedding {
  const MealEmbedding({required this.base64, required this.modelId});

  /// Base64 of the int8-quantized vector — 384 bytes, ~512 characters. There is
  /// no bytes datatype in `atomic_lib`, so a string it is (§4).
  final String base64;

  /// The encoder that produced it. Written together with [base64] and cleared
  /// together with it: a vector whose encoder is unknown is not half a record,
  /// it is a meaningless one, because it cannot be compared to anything.
  final String modelId;
}

/// DINOv2-small, fp32, CLS-pooled in the graph, through ONNX Runtime.
///
/// The weights are exported from `facebook/dinov2-small` by
/// `tool/export_model.py` rather than fetched ready-made — for the licensing
/// reason above all, and that script carries the full argument and the
/// measurements. What matters here:
///
/// - **The graph emits `[1, 384]`, not `[1, 257, 384]`.** The pooling this app
///   uses is part of the exported model, so the CLS token is the output rather
///   than the first row of one.
/// - **Its input is fixed at `[1, 3, 224, 224]`.** One legal size, said once.
/// - **fp32, after int8 and fp16 were each tried on a phone and neither would
///   load** — integer ops no mobile ORT has kernels for, and a graph-optimizer
///   assert respectively. So the 89 MB is not a preference; it is the only one
///   of the three that runs.
///
/// Everything else was picked by measurement in `tool/encoder-bench/`: CLS
/// pooling beats mean-of-patches (precision@1 0.957 against 0.826) and matches
/// CLS+mean concatenated at half the storage, and the plain centre square beats
/// the training-faithful 87.5% crop.
///
/// MobileCLIP would have been the obvious pick and cannot ship: Apple's weights
/// are `apple-amlr`, research use only, and that flows through the ONNX
/// re-exports. DINOv2 is Apache 2.0. It gives up the text tower, which was
/// already out of scope.
class DinoV2Encoder implements MealEncoder {
  DinoV2Encoder({OnnxRuntime? runtime}) : _runtime = runtime ?? OnnxRuntime();

  final OnnxRuntime _runtime;
  OrtSession? _session;
  Future<OrtSession?>? _opening;
  bool _unavailable = false;

  @override
  String? get lastError => _lastError;
  String? _lastError;

  /// Both the log line and the readout, so the two cannot drift apart.
  void _failed(String stage, Object error) {
    _lastError = '$stage: $error';
    debugPrint('MealEncoder: $_lastError');
  }

  @override
  Future<void> reset() async {
    final session = _session;
    _session = null;
    _opening = null;
    _unavailable = false;
    _lastError = null;
    await session?.close();
  }

  /// Where `make model` puts the weights. Not committed to the repo — 89 MB of
  /// binary only this app wants — but bundled into the built app, so nothing is
  /// ever downloaded at runtime. A clone that has not run `make model` fails at
  /// build time on the missing asset rather than mysteriously at runtime.
  ///
  /// **Derived from [modelIdValue] rather than written out**, so the file and
  /// the string recorded in `embedded-by-model` cannot name different things.
  /// Two consecutive encoder swaps went through here; each was a chance to
  /// change the asset and leave the id, which is the silent failure — new
  /// weights, old id, so nothing re-encodes and the index mixes two vector
  /// spaces while claiming they are comparable. `tool/export_model.py` writes
  /// this exact filename.
  static const assetKey = 'assets/models/$modelIdValue.onnx';

  /// The input side the model is fed, and the input name the export uses.
  static const inputEdge = 224;
  static const inputName = 'pixel_values';

  /// DINOv2-small's hidden size, which is the length of one embedding.
  static const dimensions = 384;

  /// **This names the whole pipeline, not just the weights file.**
  ///
  /// `embedded-by-model` exists so that a change of encoder makes suggestions go
  /// quiet rather than go wrong (§9), and the thing that has to stay constant
  /// for two vectors to be comparable is not only which weights ran but which
  /// pooling was taken off them and what geometry went in. Change the crop and
  /// leave this string alone, and every old vector silently becomes noise that
  /// still claims to be comparable. So: weights, pooling, edge.
  ///
  /// There is no quantization term any more because there is no quantization:
  /// the app exports its own fp32 graph from `facebook/dinov2-small`
  /// (`tool/export_model.py`), after int8 and fp16 were each tried on a phone
  /// and neither would load. See that script for the whole history.
  static const modelIdValue = 'dinov2-small-cls-224';

  @override
  String get modelId => modelIdValue;

  /// ImageNet statistics, which is what DINOv2 was trained against — taken from
  /// the export's own `preprocessor_config.json` rather than remembered.
  static const _mean = [0.485, 0.456, 0.406];
  static const _std = [0.229, 0.224, 0.225];

  @override
  Future<MealEmbedding?> encode(Uint8List imageBytes) =>
      _run(() => _preprocess(squareImage(imageBytes, edge: inputEdge)));

  @override
  Future<MealEmbedding?> encodePixels(
    Uint8List rgba, {
    required int width,
    required int height,
  }) =>
      _run(() => _preprocess(
            squareFromPixels(rgba, width: width, height: height, edge: inputEdge),
          ));

  Future<MealEmbedding?> _run(Future<Float32List> Function() prepare) async {
    final session = await _openSession();
    if (session == null) return null;

    Float32List input;
    try {
      input = await prepare();
    } catch (e) {
      // A frame the decoder would not take. One meal goes un-embedded, which is
      // the same outcome as not having got round to it yet.
      _failed('could not read the image', e);
      return null;
    }

    OrtValue? tensor;
    Map<String, OrtValue>? outputs;
    try {
      tensor = await OrtValue.fromList(input, [1, 3, inputEdge, inputEdge]);
      outputs = await session.run({inputName: tensor});

      final output = outputs.values.first;
      final flat = (await output.asFlattenedList()).cast<num>();

      // **The graph pools, so this is already the CLS token: [1, 384].** It
      // used to emit `last_hidden_state` at [1, 257, 384] and this code took
      // the first row — which meant 98,688 floats crossed the platform channel
      // three times a second so that 384 of them could be read and the rest
      // dropped, 386 KB a frame against 1.5. `tool/export_model.py` folds the
      // pooling into the exported graph instead. The vectors are identical
      // (cosine 1.000000); only the payload changed.
      if (flat.length < dimensions) {
        _failed('output shape', '${flat.length} values, want $dimensions');
        return null;
      }
      _lastError = null;
      final cls = Float32List(dimensions);
      for (var i = 0; i < dimensions; i++) {
        cls[i] = flat[i].toDouble();
      }

      return MealEmbedding(base64: encodeVector(cls), modelId: modelId);
    } catch (e) {
      _failed('inference failed', e);
      return null;
    } finally {
      await tensor?.dispose();
      if (outputs != null) {
        for (final value in outputs.values) {
          await value.dispose();
        }
      }
    }
  }

  /// A centre square at [inputEdge], normalized, as NCHW float32.
  ///
  /// The crop comes from `square_crop.dart` rather than being done here,
  /// because the live preview stream needs the identical geometry off a camera
  /// frame and two implementations of it would drift. Both callers hand this
  /// the same square, made the same way, off different sources.
  static Future<Float32List> _preprocess(Future<ui.Image> squared) async {
    final square = await squared;
    try {
      final raw = await square.toByteData(format: ui.ImageByteFormat.rawRgba);
      if (raw == null) throw StateError('the decoder returned no pixels');
      final rgba = raw.buffer.asUint8List();

      const plane = inputEdge * inputEdge;
      final out = Float32List(3 * plane);
      for (var i = 0; i < plane; i++) {
        final p = i * 4;
        // Planar, not interleaved: the model wants NCHW, so all the reds, then
        // all the greens, then all the blues. Alpha is dropped — every source
        // here is an opaque JPEG or an opaque camera frame.
        out[i] = (rgba[p] / 255.0 - _mean[0]) / _std[0];
        out[plane + i] = (rgba[p + 1] / 255.0 - _mean[1]) / _std[1];
        out[2 * plane + i] = (rgba[p + 2] / 255.0 - _mean[2]) / _std[2];
      }
      return out;
    } finally {
      square.dispose();
    }
  }

  /// Open once, and remember a failure so a phone that cannot run this does not
  /// try again for every meal in its history.
  Future<OrtSession?> _openSession() {
    if (_unavailable) return Future.value(null);
    final open = _session;
    if (open != null) return Future.value(open);
    return _opening ??= _open();
  }

  Future<OrtSession?> _open() async {
    try {
      final session = await _runtime.createSessionFromAsset(
        assetKey,
        options: OrtSessionOptions(providers: await _providers()),
      );
      _session = session;
      // Temporary, for the device bring-up: the failure below was already loud
      // and the success was silent, so "no encoder on this phone" and "an
      // encoder that matches nothing" looked identical from a log.
      debugPrint('MealEncoder: session open ($assetKey)');
      return session;
    } catch (e) {
      // The one case worth being loud about in a log and silent everywhere
      // else: a build without `make model` run, which is a developer's problem
      // and never a user's.
      _failed('no session ($assetKey)', e);
      _unavailable = true;
      return null;
    } finally {
      _opening = null;
    }
  }

  /// The accelerators this device actually has, best first, CPU last.
  ///
  /// **Asked rather than assumed, because the plugin validates the list instead
  /// of falling back through it.** This is the bug that cost Phase 7 its first
  /// device run: the list was hardcoded to `[CORE_ML, NNAPI, CPU]` on the
  /// understanding that "the runtime picks the first that will take it", and it
  /// does not. `flutter_onnxruntime` walks the list and appends each provider
  /// by name; a name the *platform's* plugin has no case for is a hard
  /// `INVALID_PROVIDER` failure of the whole session, not a skip. iOS knows
  /// CPU, CORE_ML and XNNPACK — so `NNAPI`, sitting in the middle of that list
  /// for Android's benefit, failed session creation on every iPhone. Which then
  /// set `_unavailable` and turned the whole feature off for the run, silently,
  /// exactly as a phone with no model would.
  ///
  /// So: intersect what we want with what the device reports. CPU is always
  /// appended, because an accelerator that refuses the model has to mean
  /// "slower", not "no suggestions" — which was the original intent and is now
  /// actually what happens.
  Future<List<OrtProvider>> _providers() async {
    // Core ML and NNAPI are what make this worth being a plugin rather than
    // `candle` in the Rust crate (§5). Neither is ever reported by the platform
    // it does not belong to.
    const wanted = [OrtProvider.CORE_ML, OrtProvider.NNAPI];
    try {
      final available = (await _runtime.getAvailableProviders()).toSet();
      final providers = [
        for (final provider in wanted)
          if (available.contains(provider)) provider,
        OrtProvider.CPU,
      ];
      debugPrint('MealEncoder: providers ${providers.map((p) => p.name)}');
      return providers;
    } catch (e) {
      // Asking failed, which says nothing about whether inference will. CPU is
      // the one provider every platform's plugin has a case for.
      debugPrint('MealEncoder: could not list providers ($e) — CPU only');
      return const [OrtProvider.CPU];
    }
  }

  @override
  Future<void> dispose() async {
    final session = _session;
    _session = null;
    await session?.close();
  }

  // ── The storage format ───────────────────────────────────────────────────

  /// L2-normalize, quantize to int8, base64.
  ///
  /// Quantization is symmetric and per-vector, and the scale is deliberately
  /// *not* stored: cosine similarity is scale-invariant and ranking is the only
  /// thing these vectors are ever used for, so the scale would be 4 bytes that
  /// no reader could do anything with. `tool/encoder-bench/` confirms the round
  /// trip moves neither precision@1 nor the intra/inter gap at three decimals.
  ///
  /// 384 dimensions at one byte each is 384 bytes, ~512 base64 characters —
  /// against a photo's ~250 KB, which is what lets an embedding outlive the
  /// picture it came from (§4).
  static String encodeVector(Float32List vector) {
    var norm = 0.0;
    for (final v in vector) {
      norm += v * v;
    }
    norm = norm <= 0 ? 1.0 : math.sqrt(norm);

    var peak = 0.0;
    final unit = Float32List(vector.length);
    for (var i = 0; i < vector.length; i++) {
      unit[i] = vector[i] / norm;
      final magnitude = unit[i].abs();
      if (magnitude > peak) peak = magnitude;
    }
    if (peak <= 0) peak = 1.0;

    final bytes = Int8List(vector.length);
    for (var i = 0; i < unit.length; i++) {
      final scaled = (unit[i] / peak * 127).round();
      bytes[i] = scaled > 127 ? 127 : (scaled < -127 ? -127 : scaled);
    }
    return base64Encode(bytes.buffer.asUint8List());
  }

  /// The other direction, for whoever is doing the comparing. Returns null
  /// rather than throwing on anything malformed: a corrupt embedding arriving
  /// over sync is a meal that does not suggest, not a crash.
  ///
  /// **The result is L2-normalized, and that is this function's job rather than
  /// its callers'.** [encodeVector] divides by the vector's *peak component* on
  /// the way in — that is what puts an int8 range to use — so the naive inverse
  /// is a vector of norm `1/peak`, which is 3–8 rather than 1. Every consumer
  /// scores by plain dot product on the promise that both sides are unit, so a
  /// caller that forgot got scores inflated by that factor: silently, because
  /// an inflated cosine is still a number in the right shape. Three callers,
  /// three chances to forget, and two of them had. Normalizing here is the only
  /// version of this that cannot be got wrong somewhere else.
  static Float32List? decodeVector(String encoded) {
    if (encoded.isEmpty) return null;
    try {
      final bytes = base64Decode(encoded).buffer.asInt8List();
      final out = Float32List(bytes.length);
      var norm = 0.0;
      for (var i = 0; i < bytes.length; i++) {
        final v = bytes[i] / 127.0;
        out[i] = v;
        norm += v * v;
      }
      if (norm > 0) {
        final inverse = 1.0 / math.sqrt(norm);
        for (var i = 0; i < out.length; i++) {
          out[i] *= inverse;
        }
      }
      return out;
    } catch (_) {
      return null;
    }
  }
}
