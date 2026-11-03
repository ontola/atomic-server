import 'dart:typed_data';

/// A [StoreBackend] that also keeps files the way the web app does: the
/// bytes as a blob named by their BLAKE3 hash, described by a `File`
/// resource under a parent, which the data browser shows and opens. Check
/// with `store.files` (null when the backend has none).
abstract interface class FilesBackend {
  /// Keep [bytes] as a `File` named [filename] under [parent]. At most 64 MB.
  /// Returns the File's subject.
  Future<String> uploadFile(
      String parent, String filename, String mimetype, Uint8List bytes);

  /// The bytes of the File [file] when this store holds them; null while
  /// they have not arrived (from another device or the server).
  Future<Uint8List?> readFile(String file);
}
