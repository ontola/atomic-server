import 'package:atomic_store/atomic_store.dart';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';

import '../src/gltf_export.dart';
import '../src/repository.dart';
import '../src/room_scanner.dart';
import 'building_chat_page.dart';
import 'common.dart';
import 'plan_view.dart';
import 'questions_view.dart';
import 'sources_view.dart';

/// A Home is one chat. Plan, Sources and Questions are secondary screens,
/// opened from the menu in the title bar.
class HomePage extends StatefulWidget {
  const HomePage(this.repo, this.home,
      {super.key,
      required this.chat,
      this.scanner,
      this.actions = const [],
      this.writeExport = _writeToDocuments});
  final BuildingRepository repo;
  final Resource home;
  final BuildingChat chat;

  /// Null means the platform scanner (RoomPlan on iOS).
  final RoomScanner? scanner;

  /// More buttons of the title bar (the account button).
  final List<Widget> actions;

  /// Stores an exported GLB under [name] and returns where it went; tests
  /// inject their own. The default writes to the app documents directory.
  final Future<String> Function(String name, Uint8List glb) writeExport;

  @override
  State<HomePage> createState() => _HomePageState();
}

Future<String> _writeToDocuments(String name, Uint8List glb) async {
  final file = File('${(await getApplicationDocumentsDirectory()).path}/$name');
  await file.writeAsBytes(glb);
  return file.path;
}

class _HomePageState extends State<HomePage> {
  late final RoomScanner _scanner = widget.scanner ?? PlatformRoomScanner();

  Future<void> _export(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final glb = await exportHomeGlb(widget.repo, widget.home.subject);
      final name = '${widget.home.name ?? 'home'}.glb'.replaceAll('/', '-');
      final path = await widget.writeExport(name, glb);
      messenger
          .showSnackBar(SnackBar(content: Text('3D model saved to $path')));
    } on Object catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Export failed: $e')));
    }
  }

  void _openScreen(String screen) {
    final (repo, home) = (widget.repo, widget.home);
    final page = switch (screen) {
      'Plan' => Builder(
          builder: (context) => Scaffold(
            appBar: AppBar(title: const Text('Plan'), actions: [
              IconButton(
                tooltip: 'Export 3D model',
                icon: const Icon(Icons.view_in_ar_outlined),
                onPressed: () => _export(context),
              ),
            ]),
            body: PlanView(repo, home, scanner: _scanner),
          ),
        ),
      'Sources' => Builder(
          builder: (context) => Scaffold(
            appBar: AppBar(title: const Text('Sources')),
            body: SourcesView(repo, home),
            floatingActionButton: FloatingActionButton(
              tooltip: 'Add note',
              onPressed: () async {
                final text = await askText(context, 'Note');
                if (text != null) {
                  await repo.addSource(home, text, MediaKind.note);
                }
              },
              child: const Icon(Icons.note_add),
            ),
          ),
        ),
      _ => Scaffold(
          appBar: AppBar(title: const Text('Questions')),
          body: QuestionsView(repo, home),
        ),
    };
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));
  }

  @override
  Widget build(BuildContext context) => BuildingChatPage(
        widget.repo,
        widget.home,
        chat: widget.chat,
        scanner: _scanner,
        actions: [
          _ScreensMenu(widget.repo, widget.home, _openScreen),
          ...widget.actions,
        ],
      );
}

/// The title bar button that lists the secondary screens; its badge counts
/// the open questions.
class _ScreensMenu extends StatefulWidget {
  const _ScreensMenu(this.repo, this.home, this.onSelected);
  final BuildingRepository repo;
  final Resource home;
  final void Function(String screen) onSelected;

  @override
  State<_ScreensMenu> createState() => _ScreensMenuState();
}

class _ScreensMenuState extends State<_ScreensMenu> {
  late final Stream<List<Resource>> _open =
      widget.repo.watchOpenQuestions(widget.home);

  @override
  Widget build(BuildContext context) => StreamBuilder<List<Resource>>(
        stream: _open,
        builder: (context, open) => PopupMenuButton<String>(
          tooltip: 'Plan, sources and questions',
          icon: Badge(
            isLabelVisible: (open.data ?? const []).isNotEmpty,
            label: Text('${open.data?.length ?? 0}'),
            child: const Icon(Icons.dashboard_outlined),
          ),
          onSelected: widget.onSelected,
          itemBuilder: (_) => const [
            PopupMenuItem(value: 'Plan', child: Text('Plan')),
            PopupMenuItem(value: 'Sources', child: Text('Sources')),
            PopupMenuItem(value: 'Questions', child: Text('Questions')),
          ],
        ),
      );
}
