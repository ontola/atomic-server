import { useEffect, type JSX } from 'react';
import styled from 'styled-components';
import {
  FAN_DIST_STEP,
  FAN_DISTS,
  FAN_HUES,
  FAN_BASE_RADIUS,
  FAN_WIDTH_RADIUS,
  FAN_WIDTHS,
  fanColor,
  fanColorCenter,
  fanColorInt,
  fanWidthCenter,
} from './fan-helpers';

interface FanOverlayProps {
  type: 'color' | 'width';
  /** Screen-coordinate centre of the toolbar button the user is dragging from. */
  buttonCenter: { x: number; y: number };
  /** Cursor offset relative to the button centre (cursor - centre). */
  dragOffset: { x: number; y: number };
  /** Currently hovered choice (highlighted). */
  hoveredColor: number | null;
  /** Currently hovered width (highlighted). */
  hoveredWidth: number | null;
  /** While true the fan renders semi-transparent (peek mode). */
  peek: boolean;
  /** Theme: only used for the live width preview's stroke colour. */
  darkMode: boolean;
}

/**
 * Visual overlay for the colour/width fan, mirroring Flutter's
 * `fan_overlay.dart`. Renders as a full-screen, click-through SVG so
 * pointer events flow through to the underlying button (which owns the
 * gesture). The button is anchored at `buttonCenter`; swatches /
 * width-dots sit at the centres computed in `fan-helpers.ts`.
 *
 * No backdrop dimming is applied — the fan elements alone are bold
 * enough, and dimming the canvas while picking a colour makes the next
 * stroke harder to plan against existing strokes.
 */
export function FanOverlay({
  type,
  buttonCenter,
  dragOffset,
  hoveredColor,
  hoveredWidth,
  peek,
  darkMode,
}: FanOverlayProps): JSX.Element {
  // Prevent body scroll / pinch zoom while the fan is open.
  useEffect(() => {
    const prev = document.body.style.overscrollBehavior;
    document.body.style.overscrollBehavior = 'none';

    return () => {
      document.body.style.overscrollBehavior = prev;
    };
  }, []);

  const fanOpacity = peek ? 0.7 : 1;
  const tipRadius =
    type === 'width' && hoveredWidth !== null
      ? Math.max(3, Math.min(36, hoveredWidth / 2))
      : 0;

  return (
    <OverlayRoot $opacity={fanOpacity}>
      <svg
        width='100%'
        height='100%'
        style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
      >
        {type === 'color'
          ? renderColorFan(buttonCenter, hoveredColor)
          : renderWidthFan(buttonCenter, hoveredWidth, darkMode)}

        {/* Live cursor follower: small dot for colour, sized circle for width.
         * Matches Flutter's fan-overlay tip preview. */}
        {tipRadius > 0 && (
          <circle
            cx={buttonCenter.x + dragOffset.x}
            cy={buttonCenter.y + dragOffset.y}
            r={tipRadius}
            fill='none'
            stroke={darkMode ? '#ffffff' : '#000000'}
            strokeWidth={2}
          />
        )}
      </svg>
    </OverlayRoot>
  );
}

function renderColorFan(
  centre: { x: number; y: number },
  hovered: number | null,
): JSX.Element[] {
  const swatches: JSX.Element[] = [];

  for (let d = 0; d < FAN_DISTS; d++) {
    for (let h = 0; h < FAN_HUES; h++) {
      const { x, y } = fanColorCenter(h, d);
      const cx = centre.x + x;
      const cy = centre.y + y;
      const colour = fanColor(h, d);
      const isHovered = hovered === fanColorInt(h, d);
      // Bigger and outlined when hovered so the user sees the snap target.
      const r = isHovered ? 24 : 18;
      swatches.push(
        <circle
          key={`c-${d}-${h}`}
          cx={cx}
          cy={cy}
          r={r}
          fill={colour}
          stroke={isHovered ? '#ffffff' : 'rgba(0,0,0,0.25)'}
          strokeWidth={isHovered ? 3 : 1}
        />,
      );
    }
  }

  return swatches;
}

function renderWidthFan(
  centre: { x: number; y: number },
  hovered: number | null,
  darkMode: boolean,
): JSX.Element[] {
  const swatches: JSX.Element[] = [];
  const dotColour = darkMode ? '#d2d2d2' : '#444444';

  for (let i = 0; i < FAN_WIDTHS.length; i++) {
    const { x, y } = fanWidthCenter(i);
    const cx = centre.x + x;
    const cy = centre.y + y;
    const width = FAN_WIDTHS[i];
    const isHovered = hovered === width;
    // Visible dot size mirrors the actual stroke width, capped so the
    // largest still fits inside the chrome.
    const dotR = Math.max(3, Math.min(22, width / 2));
    swatches.push(
      <g key={`w-${i}`}>
        <circle
          cx={cx}
          cy={cy}
          r={28}
          fill={isHovered ? 'rgba(0,0,0,0.08)' : 'transparent'}
          stroke={isHovered ? '#ffffff' : 'rgba(0,0,0,0.25)'}
          strokeWidth={isHovered ? 3 : 1}
        />
        <circle cx={cx} cy={cy} r={dotR} fill={dotColour} />
      </g>,
    );
  }

  return swatches;
}

/**
 * `pointer-events: none` so the underlying toolbar button keeps the
 * pointer capture — the parent component owns the drag gesture and
 * computes `hoveredColor` / `hoveredWidth`; this overlay is render-only.
 */
const OverlayRoot = styled.div<{ $opacity: number }>`
  position: fixed;
  inset: 0;
  z-index: 100;
  pointer-events: none;
  opacity: ${p => p.$opacity};
  transition: opacity 80ms ease;
`;

// Re-export the helpers so the page can use the same constants.
export {
  FAN_HUES,
  FAN_DISTS,
  FAN_BASE_RADIUS,
  FAN_DIST_STEP,
  FAN_WIDTH_RADIUS,
};
