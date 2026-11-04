/// A [StoreBackend] that edits a JSON array property item by item, the way
/// the canvas does its strokes: list operations that merge with edits from
/// other devices instead of a replaced array, each edit one undo step. Check
/// with `store.lists` (null when the backend has none); [Resource.editList],
/// [Resource.undo] and [Resource.redo] use it.
abstract interface class ListsBackend {
  /// Edit the JSON array [property] of [subject] as one signed commit and
  /// one undo step: put the [replace] items in place (by index), then delete
  /// the items at [delete] (indexes before the deletes), then add [push] at
  /// the end. Items are anything `jsonEncode` accepts.
  Future<void> editList(String subject, String property,
      {Map<int, Object?> replace = const {},
      List<int> delete = const [],
      List<Object?> push = const []});

  /// Take back the last [editList] on [subject] made here (not another
  /// device's), as a signed commit like any edit. `false` when there is
  /// nothing to undo; the history lasts while the app runs.
  Future<bool> undo(String subject);

  /// Do again what [undo] took back on [subject]. `false` when there is
  /// nothing to redo; a new [editList] clears what could be redone.
  Future<bool> redo(String subject);
}
