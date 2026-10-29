import 'package:atomic_chat/atomic_chat.dart';
import 'package:atomic_store/atomic_store.dart';
import 'package:flutter/material.dart';

import '../src/building_assistant_api.dart';
import '../src/building_tools.dart';
import '../src/device_picker.dart';
import '../src/repository.dart';
import '../src/room_scanner.dart';
import '../src/roomplan.dart';
import '../src/terms.g.dart';

/// What the chat needs from the app: the linked account's AI, how to sign in
/// to it, and where photos and files come from.
class BuildingChat {
  const BuildingChat({
    required this.ai,
    this.connect,
    this.picker = const DeviceAttachmentPicker(),
  });

  /// The AI of the linked account; null result when none is linked.
  final Future<HostedAi?> Function() ai;
  final Future<void> Function(BuildContext context)? connect;
  final AttachmentPicker picker;
}

/// The main screen of a Home: the chat that collects the data. It is the
/// package's [ChatScreen] on the Home's chat resource, with the building
/// tools; the title bar carries [actions], and Scan room is a row of the
/// attach sheet where the device can scan.
class BuildingChatPage extends StatefulWidget {
  const BuildingChatPage(this.repo, this.home,
      {super.key,
      required this.chat,
      required this.scanner,
      this.actions = const []});
  final BuildingRepository repo;
  final Resource home;
  final BuildingChat chat;
  final RoomScanner scanner;
  final List<Widget> actions;

  @override
  State<BuildingChatPage> createState() => _BuildingChatPageState();
}

class _BuildingChatPageState extends State<BuildingChatPage> {
  late final BuildingTools _tools = BuildingTools(widget.repo, widget.home);
  late final BuildingAssistantApi _api = BuildingAssistantApi(
      widget.repo, widget.home, _tools,
      account: widget.chat.ai, connect: widget.chat.connect);
  late final Future<String> _chat = _api.ensureChat();
  bool _canScan = false;

  /// A new key makes the chat screen read the chat again (after the scan
  /// wrote its message).
  int _version = 0;

  @override
  void initState() {
    super.initState();
    widget.scanner.isSupported().then((can) {
      if (mounted && can) setState(() => _canScan = true);
    });
  }

  Future<void> _scan() async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final room = await widget.scanner.scan();
      if (room == null) return;
      final storey = await _scanStorey();
      final result = await importScannedRoomChecked(widget.repo, storey, room);
      final text = result.needsDecision
          ? await _askPlacement(room, storey, result.reason!)
          : await summarizeScan(widget.repo, widget.home, room, result.created);
      await _api.addEntry(await _chat, 'assistant', [TextPart(text)]);
      if (mounted) setState(() => _version++);
    } on Object catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Scan failed: $e')));
    }
  }

  /// The scan could not be placed: it waits (the AI places it with
  /// connect_rooms once the person says where) and the chat asks.
  Future<String> _askPlacement(
      ScannedRoom room, Resource storey, String reason) async {
    final name = room.name ?? 'Scanned room';
    _tools.holdScan(room, storey, reason);
    final question = 'Which room does "$name" connect to, and through which '
        'door?';
    await widget.repo.createQuestion(widget.home, question, 'text',
        why: '$reason, so the scan is not on the plan yet.');
    return 'I scanned "$name" but could not place it on the plan: '
        '${reason[0].toLowerCase()}${reason.substring(1)}. It is not on the '
        'plan yet.\n\n$question';
  }

  Future<Resource> _scanStorey() async {
    final storeys = [
      for (final r in await widget.home.children())
        if (r.isA(BuildingClass.storey)) r,
    ];
    return storeys.firstOrNull ??
        await widget.repo.createStorey(widget.home, 'Ground floor');
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<String>(
        future: _chat,
        builder: (context, snap) {
          if (snap.hasError) {
            return Center(child: Text("Couldn't open the chat: ${snap.error}"));
          }
          final chat = snap.data;
          if (chat == null) {
            return const Center(child: CircularProgressIndicator());
          }
          return ChatScreen(
            key: ValueKey(_version),
            api: _api,
            subject: chat,
            drive: widget.home.parent ?? '',
            title: widget.home.name ?? 'Chat',
            tools: _tools.tools,
            attachmentPicker: widget.chat.picker,
            actions: widget.actions,
            attachActions: [
              if (_canScan)
                AttachAction(
                    label: 'Scan room',
                    icon: Icons.view_in_ar_outlined,
                    run: _scan),
            ],
          );
        },
      );
}

/// The chat message after a scan was imported: what was proposed, and a
/// question (also recorded in the Questions tab) about what the scan cannot
/// know, the room's use.
Future<String> summarizeScan(BuildingRepository repo, Resource home,
    ScannedRoom room, List<Resource> created) async {
  final name = room.name ?? 'Scanned room';
  Resource? space;
  var walls = 0, doors = 0, windows = 0, objects = 0, other = 0;
  for (final r in created) {
    if (r.isA(BuildingClass.space)) {
      space = r;
      continue;
    }
    switch (r.getString(Bldg.ifcClass)) {
      case 'IfcWall':
        walls++;
      case 'IfcDoor':
        doors++;
      case 'IfcWindow':
        windows++;
      case 'IfcFurnishingElement':
        objects++;
      default:
        other++;
    }
  }
  String n(int count, String what) => '$count $what${count == 1 ? '' : 's'}';
  final outline = space?.boundary;
  final area = outline == null ? null : polygonArea(outline);
  final parts = [
    if (space != null)
      area == null
          ? '1 space'
          : '1 space (about ${area.toStringAsFixed(1)} m² from the scanned '
              'walls)',
    if (walls > 0) n(walls, 'wall'),
    if (doors > 0) n(doors, 'door'),
    if (windows > 0) n(windows, 'window'),
    if (objects > 0) n(objects, 'object'),
    if (other > 0) n(other, 'other opening'),
  ];
  final list = parts.isEmpty
      ? 'nothing I could use'
      : parts.length == 1
          ? parts.single
          : '${parts.sublist(0, parts.length - 1).join(', ')} and ${parts.last}';
  final question = 'What is the room "$name" used for?';
  await repo.createQuestion(home, question, 'choose',
      about: space,
      why: 'The scan measures shapes; it does not know what a room is for.',
      options: const [
        'living',
        'kitchen',
        'bedroom',
        'bathroom',
        'hall',
        'storage',
        'technical',
        'outdoor',
        'other',
      ]);
  return 'I imported the scan "$name" and proposed $list. These are '
      'proposals from the scan\'s own measurements; nothing is confirmed '
      'until you check them on the Plan tab.\n\n$question';
}
