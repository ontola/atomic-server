import 'package:atomic_flutter/atomic_flutter.dart' show AppColorsExt;
import 'package:flutter/material.dart';

import 'meeting_call.dart';

/// The running call over the whole app: a small tile that can be dragged
/// (tap it to expand), or the whole screen. One [Stack] child that stays where
/// it is in the tree between the two, so the call's web view is moved and
/// resized, never made again.
class MeetingCallOverlay extends StatelessWidget {
  final MeetingCall call;

  const MeetingCallOverlay({super.key, required this.call});

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: call,
        builder: (context, _) => call.active
            ? _CallView(call: call)
            : const Positioned(
                left: 0, top: 0, width: 0, height: 0, child: SizedBox()),
      );
}

const _margin = 12.0;

class _CallView extends StatelessWidget {
  final MeetingCall call;

  const _CallView({required this.call});

  /// The tile: 112 dp wide on a phone, 168 on a tablet, 3:4.
  static Size tileSize(Size room) {
    final width = room.shortestSide >= 600 ? 168.0 : 112.0;
    return Size(width, width * 4 / 3);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.appColors;
    final room = MediaQuery.sizeOf(context);
    final pad = MediaQuery.paddingOf(context);
    final Rect rect;
    final full = call.expanded;
    if (full) {
      rect = Offset.zero & room;
    } else {
      final size = tileSize(room);
      // By default under the top bar, on the right.
      final wanted = call.tileOffset ??
          Offset(room.width - size.width - _margin - pad.right, pad.top + 64.0);
      final left = wanted.dx
          .clamp(
              _margin + pad.left, room.width - size.width - _margin - pad.right)
          .toDouble();
      final top = wanted.dy
          .clamp(pad.top + _margin,
              room.height - size.height - _margin - pad.bottom)
          .toDouble();
      rect = Offset(left, top) & size;
    }
    final page = call.page;
    return Positioned.fromRect(
      rect: rect,
      child: Material(
        key: const ValueKey('meeting-call'),
        elevation: full ? 0 : 8,
        color: c.bgBody,
        shadowColor: c.panelShadow,
        borderRadius: BorderRadius.circular(full ? 0 : 12),
        clipBehavior: Clip.antiAlias,
        child: Stack(fit: StackFit.expand, children: [
          // Full screen, the page stays clear of the status bar and the
          // gesture bar.
          Padding(
            padding: full ? pad : EdgeInsets.zero,
            child: page == null
                ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                : page.build(),
          ),
          if (!call.expanded)
            // The tile is not for touching the page: a tap expands it and a
            // drag moves it.
            Positioned.fill(
              child: GestureDetector(
                key: const ValueKey('meeting-call-tile'),
                behavior: HitTestBehavior.opaque,
                onTap: call.expand,
                onPanUpdate: (d) => call.moveTile(rect.topLeft + d.delta),
              ),
            ),
          Positioned(
            top: full ? pad.top + 8 : 2,
            right: full ? pad.right + 8 : 2,
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              if (call.expanded)
                _RoundButton(
                  key: const ValueKey('meeting-call-collapse'),
                  tooltip: 'Minimize call',
                  icon: Icons.close_fullscreen,
                  onPressed: call.collapse,
                ),
              _RoundButton(
                key: const ValueKey('meeting-call-leave'),
                tooltip: 'Leave call',
                icon: Icons.call_end,
                color: c.alert,
                onPressed: call.leave,
              ),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _RoundButton extends StatelessWidget {
  final String tooltip;
  final IconData icon;
  final Color? color;
  final VoidCallback onPressed;

  const _RoundButton({
    super.key,
    required this.tooltip,
    required this.icon,
    this.color,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.all(2),
        child: Material(
          color: color ?? Colors.black54,
          shape: const CircleBorder(),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: onPressed,
            child: Tooltip(
              message: tooltip,
              child: Padding(
                padding: const EdgeInsets.all(6),
                child: Icon(icon, size: 16, color: Colors.white),
              ),
            ),
          ),
        ),
      );
}
