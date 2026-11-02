import 'dart:async';

import 'backend.dart';
import 'comments.dart';
import 'exceptions.dart';
import 'urls.dart';
import 'value.dart';

/// A [StoreBackend] that keeps resources in a map, for tests of code that uses
/// a [Store]. Subjects of created resources are `did:ad:test:1`, `…:2`, …
///
/// It emits the events the real backend does, without any manual [touch]:
/// [ResourceEventKind.changed] for a created resource (also a drive), a saved
/// one and an edit by [touch]; [ResourceEventKind.destroyed] for a destroyed
/// one and each of its descendants.
///
/// [search] scopes like the real index: `drive:` matches that resource and
/// everything below it by walking the `parent` chain, [SearchResult.drive] is
/// the nearest ancestor that is a Drive and [SearchResult.className] the name
/// of the first class. It differs from the real backend in matching (title
/// and description, case-insensitive substring of the whole query; the real
/// index ranks, tolerates typos, splits words and indexes document bodies),
/// in ignoring the Trash, in having no agent, signatures, sync or
/// permissions, and in leaving the order of [childSubjects] to insertion
/// order.
///
/// Comments ([CommentsBackend]) are kept in [comments], one page per
/// resource and drive; [agent] writes them. Posting one announces a change
/// of its page.
class InMemoryBackend implements StoreBackend, CommentsBackend {
  InMemoryBackend([Map<String, Map<String, Value>> resources = const {}]) {
    resources.forEach((subject, props) => this.resources[subject] = Map.of(props));
  }

  /// The resources by subject. Writing here directly changes the data but
  /// announces nothing: a [Store.watch] or [Store.watchChildren] only sees the
  /// edit once you call [touch] (or [destroy] for a delete) for the subject.
  /// Writes through the [Store] (`save`, `destroy`) announce themselves.
  final Map<String, Map<String, Value>> resources = {};

  /// Every call made, as `method subject-or-query`.
  final List<String> calls = [];

  /// Throw this from the next call (then forget it).
  StoreException? failNext;

  /// The agent who writes comments ([Comment.mine]).
  String agent = 'did:ad:agent:test';

  /// Every comment, oldest first.
  final List<Comment> comments = [];

  int _next = 0;
  final Map<String, List<Completer<ResourceEventKind>>> _waiting = {};
  final List<Completer<StoreEvent>> _waitingAny = [];

  void _enter(String call) {
    calls.add(call);
    final failure = failNext;
    if (failure != null) {
      failNext = null;
      throw failure;
    }
  }

  void _emit(String subject, ResourceEventKind kind) {
    final waiting = _waiting.remove(subject) ?? const [];
    for (final c in waiting) {
      if (!c.isCompleted) c.complete(kind);
    }
    final any = List.of(_waitingAny);
    _waitingAny.clear();
    for (final c in any) {
      if (!c.isCompleted) c.complete(StoreEvent(kind, subject));
    }
  }

  /// End every pending wait (as a timeout) so no timer outlives a test. Call
  /// it after the widgets or streams under test are gone; a cancelled
  /// [Store.watch] or [Store.watchChildren] then stops without waiting out its
  /// timeout. `testWidgets` fails on timers still pending otherwise.
  void dispose() {
    final one = [for (final l in _waiting.values) ...l];
    final any = List.of(_waitingAny);
    _waiting.clear();
    _waitingAny.clear();
    for (final c in one) {
      if (!c.isCompleted) c.complete(ResourceEventKind.timeout);
    }
    for (final c in any) {
      if (!c.isCompleted) {
        c.complete(const StoreEvent(ResourceEventKind.timeout, ''));
      }
    }
  }

  /// Announce a change of [subject] to everyone waiting for it.
  void touch(String subject) => _emit(subject, ResourceEventKind.changed);

  /// Remove [subject] and its descendants and announce each, as
  /// [destroyResource] does but without being a call (acts as "someone else
  /// deleted this"). Nothing happens when [subject] is not there.
  void destroy(String subject) {
    if (!resources.containsKey(subject)) return;
    for (final child in [
      for (final e in resources.entries)
        if (e.value[Props.parent] == LinkValue(subject)) e.key
    ]) {
      destroy(child);
    }
    resources.remove(subject);
    _emit(subject, ResourceEventKind.destroyed);
  }

  @override
  Future<void> destroyResource(String subject) async {
    _enter('destroyResource $subject');
    if (!resources.containsKey(subject)) {
      throw StoreException(StoreErrorKind.notFound, 'Not found: $subject',
          subject: subject);
    }
    destroy(subject);
  }

  @override
  Future<ResourceSnapshot> getResource(String subject) async {
    _enter('getResource $subject');
    final props = resources[subject];
    if (props == null) {
      throw StoreException(StoreErrorKind.notFound, 'Not found: $subject',
          subject: subject);
    }
    return ResourceSnapshot(subject, Map.of(props));
  }

  @override
  Future<void> saveChanges(
      String subject, Map<String, Value> set, List<String> remove) async {
    _enter('saveChanges $subject');
    final props = resources[subject];
    if (props == null) {
      throw StoreException(StoreErrorKind.notFound, 'Not found: $subject',
          subject: subject);
    }
    props.addAll(set);
    remove.forEach(props.remove);
    _emit(subject, ResourceEventKind.changed);
  }

  @override
  Future<String> createResource(Map<String, Value> values) async {
    _enter('createResource');
    final subject = 'did:ad:test:${++_next}';
    resources[subject] = Map.of(values);
    _emit(subject, ResourceEventKind.changed);
    return subject;
  }

  @override
  Future<List<SearchResult>> search(String query,
      {String? drive, String? isA, int limit = 20}) async {
    _enter('search $query');
    final needle = query.toLowerCase();
    final hits = <SearchResult>[];
    for (final e in resources.entries) {
      final props = e.value;
      final title = _title(props);
      final text = _text(props[Props.description]);
      if (!title.toLowerCase().contains(needle) &&
          !text.toLowerCase().contains(needle)) {
        continue;
      }
      final classes = _classes(props);
      if (isA != null && !classes.contains(isA)) continue;
      if (drive != null && !_isUnder(e.key, drive)) continue;
      hits.add(SearchResult(
        subject: e.key,
        title: title,
        className: classes.isEmpty ? '' : _className(classes.first),
        drive: _driveOf(e.key),
        score: 1,
      ));
    }
    return hits.take(limit).toList();
  }

  static List<String> _classes(Map<String, Value> props) =>
      switch (props[Props.isA]) {
        ArrayValue(:final links) => links,
        LinkValue(:final subject) => [subject],
        _ => const [],
      };

  /// `name`, else `shortname`, else `filename`, as the real index does.
  static String _title(Map<String, Value> props) {
    for (final p in [Props.name, Props.shortname, Props.filename]) {
      final t = _text(props[p]);
      if (t.isNotEmpty) return t;
    }
    return '';
  }

  String _className(String classUrl) {
    final name = _text(resources[classUrl]?[Props.name]);
    return name.isEmpty ? classUrl : name;
  }

  /// [subject] itself or one of its ancestors (the `parent` chain) is [scope].
  bool _isUnder(String subject, String scope) {
    final seen = <String>{};
    String? current = subject;
    while (current != null && seen.add(current)) {
      if (current == scope) return true;
      final parent = resources[current]?[Props.parent];
      current = parent is LinkValue ? parent.subject : null;
    }
    return false;
  }

  /// The nearest resource up the `parent` chain (itself included) that is a
  /// drive; empty when there is none.
  String _driveOf(String subject) {
    final seen = <String>{};
    String? current = subject;
    while (current != null && seen.add(current)) {
      final props = resources[current];
      if (props == null) return '';
      if (_classes(props).contains(Classes.drive)) return current;
      final parent = props[Props.parent];
      current = parent is LinkValue ? parent.subject : null;
    }
    return '';
  }

  @override
  Future<List<String>> childSubjects(String parent, {int limit = 1000}) async {
    _enter('childSubjects $parent');
    return [
      for (final e in resources.entries)
        if (e.value[Props.parent] == LinkValue(parent)) e.key
    ].take(limit).toList();
  }

  @override
  Future<String> createDrive(String name) async {
    _enter('createDrive $name');
    final subject = 'did:ad:test:${++_next}';
    resources[subject] = {
      Props.isA: const ArrayValue([LinkValue(Classes.drive)]),
      Props.name: StringValue(name),
    };
    _emit(subject, ResourceEventKind.changed);
    return subject;
  }

  static String _text(Value? v) => switch (v) {
        StringValue(:final value) ||
        MarkdownValue(:final value) ||
        SlugValue(:final value) =>
          value,
        _ => '',
      };

  @override
  Future<StoreEvent> waitForStoreEvent(Duration timeout) async {
    _enter('waitForStoreEvent');
    final completer = Completer<StoreEvent>();
    _waitingAny.add(completer);
    final timer = Timer(timeout, () {
      if (!completer.isCompleted) {
        completer.complete(const StoreEvent(ResourceEventKind.timeout, ''));
      }
    });
    try {
      return await completer.future;
    } finally {
      timer.cancel();
      _waitingAny.remove(completer);
    }
  }

  @override
  Future<ResourceEventKind> waitForEvent(
      String subject, Duration timeout) async {
    _enter('waitForEvent $subject');
    final completer = Completer<ResourceEventKind>();
    (_waiting[subject] ??= []).add(completer);
    final timer = Timer(timeout, () {
      if (!completer.isCompleted) completer.complete(ResourceEventKind.timeout);
    });
    try {
      return await completer.future;
    } finally {
      timer.cancel();
    }
  }

  @override
  Future<List<Comment>> readComments({String? about, String? drive}) async {
    _enter('readComments ${about ?? ''}');
    return [
      for (final c in comments)
        if ((about == null || c.about == about) &&
            (drive == null || c.drive == drive))
          _withMine(c)
    ];
  }

  Comment _withMine(Comment c) => Comment(
        id: c.id,
        page: c.page,
        drive: c.drive,
        about: c.about,
        author: c.author,
        mine: c.author == agent,
        text: c.text,
        createdAt: c.createdAt,
        replyTo: c.replyTo,
        editedAt: c.editedAt,
        mentions: c.mentions,
      );

  @override
  Future<String> postComment(String about, String text,
      {String? drive, String? replyTo}) async {
    _enter('postComment $about');
    final t = text.trim();
    if (t.isEmpty) {
      throw const StoreException(
          StoreErrorKind.invalid, 'Cannot post an empty comment');
    }
    final scope = drive ?? _driveOf(about);
    final page = 'did:ad:test:comments:${Uri.encodeComponent('$scope|$about')}';
    final id = '$page#${++_next}';
    comments.add(Comment(
      id: id,
      page: page,
      drive: scope,
      about: about,
      author: agent,
      text: t,
      createdAt: DateTime.now(),
      replyTo: replyTo,
      mentions: Comment.mentionsIn(t),
    ));
    _emit(page, ResourceEventKind.changed);
    return id;
  }

  int _own(String id) {
    final i = comments.indexWhere((c) => c.id == id);
    if (i < 0) {
      throw StoreException(StoreErrorKind.notFound, 'No comment $id');
    }
    if (comments[i].author != agent) {
      throw const StoreException(
          StoreErrorKind.unauthorized, 'Only the author can change a comment');
    }
    return i;
  }

  @override
  Future<void> editComment(String id, String text) async {
    _enter('editComment $id');
    final i = _own(id);
    final c = comments[i];
    comments[i] = Comment(
      id: c.id,
      page: c.page,
      drive: c.drive,
      about: c.about,
      author: c.author,
      text: text.trim(),
      createdAt: c.createdAt,
      replyTo: c.replyTo,
      editedAt: DateTime.now(),
      mentions: Comment.mentionsIn(text),
    );
    _emit(c.page, ResourceEventKind.changed);
  }

  @override
  Future<void> deleteComment(String id) async {
    _enter('deleteComment $id');
    final c = comments.removeAt(_own(id));
    _emit(c.page, ResourceEventKind.changed);
  }
}
