import 'dart:convert';
import 'dart:typed_data';

import 'package:atomic_chat/atomic_chat.dart';
import 'package:flutter/foundation.dart' show Listenable, debugPrint;
import 'package:flutter/material.dart'
    show BuildContext, MaterialPageRoute, Navigator;

import '../atomic/account_store.dart';
import '../atomic/atomic_client.dart';
import '../atomic/own_ai.dart';
import '../atomic/own_profile.dart';
import '../screens/ai_settings_screen.dart';
import 'package:atomic_store_flutter/bridge/api/assistant.dart'
    as ffi_assistant;
import 'package:atomic_store_flutter/bridge/api/simple/drive.dart'
    as ffi_simple;
import 'fake_ai.dart';

/// The app's [AssistantApi]: the local node through [AtomicClient] (the Rust
/// bridge), and the linked account from [AccountStore].
class AtomicAssistantApi extends AssistantApi {
  const AtomicAssistantApi();

  @override
  Future<List<DriveInfo>> drives() => AtomicClient.listDrivesWithNames();
  @override
  Future<DriveChildren> driveChildren(String parent) async =>
      AssistantJson.parseDriveChildren(
          await ffi_assistant.listChildren(parent: parent, limit: 200));
  @override
  Future<void> moveResource(String subject, String newParent, int index) =>
      ffi_assistant.moveResource(
          subject: subject, newParent: newParent, index: index);
  @override
  Future<void> setActiveDrive(String subject) =>
      ffi_simple.setActiveDrive(subject: subject);
  @override
  Future<List<ChatSummary>> chats() =>
      AtomicClient.listAiChats(limit: AssistantApi.chatsPageSize);
  @override
  Future<List<ChatSummary>> chatsPage(
          {required int offset, required int limit}) =>
      AtomicClient.listAiChats(limit: limit, offset: offset);
  @override
  Future<List<ChatMessage>> messages(String chat) =>
      AtomicClient.readChat(chat);
  @override
  Future<List<SearchHit>> search(String query, {String? drive}) =>
      AtomicClient.search(query, drive: drive);
  @override
  Future<List<SearchHit>> searchClasses(String query,
          {String? drive, required List<String> classes}) =>
      AtomicClient.search(query, drive: drive, classes: classes);
  @override
  Future<void> warmSearch() => AtomicClient.warmSearch();
  @override
  Future<List<RecentResource>> recentResources(String drive) =>
      AtomicClient.recentResources(drive);
  @override
  Future<List<RecentResource>> favorites() => AtomicClient.favorites();
  @override
  Future<List<NotificationItem>> notifications() =>
      AtomicClient.notifications();
  @override
  Future<void> markNotificationRead(String subject) =>
      AtomicClient.markNotificationRead(subject);
  @override
  Future<List<ConversationRow>> conversations() => AtomicClient.conversations();
  @override
  Future<List<ConversationMessage>> conversationMessages(String subject) =>
      AtomicClient.readConversation(subject);
  @override
  Future<void> sendConversationMessage(String subject, String text) =>
      AtomicClient.sendConversationMessage(subject, text);
  @override
  Future<void> followConversation(String subject) =>
      AtomicClient.followConversation(subject);
  @override
  Listenable? get storeChanges => AtomicClient.storeRevision;
  @override
  Future<List<PresenceItem>> presence(String drive) async =>
      (await AtomicClient.presence(drive)).map(PresenceItem.fromJson).toList();
  @override
  Listenable? get presenceChanges => AtomicClient.presenceRevision;
  @override
  Future<void> announcePresence(String drive,
          {String? resource,
          String? following,
          String? session,
          Map<String, Object?>? extra}) =>
      AtomicClient.setPresence(drive, {
        ...?extra,
        'resource': resource,
        'following': following,
        'session': session,
      });
  @override
  Future<void> clearPresence(String drive) => AtomicClient.clearPresence(drive);
  @override
  Future<Set<String>?> currentMeetings(String drive) async {
    // The drive's `currentMeetings`, read the way the page reads a resource.
    final raw = await AtomicClient.embedCall(
        'getResource', jsonEncode([drive]));
    final json = jsonDecode(raw);
    if (json is! Map) return null;
    final list = json['https://atomicdata.dev/properties/currentMeetings'];
    return {
      if (list is List)
        for (final e in list)
          if (e is String)
            e
          else if (e is Map && e['@id'] is String)
            e['@id'] as String
    };
  }

  @override
  Future<ProfileIdentity?> identityOf(String agent) async {
    final name = await AtomicClient.getProperty(
            agent, 'https://atomicdata.dev/properties/name')
        .catchError((Object _) => '');
    return name.isEmpty ? null : ProfileIdentity(name: name, subject: agent);
  }
  /// The existing direct conversation with [agent]. Starting a new one
  /// needs the conversation keys the app cannot make yet, so none is created.
  @override
  Future<String?> conversationWith(String agent) async {
    String key(String s) => s.replaceFirst(RegExp(r'^(atomic|did:ad):'), '');
    final rows = jsonDecode(await ffi_assistant.listConversations(limit: 200))
        as List;
    for (final row in rows.cast<Map<String, dynamic>>()) {
      final peer = row['peer'];
      if (peer is Map && key('${peer['subject']}') == key(agent)) {
        return row['subject'] as String?;
      }
    }
    return null;
  }
  @override
  Stream<List<String>>? get resourceChanges =>
      AtomicClient.resourceChanges.stream;
  @override
  Future<List<ChatRoomMessage>> chatRoomMessages(String subject) =>
      AtomicClient.readChatRoom(subject);
  @override
  Future<void> sendChatRoomMessage(String subject, String text) =>
      AtomicClient.sendChatRoomMessage(subject, text);
  @override
  Future<List<ActivityEntry>> activity(int limit) =>
      AtomicClient.activity(limit: limit);
  @override
  Future<List<ActivityEntry>> activityWithMine(int limit) =>
      AtomicClient.activity(limit: limit, includeOwn: true);
  @override
  Future<List<ActivityEntry>> activityPage(
          {ActivityEntry? before,
          int limit = AssistantApi.activityPageSize,
          bool includeOwn = false}) =>
      AtomicClient.activityPage(
          before: before, limit: limit, includeOwn: includeOwn);
  @override
  Future<Map<String, String>> resourceIcons(List<String> subjects) =>
      AtomicClient.resourceIcons(subjects);
  @override
  Future<Uint8List?> fileBytes(String file) => AtomicClient.readFileBytes(file);
  @override
  void noteOpened(String drive, String subject) =>
      AtomicClient.noteResourceOpened(drive, subject);
  @override
  Future<String?> agentName() async =>
      (await AtomicClient.getActiveAgent())?.name;

  @override
  Future<ProfileIdentity?> ownIdentity() async {
    final agent = await AtomicClient.getActiveAgent();
    if (agent == null) return null;
    try {
      final p = await OwnProfile.load();
      return ProfileIdentity(
          name: p.name ?? agent.name,
          subject: agent.subject,
          imageUrl: p.imageUrl,
          imageBytes: p.imageBytes,
          emoji: p.emoji,
          pendingImage: p.pendingImage);
    } catch (e) {
      debugPrint('Own profile not read: $e');
      // Not read now: the shell keeps the picture it has and asks again.
      return ProfileIdentity(
          name: agent.name, subject: agent.subject, pendingImage: true);
    }
  }

  /// The linked account's AI. With no session saved, the active agent signs
  /// the account in first (as the web app does).
  @override
  Future<HostedAi?> hostedAi() async {
    if (fakeAiEnabled) return fakeHostedAi();
    // The person's own provider, when they switched to it.
    final own = await OwnAi.hostedAi();
    if (own != null) return own;
    var saved = await AccountStore.read();
    if (saved == null && await AccountStore.signInWithAgent()) {
      saved = await AccountStore.read();
    }
    if (saved == null) return null;
    return HostedAi.forSession(saved);
  }

  @override
  bool get canOpenAiSettings => true;
  @override
  Future<void> openAiSettings(BuildContext context) => Navigator.of(context)
      .push(MaterialPageRoute<void>(builder: (_) => const AiSettingsScreen()));

  @override
  bool get canSignUpForAi => !fakeAiEnabled;
  @override
  Future<void> signUpForAi(String email) => AccountStore.signUpWithAgent(email);

  @override
  Future<String> newChat(String name) => AtomicClient.createAiChat(name);
  @override
  Future<String> createResource(String drive, String classUrl, String name) =>
      AtomicClient.createResourceOfClass(drive, classUrl, name);
  @override
  Future<void> addMessage(String chat, String role, String text) =>
      AtomicClient.appendChatEntry(chat, role, text);
  @override
  Future<List<ChatEntry>> chatEntries(String chat) =>
      AtomicClient.readChatEntries(chat);
  @override
  Future<ChatPage<ChatEntry>> chatEntriesPage(String chat,
          {String? before, int limit = 50}) =>
      AtomicClient.readChatEntriesPage(chat, before: before, limit: limit);
  @override
  Future<ChatPage<ChatEntry>> chatEntriesAfter(String chat, String after,
          {int limit = 100}) =>
      AtomicClient.readChatEntriesAfter(chat, after, limit: limit);
  @override
  Future<ChatPage<ChatRoomMessage>> chatRoomMessagesPage(String subject,
          {String? before, int limit = 50}) =>
      AtomicClient.readChatRoomPage(subject, before: before, limit: limit);
  @override
  Future<ChatPage<ChatRoomMessage>> chatRoomMessagesAfter(
          String subject, String after,
          {int limit = 100}) =>
      AtomicClient.readChatRoomAfter(subject, after, limit: limit);
  @override
  Future<ChatPage<ConversationMessage>> conversationMessagesPage(String subject,
          {String? before, int limit = 50}) =>
      AtomicClient.readConversationPage(subject, before: before, limit: limit);
  @override
  Future<ChatPage<ConversationMessage>> conversationMessagesAfter(
          String subject, String after,
          {int limit = 100}) =>
      AtomicClient.readConversationAfter(subject, after, limit: limit);
  @override
  Future<void> addEntry(String chat, String role, List<ChatPart> parts) =>
      AtomicClient.appendChatEntryParts(chat, role, parts);
  @override
  Future<String> resourceText(String subject, {int maxChars = 4000}) =>
      AtomicClient.resourceText(subject, maxChars: maxChars);
  @override
  String webUrl(String subject) => AtomicClient.resourceWebUrl(subject);
  @override
  Future<String> embedCall(String method, String argsJson) =>
      AtomicClient.embedCall(method, argsJson);
  @override
  Future<void> renameResource(String subject, String name) =>
      AtomicClient.setProperty(
          subject, 'https://atomicdata.dev/properties/name', name);
}
