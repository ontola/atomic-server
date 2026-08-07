import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'package:calorie_tracker/atomic/atomic_client.dart';
import 'package:calorie_tracker/atomic/session.dart';
import 'package:calorie_tracker/main.dart';
import 'package:calorie_tracker/models/meal.dart';
import 'package:calorie_tracker/rust_init.dart';
import 'package:calorie_tracker/services/image_store.dart';
import 'package:calorie_tracker/services/meal_encoder.dart';
import 'package:calorie_tracker/services/sync_service.dart';

/// The acceptance criteria of Phases 1–3, on a real device or simulator:
/// onboard, log a meal, kill the app, relaunch, and still be the same account
/// with the same meals container and the same meal in it — through the real
/// Rust bridge, the real redb store and the real Keychain /
/// EncryptedSharedPreferences.
///
/// `test/` covers the same flows against a faked bridge in milliseconds. This
/// is the part it cannot prove: that the library is in the app bundle, that the
/// meal ontology `atomic_lib` seeds is really there to write against, that the
/// store survives the process, and that the secret comes back out of platform
/// secure storage.
///
///     flutter test integration_test/bridge_test.dart
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  const nameProperty = 'https://atomicdata.dev/properties/name';
  const parentProperty = 'https://atomicdata.dev/properties/parent';

  testWidgets('an account, its meals container and a meal survive a relaunch',
      (tester) async {
    // Whatever a previous run left in secure storage, this starts where a fresh
    // install starts.
    await AtomicSession.clear();

    await tester.pumpWidget(const CalorieTrackerApp());
    await _pumpUntil(tester, find.text('Start tracking'));

    await tester.tap(find.text('Start tracking'));
    await _pumpUntil(tester, find.text('kcal today'));

    final agent = await AtomicClient.getActiveAgent();
    expect(agent, isNotNull, reason: 'onboarding must leave an agent behind');
    final drive = AtomicClient.getActiveDrive();
    expect(drive, isNotNull);

    // The container is real, named, and hanging off the drive — not just a
    // subject a screen printed.
    final meals = await AtomicClient.ensureMealsContainer();
    expect(await AtomicClient.getProperty(meals, nameProperty), 'Meals');
    expect(await AtomicClient.getProperty(meals, parentProperty), drive);

    // A meal written against the seeded ontology. `Meal`, `consumed-at` and the
    // status tags live in atomic_lib's defaults, so this is also the check that
    // they were seeded into this device's store rather than only into a test
    // one.
    final noon = DateTime(2026, 8, 5, 12, 30);
    final day = localDayBounds(noon);
    final subject = await AtomicClient.createMeal(
      consumedAtMs: noon.millisecondsSinceEpoch,
      name: 'Integration cappuccino',
      notes: 'Oat milk',
      calories: 120,
    );

    final logged = await AtomicClient.listMeals(day.fromMs, day.toMs);
    expect(logged.map((m) => m.subject), contains(subject));

    // Relaunch: tear the tree down and build a new one, so a new AppSession
    // boots from storage rather than from anything still in memory.
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    await tester.pumpWidget(const CalorieTrackerApp());
    await _pumpUntil(tester, find.text('kcal today'));

    expect(find.text('Start tracking'), findsNothing,
        reason: 'a restored account must not be asked to onboard again');

    final restored = await AtomicClient.getActiveAgent();
    expect(restored?.subject, agent!.subject);
    expect(restored?.secret, agent.secret);
    expect(AtomicClient.getActiveDrive(), drive);
    expect(await AtomicClient.ensureMealsContainer(), meals,
        reason: 'the second launch finds the container, it does not make one');

    final after = await AtomicClient.listMeals(day.fromMs, day.toMs);
    final meal = Meal.fromItem(after.firstWhere((m) => m.subject == subject));
    expect(meal.name, 'Integration cappuccino');
    expect(meal.calories, 120);
    expect(meal.consumedAt, noon);
    expect(meal.notes, 'Oat milk',
        reason: '`meal-notes` seeds with the rest of the ontology');
    expect((await AtomicClient.getMeal(subject))?.name, 'Integration cappuccino',
        reason: 'what a notification tap resolves through');
    expect(meal.status, MealStatus.confirmed,
        reason: 'a number a person typed is not waiting to be estimated');

    // Leave nothing behind: the next run starts from a fresh install, but the
    // redb store on the device does not go with it.
    await AtomicClient.deleteResource(subject);
  });

  /// Phase 3's storage numbers, against the real native codecs.
  ///
  /// `test/image_store_test.dart` fakes the compressor — it has to, the test VM
  /// has no encoder — so everything §6 pins about the *bytes* is only ever
  /// checked here: that 1024px is really 1024px, that ~200 KB is really
  /// ~200 KB, and that what comes out is a JPEG with no EXIF on it.
  testWidgets('a captured photo is compressed to what §6 says it is',
      (tester) async {
    final documents = await getApplicationDocumentsDirectory();
    final store = ImageStore(root: Directory(p.join(documents.path, 'phase3')));
    addTearDown(() async {
      final root = Directory(p.join(documents.path, 'phase3'));
      if (await root.exists()) await root.delete(recursive: true);
    });

    // Bigger than any preset the camera is set to, so the resize has work to do.
    final camera = await _photoLikeBytes(2400, 1800);
    final stored = await store.save(camera, at: DateTime(2026, 8, 5, 12, 30));

    final full = await store.load(stored.imagePath);
    final thumb = await store.loadThumbnail(stored.imagePath);
    expect(full, isNotNull);
    expect(thumb, isNotNull);

    final bytes = await full!.readAsBytes();
    expect(bytes.sublist(0, 2), [0xFF, 0xD8],
        reason: 'JPEG, because it is the one format no vision API refuses');
    expect(bytes.length, lessThan(250 * 1024));

    final size = await _sizeOf(bytes);
    expect(size.$1, lessThanOrEqualTo(ImageStore.fullEdge));
    expect(size.$2, lessThanOrEqualTo(ImageStore.fullEdge));
    expect(
      size.$1 > size.$2 ? size.$1 : size.$2,
      ImageStore.fullEdge,
      reason: 'the longest edge is the token budget — it should be spent',
    );

    final thumbSize = await _sizeOf(await thumb!.readAsBytes());
    expect(thumbSize.$1 > thumbSize.$2 ? thumbSize.$1 : thumbSize.$2,
        ImageStore.thumbEdge);

    // The embedding source, and the one thing about it that is load-bearing:
    // it is *square*. An encoder reads this file and must see the same geometry
    // it sees off a live camera frame; a long-edge cap gave a 4:3 frame a 192px
    // crop upscaled to 224, which measured 0.65 cosine away from the meal's own
    // photo at worst — unrecognisable to the very re-encoding this file exists
    // for (`planning/calorie-tracker-embeddings.md` §9). Only the real codec can
    // prove the pixels, which is why this lives here and not in `test/`.
    final source = await store.loadSource(stored.imagePath);
    expect(source, isNotNull);
    final sourceBytes = await source!.readAsBytes();
    final sourceSize = await _sizeOf(sourceBytes);
    expect(
      sourceSize,
      (ImageStore.sourceEdge, ImageStore.sourceEdge),
      reason: 'the embedding source is a square of exactly sourceEdge — not a '
          'long-edge cap, which leaves the short edge below what any encoder '
          'takes as input',
    );
    expect(sourceBytes.sublist(0, 2), [0xFF, 0xD8]);

    // The counter agrees with the directory, which is what eviction acts on.
    expect(await store.totalBytes(), await store.recount());
  });

  /// The privacy line in §6: re-encoding drops the camera's EXIF, and with it
  /// the coordinates of every kitchen the user has ever eaten in.
  ///
  /// It needs a source that actually carries a location, so this makes one —
  /// a real JPEG with a hand-built `Exif` APP1 holding a GPS IFD spliced in —
  /// and checks the stored copy has none. (The platform encoder writes an APP1
  /// of its own regardless, which is why the assertion is about GPS rather than
  /// about EXIF being absent: what matters is what is *in* it.)
  testWidgets('a photo that knows where it was taken does not stay that way',
      (tester) async {
    final documents = await getApplicationDocumentsDirectory();
    final store = ImageStore(root: Directory(p.join(documents.path, 'exif')));
    addTearDown(() async {
      final root = Directory(p.join(documents.path, 'exif'));
      if (await root.exists()) await root.delete(recursive: true);
    });

    // A real JPEG first, then the location bolted onto it.
    final plain = await const NativeImageCompressor().compress(
      await _photoLikeBytes(1600, 1200),
      maxEdge: 1600,
      quality: 90,
    );
    final located = _withGpsExif(plain);
    expect(_hasGps(_exifSegment(located)!), isTrue,
        reason: 'the input has to carry a location for this to prove anything');

    final stored = await store.save(located, at: DateTime(2026, 8, 5, 12, 30));
    final bytes = await (await store.load(stored.imagePath))!.readAsBytes();

    final exif = _exifSegment(bytes);
    expect(exif == null || !_hasGps(exif), isTrue,
        reason: 'the stored photo must not say where the meal was eaten');
  });

  /// Phase 6's half of what only a device can answer.
  ///
  /// `test/sync_service_test.dart` covers *when* a sync runs, against a fake.
  /// What it cannot cover is the bridge underneath: that `get_known_peers_json`
  /// answers with something this app can read, and that a phone with nothing
  /// paired says so rather than throwing — which is what keeps `autoSync` from
  /// reaching for the network on a fresh install.
  ///
  /// Deliberately not a real pairing: that needs two devices and somebody to
  /// hold them.
  testWidgets('a phone with nothing paired knows it has nothing paired',
      (tester) async {
    // Both idempotent, so this does not care whether a test above already
    // booted the app — and does not depend on one having done so.
    await initRustBridge();
    final documents = await getApplicationDocumentsDirectory();
    await AtomicClient.openDb(documents.path);

    const backend = FfiSyncBackend();

    expect(await backend.deviceCount(), 0);
    expect(await backend.activeServer(), anyOf(isNull, ''),
        reason: 'device-to-device only is the default');

    final sync = SyncService(backend: backend);
    await sync.autoSync();

    expect(sync.hasDevices, isFalse);
    expect(sync.lastSyncedAt, isNull,
        reason: 'nothing paired means nothing to reach for');
  });

  _encoderTests();
}

/// Phase 7.2's acceptance criteria, against the real model and the real codecs.
///
/// `test/meal_encoder_test.dart` covers the storage format and
/// `test/embedding_queue_test.dart` the policy, both against a fake. Neither can
/// touch the thing that decides whether any of it works: an 88 MB ONNX file
/// reached through a platform channel, and whether what comes back out of it
/// means anything.
void _encoderTests() {
  /// The check the companion doc calls the one that silently breaks everything
  /// else (§6, §10).
  ///
  /// The index is built from stored JPEGs; the live query in 7.3 will be a
  /// camera frame that has been through no JPEG at all. If those two embed
  /// differently, every threshold calibrated afterwards is measuring the gap
  /// between two preprocessors rather than between two meals — and it fails
  /// silently, because the numbers still look like similarities.
  testWidgets('a frame and the file written from it embed to the same thing',
      (tester) async {
    final documents = await getApplicationDocumentsDirectory();
    final root = Directory(p.join(documents.path, 'embed'));
    final store = ImageStore(root: root);
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });

    final encoder = DinoV2Encoder();
    addTearDown(encoder.dispose);

    final frame = await _photoLikeBytes(2400, 1800);
    final stored = await store.save(frame, at: DateTime(2026, 8, 5, 12, 30));

    final fromFrame = await encoder.encode(frame);
    final source = await store.loadSource(stored.imagePath);
    final fromFile = await encoder.encode(await source!.readAsBytes());

    expect(fromFrame, isNotNull,
        reason: 'no encoder here means `make model` was not run before the '
            'build — the asset is missing, not the device incapable');
    expect(fromFile, isNotNull);
    expect(fromFrame!.modelId, fromFile!.modelId);

    final a = DinoV2Encoder.decodeVector(fromFrame.base64)!;
    final b = DinoV2Encoder.decodeVector(fromFile.base64)!;
    expect(
      _cosine(a, b),
      greaterThan(0.95),
      reason: 'the camera frame and the 256px source it was compressed into '
          'must land in the same place, or the index and the live query are '
          'not in the same space at all',
    );
  });

  /// The same check for the path Phase 7.3 added, which is the one the live
  /// query actually takes: **raw camera pixels, through no JPEG at all**.
  ///
  /// `test/square_crop_test.dart` proves the two go through the same crop and
  /// the same resample. This proves the model agrees, which is the claim every
  /// threshold in `LiveSuggestions` rests on — the index is built from stored
  /// squares and the query is a `CameraFrame`, and if those two land in
  /// different places the scores are measuring the preprocessing.
  testWidgets('a preview frame and the file written from it embed alike',
      (tester) async {
    final documents = await getApplicationDocumentsDirectory();
    final root = Directory(p.join(documents.path, 'embed-live'));
    final store = ImageStore(root: root);
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });

    final encoder = DinoV2Encoder();
    addTearDown(encoder.dispose);

    // One image, taken two ways: as the bytes a shutter hands over, and as the
    // pixels a preview stream hands over.
    final image = await _photoLikeImage(1280, 960);
    addTearDown(image.dispose);
    final encoded =
        (await image.toByteData(format: ui.ImageByteFormat.png))!
            .buffer
            .asUint8List();
    final pixels =
        (await image.toByteData(format: ui.ImageByteFormat.rawRgba))!
            .buffer
            .asUint8List();

    final stored = await store.save(encoded, at: DateTime(2026, 8, 5, 12, 45));
    final source = await store.loadSource(stored.imagePath);
    final fromFile = await encoder.encode(await source!.readAsBytes());
    final fromFrame = await encoder.encodePixels(
      pixels,
      width: image.width,
      height: image.height,
    );

    expect(fromFile, isNotNull,
        reason: 'no encoder here means `make model` was not run before the '
            'build');
    expect(fromFrame, isNotNull);
    expect(fromFrame!.modelId, fromFile!.modelId);

    expect(
      _cosine(
        DinoV2Encoder.decodeVector(fromFrame.base64)!,
        DinoV2Encoder.decodeVector(fromFile.base64)!,
      ),
      greaterThan(0.95),
      reason: 'the viewfinder matches live pixels against stored JPEGs; if '
          'those embed differently, every threshold in Phase 7.3 is calibrated '
          'against an artifact of preprocessing rather than against food',
    );
  });

  /// The other half of the acceptance criteria: that the vectors carry meaning
  /// rather than merely being stable. Asserted as a *ranking*, never against an
  /// absolute number — cosine has no units, which is the whole reason §11 says
  /// the thresholds can only come from a real phone over real days.
  testWidgets('two pictures of one thing beat two pictures of two things',
      (tester) async {
    final encoder = DinoV2Encoder();
    addTearDown(encoder.dispose);

    // The same synthetic "dish" at two sizes, against a visibly different one.
    final dish = await _photoLikeBytes(1600, 1200);
    final sameDishAgain = await _photoLikeBytes(1200, 900);
    final otherDish = await _flatishBytes(1600, 1200);

    final a = DinoV2Encoder.decodeVector((await encoder.encode(dish))!.base64)!;
    final b = DinoV2Encoder.decodeVector(
        (await encoder.encode(sameDishAgain))!.base64)!;
    final c =
        DinoV2Encoder.decodeVector((await encoder.encode(otherDish))!.base64)!;

    expect(_cosine(a, b), greaterThan(_cosine(a, c)),
        reason: 'if this does not hold the model is not being fed what it '
            'thinks it is — check the channel order and the normalization '
            'before believing any similarity this app reports');
  });

  /// What the whole storage format exists to preserve.
  testWidgets('the stored embedding is 384 int8 bytes and survives the trip',
      (tester) async {
    final encoder = DinoV2Encoder();
    addTearDown(encoder.dispose);

    final embedding = await encoder.encode(await _photoLikeBytes(800, 800));

    expect(embedding, isNotNull);
    expect(embedding!.modelId, DinoV2Encoder.modelIdValue);
    expect(DinoV2Encoder.decodeVector(embedding.base64),
        hasLength(DinoV2Encoder.dimensions));
  });
}

double _cosine(Float32List a, Float32List b) {
  var dot = 0.0, na = 0.0, nb = 0.0;
  for (var i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (math.sqrt(na) * math.sqrt(nb));
}

/// A second synthetic image that is plainly not the first: broad flat bands
/// rather than blobs on a gradient.
Future<Uint8List> _flatishBytes(int width, int height) async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  for (var i = 0; i < 8; i++) {
    canvas.drawRect(
      Rect.fromLTWH(0, height / 8 * i, width.toDouble(), height / 8),
      Paint()..color = i.isEven ? const Color(0xFFEFEFEF) : const Color(0xFF203040),
    );
  }
  final image = await recorder.endRecording().toImage(width, height);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return data!.buffer.asUint8List();
}

/// A PNG shaped like the thing this app photographs: a few large soft-edged
/// blobs on a gradient, which is what a plate under a kitchen light looks like
/// to a JPEG encoder.
///
/// Deliberately neither extreme. A flat colour compresses to nothing and would
/// pass a size assertion that means nothing; a field of hard-edged noise is
/// worse than any real photo and would fail one that should hold.
Future<Uint8List> _photoLikeBytes(int width, int height) async {
  final image = await _photoLikeImage(width, height);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return data!.buffer.asUint8List();
}

/// The same thing undecoded, for the tests that need the *pixels* — a preview
/// frame never goes through a file.
Future<ui.Image> _photoLikeImage(int width, int height) async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);

  canvas.drawRect(
    Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    Paint()
      ..shader = ui.Gradient.linear(
        Offset.zero,
        Offset(width.toDouble(), height.toDouble()),
        const [Color(0xFF3B2A1E), Color(0xFFD8C7A9)],
      ),
  );

  for (var i = 0; i < 24; i++) {
    canvas.drawCircle(
      Offset((i * 337 % width).toDouble(), (i * 521 % height).toDouble()),
      80 + (i % 7) * 25.0,
      Paint()
        ..color = Color(0xFF000000 | (i * 2654435 & 0xFFFFFF))
        ..maskFilter = const ui.MaskFilter.blur(BlurStyle.normal, 12),
    );
  }

  return recorder.endRecording().toImage(width, height);
}

Future<(int, int)> _sizeOf(Uint8List bytes) async {
  final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
  final descriptor = await ui.ImageDescriptor.encoded(buffer);
  final size = (descriptor.width, descriptor.height);
  descriptor.dispose();
  buffer.dispose();
  return size;
}

/// The payload of the `Exif` APP1 segment, or null when there is none.
///
/// Walks the marker segments rather than scanning for the bytes: `FF E1` turns
/// up inside compressed scan data often enough that a scan finds one in almost
/// any photo.
Uint8List? _exifSegment(Uint8List jpeg) {
  var i = 2;
  while (i + 4 <= jpeg.length && jpeg[i] == 0xFF) {
    final marker = jpeg[i + 1];
    // Start of scan — everything past here is image data, not metadata.
    if (marker == 0xDA || marker == 0xD9) return null;

    final length = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (marker == 0xE1 &&
        i + 10 <= jpeg.length &&
        jpeg[i + 4] == 0x45 && // E
        jpeg[i + 5] == 0x78 && // x
        jpeg[i + 6] == 0x69 && // i
        jpeg[i + 7] == 0x66 && // f
        jpeg[i + 8] == 0x00) {
      return Uint8List.sublistView(jpeg, i + 4, i + 2 + length);
    }
    i += 2 + length;
  }
  return null;
}

/// Whether an `Exif` payload carries a GPS IFD — tag `0x8825` in IFD0, which is
/// the pointer to where the coordinates live.
bool _hasGps(Uint8List exif) {
  const tiff = 6; // past "Exif\0\0"
  if (exif.length < tiff + 8) return false;

  final little = exif[tiff] == 0x49;
  int u16(int at) =>
      little ? exif[at] | (exif[at + 1] << 8) : (exif[at] << 8) | exif[at + 1];
  int u32(int at) => little
      ? exif[at] |
          (exif[at + 1] << 8) |
          (exif[at + 2] << 16) |
          (exif[at + 3] << 24)
      : (exif[at] << 24) |
          (exif[at + 1] << 16) |
          (exif[at + 2] << 8) |
          exif[at + 3];

  final ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > exif.length) return false;

  final entries = u16(ifd0);
  for (var e = 0; e < entries; e++) {
    final at = ifd0 + 2 + e * 12;
    if (at + 12 > exif.length) break;
    if (u16(at) == 0x8825) return true;
  }
  return false;
}

/// [jpeg] with an `Exif` APP1 spliced in after the SOI, carrying a GPS IFD —
/// the smallest thing that is honestly a located photo.
Uint8List _withGpsExif(Uint8List jpeg) {
  // Little-endian TIFF: header, an IFD0 whose one entry points at a GPS IFD,
  // and a GPS IFD whose one entry is a latitude reference.
  final tiff = ByteData(44);
  tiff.setUint16(0, 0x4949, Endian.little); // "II"
  tiff.setUint16(2, 42, Endian.little);
  tiff.setUint32(4, 8, Endian.little); // IFD0 at offset 8

  tiff.setUint16(8, 1, Endian.little); // one entry
  tiff.setUint16(10, 0x8825, Endian.little); // GPSInfo IFD pointer
  tiff.setUint16(12, 4, Endian.little); // LONG
  tiff.setUint32(14, 1, Endian.little);
  tiff.setUint32(18, 26, Endian.little); // → the GPS IFD
  tiff.setUint32(22, 0, Endian.little); // no next IFD

  tiff.setUint16(26, 1, Endian.little); // one entry
  tiff.setUint16(28, 0x0001, Endian.little); // GPSLatitudeRef
  tiff.setUint16(30, 2, Endian.little); // ASCII
  tiff.setUint32(32, 2, Endian.little);
  tiff.setUint32(36, 0x0000004E, Endian.little); // "N\0", inline
  tiff.setUint32(40, 0, Endian.little);

  final payload = <int>[0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff.buffer.asUint8List()];
  final length = payload.length + 2;

  return Uint8List.fromList([
    jpeg[0], jpeg[1], // SOI
    0xFF, 0xE1, (length >> 8) & 0xFF, length & 0xFF,
    ...payload,
    ...jpeg.sublist(2),
  ]);
}

/// Pump until [finder] hits. The work behind these screens touches the
/// filesystem and the Keychain, so the wait is polled rather than guessed — and
/// `pumpAndSettle` is no use here: the loading spinner never settles.
Future<void> _pumpUntil(
  WidgetTester tester,
  Finder finder, {
  Duration timeout = const Duration(seconds: 20),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(milliseconds: 100));
    if (finder.evaluate().isNotEmpty) return;
  }

  // What is on screen instead is the whole diagnosis — every phase of the
  // session has different words on it — and rebuilding this app to find out
  // costs six minutes.
  // SelectableText as well as Text: the failure screens put the reason in one.
  final onScreen = tester.allWidgets
      .map((w) => switch (w) {
            Text(:final data) => data,
            SelectableText(:final data) => data,
            _ => null,
          })
      .whereType<String>()
      .toList();
  fail('timed out waiting for $finder; on screen instead: $onScreen');
}
