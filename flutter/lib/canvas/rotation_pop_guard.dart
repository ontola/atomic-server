/// Android re-registers the predictive-back callback when window metrics
/// change. That can fire [PopScope.onPopInvokedWithResult] as if the user
/// pressed back, which would dump an open canvas back to the gallery on
/// rotation. Ignore pops for a short window after a metrics / size change.
class RotationPopGuard {
  RotationPopGuard({
    DateTime Function()? now,
    this.window = const Duration(milliseconds: 600),
  }) : _now = now ?? DateTime.now;

  final DateTime Function() _now;
  final Duration window;
  DateTime? _metricsChangedAt;

  void onMetricsChanged() {
    _metricsChangedAt = _now();
  }

  bool get shouldIgnorePop {
    final changedAt = _metricsChangedAt;
    if (changedAt == null) return false;
    return _now().difference(changedAt) < window;
  }
}
