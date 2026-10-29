import 'dart:async';

import 'package:atomic_chat/atomic_chat.dart';
import 'package:atomic_store/atomic_store.dart';
import 'package:flutter/widgets.dart' show BuildContext;

import 'building_tools.dart';
import 'repository.dart';
import 'terms.g.dart';

/// A chat made here is an `aiChatClass` resource (the web app's AI chat)
/// under the Home, but its messages are kept as JSON in
/// [chatEntriesProperty], not in the web app's `ChatLog` pages (the typed
/// store cannot write those), so the web app lists it without its messages.
const chatEntriesProperty =
    'https://atomic.place/buildings/properties/chat-entries';

/// The first message of every chat: no claims, one question.
const chatGreeting =
    "Hi! I'll help you capture this house. Send me photos, a floor plan "
    '(PDF or picture) or notes, or scan a room, and I will propose what I '
    'see and ask about what I am unsure of; nothing counts until you '
    'confirm it.\n\nTo begin: what is one real measurement you know, for '
    'example the width of the front door or the length of a wall?';

/// What a Source made from an attached file is: images are photos (a floor
/// plan when the name says so), PDFs are floor plans or PDFs, text is a note.
String guessMediaKind(String name, String mediaType) {
  final plan = RegExp(r'plan|floor|grond|tekening|blueprint|drawing',
          caseSensitive: false)
      .hasMatch(name);
  if (mediaType == 'application/pdf') {
    return plan ? MediaKind.floorplan : MediaKind.pdf;
  }
  if (mediaType.startsWith('image/')) {
    return plan ? MediaKind.floorplan : MediaKind.photo;
  }
  return MediaKind.note;
}

String _size(int? n) => n == null
    ? 'unknown size'
    : n < 1024 * 1024
        ? '${(n / 1024).ceil()} KB'
        : '${(n / 1024 / 1024).toStringAsFixed(1)} MB';

/// The [AssistantApi] of the building chat: the chat is a resource under the
/// Home in the app's [Store], the AI is the linked account's, and what the
/// person attaches becomes Sources.
///
/// Real: [hostedAi], [connectAccount], [newChat], [addEntry], [addMessage],
/// [chatEntries], [messages], [resourceText], [renameResource], and empty
/// answers for what the chat screen asks while it is open ([drives],
/// [recentResources], [favorites], [search], [resourceIcons]). Everything else
/// of the home screens (conversations, activity, notifications, moving
/// resources, the embedded renderer) throws [UnsupportedError].
class BuildingAssistantApi extends AssistantApi {
  BuildingAssistantApi(this.repo, this.home, this.tools,
      {required this.account, this.connect});

  final BuildingRepository repo;
  final Resource home;
  final BuildingTools tools;

  /// The linked account's AI, or null when no account is linked.
  final Future<HostedAi?> Function() account;

  /// Signs in to the account (or creates it); null when not offered.
  final Future<void> Function(BuildContext context)? connect;

  Store get _store => repo.store;

  Future<String>? _chat;
  Future<void> _tail = Future.value();

  /// Completes when every write of [addEntry] so far is done.
  Future<void> get settled => _tail;

  Future<T> _serial<T>(Future<T> Function() write) {
    final result = _tail.then((_) => write());
    _tail = result.then((_) {}, onError: (Object _) {});
    return result;
  }

  /// The one chat of the Home: found, or made with [chatGreeting].
  Future<String> ensureChat() => _chat ??= _findOrCreate();

  Future<String> _findOrCreate() async {
    for (final r in await home.children()) {
      if (r.isA(aiChatClass)) return r.subject;
    }
    final chat = _store.newResource(
        parent: home.subject, isA: [aiChatClass], props: {Props.name: 'Chat'});
    await chat.save();
    await addEntry(chat.subject, 'assistant', const [TextPart(chatGreeting)]);
    return chat.subject;
  }

  // ---- the chat ----

  Future<List<ChatEntry>> _read(String chat) async {
    final raw = (await _store.getResource(chat)).getJson(chatEntriesProperty);
    return [
      if (raw is List)
        for (final e in raw)
          if (e is Map)
            ChatEntry(
              id: '${e['id']}',
              role: '${e['role']}',
              createdAt: (e['createdAt'] as num?)?.toInt() ?? 0,
              parts: [
                for (final p in (e['parts'] as List? ?? const []))
                  if (p is Map) ChatPart.fromJson(Map<String, dynamic>.from(p)),
              ],
            ),
    ];
  }

  @override
  Future<List<ChatEntry>> chatEntries(String chat) => _read(chat);

  @override
  Future<List<ChatMessage>> messages(String chat) async => [
        for (final e in await _read(chat))
          (id: e.id, role: e.role, text: e.text, createdAt: e.createdAt),
      ];

  @override
  Future<String> newChat(String name) => ensureChat();

  @override
  Future<void> addMessage(String chat, String role, String text) =>
      addEntry(chat, role, [TextPart(text)]);

  /// Appends a message. What the person attaches becomes a Source each (name,
  /// type and size; the bytes are not stored, see the README), and the stored
  /// message points at it with a `source:` URL instead of holding the data.
  @override
  Future<void> addEntry(String chat, String role, List<ChatPart> parts) =>
      _serial(() async {
        final stored = <ChatPart>[];
        final made = <Resource>[];
        for (final p in parts) {
          if (p is FilePart && role == 'user' && p.url.startsWith('data:')) {
            final name = p.filename ?? 'Attachment';
            final source = await repo.addSource(
                home, name, guessMediaKind(name, p.mediaType),
                description: '${p.mediaType}, ${_size(p.bytes?.length)}. '
                    'The file itself is not stored yet.');
            made.add(source);
            stored.add(FilePart(
                url: 'source:${source.subject}',
                mediaType: p.mediaType,
                filename: p.filename));
          } else {
            stored.add(p);
          }
        }
        if (made.isNotEmpty) tools.noteSources(made);
        final resource = await _store.getResource(chat);
        final raw = resource.getJson(chatEntriesProperty);
        final list = raw is List ? List<Object?>.of(raw) : <Object?>[];
        list.add({
          'id': 'e${list.length + 1}',
          'role': role,
          'createdAt': DateTime.now().millisecondsSinceEpoch,
          'parts': [for (final p in stored) p.toJson()],
        });
        resource.setJson(chatEntriesProperty, list);
        await resource.save();
      });

  // ---- the AI ----

  @override
  Future<HostedAi?> hostedAi() async {
    final inner = await account();
    return inner == null
        ? null
        : BuildingAi(inner, tools, settled: () => settled);
  }

  @override
  bool get canConnectAccount => connect != null;

  @override
  Future<void> connectAccount(BuildContext context) async {
    final connect = this.connect;
    if (connect == null) {
      throw UnsupportedError('This app cannot connect an account');
    }
    await connect(context);
  }

  // ---- what an open chat screen asks for ----

  @override
  Future<List<DriveInfo>> drives() async => const [];
  @override
  Future<List<RecentResource>> recentResources(String drive) async => const [];
  @override
  Future<List<RecentResource>> favorites() async => const [];
  @override
  Future<List<SearchHit>> search(String query, {String? drive}) async =>
      const [];
  @override
  Future<Map<String, String>> resourceIcons(List<String> subjects) async =>
      const {};
  @override
  void noteOpened(String drive, String subject) {}
  @override
  Future<String?> agentName() async => null;

  @override
  Future<String> resourceText(String subject, {int maxChars = 4000}) async {
    final r = await _store.getResource(subject);
    final text = '${r.name ?? ''}\n${r.getString(Props.description) ?? ''}';
    return text.length > maxChars ? text.substring(0, maxChars) : text;
  }

  @override
  Future<void> renameResource(String subject, String name) async {
    final r = await _store.getResource(subject);
    r.set(Props.name, name);
    await r.save();
  }

  // ---- not in this app ----

  Never _no(String what) => throw UnsupportedError(
      'AssistantApi.$what is not available in AtomicBuildings');

  @override
  Future<List<ChatSummary>> chats() => _no('chats');
  @override
  Future<List<NotificationItem>> notifications() => _no('notifications');
  @override
  Future<void> markNotificationRead(String subject) =>
      _no('markNotificationRead');
  @override
  Future<List<ConversationRow>> conversations() => _no('conversations');
  @override
  Future<List<ConversationMessage>> conversationMessages(String subject) =>
      _no('conversationMessages');
  @override
  Future<void> sendConversationMessage(String subject, String text) =>
      _no('sendConversationMessage');
  @override
  Future<void> followConversation(String subject) => _no('followConversation');
  @override
  Future<List<ChatRoomMessage>> chatRoomMessages(String subject) =>
      _no('chatRoomMessages');
  @override
  Future<void> sendChatRoomMessage(String subject, String text) =>
      _no('sendChatRoomMessage');
  @override
  Future<List<ActivityEntry>> activity(int limit) => _no('activity');
  @override
  Future<String> createResource(String drive, String classUrl, String name) =>
      _no('createResource');
  @override
  String webUrl(String subject) => _no('webUrl');

  /// The breadcrumbs under the chat's title ask for the chat's parents; there
  /// is no embedded renderer here, so they stay empty.
  @override
  Future<String> embedCall(String method, String argsJson) => _no('embedCall');
}

/// The account's AI with the building prompt and state in front of every
/// answer, one AnalysisRun per answer, and photos that the model may refuse.
///
/// A photo goes to the model as an image part. If the model fails on a
/// message that carries one before it said anything, the answer is asked
/// again without the images (they become a note that the model cannot see
/// them), the chat says so, and images are left out from then on. The photo
/// stays a Source either way.
class BuildingAi extends HostedAi {
  BuildingAi(HostedAi inner, this.building, {this.settled})
      : _inner = inner,
        super(
          status: inner.status,
          completions: (_, __, ___) => const Stream.empty(),
          enable: () async {
            await inner.enable();
            return inner.status;
          },
          transcribe: inner.transcribe,
          voiceStatus: inner.voiceStatus,
          acceptsImages: true,
          portal: inner.portal,
        );

  final HostedAi _inner;
  final BuildingTools building;

  /// Completes when the person's message and its Sources are written.
  final Future<void> Function()? settled;

  bool _imagesRefused = false;

  /// What the chat says when the model could not take a photo.
  static const imagesRefusedNotice =
      'The included AI could not take the photo, so it answers without seeing '
      'it. The photo is kept as a source.';

  @override
  bool get supportsTools => _inner.supportsTools;

  @override
  Future<String?> title(String question, String answer) =>
      _inner.title(question, answer);

  static bool _hasImage(List<ChatEntry> history) =>
      history.any((e) => e.parts.any((p) => p is FilePart && p.isImage));

  /// [history] with images as notes when [images] is false, and always when
  /// their data is gone (a stored message has only a `source:` URL).
  List<ChatEntry> _prepare(List<ChatEntry> history, {required bool images}) {
    final batch = building.lastAttachments;
    final last = history.lastIndexWhere((e) => e.role == 'user');
    return [
      for (final (i, e) in history.indexed)
        ChatEntry(
          id: e.id,
          role: e.role,
          createdAt: e.createdAt,
          context: e.context,
          parts: [
            for (final p in e.parts)
              if (p is FilePart &&
                  p.isImage &&
                  !(images && p.url.startsWith('data:')))
                TextPart(
                    '[The person attached the photo "${p.filename ?? 'photo'}"'
                    '${p.url.startsWith('source:') ? ', stored as source ${p.url.substring(7)}' : ''}. '
                    'You cannot see it.]')
              else
                p,
            if (i == last && batch.isNotEmpty)
              TextPart('[Stored as sources: ${batch.map((s) => '${s.subject} '
                  '(${s.name}, ${s.getString(Bldg.mediaKind)})').join('; ')}]'),
          ],
        ),
    ];
  }

  @override
  Stream<AiEvent> run(
    List<ChatEntry> history, {
    String? context,
    List<AiTool> tools = const [],
    WebToolBridge? bridge,
  }) async* {
    await settled?.call();
    building.beginTurn(model);
    try {
      final prompt = await building.context();
      final ctx = [prompt, if (context != null && context.isNotEmpty) context]
          .join('\n\n');
      while (true) {
        final images = !_imagesRefused;
        var said = false;
        try {
          await for (final e in _inner.run(_prepare(history, images: images),
              context: ctx, tools: tools, bridge: bridge)) {
            if (e is AiTextDelta || e is AiToolStarted) said = true;
            yield e;
          }
          return;
        } on Object {
          if (said || !images || !_hasImage(history)) rethrow;
          _imagesRefused = true;
          yield const AiNotice(imagesRefusedNotice);
        }
      }
    } finally {
      await building.endTurn();
    }
  }
}
