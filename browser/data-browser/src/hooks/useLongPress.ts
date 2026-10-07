import { useCallback, useRef } from 'react';

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE = 8;

/**
 * Fires `onLongPress` with the press point when a touch or pen is held still.
 * Mouse right-click is left to `onContextMenu`. Spread the returned handlers on
 * the element. `consumeClick()` is true once after a long press so the click
 * that follows the release can be ignored.
 */
export function useLongPress(
  onLongPress: (point: { x: number; y: number }) => void,
) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useRef({ x: 0, y: 0 });
  const fired = useRef(false);

  const cancel = useCallback(() => clearTimeout(timer.current), []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      cancel();
      timer.current = setTimeout(() => {
        fired.current = true;
        onLongPress(start.current);
      }, LONG_PRESS_MS);
    },
    [cancel, onLongPress],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (
        Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) >
        MOVE_TOLERANCE
      ) {
        cancel();
      }
    },
    [cancel],
  );

  const consumeClick = useCallback(() => {
    const was = fired.current;
    fired.current = false;

    return was;
  }, []);

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: cancel,
      onPointerCancel: cancel,
    },
    consumeClick,
  };
}
