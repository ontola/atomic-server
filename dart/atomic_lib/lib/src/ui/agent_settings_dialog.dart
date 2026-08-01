import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../atomic_client.dart';
import '../session.dart';
import 'pair_screen.dart';
import 'error_snack.dart';
import 'server_settings_section.dart';

/// Opens account / workspace / sync settings.
Future<bool> showAgentSettings(BuildContext context) =>
    AgentSettingsDialog.show(context);

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
  String? _peerId;
  // The peer never starts from this dialog anymore (pairing is its own screen),
  // but the "This device" card still reads it as an online/starting hint.
  final bool _peerStarting = false;
  String _deviceName = '';
  final _newDriveController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _loadData();
    _loadDeviceName();
  }

  @override
  void dispose() {
    _newDriveController.dispose();
    super.dispose();
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

    setState(() {
      _agent = agent;
      _drives = drives;
      _driveNames = names;
      _activeDrive = activeDrive;
      _peerId = peerId;
      _loading = false;
    });
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
      if (mounted) showErrorSnack(context, 'Failed to create drive: $e');
    }
    setState(() => _creatingDrive = false);
  }

  Future<void> _switchDrive(String drive) async {
    try {
      await AtomicClient.setActiveDrive(drive);
      await AtomicSession.saveDrive(drive);
      setState(() => _activeDrive = drive);
    } catch (e) {
      if (mounted) showErrorSnack(context, 'Failed to switch drive: $e');
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
                    // This device, then the devices it syncs with, then the
                    // code to add another — the same order as the browser Sync
                    // page. A server is one of those devices (an always-on
                    // one), not a category of its own.
                    _buildThisDeviceCard(theme),

                    const SizedBox(height: 16),

                    // ── Devices (servers + paired devices, incl. QR pairing) ──
                    ServerSettingsSection(onServerChanged: _loadData),

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

  /// This device, always shown first — the browser Sync page leads with the
  /// same card. It is the one device you are looking *from*.
  Widget _buildThisDeviceCard(ThemeData theme) {
    final isOnline = _peerId != null;

    return _deviceCard(
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
      status: isOnline ? 'Online' : (_peerStarting ? 'Starting...' : 'Offline'),
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
        color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.3),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
            color: theme.colorScheme.outlineVariant.withValues(alpha: 0.3)),
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
                  color: statusColor.withValues(alpha: 0.1),
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
}
