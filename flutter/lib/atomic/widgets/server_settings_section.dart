/// Server settings: which server this device syncs through, and what it costs.
///
/// A sync hub is optional here — the data lives locally and syncs peer-to-peer
/// just as well — so "no server" is a first-class state, not an error.
///
/// Mirrors the data-browser's Sync page: one stable list, the active server
/// marked rather than moved (a list that reorders under the finger that tapped
/// it is a bad list), URLs that do not demand a scheme, and the node's own
/// account of itself read from `/server`.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../atomic_auth.dart';
import '../atomic_client.dart';
import '../server_info.dart';
import '../server_url.dart';
import '../session.dart';

class ServerSettingsSection extends StatefulWidget {
  const ServerSettingsSection({super.key, this.onServerChanged});

  /// Called after the active server changes, so the host can reload whatever
  /// it read from the old one.
  final VoidCallback? onServerChanged;

  @override
  State<ServerSettingsSection> createState() => _ServerSettingsSectionState();
}

class _ServerSettingsSectionState extends State<ServerSettingsSection> {
  List<String> _servers = [];
  String? _active;
  ServerInfo _info = ServerInfo.unknown;
  DriveUsage? _usage;
  bool _loading = true;
  bool _busy = false;
  bool _showAdd = false;
  String? _error;
  final _addController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _addController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final servers = await AtomicSession.knownServers();
    final active = await AtomicSession.activeServer();

    if (!mounted) return;

    setState(() {
      _servers = servers;
      _active = active;
      _loading = false;
    });

    await _loadActiveDetails();
  }

  /// The active node's own account of itself, plus what this drive costs there.
  /// Both are best-effort: an unreachable server is a normal state to be in.
  Future<void> _loadActiveDetails() async {
    final active = _active;

    if (active == null) {
      if (mounted) setState(() => _info = ServerInfo.unknown);

      return;
    }

    final info = await fetchServerInfo(active);

    if (!mounted) return;

    setState(() => _info = info);

    // Usage is a signed read, so there is nothing to ask without an agent.
    final session = await AtomicSession.load();

    if (session == null) return;

    final drive = AtomicClient.getActiveDrive() ?? session.drive;

    if (drive == null) return;

    final usage = await fetchDriveUsage(
      active,
      drive,
      AtomicAgent.fromSecret(session.secret),
    );

    if (mounted) setState(() => _usage = usage);
  }

  Future<void> _switchTo(String url) async {
    setState(() {
      _busy = true;
      _error = null;
      _usage = null;
      _info = ServerInfo.unknown;
    });

    try {
      await AtomicClient.closeWsSync();
      await AtomicSession.setActiveServer(url);
      await AtomicClient.openWsSync(url);

      if (!mounted) return;

      setState(() => _active = normalizeServerUrl(url));
      widget.onServerChanged?.call();
      await _loadActiveDetails();
    } catch (e) {
      // The server stays selected: it is the one the session now points at, and
      // saying so beats silently snapping back to the old one.
      if (mounted) setState(() => _error = 'Could not connect: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _add() async {
    final url = normalizeServerUrl(_addController.text);

    if (url.isEmpty) return;

    await AtomicSession.addKnownServer(url);
    _addController.clear();

    if (!mounted) return;

    setState(() => _showAdd = false);

    // First server added is the one to use — nothing to choose between.
    if (_active == null) {
      await _switchTo(url);
      await _load();

      return;
    }

    await _load();
  }

  /// Offer this device's workspace to the active server.
  ///
  /// Connecting alone does not do this: a drive made here before any server was
  /// connected has never been pushed, so it exists nowhere else — and a browser
  /// signed in as the same account still sees nothing, because a browser reads
  /// from a server rather than syncing with devices.
  Future<void> _pushWorkspace() async {
    final active = _active;

    if (active == null || _busy) return;

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final pushed = await AtomicClient.syncDriveToServer(active);

      if (!mounted) return;

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            pushed == 0
                ? 'Already up to date'
                : 'Synced $pushed ${pushed == 1 ? 'resource' : 'resources'} to ${serverLabel(active)}',
          ),
        ),
      );

      await _loadActiveDetails();
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _remove(String url) async {
    final wasActive = sameOrigin(url, _active);

    if (wasActive) {
      await AtomicClient.closeWsSync();
    }

    await AtomicSession.removeKnownServer(url);

    if (wasActive) widget.onServerChanged?.call();

    await _load();
  }

  void _copy(String text, String label) {
    Clipboard.setData(ClipboardData(text: text));
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('$label copied'), duration: const Duration(seconds: 2)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    if (_loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 16),
        child: Center(child: CircularProgressIndicator()),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Text(
            'Devices',
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ),
        if (_servers.isEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              'No always-on device yet. This device syncs directly with your others.',
              style: TextStyle(
                fontSize: 12,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        for (final server in _servers) _serverCard(theme, server),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              _error!,
              style: const TextStyle(fontSize: 12, color: Colors.red),
            ),
          ),
        if (_showAdd) _addField(theme) else _addButton(),
      ],
    );
  }

  Widget _serverCard(ThemeData theme, String server) {
    final isActive = sameOrigin(server, _active);
    final scheme = theme.colorScheme;

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(8),
        color: isActive ? scheme.primaryContainer.withValues(alpha: 0.3) : null,
        border: Border.all(
          color: isActive ? scheme.primary : scheme.outlineVariant,
          width: isActive ? 1.5 : 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                isActive ? Icons.cloud_done : Icons.cloud_outlined,
                size: 18,
                color: isActive ? scheme.primary : scheme.onSurfaceVariant,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  serverLabel(server),
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: isActive ? FontWeight.w600 : FontWeight.normal,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (isActive)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: scheme.primary,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    'In use',
                    style: TextStyle(fontSize: 10, color: scheme.onPrimary),
                  ),
                ),
            ],
          ),
          if (isActive) ..._activeDetails(theme),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              if (isActive)
                TextButton(
                  onPressed: _busy ? null : _pushWorkspace,
                  child: const Text(
                    'Sync workspace here',
                    style: TextStyle(fontSize: 12),
                  ),
                ),
              if (!isActive)
                TextButton(
                  onPressed: _busy ? null : () => _switchTo(server),
                  child: const Text('Switch to this', style: TextStyle(fontSize: 12)),
                ),
              TextButton(
                onPressed: _busy ? null : () => _remove(server),
                style: TextButton.styleFrom(foregroundColor: Colors.red),
                child: const Text('Remove', style: TextStyle(fontSize: 12)),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// What the active node says about itself. Absent facts are simply not shown:
  /// a node with no peer-to-peer transport has no node id, which is not a fault.
  List<Widget> _activeDetails(ThemeData theme) {
    final scheme = theme.colorScheme;
    final labelStyle = TextStyle(fontSize: 11, color: scheme.onSurfaceVariant);

    if (_busy) {
      return const [
        SizedBox(height: 8),
        SizedBox(
          height: 2,
          child: LinearProgressIndicator(),
        ),
      ];
    }

    return [
      const SizedBox(height: 6),
      if (_info.version != null)
        Text('atomic-server ${_info.version}', style: labelStyle)
      else
        Text('Not reachable', style: labelStyle.copyWith(color: Colors.orange)),
      if (_info.nodeId != null) ...[
        const SizedBox(height: 4),
        InkWell(
          onTap: () => _copy(_info.nodeId!, 'Node ID'),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  _info.nodeId!,
                  style: const TextStyle(fontSize: 10, fontFamily: 'monospace'),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Icon(Icons.copy, size: 12, color: scheme.onSurfaceVariant),
            ],
          ),
        ),
      ],
      if (_usage != null) ...[
        const SizedBox(height: 6),
        Text(
          '${_usage!.resourceCount} resources · ${formatBytes(_usage!.totalBytes)}',
          style: labelStyle,
        ),
        if (_usage!.blobBytes > 0)
          Text(
            'files ${formatBytes(_usage!.blobBytes)} · edits ${formatBytes(_usage!.loroBytes)}',
            style: labelStyle.copyWith(fontSize: 10),
          ),
      ],
    ];
  }

  Widget _addButton() {
    return TextButton.icon(
      onPressed: () => setState(() => _showAdd = true),
      icon: const Icon(Icons.add, size: 16),
      label: const Text('Connect an always-on device', style: TextStyle(fontSize: 12)),
      style: TextButton.styleFrom(padding: EdgeInsets.zero),
    );
  }

  Widget _addField(ThemeData theme) {
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _addController,
              autofocus: true,
              decoration: const InputDecoration(
                hintText: 'localhost:9883',
                border: OutlineInputBorder(),
                isDense: true,
              ),
              keyboardType: TextInputType.url,
              autocorrect: false,
              onSubmitted: (_) => _add(),
            ),
          ),
          const SizedBox(width: 8),
          TextButton(
            onPressed: _add,
            child: const Text('Add'),
          ),
          TextButton(
            onPressed: () => setState(() {
              _showAdd = false;
              _addController.clear();
            }),
            child: const Text('Cancel'),
          ),
        ],
      ),
    );
  }
}
