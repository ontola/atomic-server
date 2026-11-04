/// Comments on any resource, as the web app's comment panel writes them: the
/// entries of `ChatLog` pages with `about` = the resource, kept in the
/// `Comments` folder of a drive. The drive a comment lives in decides who can
/// read it, so one resource can carry comments for several audiences.
library;

/// One comment.
class Comment {
  const Comment({
    required this.id,
    required this.about,
    required this.author,
    required this.text,
    required this.createdAt,
    this.page = '',
    this.drive = '',
    this.mine = false,
    this.replyTo,
    this.editedAt,
    this.mentions = const [],
    this.anchor,
  });

  /// `<page>#<key>`: what [CommentsBackend.editComment] and
  /// [CommentsBackend.deleteComment] take, and what a reply's [replyTo] is.
  final String id;

  /// The `ChatLog` page the comment is an entry of.
  final String page;

  /// The drive the page lives in: who can read the comment.
  final String drive;

  /// The resource commented on.
  final String about;

  /// The agent who wrote it.
  final String author;

  /// Written by this store's own agent.
  final bool mine;

  /// Markdown; mentions as [mention] writes them.
  final String text;
  final DateTime createdAt;

  /// The [id] of the comment this answers.
  final String? replyTo;
  final DateTime? editedAt;

  /// The subjects mentioned in [text], in order, each once.
  final List<String> mentions;

  /// Where in [about] the comment is placed, when it is: the value of a W3C
  /// Web Annotation `FragmentSelector`; for a PDF an RFC 3778 fragment such
  /// as `page=3&viewrect=120,300,0,0` (PDF points from the top left). See
  /// [PdfSpot] to make and read one.
  final String? anchor;

  /// From the JSON the bridge's `readComments` gives.
  factory Comment.fromJson(Map<String, dynamic> json) => Comment(
        id: json['id'] as String? ?? '',
        page: json['page'] as String? ?? '',
        drive: json['drive'] as String? ?? '',
        about: json['about'] as String? ?? '',
        author: json['author'] as String? ?? '',
        mine: json['mine'] == true,
        text: json['text'] as String? ?? '',
        createdAt: DateTime.fromMillisecondsSinceEpoch(
            (json['c'] as num?)?.toInt() ?? 0),
        replyTo: json['reply_to'] as String?,
        editedAt: json['edited'] is num
            ? DateTime.fromMillisecondsSinceEpoch(
                (json['edited'] as num).toInt())
            : null,
        mentions: [
          for (final m in json['mentions'] as List? ?? const [])
            if (m is String) m
        ],
        anchor: json['anchor'] as String?,
      );

  /// The mention markup of the web app for [subject], shown as [label].
  static String mention(String subject, String label) =>
      '[@id="$subject" label="${label.replaceAll('"', "'")}"]';

  /// The subjects mentioned in [text] (the `id` of each `[@id="…" …]`).
  static List<String> mentionsIn(String text) {
    final out = <String>[];
    for (final m
        in RegExp(r'\[@[^\]]*?id="([^"]+)"[^\]]*\]').allMatches(text)) {
      final id = m.group(1)!;
      if (!out.contains(id)) out.add(id);
    }
    return out;
  }

  /// [text] with each mention replaced by `@label`.
  static String plain(String text) => text.replaceAllMapped(
      RegExp(r'\[@[^\]]*?label="([^"]*)"[^\]]*\]'), (m) => '@${m.group(1)}');
}

/// A [StoreBackend] that also reads and writes comments. Check with
/// `store.comments` (null when the backend has none).
abstract interface class CommentsBackend {
  /// The comments about [about] (every comment, when null) in [drive] or in
  /// every drive this store holds, oldest first. Local, never waits on the
  /// network.
  Future<List<Comment>> readComments({String? about, String? drive});

  /// Comment [text] on [about] as this store's agent, in [drive] (the drive of
  /// [about] when null). Returns the comment's id.
  /// With [anchor], the comment is placed at that spot in [about]
  /// ([Comment.anchor]).
  Future<String> postComment(String about, String text,
      {String? drive, String? replyTo, String? anchor});

  /// Replace the text of an own comment.
  Future<void> editComment(String id, String text);

  /// Remove an own comment.
  Future<void> deleteComment(String id);
}

/// A spot on a page of a PDF, as a [Comment.anchor]: the RFC 3778 fragment
/// `page=<n>&viewrect=<x>,<y>,0,0` (PDF points from the top left).
class PdfSpot {
  const PdfSpot(this.page, this.x, this.y);

  final int page;
  final double x;
  final double y;

  /// The [Comment.anchor] for this spot.
  String get anchor => 'page=$page&viewrect=${_n(x)},${_n(y)},0,0';

  static String _n(double v) => ((v * 10).round() / 10).toString();

  /// The spot [anchor] names; null for an anchor that is not a PDF spot.
  static PdfSpot? parse(String? anchor) {
    if (anchor == null) return null;
    final m = RegExp(r'(?:^|&)page=(\d+)(?:&viewrect=([-\d.]+),([-\d.]+))?')
        .firstMatch(anchor);
    if (m == null) return null;
    final page = int.parse(m.group(1)!);
    return PdfSpot(page, double.tryParse(m.group(2) ?? '') ?? 0,
        double.tryParse(m.group(3) ?? '') ?? 0);
  }

  @override
  bool operator ==(Object other) =>
      other is PdfSpot && other.page == page && other.x == x && other.y == y;

  @override
  int get hashCode => Object.hash(page, x, y);
}
