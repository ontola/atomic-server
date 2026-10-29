import 'dart:io' show Platform;

import 'package:atomic_chat/atomic_chat.dart' hide ImageSource;
import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:image_picker/image_picker.dart' hide PickedFile;

/// The media type of a file by its extension; a generic one when unknown.
String mediaTypeOf(String name) {
  final dot = name.lastIndexOf('.');
  final ext = dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
  return switch (ext) {
    'jpg' || 'jpeg' => 'image/jpeg',
    'png' => 'image/png',
    'gif' => 'image/gif',
    'webp' => 'image/webp',
    'heic' => 'image/heic',
    'heif' => 'image/heif',
    'pdf' => 'application/pdf',
    'txt' || 'log' => 'text/plain',
    'md' => 'text/markdown',
    'csv' => 'text/csv',
    'json' => 'application/json',
    _ => 'application/octet-stream',
  };
}

/// Photos, the camera and files for the building chat: `image_picker` for the
/// photo library and the camera, `file_picker` for PDFs and other files. The
/// camera is offered on phones and tablets only. PDFs (floor plans) are kept
/// ([keeps]) though the AI cannot read them.
class DeviceAttachmentPicker extends AttachmentPicker {
  const DeviceAttachmentPicker();

  static bool get _mobile => !kIsWeb && (Platform.isIOS || Platform.isAndroid);

  @override
  bool get canTakePhoto => _mobile;

  @override
  bool keeps(PickedFile file) => file.mediaType == 'application/pdf';

  // The included AI takes photos of up to 1 MB each (as base64): a phone
  // photo is shrunk and re-encoded as JPEG, which is plenty to read a room or
  // a floor plan.
  static const _maxSide = 1400.0;
  static const _quality = 75;

  static Future<PickedFile> _read(XFile f) async => PickedFile(
      name: f.name,
      mediaType: f.mimeType ?? mediaTypeOf(f.name),
      bytes: await f.readAsBytes());

  @override
  Future<List<PickedFile>> pickImages() async => [
        for (final f in await ImagePicker().pickMultiImage(
            maxWidth: _maxSide, maxHeight: _maxSide, imageQuality: _quality))
          await _read(f),
      ];

  @override
  Future<PickedFile?> takePhoto() async {
    final f = await ImagePicker().pickImage(
        source: ImageSource.camera,
        maxWidth: _maxSide,
        maxHeight: _maxSide,
        imageQuality: _quality);
    return f == null ? null : _read(f);
  }

  @override
  Future<List<PickedFile>> pickFiles() async {
    final result = await FilePicker.platform
        .pickFiles(allowMultiple: true, withData: true);
    return [
      for (final f in result?.files ?? const <PlatformFile>[])
        if (f.bytes != null)
          PickedFile(
              name: f.name, mediaType: mediaTypeOf(f.name), bytes: f.bytes!),
    ];
  }
}
