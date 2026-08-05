import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter_image_compress/flutter_image_compress.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';

import '../models/meal.dart';

/// Photos on disk — compressed once at capture, capped in total, and evicted
/// oldest-first when the cap is reached.
///
/// Photos are the only part of this app that grows without bound, and they cost
/// twice: every pixel sent to the vision model is billed, and every byte kept is
/// storage the user never asked us for. The two have different levers
/// (`planning/calorie-tracker-plan.md` §6) — resolution is what the model bills,
/// format and quality are what the disk costs — so both are pinned here rather
/// than decided at each call site.
///
/// **Photos are a cache; meals are the data.** Nothing in a meal record depends
/// on its file still being there, and every read path returns null rather than
/// throwing for one that is gone.
class ImageStore {
  ImageStore({
    required this.root,
    ImageCompressor compressor = const NativeImageCompressor(),
  }) : _compressor = compressor;

  /// Where the two subdirectories live. The app documents directory in
  /// production, a temp dir under test — nothing else here knows the difference.
  final Directory root;
  final ImageCompressor _compressor;

  /// The stored format, named once (§6.1). JPEG is the one format no vision
  /// provider refuses; WebP would save ~25–30% of the disk and zero tokens, and
  /// is blocked on measuring iOS encode time on the shutter path. Because the
  /// stored path's extension is what decides the mime type sent to OpenRouter, a
  /// store holding both formats is already valid — which is what makes a later
  /// switch a no-op for photos already on disk.
  static const extension = 'jpg';

  /// Longest edge of the stored image. This is the number the vision model
  /// bills: ~1040 visual tokens per meal, a few cents a month. Sending fewer
  /// pixels is the only way to spend less, and it costs the portion-size detail
  /// the whole estimate rests on.
  static const fullEdge = 1024;

  /// One pass at 80 is the floor: lossy artifacts measurably degrade vision
  /// model accuracy, and they compound over repeated passes.
  static const fullQuality = 80;

  static const thumbEdge = 256;
  static const thumbQuality = 70;

  /// Full images and thumbnails are separated by directory, not by filename, so
  /// a thumbnail's path is derivable from the meal's `image-path` and the meal
  /// only has to store the one.
  static const fullDir = 'photos';
  static const thumbDir = 'thumbs';

  static const _totalKey = 'photo_bytes_total';
  static const _budgetKey = 'photo_budget_bytes';

  /// Keeps the running total off the disk on the shutter path. The truth is the
  /// directory, and [recount] is what goes and asks it.
  int? _total;

  // ── Writing ──────────────────────────────────────────────────────────────

  /// Compress the camera frame and write it, plus its thumbnail.
  ///
  /// The full-resolution frame (2–5 MB) is never kept: there is no "original" to
  /// fall back to, deliberately — a second copy would double storage to serve a
  /// use case v1 does not have, and the model never sees more than this anyway.
  Future<StoredImage> save(Uint8List cameraBytes, {DateTime? at}) async {
    await _ensureDirs();

    // Unique, and sorted by name is sorted by capture — which is the order the
    // sweep wants when it has no meals to go on.
    final stamp = (at ?? DateTime.now()).toUtc().microsecondsSinceEpoch;
    final name = '$stamp.$extension';

    // Both encodes come off the camera frame rather than the thumbnail off the
    // stored image: one lossy pass each instead of two stacked.
    final full = await _compressor.compress(
      cameraBytes,
      maxEdge: fullEdge,
      quality: fullQuality,
    );
    final thumb = await _compressor.compress(
      cameraBytes,
      maxEdge: thumbEdge,
      quality: thumbQuality,
    );

    final imagePath = p.join(fullDir, name);
    final thumbnailPath = p.join(thumbDir, name);

    // Flushed, because the point of writing the file before the meal is that
    // the app can be killed the instant the shutter returns.
    await _file(imagePath).writeAsBytes(full, flush: true);
    await _file(thumbnailPath).writeAsBytes(thumb, flush: true);

    final bytes = full.length + thumb.length;
    await _addToTotal(bytes);

    return StoredImage(
      imagePath: imagePath,
      thumbnailPath: thumbnailPath,
      bytes: bytes,
    );
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  /// The stored image, or null when it was evicted (or never written).
  Future<File?> load(String imagePath) => _existing(imagePath);

  /// The thumbnail of [imagePath]. Outlives the full image: at ~15 KB a decade
  /// of history costs ~10 MB, so old days still look like meals after their
  /// photos are gone.
  Future<File?> loadThumbnail(String imagePath) =>
      _existing(thumbnailPathFor(imagePath));

  /// Where the thumbnail of [imagePath] lives. Pure — says nothing about
  /// whether either file exists.
  static String thumbnailPathFor(String imagePath) =>
      imagePath.isEmpty ? '' : p.join(thumbDir, p.basename(imagePath));

  /// What is left of the photo at [imagePath]. The detail sheet reads it, and
  /// so will Phase 4's re-estimate, which is only offered for
  /// [PhotoState.stored] — there is nothing to send a model without the full
  /// image.
  Future<PhotoState> stateOf(String imagePath) async {
    if (imagePath.isEmpty) return PhotoState.none;
    return await load(imagePath) != null
        ? PhotoState.stored
        : PhotoState.evicted;
  }

  // ── Budget ───────────────────────────────────────────────────────────────

  /// Bytes currently on disk, both directories. Answered from the counter when
  /// there is one; [recount] is what makes there be one.
  Future<int> totalBytes() async => _total ??= await _readTotal();

  /// Walk the directory and add it up, healing whatever the counter drifted to.
  ///
  /// Cheap for a few thousand files, and the only thing that survives a crash
  /// between a write and its counter update. Runs on app start and inside every
  /// [sweep].
  Future<int> recount() async {
    var total = 0;
    for (final file in await _allFiles()) {
      total += await file.length();
    }
    await _setTotal(total);
    return total;
  }

  /// The cap, in bytes. [unlimitedBudget] means there isn't one.
  Future<int> budgetBytes() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getInt(_budgetKey) ?? defaultBudgetBytes;
  }

  Future<void> setBudgetBytes(int bytes) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt(_budgetKey, bytes);
  }

  /// ≈8 months of typical use (5 meals/day at ~200 KB), which is the point:
  /// most users never reach it.
  static const defaultBudgetBytes = 250 * 1024 * 1024;

  static const unlimitedBudget = 0;

  /// What Settings offers, largest label last.
  static const budgetOptions = <int>[
    100 * 1024 * 1024,
    defaultBudgetBytes,
    1024 * 1024 * 1024,
    unlimitedBudget,
  ];

  // ── Eviction ─────────────────────────────────────────────────────────────

  /// Drop files nobody needs, and — only when over budget — the oldest photos.
  /// Returns the bytes freed.
  ///
  /// Silent by design. This is a cache policy, not a deletion the user needs to
  /// weigh in on: the meal, its calories and its thumbnail all survive.
  ///
  /// [meals] is every meal there is, not one day's — eviction is a decision
  /// about the whole history.
  Future<int> sweep({required List<Meal> meals}) async {
    await _ensureDirs();

    // Ask the disk rather than trusting the counter: a sweep that evicts on a
    // drifted number either frees nothing or empties the library.
    var total = await recount();
    var freed = 0;

    freed += await _removeOrphans(meals);
    total -= freed;

    final budget = await budgetBytes();
    if (budget == unlimitedBudget || total <= budget) {
      await _setTotal(total);
      return freed;
    }

    // Stop 10% below the cap rather than exactly at it, so a sweep frees real
    // headroom instead of re-triggering on the very next shot.
    final target = budget - budget ~/ 10;

    final evictable = meals
        .where((m) => m.imagePath.isNotEmpty && !_isInFlight(m.status))
        .toList()
      ..sort((a, b) => a.consumedAt.compareTo(b.consumedAt));

    for (final meal in evictable) {
      if (total <= target) break;
      // Only the full image. Thumbnails are never evicted.
      final bytes = await _deleteIfPresent(meal.imagePath);
      total -= bytes;
      freed += bytes;
    }

    if (total > target) {
      // What is left is thumbnails, which are never evicted, and photos the
      // estimator has not finished with. A backlog big enough to fill the
      // budget on its own is a bug, not a storage problem — deleting the
      // queue's input would only hide it.
      final waiting = meals.where((m) => _isInFlight(m.status)).length;
      debugPrint(
        'ImageStore: ${total - target} bytes over budget with nothing left to '
        'evict — $waiting meals still waiting on an estimate',
      );
    }

    await _setTotal(total);
    return freed;
  }

  /// How long a file gets to become somebody's photo before it counts as an
  /// orphan.
  ///
  /// A capture writes the file and *then* the meal, and a sweep can be running
  /// in between — the one kicked off at launch, or by another capture. Without
  /// this window, that sweep would delete the photo of the meal being logged
  /// while it was being logged: rare, silent, and impossible to reproduce.
  /// Nothing is lost by waiting, because an orphan is by definition not urgent.
  static const orphanGrace = Duration(minutes: 2);

  /// Files no meal points at — what a crash between writing the file and
  /// writing the resource leaves behind. Removed on every sweep, over budget or
  /// not: they are bytes nobody will ever miss, and deciding costs one
  /// directory listing we are doing anyway.
  Future<int> _removeOrphans(List<Meal> meals) async {
    final referenced = <String>{};
    for (final meal in meals) {
      if (meal.imagePath.isEmpty) continue;
      referenced
        ..add(_normalise(meal.imagePath))
        ..add(_normalise(thumbnailPathFor(meal.imagePath)));
    }

    final cutoff = DateTime.now().subtract(orphanGrace);
    var freed = 0;
    for (final file in await _allFiles()) {
      final relative = _normalise(p.relative(file.path, from: root.path));
      if (referenced.contains(relative)) continue;
      if ((await file.stat()).modified.isAfter(cutoff)) continue;
      freed += await _delete(file);
    }
    return freed;
  }

  /// Whether the estimator still needs this meal's photo. Evicting one of these
  /// would delete the input of a job that is going to run.
  static bool _isInFlight(MealStatus status) =>
      status == MealStatus.pending ||
      status == MealStatus.estimating ||
      status == MealStatus.needsInfo;

  /// Throw away every photo and thumbnail, keeping the meals. What the "delete
  /// all photos now" button in Settings does.
  Future<int> deleteAll() async {
    var freed = 0;
    for (final file in await _allFiles()) {
      freed += await _delete(file);
    }
    await _setTotal(0);
    return freed;
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────

  File _file(String relative) => File(p.join(root.path, relative));

  Future<File?> _existing(String relative) async {
    if (relative.isEmpty) return null;
    final file = _file(relative);
    return await file.exists() ? file : null;
  }

  Future<int> _deleteIfPresent(String relative) async {
    final file = await _existing(relative);
    return file == null ? 0 : _delete(file);
  }

  Future<int> _delete(File file) async {
    try {
      final bytes = await file.length();
      await file.delete();
      return bytes;
    } on FileSystemException {
      // Gone underneath us, which is the outcome we wanted anyway.
      return 0;
    }
  }

  Future<List<File>> _allFiles() async {
    final files = <File>[];
    for (final name in const [fullDir, thumbDir]) {
      final dir = Directory(p.join(root.path, name));
      if (!await dir.exists()) continue;
      await for (final entity in dir.list()) {
        if (entity is File) files.add(entity);
      }
    }
    return files;
  }

  Future<void> _ensureDirs() async {
    for (final name in const [fullDir, thumbDir]) {
      await Directory(p.join(root.path, name)).create(recursive: true);
    }
  }

  /// Path separators differ between what we join and what the OS lists back.
  static String _normalise(String relative) => p.normalize(relative);

  Future<int> _readTotal() async {
    final prefs = await SharedPreferences.getInstance();
    final stored = prefs.getInt(_totalKey);
    return stored ?? await recount();
  }

  Future<void> _setTotal(int bytes) async {
    _total = bytes < 0 ? 0 : bytes;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt(_totalKey, _total!);
  }

  /// Deliberately not `totalBytes() + bytes`: the file is already written by the
  /// time this runs, so a first call that fell through to [recount] would count
  /// it and then add it again.
  Future<void> _addToTotal(int bytes) async {
    final prefs = await SharedPreferences.getInstance();
    final known = _total ?? prefs.getInt(_totalKey);
    if (known == null) {
      await recount();
      return;
    }
    await _setTotal(known + bytes);
  }
}

/// What [ImageStore.save] wrote. Both paths are relative to the store's root —
/// absolute paths do not survive an iOS reinstall, which moves the app
/// container.
class StoredImage {
  const StoredImage({
    required this.imagePath,
    required this.thumbnailPath,
    required this.bytes,
  });

  /// What goes on the meal's `image-path`.
  final String imagePath;
  final String thumbnailPath;

  /// Both files together.
  final int bytes;
}

/// How much of a meal's photo is left on this device.
enum PhotoState {
  /// A meal nobody photographed — typed in by hand.
  none,

  /// The full image is here.
  stored,

  /// There was a photo and the full image is gone. Usually evicted to free up
  /// space, in which case the thumbnail is still there to show.
  evicted,
}

/// Turning camera bytes into stored bytes.
///
/// A seam because [NativeImageCompressor] goes through platform codecs, which
/// the test VM has none of — and because compression is the one step on the
/// shutter path with a time budget, so it is worth being able to stub.
abstract class ImageCompressor {
  Future<Uint8List> compress(
    Uint8List source, {
    required int maxEdge,
    required int quality,
  });
}

/// The real one: native codecs, ~10× faster than a pure-Dart encoder, which
/// matters because this runs between the shutter and the meal being logged.
class NativeImageCompressor implements ImageCompressor {
  const NativeImageCompressor();

  @override
  Future<Uint8List> compress(
    Uint8List source, {
    required int maxEdge,
    required int quality,
  }) async {
    final (width, height) = await _sizeOf(source);
    // flutter_image_compress scales to satisfy *both* minimums and never scales
    // up, so passing (maxEdge, maxEdge) leaves a portrait photo at its original
    // height. Give it the exact target instead, worked out from the source.
    final longest = width > height ? width : height;
    final scale = longest <= maxEdge ? 1.0 : maxEdge / longest;

    return FlutterImageCompress.compressWithList(
      source,
      minWidth: (width * scale).round(),
      minHeight: (height * scale).round(),
      quality: quality,
      format: CompressFormat.jpeg,
      // Re-encoding strips EXIF, which drops the GPS coordinates off every food
      // photo — a privacy win we get for free. `autoCorrectionAngle` stays on
      // so the orientation EXIF carried is baked into the pixels before it goes.
      keepExif: false,
    );
  }

  /// Pixel dimensions from the encoded header, without decoding the image.
  static Future<(int, int)> _sizeOf(Uint8List bytes) async {
    final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
    final descriptor = await ui.ImageDescriptor.encoded(buffer);
    final size = (descriptor.width, descriptor.height);
    descriptor.dispose();
    buffer.dispose();
    return size;
  }
}
