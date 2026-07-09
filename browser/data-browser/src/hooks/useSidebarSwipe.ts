import { useEffect } from 'react';
import { useEffectEvent } from 'react';

/**
 * Swipe-to-open/close for the mobile sidebar.
 *
 * On Android 10+ the OS reserves the outer screen edges for the system Back
 * gesture, and apps only get a ~200dp exclusion band — so an edge-swipe
 * drawer can't work reliably in a webview. Instead (like Slack/Notion): a
 * rightward swipe that STARTS in the left part of the content opens the
 * sidebar, and a leftward swipe anywhere closes it. Touches that begin on
 * horizontally scrollable content, canvases, inputs, or editable text are
 * left alone.
 */

/** Outer band the OS back gesture owns; touches there are not ours. */
const EDGE_IGNORE_PX = 24;
/** An open-swipe must start in this fraction of the viewport width. */
const OPEN_START_ZONE = 0.4;
/** Horizontal distance that commits the gesture. */
const SWIPE_DISTANCE_PX = 60;
/** Horizontal dominance: dx must exceed dy by this factor. */
const DIRECTION_RATIO = 2;

/**
 * True when the element (or an ancestor) handles horizontal touch movement
 * itself: sideways-scrolling containers (tables, kanban), canvases, inputs,
 * rich text. A sidebar gesture starting there would fight it.
 */
export function ownsHorizontalTouch(start: Element | null): boolean {
  for (let node = start; node; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }

    if (
      node.tagName === 'CANVAS' ||
      node.tagName === 'INPUT' ||
      node.tagName === 'TEXTAREA' ||
      node.isContentEditable
    ) {
      return true;
    }

    const style = getComputedStyle(node);

    if (style.touchAction === 'none') {
      return true;
    }

    if (
      (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
      node.scrollWidth > node.clientWidth + 1
    ) {
      return true;
    }
  }

  return false;
}

interface SwipeArgs {
  /** Only active on small screens — wide screens have the sidebar in-flow. */
  enabled: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

export function useSidebarSwipe({
  enabled,
  open,
  onOpen,
  onClose,
}: SwipeArgs): void {
  const handleSwipe = useEffectEvent((direction: 'left' | 'right') => {
    if (direction === 'right' && !open) {
      onOpen();
    } else if (direction === 'left' && open) {
      onClose();
    }
  });

  const shouldTrack = useEffectEvent((x: number, target: Element | null) => {
    if (x < EDGE_IGNORE_PX || x > window.innerWidth - EDGE_IGNORE_PX) {
      return false;
    }

    // Opening requires starting on the left; closing may start anywhere
    // (the open sidebar + overlay cover most of the screen anyway).
    if (!open && x > window.innerWidth * OPEN_START_ZONE) {
      return false;
    }

    return !ownsHorizontalTouch(target);
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let startX = 0;
    let startY = 0;
    let tracking = false;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;

        return;
      }

      const touch = event.touches[0];
      tracking = shouldTrack(touch.clientX, event.target as Element | null);
      startX = touch.clientX;
      startY = touch.clientY;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking) {
        return;
      }

      const touch = event.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      // A clearly vertical movement is a scroll — stop considering this
      // touch so a later sideways wiggle doesn't toggle the sidebar.
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > SWIPE_DISTANCE_PX) {
        tracking = false;

        return;
      }

      if (
        Math.abs(dx) >= SWIPE_DISTANCE_PX &&
        Math.abs(dx) > Math.abs(dy) * DIRECTION_RATIO
      ) {
        tracking = false;
        handleSwipe(dx > 0 ? 'right' : 'left');
      }
    };

    const onTouchEnd = () => {
      tracking = false;
    };

    // Passive: we never preventDefault, so scrolling stays smooth.
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [enabled]);
}
