import 'dart:ui' as ui;
import 'stroke_data.dart';

class CanvasEntry {
  String id;
  String? folderId;
  String name;
  DateTime lastModified;
  List<StrokeData> strokes;
  ui.Image? thumbnail;
  ui.Color penColor;
  ui.Color prevColor;

  CanvasEntry({
    required this.id,
    this.folderId,
    this.name = '',
    required this.lastModified,
    this.strokes = const [],
    this.thumbnail,
    this.penColor = const ui.Color(0xFF000000),
    this.prevColor = const ui.Color(0xFFE63946),
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'folderId': folderId,
        'lastModified': lastModified.toIso8601String(),
        'strokes': strokes.map((s) => s.toJson()).toList(),
        'penColor': penColor.value,
        'prevColor': prevColor.value,
      };

  factory CanvasEntry.fromJson(Map<String, dynamic> json) {
    return CanvasEntry(
      id: json['id'] as String,
      folderId: json['folderId'] as String?,
      lastModified: DateTime.parse(json['lastModified'] as String),
      strokes: (json['strokes'] as List)
          .map((s) => StrokeData.fromJson(s as Map<String, dynamic>))
          .toList(),
      penColor: ui.Color(json['penColor'] as int? ?? 0xFF000000),
      prevColor: ui.Color(json['prevColor'] as int? ?? 0xFFE63946),
    );
  }
}

class FolderEntry {
  final String id;
  String name;

  FolderEntry({required this.id, required this.name});

  Map<String, dynamic> toJson() => {'id': id, 'name': name};

  factory FolderEntry.fromJson(Map<String, dynamic> json) {
    return FolderEntry(
      id: json['id'] as String,
      name: json['name'] as String,
    );
  }
}
