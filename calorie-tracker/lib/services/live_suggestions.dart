import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import 'camera_feed.dart';
import 'camera_frame.dart';
import 'meal_encoder.dart';
import 'meal_index.dart';
import 'meal_suggestions.dart';

/// What the camera is looking at, matched against what this person has eaten.
///
/// The chips above the shutter come from here whenever anything is close enough,
/// and from the frequency list underneath when nothing is
/// (`calorie-tracker-embeddings.md` §7). Live rather than post-capture, which is
/// the load-bearing decision: a tapped suggestion writes a `confirmed` meal that
/// `update_meal_estimate` is then forbidden to correct, so a wrong one has to
/// cost nothing — and with the food in frame it does, because the user presses
/// the shutter instead, which is what they were going to do anyway.
///
/// **Nothing on the capture path waits for any of this.** The shutter is exactly
/// what it was: compress, write, log, done. This is an overlay that either has
/// an answer by the time the user decides or does not.
class LiveSuggestions extends ChangeNotifier {
  LiveSuggestions({
    required CameraFeed camera,
    required MealEncoder encoder,
    required MealIndex index,
  })  : _camera = camera,
        _encoder = encoder,
        _index = index;

  final CameraFeed _camera;
  final MealEncoder _encoder;
  final MealIndex _index;

  // ── The numbers, all of which §11 owns ───────────────────────────────────
  //
  // Every constant here is provisional, and deliberately gathered in one place
  // for that reason. Cosine has no units, so none of these can be reasoned to —
  // they come from pointing a real phone at real repeated meals over real days
  // and reading the log. The starting points are from `tool/encoder-bench/`:
  // inter-dish similarity averages 0.080 and real intra-dish runs 0.50–0.65 on
  // a 23-photo fixture set, which is stock food photography rather than one
  // kitchen in evening light.

  /// How often a frame is worth an inference. ~3 Hz: fast enough that the row
  /// has caught up by the time somebody has decided where to point the phone,
  /// slow enough that it is a rounding error against the camera already running.
  static const sampleInterval = Duration(milliseconds: 320);

  /// Above this, a past meal is offered as a chip. Generous on purpose — §2's
  /// argument is that a wrong suggestion in a live viewfinder costs nothing.
  static const suggestThreshold = 0.55;

  /// Weight given to what the last frames said, in the EMA over query vectors.
  ///
  /// Without it the row re-ranks on every frame and flickers between two
  /// candidates that are half a point apart, which reads as broken software
  /// rather than as a close call.
  static const smoothing = 0.6;

  /// How far a challenger has to beat the incumbent before the chips swap.
  ///
  /// The other half of the same problem, and the half that matters at the
  /// boundary: smoothing steadies the *query*, this steadies the *answer*. The
  /// target is a list that changes when the user re-aims and is otherwise still.
  static const swapMargin = 0.04;

  /// Variance of the Laplacian below which the frame is too soft to spend an
  /// inference on. Most of what a camera sees on the way to the plate is a
  /// table, a lap, or motion blur; the threshold would reject those anyway, but
  /// not before paying for them.
  static const minSharpness = 60.0;

  /// Mean absolute luma change, out of 255, above which the phone is being
  /// moved rather than aimed. Cheaper than an inference and stops the row
  /// twitching while the phone is being raised.
  static const maxMotion = 12.0;

  /// The side of the grid the motion check samples. Coarse deliberately: it is
  /// asking whether the view changed, not what it changed to.
  static const _motionGrid = 16;

  // ── State ────────────────────────────────────────────────────────────────

  StreamSubscription<CameraFrame>? _frames;
  bool _wanted = false;
  bool _busy = false;

  Float32List? _query;
  Uint8List? _lastGrid;
  List<ScoredSuggestion> _matches = const [];

  /// The meals to offer, best first. Empty when nothing is close enough, which
  /// is when the capture screen falls back to [MealSuggestions.frequent].
  List<MealSuggestion> get matches =>
      [for (final m in _matches) m.suggestion];

  /// The best score of the last frame that was actually looked at, or 0.
  ///
  /// Exposed because §11 says the thresholds come from a log of exactly this,
  /// kept while somebody lives with the app for a week.
  double get topScore => _matches.isEmpty ? 0 : _matches.first.score;

  /// Whether frames are being watched. False before the camera is up, and after
  /// [stop].
  bool get running => _frames != null;

  /// Frames encoded since [start] — for the same calibration log.
  int get framesEncoded => _framesEncoded;
  int _framesEncoded = 0;

  /// The best score of the last frame that was *scored*, above or below the
  /// threshold — unlike [topScore], which is 0 whenever nothing was offered.
  /// The one number that says whether this is a threshold problem or a
  /// pipeline problem, and it needs somewhere to be read from a phone with no
  /// cable attached.
  double get bestSeen => _bestSeen;
  double _bestSeen = 0;

  /// The highest score any frame has reached since the app started.
  ///
  /// [bestSeen] alone reads low for a reason that has nothing to do with the
  /// encoder: the last frame before anybody opens a screen to *look* at these
  /// numbers is the phone being lowered, which is a table. This survives
  /// [stop], because the question it answers — how close does this person's
  /// food actually get to the bar — spans a session rather than a viewfinder.
  double get bestEver => _bestEver;
  double _bestEver = 0;

  /// How long the last inference took, wall clock, or 0.
  ///
  /// This is the ceiling on how fast the row can possibly react: [_busy] means
  /// one frame is scored per inference, so [sampleInterval] is a floor and this
  /// is the real rate. If it reads ~50 ms an accelerator took the graph; if it
  /// reads several hundred, this is running on the CPU.
  int get lastEncodeMs => _lastEncodeMs;
  int _lastEncodeMs = 0;

  // ── Turning it on and off ────────────────────────────────────────────────

  /// Watch the preview.
  ///
  /// Safe to call when the camera is not up yet: this listens to it and attaches
  /// when it is, which is also how it recovers from Android taking the camera
  /// away while the app was in the background.
  void start() {
    if (_wanted) return;
    _wanted = true;
    _camera.addListener(_cameraChanged);
    _attach();
  }

  /// Stop watching, and forget what was on screen.
  ///
  /// Called on `paused`, on `inactive` and on navigating off the capture screen
  /// — §6's "battery is bounded by the viewfinder being up" is only true if
  /// something actually ends the stream. The smoothed query is dropped too: it
  /// describes a plate somebody has walked away from.
  Future<void> stop() async {
    _wanted = false;
    _camera.removeListener(_cameraChanged);
    final frames = _frames;
    _frames = null;
    _query = null;
    _lastGrid = null;
    await frames?.cancel();
    if (_matches.isNotEmpty) {
      _matches = const [];
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _camera.removeListener(_cameraChanged);
    unawaited(_frames?.cancel());
    _frames = null;
    super.dispose();
  }

  void _cameraChanged() {
    if (!_wanted) return;
    _attach();
  }

  void _attach() {
    if (_frames != null || !_camera.isReady) return;
    _frames = _camera.frames(minInterval: sampleInterval).listen(
          _onFrame,
          onError: (Object e) => debugPrint('Preview stream: $e'),
          // A stream that ends is a camera that went away. Re-attaching is the
          // camera listener's job, so that there is one path rather than two.
          onDone: () => _frames = null,
          cancelOnError: true,
        );
  }

  // ── One frame ────────────────────────────────────────────────────────────

  Future<void> _onFrame(CameraFrame frame) async {
    if (_index.isEmpty) return;

    // **The motion check runs on every frame, including the ones an inference
    // is already busy through.** It used to sit behind the `_busy` gate, which
    // quietly made it a function of how fast the phone was: the grid was only
    // ever replaced on frames that reached the encoder, so with an inference
    // taking ~800 ms the two frames being compared were most of a second apart
    // and ordinary hand-shake measured like a re-aim. The gate then rejected
    // the frame, which pushed the *next* comparison further apart still. A
    // threshold in luma-per-frame has to be sampled at a fixed interval or it
    // is not a threshold at all, and this is cheap enough — 256 samples — to
    // run on every one.
    final grid = _lumaGrid(frame);
    final previous = _lastGrid;
    _lastGrid = grid;

    // Moving, not aiming. Deliberately *after* storing the grid, so the frame
    // that ends the movement is compared against where the phone actually was.
    if (previous != null && _motionBetween(previous, grid) > maxMotion) {
      // **And the smoothed query goes with it.** This is the whole of the
      // "suggestions take three seconds to catch up" problem. The EMA exists to
      // steady a view somebody is holding still; once the phone has been swung
      // to a different plate, what it holds is an average of a meal that is no
      // longer in front of the camera, and at [smoothing] 0.6 it takes four or
      // five *inferences* to wash out — which at a second each is the delay
      // that was being felt. A large view change is the one unambiguous signal
      // that the average describes something gone, and dropping it makes the
      // first inference on the new plate the answer rather than a fifth of it.
      // Same reasoning as [stop] clearing it, arrived at from the other end.
      _query = null;
      return;
    }

    // An inference still running is the strongest throttle there is, and the
    // only one that adapts to the phone it is on.
    if (_busy) return;
    if (_sharpnessOf(frame) < minSharpness) return;

    _busy = true;
    final started = DateTime.now();
    try {
      final embedding = await _encoder.encodePixels(
        frame.rgba,
        width: frame.edge,
        height: frame.edge,
      );
      if (!_wanted || embedding == null) return;

      final vector = DinoV2Encoder.decodeVector(embedding.base64);
      if (vector == null || vector.isEmpty) return;
      _framesEncoded++;
      // One inference, wall clock. The only number that says whether the row is
      // slow because the model is slow or because the policy above is holding
      // it up, and the two want completely different fixes.
      _lastEncodeMs = DateTime.now().difference(started).inMilliseconds;

      _rank(_smooth(vector));
    } catch (e) {
      // One bad frame. The next one is along in 320 ms.
      debugPrint('Could not match this frame: $e');
    } finally {
      _busy = false;
    }
  }

  /// Fold this frame's vector into the running one, and re-normalize.
  ///
  /// Re-normalizing matters: the index scores by dot product on the promise that
  /// both sides are unit vectors, and a weighted sum of two unit vectors is not
  /// one. Without this the scores would sag whenever the view was changing,
  /// which is exactly when the smoothing is doing something.
  Float32List _smooth(Float32List vector) {
    final previous = _query;
    if (previous == null || previous.length != vector.length) {
      _query = vector;
      return vector;
    }

    final merged = Float32List(vector.length);
    var norm = 0.0;
    for (var i = 0; i < vector.length; i++) {
      final v = previous[i] * smoothing + vector[i] * (1 - smoothing);
      merged[i] = v;
      norm += v * v;
    }
    if (norm > 0) {
      final inverse = 1.0 / math.sqrt(norm);
      for (var i = 0; i < merged.length; i++) {
        merged[i] *= inverse;
      }
    }
    _query = merged;
    return merged;
  }

  /// Rank the history against [query], keeping what is already on screen unless
  /// something clearly beats it.
  ///
  /// Two rules, and they are the whole of the hysteresis:
  ///
  /// - **Nothing overtakes what it does not beat by [swapMargin].** The row
  ///   starts in the order it is already in and is bubbled from there, so a
  ///   candidate half a hundredth ahead does not move the chip somebody is
  ///   reaching for. Sorting by score and nudging the incumbents would not do
  ///   this: once two chips are both incumbents the nudge cancels out and they
  ///   swap on any lead at all, which is the flicker this exists to stop.
  /// - **A chip already up survives [swapMargin] below the threshold.** The
  ///   same number doing the other half of the job: a match hovering at the
  ///   boundary either stays or leaves rather than blinking.
  ///
  /// A bubble pass over at most eight items, a few times a second. The clarity
  /// is worth more here than the four comparisons it saves.
  void _rank(Float32List query) {
    final scored = _index.nearest(query, limit: MealSuggestions.limit * 2);
    final fresh = {
      for (final match in scored) match.suggestion.sourceSubject: match,
    };

    // The incumbents in the order they are in, then everything new, by score.
    final ordered = <ScoredSuggestion>[];
    for (final held in _matches) {
      final now = fresh.remove(held.suggestion.sourceSubject);
      if (now != null) ordered.add(now);
    }
    ordered.addAll(fresh.values);

    for (var pass = 0; pass < ordered.length; pass++) {
      var moved = false;
      for (var i = 0; i + 1 < ordered.length; i++) {
        if (ordered[i + 1].score - ordered[i].score > swapMargin) {
          final held = ordered[i];
          ordered[i] = ordered[i + 1];
          ordered[i + 1] = held;
          moved = true;
        }
      }
      if (!moved) break;
    }

    final incumbents = {for (final m in _matches) m.suggestion.sourceSubject};
    final kept = [
      for (final match in ordered)
        if (match.score >=
            (incumbents.contains(match.suggestion.sourceSubject)
                ? suggestThreshold - swapMargin
                : suggestThreshold))
          match,
    ].take(MealSuggestions.limit).toList();

    final unchanged = _sameAs(kept);
    // Assigned either way, so [topScore] is the last thing measured rather than
    // the last thing drawn — it is what §11's calibration log reads.
    _matches = kept;

    // **The best score, whether or not the row moved.** Logging only on a
    // change meant a phone where nothing ever cleared the threshold printed
    // nothing at all, so "the encoder is dead", "the camera stream is dead" and
    // "0.55 is too high" were one indistinguishable silence. This is the number
    // §11 wants anyway: every frame that got as far as being scored, and what
    // it scored against the bar it had to clear.
    _bestSeen = ordered.isEmpty ? 0 : ordered.first.score;
    if (_bestSeen > _bestEver) _bestEver = _bestSeen;
    if (kDebugMode && ordered.isNotEmpty) {
      debugPrint('suggestions: frame $_framesEncoded in ${_lastEncodeMs}ms — '
          'best ${ordered.first.suggestion.name} '
          '${ordered.first.score.toStringAsFixed(3)} '
          '(need ${suggestThreshold.toStringAsFixed(2)}), '
          '${_index.size} in index');
    }

    // The scores moved and the answer did not, which is the point of all of the
    // above. Nothing to repaint.
    if (unchanged) return;

    // §11: the thresholds above cannot be reasoned to, only read off a week of
    // this. Every row change, with what it scored and what it beat — which is
    // enough to answer both questions that phase asks: where the line should
    // be, and whether the embedding beats "the four things you eat most".
    if (kDebugMode) {
      final best = ordered.isEmpty ? null : ordered.first;
      debugPrint('suggestions: '
          '${kept.map((m) => '${m.suggestion.name} '
              '${m.score.toStringAsFixed(3)}').join(', ')}'
          '${kept.isEmpty ? 'none, best was '
              '${best?.score.toStringAsFixed(3) ?? '-'}' : ''}');
    }
    notifyListeners();
  }

  bool _sameAs(List<ScoredSuggestion> next) {
    if (next.length != _matches.length) return false;
    for (var i = 0; i < next.length; i++) {
      if (next[i].suggestion.sourceSubject !=
          _matches[i].suggestion.sourceSubject) {
        return false;
      }
    }
    return true;
  }

  // ── The garbage-frame gate ───────────────────────────────────────────────

  /// Mean luma over a coarse grid, for comparing one frame to the next.
  static Uint8List _lumaGrid(CameraFrame frame) {
    final grid = Uint8List(_motionGrid * _motionGrid);
    final cell = frame.edge / _motionGrid;
    for (var gy = 0; gy < _motionGrid; gy++) {
      for (var gx = 0; gx < _motionGrid; gx++) {
        // The centre of the cell rather than an average of it: this is a
        // question about whether the view moved, and a sample answers it for a
        // fraction of the reads.
        final x = ((gx + 0.5) * cell).floor().clamp(0, frame.edge - 1);
        final y = ((gy + 0.5) * cell).floor().clamp(0, frame.edge - 1);
        grid[gy * _motionGrid + gx] = frame.lumaAt(x, y);
      }
    }
    return grid;
  }

  static double _motionBetween(Uint8List a, Uint8List b) {
    var total = 0;
    for (var i = 0; i < a.length; i++) {
      total += (a[i] - b[i]).abs();
    }
    return total / a.length;
  }

  /// Variance of the Laplacian over the middle of the frame.
  ///
  /// Sampled at *native* adjacency — neighbouring pixels, every third one —
  /// rather than off the grid above. A downsampled image has had its high
  /// frequencies averaged away, so a blur measured on one says everything is
  /// blurred, which is the same as saying nothing.
  static double _sharpnessOf(CameraFrame frame) {
    final edge = frame.edge;
    if (edge < 32) return 0;

    // The middle half, which is where a plate held at arm's length is. The
    // edges of the frame are a table and a sleeve, and their focus is not the
    // question.
    final from = edge ~/ 4;
    final to = edge - from;

    var count = 0;
    var sum = 0.0;
    var sumSquares = 0.0;
    for (var y = from; y < to; y += 3) {
      for (var x = from; x < to; x += 3) {
        final laplacian = 4 * frame.lumaAt(x, y) -
            frame.lumaAt(x - 1, y) -
            frame.lumaAt(x + 1, y) -
            frame.lumaAt(x, y - 1) -
            frame.lumaAt(x, y + 1);
        sum += laplacian;
        sumSquares += laplacian * laplacian;
        count++;
      }
    }
    if (count == 0) return 0;

    final mean = sum / count;
    return sumSquares / count - mean * mean;
  }
}
