import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../atomic_client.dart';
import '../session.dart';
import '../../screens/pair_screen.dart';

class AgentSettingsDialog extends StatefulWidget {
  const AgentSettingsDialog({super.key});

  static Future<bool> show(BuildContext context) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (context) => const AgentSettingsDialog(),
    );
    return result ?? false;
  }

  @override
  State<AgentSettingsDialog> createState() => _AgentSettingsDialogState();
}

class _AgentSettingsDialogState extends State<AgentSettingsDialog> {
  AgentInfo? _agent;
  List<String> _drives = [];
  Map<String, String> _driveNames = {};
  String? _activeDrive;
  bool _loading = true;
  bool _creatingDrive = false;
  bool _showNewDrive = false;
  bool _syncing = false;
  String? _syncResult;
  String? _peerId;
  final bool _peerStarting = false;
  bool _showAddPeer = false;
  bool _discovering = false;
  List<Map<String, String>> _knownPeers = [];
  Set<String> _livePeerIds = {};
  int? _lastSyncCount;
  DateTime? _lastSyncTime;
  String _deviceName = '';
  final _newDriveController = TextEditingController();
  final _peerController = TextEditingController();
  Timer? _liveRefreshTimer;
  VoidCallback? _livePeersListener;

  @override
  void initState() {
    super.initState();
    _loadData();
    _loadDeviceName();
    _liveRefreshTimer =
        Timer.periodic(const Duration(seconds: 2), (_) => _refreshLivePeers());
    _livePeersListener = () => _refreshLivePeers();
    AtomicClient.livePeersRevision.addListener(_livePeersListener!);
  }

  @override
  void dispose() {
    if (_livePeersListener != null) {
      AtomicClient.livePeersRevision.removeListener(_livePeersListener!);
    }
    _liveRefreshTimer?.cancel();
    _newDriveController.dispose();
    _peerController.dispose();
    super.dispose();
  }

  Future<void> _refreshLivePeers() async {
    final live = AtomicClient.livePeerIds();
    if (!mounted) return;
    setState(() => _livePeerIds = live);
  }

  void _loadDeviceName() async {
    var name = await AtomicClient.getDeviceName();
    if (name.isEmpty) {
      name = await PairScreen.getDeviceName();
      if (name.isNotEmpty && name != 'localhost') {
        await AtomicClient.setDeviceName(name);
      }
    }
    if (mounted) setState(() => _deviceName = name);
  }

  // ── Actions ──────────────────────────────────────────────────────────

  Future<void> _loadData() async {
    setState(() => _loading = true);
    final agent = await AtomicClient.getActiveAgent();
    final drives = await AtomicClient.listDrives();
    final activeDrive = AtomicClient.getActiveDrive();
    final peerId = await AtomicClient.getPeerId();

    final names = <String, String>{};
    for (final d in drives) {
      try {
        names[d] = await AtomicClient.getProperty(
            d, 'https://atomicdata.dev/properties/name');
      } catch (_) {
        names[d] = '';
      }
    }

    final knownPeers = await AtomicClient.getKnownPeers();
    final livePeerIds = AtomicClient.livePeerIds();

    setState(() {
      _agent = agent;
      _drives = drives;
      _driveNames = names;
      _activeDrive = activeDrive;
      _peerId = peerId;
      _knownPeers = knownPeers;
      _livePeerIds = livePeerIds;
      _loading = false;
    });
  }

  /// Settings → Retry and automatic sync on open.
  Future<void> _autoSyncConnectivity() async {
    if (_activeDrive == null) return;
    await _syncConnectivity();
  }

  Future<void> _discoverAndSync() => _syncConnectivity();

  Future<void> _syncConnectivity() async {
    if (_activeDrive == null) return;
    setState(() {
      _discovering = true;
      _syncResult = null;
    });
    try {
      if ((await AtomicClient.getPeerId()) == null) {
        await AtomicClient.startPeer();
      }
      final report = await AtomicClient.syncConnectivityNow();
      final liveIds = AtomicClient.livePeerIds();
      if (!mounted) return;
      setState(() {
        _discovering = false;
        _lastSyncCount = report.imported;
        _lastSyncTime = DateTime.now();
        _livePeerIds = liveIds;
        if (report.livePeers > 0) {
          _syncResult = report.message;
        } else if (report.imported > 0) {
          _syncResult = report.message;
        } else {
          _syncResult = 'Error: ${report.message}';
        }
      });
      await _loadData();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _discovering = false;
        _syncResult = 'Error: $e';
      });
    }
  }

  Future<void> _syncWithPeer() async {
    var nodeId = _peerController.text.trim();
    if (nodeId.isEmpty) return;
    if (nodeId.startsWith('iroh:')) nodeId = nodeId.substring(5);

    setState(() {
      _syncing = true;
      _syncResult = null;
    });
    try {
      if ((await AtomicClient.getPeerId()) == null) {
        await AtomicClient.startPeer();
        setState(() => _peerId = nodeId);
      }
      final count = await AtomicClient.peerSync(nodeId);
      setState(() {
        _syncResult = 'Synced $count resources';
        _lastSyncCount = count;
        _lastSyncTime = DateTime.now();
        _syncing = false;
        _showAddPeer = false;
      });
      _peerController.clear();
      await _loadData(); // Refresh drives etc.
    } catch (e) {
      setState(() {
        _syncResult = 'Error: $e';
        _syncing = false;
      });
    }
  }

  Future<void> _createDrive() async {
    final name = _newDriveController.text.trim();
    if (name.isEmpty) return;
    setState(() => _creatingDrive = true);
    try {
      await AtomicClient.createDrive(name);
      _newDriveController.clear();
      setState(() => _showNewDrive = false);
      await _loadData();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed: $e')),
        );
      }
    }
    setState(() => _creatingDrive = false);
  }

  Future<void> _switchDrive(String drive) async {
    try {
      await AtomicClient.setActiveDrive(drive);
      await AtomicSession.saveDrive(drive);
      setState(() => _activeDrive = drive);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed: $e')),
        );
      }
    }
  }

  Future<void> _signOut() async {
    final navigator = Navigator.of(context);
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Sign out?'),
        content: const Text(
            'Your local data will be kept, but you\'ll need your secret to sign back in.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('Sign out'),
          ),
        ],
      ),
    );
    if (confirm != true) return;
    await AtomicSession.clear();
    navigator.pop(true);
  }

  void _copyToClipboard(String text, String label) {
    Clipboard.setData(ClipboardData(text: text));
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
          content: Text('$label copied'), duration: const Duration(seconds: 2)),
    );
  }

  // ── Build ────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    final screenWidth = MediaQuery.of(context).size.width;
    final isPhone = screenWidth < 600;
    final dialogWidth = isPhone ? screenWidth * 0.92 : 420.0;

    return AlertDialog(
      title: const Text('Settings'),
      insetPadding: EdgeInsets.symmetric(
        horizontal: isPhone ? 12 : 40,
        vertical: 24,
      ),
      content: _loading
          ? const SizedBox(
              height: 200, child: Center(child: CircularProgressIndicator()))
          : SizedBox(
              width: dialogWidth,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // ── Sync ──
                    _buildSyncSection(theme),

                    const Divider(height: 32),

                    // ── Identity ──
                    _buildIdentitySection(theme),

                    const Divider(height: 32),

                    // ── Drives ──
                    _buildDrivesSection(theme),
                  ],
                ),
              ),
            ),
      actions: [
        TextButton(
          onPressed: _signOut,
          style: TextButton.styleFrom(foregroundColor: Colors.red),
          child: const Text('Sign out'),
        ),
        const Spacer(),
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('Done'),
        ),
      ],
    );
  }

  // ── Sync Section ──────────────────────────────────────────────────────

  Widget _buildSyncSection(ThemeData theme) {
    final isOnline = _peerId != null;
    final isSynced = _lastSyncCount != null;
    final isBusy = _syncing || _discovering || _peerStarting;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _sectionTitle('Sync'),

        // This device
        _deviceCard(
          theme,
          icon: Icons.phone_android,
          title: _deviceName.isNotEmpty ? _deviceName : 'This device',
          onTitleTap: () async {
            final controller = TextEditingController(text: _deviceName);
            final newName = await showDialog<String>(
              context: context,
              builder: (ctx) => AlertDialog(
                title: const Text('Device name'),
                content: TextField(
                  controller: controller,
                  autofocus: true,
                  decoration: const InputDecoration(
                    hintText: 'Enter device name',
                    border: OutlineInputBorder(),
                  ),
                  onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
                ),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(ctx),
                      child: const Text('Cancel')),
                  TextButton(
                    onPressed: () => Navigator.pop(ctx, controller.text.trim()),
                    child: const Text('Save'),
                  ),
                ],
              ),
            );
            if (newName != null && newName.isNotEmpty) {
              await AtomicClient.setDeviceName(newName);
              setState(() => _deviceName = newName);
            }
          },
          status:
              isOnline ? 'Online' : (_peerStarting ? 'Starting...' : 'Offline'),
          statusColor:
              isOnline ? Colors.green : theme.colorScheme.onSurfaceVariant,
          details: [
            if (_peerId != null)
              _miniDetail('Device ID', '${_peerId!.substring(0, 16)}...',
                  onCopy: () => _copyToClipboard(_peerId!, 'Device ID')),
            if (_activeDrive != null)
              _miniDetail(
                  'Drive',
                  _driveNames[_activeDrive]?.isNotEmpty == true
                      ? _driveNames[_activeDrive]!
                      : '${_activeDrive!.substring(0, 16)}...'),
          ],
        ),

        const SizedBox(height: 12),

        const SizedBox(height: 12),
        // Advanced / Offline Sync (demoted)
        Theme(
          data: theme.copyWith(dividerColor: Colors.transparent),
          child: ExpansionTile(
            title: Text('Offline Sync & Pairing',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: theme.colorScheme.onSurfaceVariant,
                )),
            tilePadding: EdgeInsets.zero,
            dense: true,
            children: [
              // QR pairing button
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  icon: const Icon(Icons.qr_code_2, size: 18),
                  label: const Text('Pair with QR Code'),
                  onPressed: () async {
                    final count = await PairScreen.show(context);
                    if (count != null) {
                      await _loadData();
                    }
                  },
                ),
              ),

              const SizedBox(height: 16),

              // Peers header
              Row(
                children: [
                  Text('Direct Peers',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: theme.colorScheme.onSurfaceVariant,
                      )),
                  const Spacer(),
                  if (isOnline && !isBusy)
                    TextButton.icon(
                      icon: const Icon(Icons.refresh, size: 14),
                      label:
                          const Text('Retry', style: TextStyle(fontSize: 11)),
                      style: TextButton.styleFrom(
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                        minimumSize: const Size(0, 0),
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      ),
                      onPressed: _discoverAndSync,
                    ),
                ],
              ),
              const SizedBox(height: 8),

              // Known peers list
              if (_knownPeers.isEmpty)
                _peerStatusRow(theme, Icons.devices, 'No paired devices yet',
                    theme.colorScheme.onSurfaceVariant)
              else
                ..._knownPeers.map((peer) {
                  final nodeId = peer['node_id'] ?? '';
                  final name = peer['name'] ?? '';
                  final label = name.isNotEmpty
                      ? name
                      : '${nodeId.substring(0, nodeId.length.clamp(0, 16))}...';
                  final isLive = AtomicClient.isLivePeer(nodeId, _livePeerIds);
                  return Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Row(
                      children: [
                        Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(
                            color: isLive
                                ? Colors.green
                                : theme.colorScheme.onSurfaceVariant
                                    .withOpacity(0.3),
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            label,
                            style: TextStyle(
                              fontSize: 12,
                              color: isLive
                                  ? theme.colorScheme.onSurface
                                  : theme.colorScheme.onSurfaceVariant,
                            ),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        if (isOnline && !isBusy)
                          TextButton(
                            style: TextButton.styleFrom(
                              padding:
                                  const EdgeInsets.symmetric(horizontal: 6),
                              minimumSize: const Size(0, 0),
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ),
                            onPressed: () async {
                              setState(() {
                                _syncing = true;
                                _syncResult = null;
                              });
                              try {
                                final count =
                                    await AtomicClient.peerSync(nodeId);
                                setState(() {
                                  _syncResult = 'Synced $count resources';
                                  _lastSyncCount = count;
                                  _lastSyncTime = DateTime.now();
                                  _syncing = false;
                                });
                                await _loadData();
                              } catch (e) {
                                setState(() {
                                  _syncResult = 'Error: $e';
                                  _syncing = false;
                                });
                              }
                            },
                            child: const Text('Sync',
                                style: TextStyle(fontSize: 11)),
                          ),
                        IconButton(
                          icon: const Icon(Icons.close, size: 14),
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints(),
                          onPressed: () async {
                            await AtomicClient.removeKnownPeer(nodeId);
                            setState(() => _knownPeers
                                .removeWhere((p) => p['node_id'] == nodeId));
                          },
                        ),
                      ],
                    ),
                  );
                }),

              // Sync result
              if (isBusy)
                _peerStatusRow(
                    theme, Icons.sync, 'Syncing...', theme.colorScheme.primary,
                    isLoading: true)
              else if (isSynced)
                _peerStatusRow(
                    theme,
                    Icons.check_circle,
                    'Synced $_lastSyncCount resources (${_timeAgo(_lastSyncTime!)})',
                    Colors.green)
              else if (_syncResult != null && _syncResult!.startsWith('Error'))
                _peerStatusRow(
                    theme, Icons.error_outline, _syncResult!, Colors.red),

              const SizedBox(height: 12),

              // Manual connect
              if (isOnline) ...[
                if (!_showAddPeer)
                  TextButton.icon(
                    icon: const Icon(Icons.add, size: 14),
                    label: const Text('Connect manually',
                        style: TextStyle(fontSize: 12)),
                    style: TextButton.styleFrom(
                      foregroundColor: theme.colorScheme.onSurfaceVariant,
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                    ),
                    onPressed: () => setState(() => _showAddPeer = true),
                  )
                else ...[
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _peerController,
                          autofocus: true,
                          decoration: const InputDecoration(
                            hintText: 'Paste device ID',
                            border: OutlineInputBorder(),
                            isDense: true,
                            contentPadding: EdgeInsets.symmetric(
                                horizontal: 12, vertical: 10),
                          ),
                          onSubmitted: (_) => _syncWithPeer(),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton(
                        icon: _syncing
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child:
                                    CircularProgressIndicator(strokeWidth: 2))
                            : const Icon(Icons.sync, size: 20),
                        onPressed: _syncing ? null : _syncWithPeer,
                      ),
                      IconButton(
                        icon: const Icon(Icons.close, size: 20),
                        onPressed: () => setState(() => _showAddPeer = false),
                      ),
                    ],
                  ),
                  if (_syncResult != null && _syncResult!.startsWith('Error'))
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(_syncResult!,
                          style:
                              const TextStyle(fontSize: 11, color: Colors.red)),
                    ),
                ],
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _deviceCard(
    ThemeData theme, {
    required IconData icon,
    required String title,
    required String status,
    required Color statusColor,
    List<Widget> details = const [],
    VoidCallback? onTitleTap,
  }) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest.withOpacity(0.3),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
            color: theme.colorScheme.outlineVariant.withOpacity(0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 20, color: theme.colorScheme.onSurface),
              const SizedBox(width: 8),
              GestureDetector(
                onTap: onTitleTap,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(title,
                        style: const TextStyle(
                            fontSize: 13, fontWeight: FontWeight.w600)),
                    if (onTitleTap != null) ...[
                      const SizedBox(width: 4),
                      Icon(Icons.edit,
                          size: 12, color: theme.colorScheme.onSurfaceVariant),
                    ],
                  ],
                ),
              ),
              const Spacer(),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: statusColor.withOpacity(0.1),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(status,
                    style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w600,
                        color: statusColor)),
              ),
            ],
          ),
          if (details.isNotEmpty) ...[
            const SizedBox(height: 8),
            ...details,
          ],
        ],
      ),
    );
  }

  Widget _miniDetail(String label, String value, {VoidCallback? onCopy}) {
    return Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Row(
        children: [
          SizedBox(
            width: 65,
            child: Text(label,
                style: TextStyle(
                    fontSize: 11,
                    color: Theme.of(context).colorScheme.onSurfaceVariant)),
          ),
          Expanded(
            child: Text(value,
                style: const TextStyle(fontSize: 11),
                overflow: TextOverflow.ellipsis),
          ),
          if (onCopy != null)
            GestureDetector(
              onTap: onCopy,
              child: Text('Copy',
                  style: TextStyle(
                      fontSize: 10,
                      color: Theme.of(context).colorScheme.primary)),
            ),
        ],
      ),
    );
  }

  Widget _peerStatusRow(
      ThemeData theme, IconData icon, String text, Color color,
      {bool isLoading = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          if (isLoading)
            SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 2, color: color))
          else
            Icon(icon, size: 16, color: color),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text,
                style: TextStyle(fontSize: 12, color: color), softWrap: true),
          ),
        ],
      ),
    );
  }

  // ── Identity Section ─────────────────────────────────────────────────

  Widget _buildIdentitySection(ThemeData theme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _sectionTitle('Identity'),
        if (_agent != null) ...[
          _miniDetail('Name', _agent!.name ?? 'Anonymous'),
          _miniDetail('DID', '${_agent!.subject.substring(0, 24)}...',
              onCopy: () => _copyToClipboard(_agent!.subject, 'DID')),
          const SizedBox(height: 4),
          OutlinedButton.icon(
            icon: const Icon(Icons.key, size: 14),
            label: const Text('Copy Secret', style: TextStyle(fontSize: 12)),
            onPressed: () => _copyToClipboard(_agent!.secret, 'Secret'),
          ),
        ] else
          Text('No agent',
              style: TextStyle(
                  fontSize: 13,
                  color: Theme.of(context).colorScheme.onSurfaceVariant)),
      ],
    );
  }

  // ── Drives Section ───────────────────────────────────────────────────

  Widget _buildDrivesSection(ThemeData theme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _sectionTitle('Drives'),
        if (_drives.isEmpty)
          Text('No drives',
              style: TextStyle(
                  fontSize: 13,
                  color: Theme.of(context).colorScheme.onSurfaceVariant))
        else
          ..._drives.map((d) => _driveTile(d)),
        if (_showNewDrive) ...[
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _newDriveController,
                  autofocus: true,
                  decoration: const InputDecoration(
                    hintText: 'Drive name',
                    border: OutlineInputBorder(),
                    isDense: true,
                    contentPadding:
                        EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  ),
                  onSubmitted: (_) => _createDrive(),
                ),
              ),
              const SizedBox(width: 8),
              IconButton(
                icon: _creatingDrive
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.check, size: 20),
                onPressed: _creatingDrive ? null : _createDrive,
              ),
              IconButton(
                icon: const Icon(Icons.close, size: 20),
                onPressed: () => setState(() => _showNewDrive = false),
              ),
            ],
          ),
        ] else
          TextButton.icon(
            icon: const Icon(Icons.add, size: 14),
            label: const Text('New drive', style: TextStyle(fontSize: 12)),
            style: TextButton.styleFrom(
              foregroundColor: Theme.of(context).colorScheme.onSurfaceVariant,
              padding: const EdgeInsets.symmetric(horizontal: 4),
            ),
            onPressed: () => setState(() => _showNewDrive = true),
          ),
      ],
    );
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  Widget _driveTile(String drive) {
    final isActive = drive == _activeDrive;
    final name = _driveNames[drive];
    final label = (name != null && name.isNotEmpty)
        ? name
        : (drive.length > 30
            ? '${drive.substring(0, 12)}...${drive.substring(drive.length - 8)}'
            : drive);
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: Icon(
        isActive ? Icons.check_circle : Icons.circle_outlined,
        color: isActive ? Theme.of(context).colorScheme.primary : Colors.grey,
        size: 20,
      ),
      title: Text(label, style: const TextStyle(fontSize: 13)),
      onTap: () => _switchDrive(drive),
    );
  }

  Widget _sectionTitle(String title) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(
        title,
        style: TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w600,
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }

  String _timeAgo(DateTime time) {
    final diff = DateTime.now().difference(time);
    if (diff.inSeconds < 10) return 'just now';
    if (diff.inSeconds < 60) return '${diff.inSeconds}s ago';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    return '${diff.inHours}h ago';
  }
}
