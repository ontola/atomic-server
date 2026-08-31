import 'package:flutter/material.dart';
import 'rotation_pop_guard.dart';

/// Back-to-gallery for the canvas, without treating a screen rotation as
/// a back press. See [RotationPopGuard].
class CanvasPopScope extends StatefulWidget {
  const CanvasPopScope({
    super.key,
    required this.onClose,
    required this.child,
    this.guard,
  });

  final VoidCallback onClose;
  final Widget child;
  final RotationPopGuard? guard;

  @override
  State<CanvasPopScope> createState() => _CanvasPopScopeState();
}

class _CanvasPopScopeState extends State<CanvasPopScope>
    with WidgetsBindingObserver {
  late final RotationPopGuard _guard;
  Size? _lastSize;

  @override
  void initState() {
    super.initState();
    _guard = widget.guard ?? RotationPopGuard();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeMetrics() {
    _guard.onMetricsChanged();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final size = MediaQuery.sizeOf(context);
    if (_lastSize != null && _lastSize != size) {
      _guard.onMetricsChanged();
    }
    _lastSize = size;
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop || _guard.shouldIgnorePop) return;
        widget.onClose();
      },
      child: widget.child,
    );
  }
}
