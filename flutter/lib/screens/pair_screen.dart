import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../atomic/atomic_client.dart';

/// DID prefix for Iroh node identifiers.
const _nodeDidPrefix = 'did:ad:node:';

enum _Step { loading, showQr, syncing, done, error }

/// Parsed result from a QR code or DID URI.
class PeerInfo {
  final String nodeId;
  final String name;
  PeerInfo(this.nodeId, [this.name = '']);
}

class PairScreen extends StatefulWidget {
  /// If non-null, skip straight to syncing with this node ID (from deep link).
  final String? initialNodeId;

  const PairScreen({super.key, this.initialNodeId});

  static Future<int?> show(BuildContext context, {String? nodeId}) {
    return showDialog<int>(
      context: context,
      builder: (_) => PairScreen(initialNodeId: nodeId),
    );
  }

  /// Parse a QR code value into a PeerInfo.
  /// Formats: "did:ad:node:<hex>:<name>" or "did:ad:node:<hex>" or raw hex.
  static PeerInfo? parsePeerInfo(String input) {
    var value = input.trim();
    String name = '';

    if (value.startsWith(_nodeDidPrefix)) {
      value = value.substring(_nodeDidPrefix.length);
      // Check for :<name> suffix after the 64-char hex
      if (value.length > 64 && value[64] == ':') {
        name = Uri.decodeComponent(value.substring(65));
        value = value.substring(0, 64);
      }
    }
    if (value.startsWith('iroh:')) value = value.substring(5);
    if (RegExp(r'^[a-f0-9]{64}$').hasMatch(value)) {
      return PeerInfo(value, name);
    }
    return null;
  }

  /// Format a QR code value with optional device name.
  static String formatQrValue(String nodeId, String deviceName) {
    if (deviceName.isEmpty) return '$_nodeDidPrefix$nodeId';
    return '$_nodeDidPrefix$nodeId:${Uri.encodeComponent(deviceName)}';
  }

  /// Get the local device name from the OS.
  static Future<String> getDeviceName() async {
    try {
      const channel = MethodChannel('app.atomicdata.canvas/deeplink');
      final name = await channel.invokeMethod<String>('getDeviceName');
      return name ?? Platform.localHostname;
    } catch (_) {
      return Platform.localHostname;
    }
  }

  @override
  State<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends State<PairScreen> {
  _Step _step = _Step.loading;
  String? _myNodeId;
  String? _scannedNodeId;
  String? _scannedName;
  String? _error;
  int _syncCount = 0;
  bool _scanned = false;
  MobileScannerController? _scanController;
  String _deviceName = '';

  @override
  void initState() {
    super.initState();
    _loadDeviceName();
    _ensurePeerStarted();
  }

  void _loadDeviceName() async {
    // Prefer persisted name, fall back to OS name
    var name = await AtomicClient.getDeviceName();
    if (name.isEmpty) {
      name = await PairScreen.getDeviceName();
      if (name.isNotEmpty && name != 'localhost') {
        await AtomicClient.setDeviceName(name);
      }
    }
    if (mounted) setState(() => _deviceName = name);
  }

  @override
  void dispose() {
    _scanController?.dispose();
    super.dispose();
  }

  Future<void> _ensurePeerStarted() async {
    try {
      var nodeId = await AtomicClient.getPeerId();
      nodeId ??= await AtomicClient.startPeer();
      // Start camera immediately
      _scanController = MobileScannerController();
      setState(() {
        _myNodeId = nodeId;
        _step = _Step.showQr;
      });

      if (widget.initialNodeId != null) {
        _scannedNodeId = widget.initialNodeId;
        _doSync(widget.initialNodeId!);
      }
    } catch (e) {
      setState(() {
        _error = 'Failed to start peer: $e';
        _step = _Step.error;
      });
    }
  }

  void _onDetect(BarcodeCapture capture) {
    if (_scanned) return;
    final barcode = capture.barcodes.firstOrNull;
    if (barcode == null || barcode.rawValue == null) return;

    final peer = PairScreen.parsePeerInfo(barcode.rawValue!);
    if (peer == null) return;

    _scanned = true;
    _scanController?.stop();
    _scannedNodeId = peer.nodeId;
    _scannedName = peer.name;
    _doSync(peer.nodeId, peer.name);
  }

  Future<void> _doSync(String nodeId, [String name = '']) async {
    if (!mounted) return;
    setState(() {
      _step = _Step.syncing;
      _error = null;
    });
    try {
      final count = await AtomicClient.peerSync(nodeId);
      await AtomicClient.addKnownPeer(nodeId, name);
      if (!mounted) return;
      setState(() {
        _syncCount = count;
        _step = _Step.done;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _step = _Step.error;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final screenWidth = MediaQuery.of(context).size.width;
    final isPhone = screenWidth < 600;

    return AlertDialog(
      insetPadding: EdgeInsets.symmetric(
        horizontal: isPhone ? 16 : 40,
        vertical: 24,
      ),
      content: SizedBox(
        width: isPhone ? screenWidth * 0.85 : 360.0,
        child: AnimatedSwitcher(
          duration: const Duration(milliseconds: 200),
          child: _buildStep(theme),
        ),
      ),
      actions: _buildActions(theme),
    );
  }

  List<Widget> _buildActions(ThemeData theme) {
    switch (_step) {
      case _Step.loading:
      case _Step.syncing:
        return [];
      case _Step.showQr:
        return [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
        ];
      case _Step.done:
        return [
          FilledButton(
            onPressed: () => Navigator.pop(context, _syncCount),
            child: const Text('Done'),
          ),
        ];
      case _Step.error:
        return [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          const SizedBox(width: 16),
          TextButton(
            onPressed: () {
              if (_scannedNodeId != null) {
                _doSync(_scannedNodeId!, _scannedName ?? '');
              } else {
                setState(() => _step = _Step.showQr);
              }
            },
            child: const Text('Retry'),
          ),
        ];
    }
  }

  Widget _buildStep(ThemeData theme) {
    switch (_step) {
      case _Step.loading:
        return const SizedBox(
          key: ValueKey('loading'),
          height: 200,
          child: Center(child: CircularProgressIndicator()),
        );

      case _Step.showQr:
        final qrData = PairScreen.formatQrValue(_myNodeId!, _deviceName);
        return Column(
          key: const ValueKey('qr'),
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Pair Device', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(
              'Show your QR or scan theirs',
              style: TextStyle(
                  fontSize: 13, color: theme.colorScheme.onSurfaceVariant),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 12),
            // QR code
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(10),
              ),
              child: QrImageView(
                data: qrData,
                version: QrVersions.auto,
                size: 180,
                backgroundColor: Colors.white,
              ),
            ),
            const SizedBox(height: 6),
            if (_deviceName.isNotEmpty)
              Text(_deviceName,
                  style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: theme.colorScheme.onSurface)),
            const SizedBox(height: 8),
            // Camera scanner (compact)
            if (_scanController != null)
              SizedBox(
                height: 100,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: MobileScanner(
                    controller: _scanController!,
                    onDetect: _onDetect,
                  ),
                ),
              ),
          ],
        );

      case _Step.syncing:
        final label = (_scannedName != null && _scannedName!.isNotEmpty)
            ? _scannedName!
            : '${_scannedNodeId!.substring(0, 12)}...';
        return SizedBox(
          key: const ValueKey('syncing'),
          height: 200,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const CircularProgressIndicator(),
              const SizedBox(height: 16),
              Text(
                'Connecting to $label',
                style: TextStyle(
                    fontSize: 13, color: theme.colorScheme.onSurfaceVariant),
              ),
            ],
          ),
        );

      case _Step.done:
        final label = (_scannedName != null && _scannedName!.isNotEmpty)
            ? _scannedName!
            : 'device';
        return Column(
          key: const ValueKey('done'),
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.check_circle, color: Colors.green, size: 48),
            const SizedBox(height: 12),
            Text('Paired with $label', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(
              'Synced $_syncCount resource${_syncCount != 1 ? 's' : ''}',
              style: TextStyle(
                  fontSize: 13, color: theme.colorScheme.onSurfaceVariant),
            ),
          ],
        );

      case _Step.error:
        return Column(
          key: const ValueKey('error'),
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, color: Colors.red, size: 48),
            const SizedBox(height: 12),
            Text('Connection Failed', style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(
              _error ?? 'Unknown error',
              style: const TextStyle(fontSize: 12, color: Colors.red),
              textAlign: TextAlign.center,
            ),
          ],
        );
    }
  }
}
