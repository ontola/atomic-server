import 'package:flutter/material.dart';

import '../atomic_client.dart';
import '../session.dart';

/// Compact workspace (drive) picker for app bars and settings.
///
/// Lists local workspaces, highlights the active one, and can create a new
/// workspace. App builders drop this in instead of wiring drive APIs by hand.
class DriveSwitcher extends StatefulWidget {
  const DriveSwitcher({
    super.key,
    this.onChanged,
    this.compact = false,
  });

  /// Called after the active workspace changes.
  final ValueChanged<String>? onChanged;

  /// When true, renders as a menu button rather than an expanded list.
  final bool compact;

  @override
  State<DriveSwitcher> createState() => _DriveSwitcherState();
}

class _DriveSwitcherState extends State<DriveSwitcher> {
  List<String> _drives = [];
  Map<String, String> _names = {};
  String? _active;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final drives = await AtomicClient.listDrives();
    final active = AtomicClient.getActiveDrive();
    final names = <String, String>{};
    for (final d in drives) {
      try {
        names[d] = await AtomicClient.getProperty(
          d,
          'https://atomicdata.dev/properties/name',
        );
      } catch (_) {
        names[d] = d;
      }
    }
    if (!mounted) return;
    setState(() {
      _drives = drives;
      _names = names;
      _active = active;
      _loading = false;
    });
  }

  Future<void> _select(String drive) async {
    await AtomicClient.setActiveDrive(drive);
    await AtomicSession.saveDrive(drive);
    if (!mounted) return;
    setState(() => _active = drive);
    widget.onChanged?.call(drive);
  }

  Future<void> _create() async {
    final controller = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('New workspace'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(
            labelText: 'Name',
            border: OutlineInputBorder(),
          ),
          onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('Create'),
          ),
        ],
      ),
    );
    if (name == null || name.isEmpty) return;
    final drive = await AtomicClient.createDrive(name);
    await _select(drive);
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const SizedBox(
        width: 24,
        height: 24,
        child: CircularProgressIndicator(strokeWidth: 2),
      );
    }

    if (widget.compact) {
      final label = _active == null
          ? 'Workspace'
          : (_names[_active] ?? _active!);
      return PopupMenuButton<String>(
        tooltip: 'Switch workspace',
        onSelected: (value) {
          if (value == '__new__') {
            _create();
          } else {
            _select(value);
          }
        },
        itemBuilder: (context) => [
          for (final d in _drives)
            PopupMenuItem(
              value: d,
              child: Row(
                children: [
                  if (d == _active)
                    const Icon(Icons.check, size: 18)
                  else
                    const SizedBox(width: 18),
                  const SizedBox(width: 8),
                  Expanded(child: Text(_names[d] ?? d)),
                ],
              ),
            ),
          const PopupMenuDivider(),
          const PopupMenuItem(
            value: '__new__',
            child: ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(Icons.add),
              title: Text('New workspace'),
              dense: true,
            ),
          ),
        ],
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.folder_outlined, size: 20),
              const SizedBox(width: 6),
              Flexible(
                child: Text(label, overflow: TextOverflow.ellipsis),
              ),
              const Icon(Icons.arrow_drop_down),
            ],
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final d in _drives)
          ListTile(
            leading: Icon(
              d == _active ? Icons.folder : Icons.folder_outlined,
            ),
            title: Text(_names[d] ?? d),
            selected: d == _active,
            onTap: () => _select(d),
          ),
        ListTile(
          leading: const Icon(Icons.add),
          title: const Text('New workspace'),
          onTap: _create,
        ),
      ],
    );
  }
}
