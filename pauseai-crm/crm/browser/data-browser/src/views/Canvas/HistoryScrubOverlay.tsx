import { useEffect, useRef, type JSX } from 'react';
import styled from 'styled-components';
import { drawCanvasStrokes } from './canvas-draw';
import type { DiscardedBranch, StrokeSnapshot } from './history-helpers';

interface HistoryScrubOverlayProps {
  /** Current position on the history timeline (0-based). */
  step: number;
  /** Total number of timeline states. */
  totalSteps: number;
  /** Recoverable discarded versions, oldest first. */
  branches: DiscardedBranch[];
  /** Branch currently under the pointer (highlighted + previewed). */
  hoveredBranchId: string | null;
  /**
   * True after a scrub release (grace window): tiles respond to their own
   * hover / click. While the undo button still owns the pointer capture
   * this is false and the page hit-tests tiles via `data-branch-id`.
   */
  interactive: boolean;
  darkMode: boolean;
  onBranchHover: (id: string | null) => void;
  onBranchPick: (id: string) => void;
}

/**
 * Overlay shown while holding / scrubbing the undo button, mirroring
 * Flutter's `HistoryScrubberOverlay`: a bottom progress bar with the
 * current step, plus a right-side column of discarded-version thumbnails
 * that can be restored by dragging over one and releasing (or hovering +
 * clicking during the post-release grace window).
 */
export function HistoryScrubOverlay({
  step,
  totalSteps,
  branches,
  hoveredBranchId,
  interactive,
  darkMode,
  onBranchHover,
  onBranchPick,
}: HistoryScrubOverlayProps): JSX.Element {
  const progress = totalSteps > 1 ? step / (totalSteps - 1) : 1;

  return (
    <OverlayRoot>
      <ProgressPill>
        <span>
          Version {step + 1} / {totalSteps}
        </span>
        <ProgressTrack>
          <ProgressFill style={{ width: `${progress * 100}%` }} />
        </ProgressTrack>
      </ProgressPill>
      {branches.length > 0 && (
        <BranchPanel $interactive={interactive}>
          <BranchPanelTitle>Discarded versions</BranchPanelTitle>
          {branches.map((branch, i) => (
            <BranchTile
              key={branch.id}
              type='button'
              data-branch-id={branch.id}
              $highlighted={branch.id === hoveredBranchId}
              aria-label={`Restore discarded version ${i + 1}`}
              onPointerEnter={() => interactive && onBranchHover(branch.id)}
              onPointerLeave={() => interactive && onBranchHover(null)}
              onClick={() => interactive && onBranchPick(branch.id)}
            >
              <BranchThumb strokes={branch.strokes} darkMode={darkMode} />
            </BranchTile>
          ))}
        </BranchPanel>
      )}
    </OverlayRoot>
  );
}

const THUMB_W = 72;
const THUMB_H = 72;

/** Renders a stroke snapshot fit into a small thumbnail canvas. */
function BranchThumb({
  strokes,
  darkMode,
}: {
  strokes: StrokeSnapshot;
  darkMode: boolean;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = ref.current;

    if (!el) return;

    const ctx = el.getContext('2d');

    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    el.width = THUMB_W * dpr;
    el.height = THUMB_H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, THUMB_W, THUMB_H);

    if (strokes.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const s of strokes) {
      for (const [x, y] of s.path) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }

    const padding = 6;
    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);
    const scale = Math.min(
      (THUMB_W - padding * 2) / contentW,
      (THUMB_H - padding * 2) / contentH,
    );
    const offsetX = THUMB_W / 2 - ((minX + maxX) / 2) * scale;
    const offsetY = THUMB_H / 2 - ((minY + maxY) / 2) * scale;

    drawCanvasStrokes(ctx, strokes, null, scale, offsetX, offsetY, darkMode);
  }, [strokes, darkMode]);

  return <ThumbCanvas ref={ref} />;
}

/**
 * The root ignores pointer events so the undo button keeps its capture;
 * branch tiles opt back in (they receive real events only during the
 * grace window, but must stay hit-testable for `elementsFromPoint` during
 * the captured drag).
 */
const OverlayRoot = styled.div`
  position: absolute;
  inset: 0;
  z-index: 4;
  pointer-events: none;
`;

const ProgressPill = styled.div`
  position: absolute;
  bottom: calc(${p => p.theme.size(2)} + 64px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  padding: 8px 16px;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg};
  border: 1px solid ${p => p.theme.colors.bg2};
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  font-size: 0.85rem;
  color: ${p => p.theme.colors.text};
  white-space: nowrap;
`;

const ProgressTrack = styled.div`
  width: 180px;
  height: 4px;
  border-radius: 2px;
  background: ${p => p.theme.colors.bg2};
  overflow: hidden;
`;

const ProgressFill = styled.div`
  height: 100%;
  background: ${p => p.theme.colors.main};
  transition: width 60ms linear;
`;

const BranchPanel = styled.div<{ $interactive: boolean }>`
  position: absolute;
  right: ${p => p.theme.size(2)};
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 80%;
  overflow-y: auto;
  pointer-events: ${p => (p.$interactive ? 'auto' : 'none')};
`;

const BranchPanelTitle = styled.span`
  font-size: 0.75rem;
  color: ${p => p.theme.colors.textLight};
  text-align: center;
`;

const BranchTile = styled.button<{ $highlighted: boolean }>`
  width: ${THUMB_W + 4}px;
  height: ${THUMB_H + 4}px;
  padding: 1px;
  border-radius: 14px;
  cursor: pointer;
  background: ${p => p.theme.colors.bg};
  border: ${p =>
    p.$highlighted
      ? `2.5px solid ${p.theme.colors.main}`
      : `1px solid ${p.theme.colors.bg2}`};
  box-shadow: ${p =>
    p.$highlighted
      ? `0 0 8px ${p.theme.colors.main}`
      : '0 2px 8px rgba(0, 0, 0, 0.15)'};
  /* Tiles must be hit-testable via elementsFromPoint while the undo
     button owns the pointer capture, even though real events only arrive
     during the grace window. */
  pointer-events: auto;
`;

const ThumbCanvas = styled.canvas`
  display: block;
  width: ${THUMB_W}px;
  height: ${THUMB_H}px;
  border-radius: 12px;
`;
