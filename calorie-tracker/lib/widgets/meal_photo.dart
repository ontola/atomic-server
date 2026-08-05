import 'dart:io';

import 'package:flutter/material.dart';

import '../services/image_store.dart';

/// A meal's photo, at whatever size is left of it.
///
/// Meals store a path relative to the photo directory, and the file behind it is
/// a cache: it can be evicted between the meal being read and this being built.
/// So everything here resolves the path through [ImageStore] and renders
/// something sensible when the answer is "it's gone" — nothing in this file
/// throws for a missing file, because that is a normal state.
///
/// These are [StatefulWidget]s only because their work is a `Future`: resolving
/// it in `build` would start a new one every time the last one finished, which
/// is a rebuild loop rather than an image.

/// The small square in a list row, or on the "Logged" chip.
class MealThumbnail extends StatefulWidget {
  const MealThumbnail({
    super.key,
    required this.images,
    required this.imagePath,
    this.size = 44,
  });

  /// Null in tests and before the documents directory is known — then there is
  /// nothing to show and the placeholder stands in.
  final ImageStore? images;

  /// The meal's `image-path`. Empty for a typed meal.
  final String imagePath;
  final double size;

  @override
  State<MealThumbnail> createState() => _MealThumbnailState();
}

class _MealThumbnailState extends State<MealThumbnail> {
  Future<File?>? _file;

  @override
  void initState() {
    super.initState();
    _resolve();
  }

  @override
  void didUpdateWidget(MealThumbnail old) {
    super.didUpdateWidget(old);
    if (old.imagePath != widget.imagePath || old.images != widget.images) {
      _resolve();
    }
  }

  void _resolve() {
    final images = widget.images;
    _file = images == null || widget.imagePath.isEmpty
        ? null
        : images.loadThumbnail(widget.imagePath);
  }

  @override
  Widget build(BuildContext context) {
    final placeholder = _Placeholder(size: widget.size);

    return ClipRRect(
      borderRadius: BorderRadius.circular(widget.size / 5),
      child: SizedBox.square(
        dimension: widget.size,
        child: _file == null
            ? placeholder
            : _FileImage(file: _file!, fallback: placeholder),
      ),
    );
  }
}

/// The photo on the meal's detail sheet — the full image while it is still
/// here, and the thumbnail plus an explanation once it isn't.
class MealPhoto extends StatefulWidget {
  const MealPhoto({super.key, required this.images, required this.imagePath});

  final ImageStore? images;
  final String imagePath;

  @override
  State<MealPhoto> createState() => _MealPhotoState();
}

class _MealPhotoState extends State<MealPhoto> {
  Future<PhotoState>? _state;

  @override
  void initState() {
    super.initState();
    _resolve();
  }

  @override
  void didUpdateWidget(MealPhoto old) {
    super.didUpdateWidget(old);
    if (old.imagePath != widget.imagePath || old.images != widget.images) {
      _resolve();
    }
  }

  void _resolve() {
    _state = widget.images?.stateOf(widget.imagePath);
  }

  @override
  Widget build(BuildContext context) {
    final images = widget.images;
    final state = _state;
    if (images == null || state == null) return const SizedBox.shrink();

    return FutureBuilder<PhotoState>(
      future: state,
      builder: (context, snapshot) {
        final photo = snapshot.data;
        if (photo == null || photo == PhotoState.none) {
          return const SizedBox.shrink();
        }

        final theme = Theme.of(context);
        final evicted = photo == PhotoState.evicted;

        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: AspectRatio(
                aspectRatio: 4 / 3,
                child: _FileImage(
                  // The thumbnail is what an eviction leaves behind, and at
                  // 256px it is soft at this size — which is the honest
                  // rendering of "this photo is gone", and better than a grey
                  // box that would read as a broken meal.
                  file: evicted
                      ? images.loadThumbnail(widget.imagePath)
                      : images.load(widget.imagePath),
                  fallback: const ColoredBox(color: Colors.black26),
                ),
              ),
            ),
            if (evicted) ...[
              const SizedBox(height: 6),
              Text(
                'Photo removed to free up space',
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: theme.colorScheme.outline),
              ),
            ],
            const SizedBox(height: 16),
          ],
        );
      },
    );
  }
}

class _FileImage extends StatelessWidget {
  const _FileImage({required this.file, required this.fallback});

  final Future<File?> file;
  final Widget fallback;

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<File?>(
      future: file,
      builder: (context, snapshot) {
        final resolved = snapshot.data;
        if (resolved == null) return fallback;
        return Image.file(
          resolved,
          fit: BoxFit.cover,
          gaplessPlayback: true,
          // Evicted between the exists() check and the decode. Rare, and not
          // worth a different rendering than never having had one.
          errorBuilder: (_, __, ___) => fallback,
        );
      },
    );
  }
}

class _Placeholder extends StatelessWidget {
  const _Placeholder({required this.size});

  final double size;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ColoredBox(
      color: theme.colorScheme.surfaceContainerHighest,
      child: Icon(
        Icons.restaurant_outlined,
        size: size * 0.5,
        color: theme.colorScheme.outline,
      ),
    );
  }
}
