import 'dart:async';
import 'package:flutter/material.dart';
import '../models/canvas_entry.dart';
import '../theme.dart';
import '../atomic/atomic_client.dart';
import 'canvas_store.dart';
import '../atomic/widgets/agent_settings_dialog.dart';

class GalleryScreen extends StatefulWidget {
  final CanvasStore store;
  final void Function(CanvasEntry) onOpen;
  final void Function({String? folderId}) onNew;
  final VoidCallback? onSignOut;

  const GalleryScreen({
    super.key,
    required this.store,
    required this.onOpen,
    required this.onNew,
    this.onSignOut,
  });

  @override
  State<GalleryScreen> createState() => _GalleryScreenState();
}

class _GalleryScreenState extends State<GalleryScreen> {
  FolderEntry? _currentFolder;
  final Set<String> _selected = {};
  bool _pickingFolder = false;
  bool _editingFolderName = false;
  final _folderNameController = TextEditingController();
  final _folderNameFocus = FocusNode();

  bool get _selecting => _selected.isNotEmpty;

  @override
  void initState() {
    super.initState();
    _folderNameFocus.addListener(() {
      if (!_folderNameFocus.hasFocus && _editingFolderName) {
        _commitFolderRename();
        setState(() => _editingFolderName = false);
      }
    });
    // Live-reload when canvases change (e.g. after sync)
    widget.store.setOnChanged(() {
      if (mounted) setState(() {});
    });
  }

  bool? _lastDarkMode;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final isDark = Theme.of(context).brightness == Brightness.dark;
    widget.store.isDarkMode = isDark;
    if (_lastDarkMode != null && _lastDarkMode != isDark) {
      _regenerateThumbnails(isDark);
    }
    _lastDarkMode = isDark;
  }

  void _regenerateThumbnails(bool isDarkMode) {
    for (final canvas in widget.store.canvases) {
      if (canvas.strokes.isNotEmpty) {
        widget.store.loadStrokes(canvas, isDarkMode: isDarkMode).then((_) {
          if (mounted) setState(() {});
        });
      }
    }
  }

  @override
  void dispose() {
    widget.store.setOnChanged(null);
    _folderNameController.dispose();
    _folderNameFocus.dispose();
    super.dispose();
  }

  void _back() {
    if (_pickingFolder) {
      setState(() => _pickingFolder = false);
    } else if (_selecting) {
      setState(() => _selected.clear());
    } else if (_currentFolder != null) {
      setState(() {
        _currentFolder = null;
        _editingFolderName = false;
      });
    }
  }

  bool get _canGoBack => _pickingFolder || _selecting || _currentFolder != null;

  void _moveSelectedToFolder(String? folderId) {
    widget.store.moveToFolder(_selected.toList(), folderId);
    setState(() {
      _selected.clear();
      _pickingFolder = false;
    });
  }

  void _deleteSelected() {
    widget.store.deleteCanvases(_selected.toList());
    setState(() => _selected.clear());
  }

  void _createFolderAndMove() {
    final folder = widget.store.createFolder();
    _moveSelectedToFolder(folder.id);
  }

  void _toggleSelect(String id) {
    setState(() {
      if (_selected.contains(id)) {
        _selected.remove(id);
      } else {
        _selected.add(id);
      }
    });
  }

  String _folderDisplayName(FolderEntry f) =>
      f.name.isEmpty ? 'Unnamed folder' : f.name;

  void _commitFolderRename() {
    final folder = _currentFolder;
    if (folder == null) return;
    final name = _folderNameController.text.trim();
    final resolved = name.isEmpty ? 'Folder' : name;
    if (resolved == folder.name) return;
    widget.store.renameFolder(folder, resolved);
  }

  void _startEditingFolderName() {
    _folderNameController.text = _currentFolder!.name;
    setState(() => _editingFolderName = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _folderNameFocus.requestFocus();
      _folderNameController.selection = TextSelection(
        baseOffset: 0,
        extentOffset: _folderNameController.text.length,
      );
    });
  }

  // ── Tiles ─────────────────────────────────────────────────────────────────

  Widget _buildFolderTile(FolderEntry folder) {
    final c = context.appColors;
    final previews = widget.store.canvasesInFolder(folder.id).take(4).toList();
    return GestureDetector(
      onTap: () {
        if (_pickingFolder) {
          _moveSelectedToFolder(folder.id);
        } else if (_selecting) {
          // folders can't be selected
        } else {
          setState(() {
            _currentFolder = folder;
            _editingFolderName = false;
          });
        }
      },
      child: Container(
        decoration: BoxDecoration(
          color: c.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: c.surfaceDim),
        ),
        clipBehavior: Clip.hardEdge,
        child: Stack(
          children: [
            GridView.count(
              crossAxisCount: 2,
              physics: const NeverScrollableScrollPhysics(),
              children: List.generate(4, (i) {
                final canvas = i < previews.length ? previews[i] : null;
                return Container(
                  color: c.surfaceDim,
                  child: canvas?.thumbnail != null
                      ? RawImage(image: canvas!.thumbnail, fit: BoxFit.cover)
                      : null,
                );
              }),
            ),
            Positioned(
              left: 6,
              bottom: 6,
              right: 6,
              child: Text(
                _folderDisplayName(folder),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: c.textPrimary,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildCanvasTile(CanvasEntry canvas) {
    final c = context.appColors;
    final isSelected = _selected.contains(canvas.id);
    return GestureDetector(
      onTap: () {
        if (_selecting) {
          _toggleSelect(canvas.id);
        } else {
          widget.onOpen(canvas);
        }
      },
      onLongPress: () => _toggleSelect(canvas.id),
      child: Container(
        decoration: BoxDecoration(
          color: c.surface,
          borderRadius: BorderRadius.circular(12),
          boxShadow: [
            BoxShadow(
                color: c.panelShadow,
                blurRadius: 4,
                offset: const Offset(0, 1)),
          ],
        ),
        clipBehavior: Clip.hardEdge,
        child: Stack(
          fit: StackFit.expand,
          children: [
            canvas.thumbnail != null
                ? RawImage(image: canvas.thumbnail, fit: BoxFit.cover)
                : Container(color: c.surfaceDim),
            if (isSelected) ...[
              Container(color: const Color(0x552196F3)),
              const Center(
                  child:
                      Icon(Icons.check_circle, color: Colors.white, size: 40)),
            ] else if (_selecting)
              Container(color: const Color(0x22000000)),
          ],
        ),
      ),
    );
  }

  Widget _buildNewTile() {
    final c = context.appColors;
    return GestureDetector(
      onTap: () => widget.onNew(folderId: _currentFolder?.id),
      child: Container(
        decoration: BoxDecoration(
          color: c.surfaceDim,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Center(
          child: Icon(Icons.add, size: 48, color: c.iconDisabled),
        ),
      ),
    );
  }

  Widget _buildNewFolderTile() {
    final c = context.appColors;
    return GestureDetector(
      onTap: _createFolderAndMove,
      child: Container(
        decoration: BoxDecoration(
          color: c.surfaceDim,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.create_new_folder, size: 40, color: c.iconDisabled),
            const SizedBox(height: 6),
            Text('New folder',
                style: TextStyle(fontSize: 12, color: c.iconDisabled)),
          ],
        ),
      ),
    );
  }

  Widget _buildRootTile() {
    final c = context.appColors;
    return GestureDetector(
      onTap: () => _moveSelectedToFolder(null),
      child: Container(
        decoration: BoxDecoration(
          color: c.surfaceDim,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.home_outlined, size: 40, color: c.iconDisabled),
            const SizedBox(height: 6),
            Text('Gallery root',
                style: TextStyle(fontSize: 12, color: c.iconDisabled)),
          ],
        ),
      ),
    );
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final c = context.appColors;
    final List<Widget> gridItems;

    if (_pickingFolder) {
      gridItems = [
        _buildNewFolderTile(),
        _buildRootTile(),
        ...widget.store.folders.map(_buildFolderTile),
      ];
    } else {
      gridItems = [
        _buildNewTile(),
        if (_currentFolder == null)
          ...widget.store.folders.map(_buildFolderTile),
        ...widget.store
            .canvasesInFolder(_currentFolder?.id)
            .map(_buildCanvasTile),
      ];
    }

    return Scaffold(
      backgroundColor: c.canvasBg,
      body: SafeArea(
          child: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 64),
            child: GridView.count(
              crossAxisCount: _crossAxisCount(context),
              padding: const EdgeInsets.all(16),
              mainAxisSpacing: 12,
              crossAxisSpacing: 12,
              children: gridItems,
            ),
          ),

          // Top bar
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: Container(
              height: 64,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              decoration: BoxDecoration(
                color: c.canvasBg.withOpacity(0.95),
              ),
              child: Row(
                children: [
                  if (_canGoBack)
                    IconButton(
                      icon: Icon(_selecting && !_pickingFolder
                          ? Icons.close
                          : Icons.arrow_back),
                      onPressed: _back,
                      style:
                          IconButton.styleFrom(backgroundColor: c.backButtonBg),
                    )
                  else
                    const SizedBox(width: 8),
                  const SizedBox(width: 8),

                  // Title
                  Expanded(child: _buildTitle()),

                  // Actions
                  if (_selecting && !_pickingFolder) ...[
                    TextButton.icon(
                      icon: const Icon(Icons.folder, size: 18),
                      label: const Text('Move'),
                      style: TextButton.styleFrom(
                        backgroundColor: const Color(0xFF1976D2),
                        foregroundColor: Colors.white,
                        shape: const StadiumBorder(),
                      ),
                      onPressed: () => setState(() => _pickingFolder = true),
                    ),
                    const SizedBox(width: 8),
                    IconButton(
                      icon: const Icon(Icons.delete),
                      style: IconButton.styleFrom(
                        backgroundColor: const Color(0xFFE53935),
                        foregroundColor: Colors.white,
                      ),
                      onPressed: _deleteSelected,
                    ),
                  ] else ...[
                    _SyncBadgeButton(
                      onPressed: () async {
                        final signedOut =
                            await AgentSettingsDialog.show(context);
                        if (signedOut) {
                          widget.onSignOut?.call();
                        } else {
                          await widget.store.load();
                          if (mounted) setState(() {});
                        }
                      },
                    ),
                  ],
                ],
              ),
            ),
          ),
        ],
      )),
    );
  }

  int _crossAxisCount(BuildContext context) {
    final w = MediaQuery.of(context).size.width;
    if (w > 1200) return 6;
    if (w > 800) return 4;
    if (w > 500) return 3;
    return 2;
  }

  Widget _buildTitle() {
    final c = context.appColors;
    if (_pickingFolder) {
      return const Text('Move to folder',
          style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16));
    }

    if (_selecting) {
      return Text('${_selected.length} selected',
          style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16));
    }

    if (_currentFolder != null) {
      if (_editingFolderName) {
        return TextField(
          controller: _folderNameController,
          focusNode: _folderNameFocus,
          style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16),
          decoration: const InputDecoration(
            hintText: 'Folder name',
            border: InputBorder.none,
            isDense: true,
            contentPadding: EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          ),
          onChanged: (v) => _currentFolder!.name = v,
          onSubmitted: (_) {
            _commitFolderRename();
            setState(() => _editingFolderName = false);
          },
        );
      }
      return GestureDetector(
        onTap: _startEditingFolderName,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              _folderDisplayName(_currentFolder!),
              style: TextStyle(
                fontWeight: FontWeight.w600,
                fontSize: 16,
                color: _currentFolder!.name.isEmpty
                    ? c.iconDisabled
                    : c.textPrimary,
              ),
            ),
            const SizedBox(width: 6),
            Icon(Icons.edit, size: 14, color: c.textSecondary),
          ],
        ),
      );
    }

    return const Text('Gallery',
        style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16));
  }
}

/// Settings button with a badge showing the number of live peer connections.
class _SyncBadgeButton extends StatefulWidget {
  final VoidCallback onPressed;
  const _SyncBadgeButton({required this.onPressed});

  @override
  State<_SyncBadgeButton> createState() => _SyncBadgeButtonState();
}

class _SyncBadgeButtonState extends State<_SyncBadgeButton> {
  int _count = 0;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _startWatching();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _startWatching() async {
    // Get initial count
    final initial = await AtomicClient.livePeerCount();
    if (mounted) setState(() => _count = initial);
    // Reactive loop: blocks until count changes
    while (mounted) {
      final newCount = await AtomicClient.waitForPeerCountChange(_count);
      if (mounted && newCount != _count) setState(() => _count = newCount);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        IconButton(
          icon: const Icon(Icons.account_circle_outlined),
          onPressed: widget.onPressed,
        ),
        if (_count > 0)
          Positioned(
            right: 4,
            top: 4,
            child: Container(
              width: 16,
              height: 16,
              decoration: const BoxDecoration(
                color: Colors.green,
                shape: BoxShape.circle,
              ),
              child: Center(
                child: Text(
                  '$_count',
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
