import 'package:flutter/material.dart';
import '../models/stroke_data.dart';
import '../theme.dart';

class HistoryScrubberOverlay extends StatelessWidget {
  final int actionIndex;
  final int totalActions;
  final List<DiscardedBranch> branches;
  final DiscardedBranch? previewBranch;
  final ValueChanged<DiscardedBranch> onBranchHover;
  final VoidCallback onBranchHoverEnd;
  final ValueChanged<DiscardedBranch> onBranchTap;

  const HistoryScrubberOverlay({
    super.key,
    required this.actionIndex,
    required this.totalActions,
    required this.branches,
    required this.previewBranch,
    required this.onBranchHover,
    required this.onBranchHoverEnd,
    required this.onBranchTap,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.appColors;
    return Stack(
      children: [
        // Bottom progress bar
        Positioned(
          left: 80,
          right: branches.isNotEmpty ? 92 : 24,
          bottom: 96,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
            decoration: BoxDecoration(
              color: c.panelBg.withOpacity(0.92),
              borderRadius: BorderRadius.circular(20),
              boxShadow: [BoxShadow(color: c.panelShadow, blurRadius: 8)],
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'Step $actionIndex / $totalActions',
                  style: TextStyle(fontSize: 12, color: c.textSecondary),
                ),
                const SizedBox(height: 8),
                ClipRRect(
                  borderRadius: BorderRadius.circular(3),
                  child: LinearProgressIndicator(
                    value: totalActions > 0 ? actionIndex / totalActions : 0,
                    backgroundColor: c.surfaceDim,
                    valueColor: AlwaysStoppedAnimation(c.dot),
                    minHeight: 6,
                  ),
                ),
              ],
            ),
          ),
        ),

        // Right-side branches panel
        if (branches.isNotEmpty)
          Positioned(
            right: 8,
            top: 80,
            bottom: 80,
            width: 80,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Text('Branches',
                      style: TextStyle(fontSize: 10, color: c.textSecondary)),
                ),
                Expanded(
                  child: ListView.separated(
                    itemCount: branches.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 8),
                    itemBuilder: (context, i) {
                      final branch = branches[i];
                      final isPreviewing = previewBranch?.id == branch.id;
                      return Listener(
                        onPointerDown: (_) => onBranchHover(branch),
                        onPointerUp: (_) => onBranchTap(branch),
                        child: MouseRegion(
                          onEnter: (_) => onBranchHover(branch),
                          onExit: (_) => onBranchHoverEnd(),
                          child: AnimatedContainer(
                            duration: const Duration(milliseconds: 150),
                            width: 72,
                            height: 72,
                            decoration: BoxDecoration(
                              borderRadius: BorderRadius.circular(14),
                              border: Border.all(
                                color: isPreviewing
                                    ? const Color(0xFF1976D2)
                                    : c.surfaceDim,
                                width: isPreviewing ? 2.5 : 1,
                              ),
                              boxShadow: isPreviewing
                                  ? [
                                      const BoxShadow(
                                          color: Color(0x331976D2),
                                          blurRadius: 8)
                                    ]
                                  : [],
                            ),
                            clipBehavior: Clip.hardEdge,
                            child: branch.thumbnail != null
                                ? RawImage(
                                    image: branch.thumbnail, fit: BoxFit.cover)
                                : Container(
                                    color: c.surfaceDim,
                                    child: Center(
                                        child: Text('…',
                                            style: TextStyle(
                                                color: c.iconDisabled))),
                                  ),
                          ),
                        ),
                      );
                    },
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
