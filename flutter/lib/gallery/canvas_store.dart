import 'dart:convert';
import 'dart:ui' as ui;
import 'package:flutter/foundation.dart';
import '../atomic/atomic_client.dart';
import '../models/canvas_entry.dart';
import '../models/stroke_data.dart';
import '../canvas/thumbnail.dart';

class CanvasStore {
  final List<CanvasEntry> canvases = [];
  final List<FolderEntry> folders = [];
  bool _loaded = false;
  VoidCallback? _onChanged;
  bool _watching = false;

  CanvasStore();

  /// Register a callback that fires when the canvas list changes (e.g. after sync).
  void setOnChanged(VoidCallback? callback) {
    _onChanged = callback;
    if (callback != null && !_watching) {
      _startWatching();
    }
  }

  void _startWatching() {
    _watching = true;
    final drive = AtomicClient.getActiveDrive();
    if (drive == null) return;
    Future(() async {
      while (_onChanged != null) {
        final changedSubject = await AtomicClient.watchChildren(drive);
        if (changedSubject == 'timeout' || _onChanged == null) continue;

        // Collect more changes that arrive in quick succession
        final changed = <String>{changedSubject};
        await Future.delayed(const Duration(milliseconds: 50));
        // Note: watchChildren blocks until next change, so we just use the set we have

        await load();

        // Only reload strokes for changed canvases + any without strokes
        for (final canvas in canvases) {
          if (canvas.id.isNotEmpty &&
              (changed.contains(canvas.id) || canvas.strokes.isEmpty)) {
            await loadStrokes(canvas, isDarkMode: isDarkMode);
          }
        }

        _onChanged?.call();
      }
      _watching = false;
    });
  }

  bool get isLoaded => _loaded;

  bool isDarkMode = false;

  Future<void> load() async {
    try {
      final items = await AtomicClient.listCanvases();
      // Merge: keep existing entries (with thumbnails), add new, remove stale
      final newIds = items.map((i) => i.subject).toSet();
      canvases.removeWhere((c) => c.id.isNotEmpty && !newIds.contains(c.id));
      final newEntries = <CanvasEntry>[];
      for (final item in items) {
        if (!canvases.any((c) => c.id == item.subject)) {
          final entry = CanvasEntry(
            id: item.subject,
            lastModified: DateTime.now(),
            name: item.name,
            strokes: [],
          );
          canvases.add(entry);
          newEntries.add(entry);
        } else {
          final existing = canvases.firstWhere((c) => c.id == item.subject);
          existing.name = item.name;
        }
      }
      // Load strokes + generate thumbnails for new entries
      for (final entry in newEntries) {
        loadStrokes(entry, isDarkMode: isDarkMode).then((_) {
          if (entry.thumbnail != null) _onChanged?.call();
        }).catchError((e) {
          debugPrint('[load] failed to load strokes: $e');
        });
      }
    } catch (e) {
      debugPrint('Failed to list canvases: $e');
    }
    _loaded = true;
  }

  CanvasEntry createCanvas({String? folderId}) {
    final entry = CanvasEntry(
      id: '',
      folderId: folderId,
      lastModified: DateTime.now(),
      strokes: [],
    );
    canvases.insert(0, entry);
    _createRemote(entry);
    return entry;
  }

  Future<void> _createRemote(CanvasEntry entry) async {
    try {
      final name = 'Canvas ${DateTime.now().millisecondsSinceEpoch}';
      final subject = await AtomicClient.createCanvas(name);
      entry.id = subject;
      entry.name = name;
    } catch (e) {
      debugPrint('Failed to create canvas on server: $e');
    }
  }

  FolderEntry createFolder({String name = ''}) {
    final folder = FolderEntry(
        id: DateTime.now().microsecondsSinceEpoch.toString(), name: name);
    folders.add(folder);
    return folder;
  }

  void deleteCanvases(List<String> ids) {
    canvases.removeWhere((c) => ids.contains(c.id));
    for (final id in ids) {
      if (id.isNotEmpty) {
        AtomicClient.deleteCanvas(id).then((_) {
          debugPrint('[delete] canvas $id deleted');
        }).catchError((e) {
          debugPrint('[delete] Failed to delete canvas $id: $e');
        });
      }
    }
  }

  void deleteFolder(String folderId) {
    for (final c in canvases) {
      if (c.folderId == folderId) c.folderId = null;
    }
    folders.removeWhere((f) => f.id == folderId);
  }

  void moveToFolder(List<String> canvasIds, String? folderId) {
    for (final c in canvases) {
      if (canvasIds.contains(c.id)) c.folderId = folderId;
    }
  }

  List<CanvasEntry> canvasesInFolder(String? folderId) {
    return canvases.where((c) => c.folderId == folderId).toList()
      ..sort((a, b) => b.lastModified.compareTo(a.lastModified));
  }

  void onCanvasChanged(CanvasEntry canvas, List<StrokeData> strokes,
      {bool? isDarkMode, ui.Color? penColor, ui.Color? prevColor}) {
    isDarkMode ??= this.isDarkMode;
    canvas.strokes = List.unmodifiable(strokes);
    canvas.lastModified = DateTime.now();
    if (penColor != null) canvas.penColor = penColor;
    if (prevColor != null) canvas.prevColor = prevColor;
    renderThumbnail(strokes, size: 256, isDarkMode: isDarkMode)
        .then((img) => canvas.thumbnail = img);
  }

  /// Push a single stroke to the canvas. CRDT-friendly — appends to the Loro list.
  Future<void> pushStroke(CanvasEntry canvas, StrokeData stroke) async {
    if (canvas.id.isEmpty) return;
    try {
      final strokeJson = jsonEncode(stroke.toJson());
      await AtomicClient.pushStroke(canvas.id, strokeJson);
    } catch (e) {
      debugPrint('Failed to push stroke: $e');
    }
  }

  /// Loro undo (persisted + sync). Reloads [canvas].strokes. Returns false if nothing to undo.
  Future<bool> undoCanvas(CanvasEntry canvas) async {
    if (canvas.id.isEmpty) return false;
    try {
      final before = canvas.strokes.length;
      await AtomicClient.undoCanvas(canvas.id);
      await loadStrokes(canvas, isDarkMode: isDarkMode);
      return canvas.strokes.length < before;
    } catch (e) {
      debugPrint('Failed to undo canvas: $e');
      return false;
    }
  }

  /// Loro redo (persisted + sync). Reloads [canvas].strokes.
  Future<bool> redoCanvas(CanvasEntry canvas) async {
    if (canvas.id.isEmpty) return false;
    try {
      final before = canvas.strokes.length;
      await AtomicClient.redoCanvas(canvas.id);
      await loadStrokes(canvas, isDarkMode: isDarkMode);
      return canvas.strokes.length != before;
    } catch (e) {
      debugPrint('Failed to redo canvas: $e');
      return false;
    }
  }

  Future<({bool canUndo, bool canRedo})> undoRedoState(CanvasEntry canvas) async {
    if (canvas.id.isEmpty) {
      return (canUndo: false, canRedo: false);
    }
    try {
      final canUndo = await AtomicClient.canUndoCanvas(canvas.id);
      final canRedo = await AtomicClient.canRedoCanvas(canvas.id);
      return (canUndo: canUndo, canRedo: canRedo);
    } catch (e) {
      debugPrint('Failed to read undo/redo state: $e');
      return (canUndo: false, canRedo: false);
    }
  }

  /// Save the full stroke list (replaces Loro list). Used after undo/scrub.
  Future<void> saveFullStrokeState(
      CanvasEntry canvas, List<StrokeData> strokes) async {
    if (canvas.id.isEmpty) return;
    try {
      final json = jsonEncode(strokes.map((s) => s.toJson()).toList());
      await AtomicClient.setStrokes(canvas.id, json);
    } catch (e) {
      debugPrint('Failed to save stroke state: $e');
    }
  }

  Future<void> loadStrokes(CanvasEntry canvas, {bool? isDarkMode}) async {
    isDarkMode ??= this.isDarkMode;
    if (canvas.id.isEmpty) return;
    try {
      final jsonStr = await AtomicClient.loadCanvasStrokes(canvas.id);
      if (jsonStr.isEmpty || jsonStr == "[]") return;

      final dynamic decoded = jsonDecode(jsonStr);

      if (decoded is Map<String, dynamic> && decoded.containsKey('strokes')) {
        final entry = CanvasEntry.fromJson(decoded);
        canvas.strokes = entry.strokes;
        canvas.penColor = entry.penColor;
        canvas.prevColor = entry.prevColor;
      } else if (decoded is List) {
        canvas.strokes = decoded
            .map((s) => StrokeData.fromJson(s as Map<String, dynamic>))
            .toList();
      }

      if (canvas.strokes.isNotEmpty) {
        final img = await renderThumbnail(canvas.strokes,
            size: 256, isDarkMode: isDarkMode);
        canvas.thumbnail = img;
      }
    } catch (e) {
      debugPrint('Failed to load strokes for ${canvas.id}: $e');
    }
  }
}
