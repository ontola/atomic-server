import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

/// The last laid-out height of a [MeasuredSize], readable by anyone,
/// including while a scrollable lays out (when reading another box's size is
/// not allowed).
class SizeMeter {
  /// Null while no [MeasuredSize] with this meter is laid out.
  double? height;

  RenderObject? _owner;
}

/// Records its own height in [meter] each time it is laid out. Reading a
/// child's size in your own layout is allowed, so this is the one place the
/// height of a list row can be had without touching the row from outside.
class MeasuredSize extends SingleChildRenderObjectWidget {
  const MeasuredSize({super.key, required this.meter, super.child});

  final SizeMeter meter;

  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderMeasuredSize(meter);

  @override
  void updateRenderObject(
      BuildContext context, covariant _RenderMeasuredSize renderObject) {
    renderObject.meter = meter;
  }
}

class _RenderMeasuredSize extends RenderProxyBox {
  _RenderMeasuredSize(this._meter);

  SizeMeter _meter;
  set meter(SizeMeter value) {
    if (identical(value, _meter)) return;
    _release();
    _meter = value;
    if (hasSize) _record();
  }

  void _record() {
    _meter
      ..height = size.height
      .._owner = this;
  }

  void _release() {
    if (identical(_meter._owner, this)) {
      _meter
        ..height = null
        .._owner = null;
    }
  }

  @override
  void performLayout() {
    super.performLayout();
    _record();
  }

  @override
  void detach() {
    _release();
    super.detach();
  }
}
