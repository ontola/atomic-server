import 'dart:math' as math;
import 'dart:typed_data';

import 'package:calorie_tracker/models/meal.dart';
import 'package:calorie_tracker/services/camera_frame.dart';
import 'package:calorie_tracker/services/live_suggestions.dart';
import 'package:calorie_tracker/services/meal_encoder.dart';
import 'package:calorie_tracker/services/meal_index.dart';
import 'package:calorie_tracker/services/meal_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_camera.dart';
import 'fake_encoder.dart';
import 'fake_meal_backend.dart';

/// The live pipeline: what gets encoded, what gets shown, and what stops.
///
/// No model and no camera — the encoder is told what to answer, so every test
/// here is about the *policy* around it. That is where this phase's bugs live:
/// a gate that lets everything through costs battery on a phone that is also
/// running a camera, and one that lets nothing through is a feature that
/// silently does not exist.
void main() {
  const model = 'fake-encoder-v1';

  late FakeMealBackend backend;
  late FakeCamera camera;
  late FakeEncoder encoder;
  late MealIndex index;
  late LiveSuggestions live;

  /// Unit vectors, one axis each: two meals that look nothing like each other.
  Float32List axis(int which, {int length = 8}) {
    final vector = Float32List(length);
    vector[which % length] = 1;
    return vector;
  }

  /// A unit vector [degrees] round from axis 0 towards axis 1 — how a query
  /// that is *between* two known meals is written down.
  Float32List between(double degrees, {int length = 8}) {
    final vector = Float32List(length);
    final radians = degrees * math.pi / 180;
    vector[0] = math.cos(radians);
    vector[1] = math.sin(radians);
    return vector;
  }

  var nextId = 0;
  void seed(String name, Float32List vector) => backend.seed(Meal(
        subject: 'did:ad:meal:${nextId++}',
        name: name,
        description: '',
        consumedAt: DateTime(2026, 8, 5, 12).add(Duration(minutes: nextId)),
        status: MealStatus.estimated,
        calories: 400,
        imagePath: 'photos/$nextId.jpg',
        embedding: DinoV2Encoder.encodeVector(vector),
        embeddedByModel: model,
      ));

  /// A frame with real detail in it: alternating pixels, which is what the blur
  /// gate is looking for.
  CameraFrame sharp({bool invert = false, int edge = 64}) {
    final rgba = Uint8List(edge * edge * 4);
    for (var y = 0; y < edge; y++) {
      for (var x = 0; x < edge; x++) {
        final on = ((x + y).isEven) != invert;
        final p = (y * edge + x) * 4;
        rgba[p] = rgba[p + 1] = rgba[p + 2] = on ? 255 : 0;
        rgba[p + 3] = 255;
      }
    }
    return CameraFrame(edge: edge, rgba: rgba);
  }

  /// A smooth ramp: no high frequencies at all, which is what a phone in motion
  /// and a phone pointed at a tablecloth both look like.
  CameraFrame blurred({int edge = 64}) {
    final rgba = Uint8List(edge * edge * 4);
    for (var y = 0; y < edge; y++) {
      for (var x = 0; x < edge; x++) {
        final p = (y * edge + x) * 4;
        rgba[p] = rgba[p + 1] = rgba[p + 2] = (x * 255 ~/ edge);
        rgba[p + 3] = 255;
      }
    }
    return CameraFrame(edge: edge, rgba: rgba);
  }

  /// Let the frame that was just emitted be worked through. Nothing here waits
  /// on a real clock; the encoder answers on a microtask.
  Future<void> settle() async {
    for (var i = 0; i < 4; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  Future<void> show(CameraFrame frame, {int times = 1}) async {
    for (var i = 0; i < times; i++) {
      expect(camera.emit(frame), isTrue,
          reason: 'nothing is listening to the preview — the stream was never '
              'attached or was cancelled');
      await settle();
    }
  }

  List<String> chipNames() => [for (final m in live.matches) m.name];

  setUp(() async {
    backend = FakeMealBackend();
    camera = FakeCamera();
    encoder = FakeEncoder(modelId: model);
    index = MealIndex(meals: MealStore(backend: backend), modelId: model);
    live = LiveSuggestions(camera: camera, encoder: encoder, index: index);
  });

  tearDown(() async {
    await live.stop();
    live.dispose();
  });

  Future<void> begin() async {
    await index.refresh();
    live.start();
  }

  group('attaching', () {
    test('the camera is asked for the interval this class owns', () async {
      await begin();

      expect(camera.lastInterval, LiveSuggestions.sampleInterval);
      expect(live.running, isTrue);
    });

    test('starting before the camera is up attaches when it comes up', () async {
      camera = FakeCamera(ready: false);
      live = LiveSuggestions(camera: camera, encoder: encoder, index: index);

      live.start();
      expect(live.running, isFalse);

      camera.becomeReady();
      expect(live.running, isTrue,
          reason: 'the same path recovers from Android taking the camera away '
              'while the app was in the background');
    });

    test('stopping cancels the stream and forgets what was on screen', () async {
      seed('Porridge', axis(0));
      await begin();
      encoder.frameVector = axis(0);
      await show(sharp());
      expect(chipNames(), ['Porridge']);

      await live.stop();

      expect(camera.frameStreamsCancelled, 1);
      expect(camera.streams, isEmpty);
      expect(live.matches, isEmpty,
          reason: 'the smoothed query describes a plate somebody has walked '
              'away from');
    });

    test('starting again after stopping attaches a second time', () async {
      await begin();
      await live.stop();
      live.start();

      expect(camera.frameStreams, 2);
      expect(live.running, isTrue);
    });
  });

  group('the gate', () {
    test('nothing is encoded when there is nothing to match against', () async {
      await begin();
      await show(sharp(), times: 3);

      expect(encoder.framesEncoded, 0,
          reason: 'cold start is silence, and silence should not cost battery');
    });

    test('a frame with no detail in it is not worth an inference', () async {
      seed('Porridge', axis(0));
      await begin();

      await show(blurred(), times: 3);

      expect(encoder.framesEncoded, 0);
    });

    test('a frame taken while the phone was moving is skipped', () async {
      seed('Porridge', axis(0));
      await begin();
      encoder.frameVector = axis(0);

      await show(sharp());
      expect(encoder.framesEncoded, 1);

      // The whole view changed between one frame and the next: the phone is
      // being raised, not aimed.
      await show(sharp(invert: true));
      expect(encoder.framesEncoded, 1);

      // And the frame after it, which is where the phone came to rest, is.
      await show(sharp(invert: true));
      expect(encoder.framesEncoded, 2);
    });

    test('re-aiming drops the smoothed query, so one inference answers',
        () async {
      // The latency bug this exists to stop: the EMA holds 60% of the plate the
      // phone was pointed at, so after a swing to a different meal it took four
      // or five *inferences* — seconds, at a second each — before the new one
      // outweighed the old. A large view change means the average describes
      // something no longer in front of the camera.
      seed('Porridge', axis(0));
      seed('Cappuccino', axis(1));
      await begin();

      // Settle thoroughly on the first meal, so the EMA is fully committed.
      encoder.frameVector = axis(0);
      await show(sharp(), times: 4);
      expect(chipNames(), ['Porridge']);

      // Swing the phone: the whole view changes, and the next steady frame is
      // a different meal.
      await show(sharp(invert: true));
      encoder.frameVector = axis(1);
      await show(sharp(invert: true));

      expect(chipNames(), ['Cappuccino'],
          reason: 'the first inference after a re-aim has to be the answer, '
              'not a fifth of it — otherwise the row lags by however long '
              'four inferences take on this phone');
    });

    test('a steady view still smooths, so the row does not flicker', () async {
      // The other half, and the reason the reset above is conditional on
      // motion rather than done every frame: with the view held still the EMA
      // must still be doing its job.
      seed('Porridge', axis(0));
      seed('Cappuccino', axis(1));
      await begin();

      encoder.frameVector = axis(0);
      await show(sharp(), times: 3);
      expect(chipNames(), ['Porridge']);

      // One frame of noise — a hand across the plate, a reflection — with the
      // phone held still. It must not take the row with it.
      encoder.frameVector = between(80);
      await show(sharp());

      expect(chipNames(), ['Porridge'],
          reason: 'a single odd frame on a steady view is what the EMA is for');
    });

    test('the inference time is recorded, since it is the real frame rate',
        () async {
      seed('Porridge', axis(0));
      await begin();
      encoder.frameVector = axis(0);
      encoder.frameDelay = const Duration(milliseconds: 30);

      camera.emit(sharp());
      await Future<void>.delayed(const Duration(milliseconds: 150));

      expect(live.lastEncodeMs, greaterThanOrEqualTo(30),
          reason: 'one frame is scored per inference, so this and not '
              'sampleInterval is what bounds how fast the row can react');
    });

    test('a second frame arriving mid-inference is dropped', () async {
      seed('Porridge', axis(0));
      await begin();
      encoder.frameVector = axis(0);

      // An inference that takes a moment, which is what one is on a phone: the
      // frames that arrive during it are most of them.
      encoder.frameDelay = const Duration(milliseconds: 40);

      final frame = sharp();
      camera.emit(frame);
      camera.emit(frame);
      await Future<void>.delayed(const Duration(milliseconds: 150));

      expect(encoder.framesEncoded, 1,
          reason: 'an inference already running is the strongest throttle '
              'there is, and the only one that adapts to the phone');
    });
  });

  group('what the row shows', () {
    test('a meal the camera recognises', () async {
      seed('Porridge', axis(0));
      seed('Ramen', axis(3));
      await begin();

      encoder.frameVector = axis(3);
      await show(sharp());

      expect(chipNames(), ['Ramen']);
      expect(live.topScore, closeTo(1.0, 0.02));
    });

    test('nothing at all when nothing is close enough', () async {
      seed('Porridge', axis(0));
      await begin();

      // Most of a right angle away: this is what pointing at a tablecloth
      // looks like once it has been encoded.
      encoder.frameVector = between(80);
      await show(sharp());

      expect(live.matches, isEmpty,
          reason: 'an empty row is what the capture screen falls back to the '
              'frequency list on — a wrong chip is worse than no chip');
    });

    test('four at most, however many are close enough', () async {
      // Six meals a few degrees apart, and a query in the middle of them: every
      // one of them is well over the threshold, so nothing but the limit is
      // deciding what the row holds.
      for (var i = 0; i < 6; i++) {
        seed('Meal $i', between(i * 5.0));
      }
      await begin();

      encoder.frameVector = between(12);
      await show(sharp());

      expect(live.matches, hasLength(4));
      expect(
        chipNames().toSet(),
        hasLength(4),
        reason: 'four suggestions should be four different meals',
      );
    });
  });

  group('stability', () {
    /// The target §6 sets: "a list that changes when the user re-aims and is
    /// otherwise still".
    test('holding the phone still repaints once, not once a frame', () async {
      seed('Porridge', axis(0));
      await begin();
      encoder.frameVector = axis(0);

      var notifications = 0;
      live.addListener(() => notifications++);

      await show(sharp(), times: 5);

      expect(chipNames(), ['Porridge']);
      expect(notifications, 1,
          reason: 'the scores move every frame and the answer does not; a '
              'repaint per frame is what reads as broken software');
    });

    test('re-aiming at a different meal swaps the row', () async {
      seed('Porridge', axis(0));
      seed('Ramen', axis(1));
      await begin();

      encoder.frameVector = axis(0);
      await show(sharp(), times: 3);
      expect(chipNames().first, 'Porridge');

      encoder.frameVector = axis(1);
      await show(sharp(), times: 6);
      expect(chipNames().first, 'Ramen');
    });

    /// The margin itself, against its own control. The query sits fractionally
    /// nearer Ramen than Porridge — inside [LiveSuggestions.swapMargin] — so
    /// which of them leads depends entirely on which was there first.
    test('a challenger that is barely ahead does not take the lead', () async {
      seed('Porridge', axis(0));
      seed('Ramen', axis(1));
      await begin();

      // Ramen ahead by ~0.015, well under the 0.04 margin.
      final nearlyTied = between(45.6);

      // With Porridge already on screen, it stays on screen.
      encoder.frameVector = axis(0);
      await show(sharp(), times: 2);
      expect(chipNames().first, 'Porridge');

      encoder.frameVector = nearlyTied;
      await show(sharp(), times: 12);
      expect(chipNames().first, 'Porridge',
          reason: 'a fifteen-thousandth of a cosine is not a reason to move '
              'the chip somebody is reaching for');

      // The control: the same query, with nothing already on screen, ranks the
      // other way round — so the assertion above is the hysteresis and not an
      // accident of the fixtures.
      final fresh = LiveSuggestions(
        camera: camera,
        encoder: encoder,
        index: index,
      );
      addTearDown(fresh.dispose);
      await live.stop();
      fresh.start();
      encoder.frameVector = nearlyTied;
      expect(camera.emit(sharp()), isTrue);
      await settle();

      expect(fresh.matches.first.name, 'Ramen');
      await fresh.stop();
    });
  });
}
