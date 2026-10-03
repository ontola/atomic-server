import { useEffect, useRef, type RefObject } from 'react';
import { useSettings } from '../../helpers/AppSettings';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useRightPanel } from './RightPanelContext';
import { RIGHT_PANEL_OVERLAY_BREAKPOINT } from './layout';

/** Narrower than this, the page between the two side panels stops being
 *  usable: a board shows one column cut off, a document wraps every word. */
export const MIN_MAIN_WIDTH = 420;

type Side = 'left' | 'right';

/**
 * Keep room for the page itself. With the sidebar and a right panel (a
 * meeting, comments, AI) both docked, widening one of them squeezed the page
 * in the middle to a sliver. When it gets narrower than {@link MIN_MAIN_WIDTH},
 * close the side panel that was used longest ago, never the one the user is
 * opening, dragging or working in right now.
 *
 * "Used" is opening a panel, or a pointer or focus landing in it. Only docked
 * panels count: below the overlay breakpoint the right panel floats over the
 * page and already closes the sidebar when it opens.
 */
export function useKeepMainRoom(mainRef: RefObject<HTMLElement | null>): void {
  const { sideBarLocked, setSideBarLocked } = useSettings();
  const { activePanel, setPanelOpen } = useRightPanel();
  const docked = useMediaQuery(
    `(min-width: ${RIGHT_PANEL_OVERLAY_BREAKPOINT}px)`,
    true,
  );
  const lastUsed = useRef<Record<Side, number>>({ left: 0, right: 0 });

  // Opening counts as using.
  useEffect(() => {
    if (sideBarLocked) lastUsed.current.left = performance.now();
  }, [sideBarLocked]);
  useEffect(() => {
    if (activePanel) lastUsed.current.right = performance.now();
  }, [activePanel]);

  // So does touching it: a pointer down, a resize drag, or focus moving in.
  useEffect(() => {
    const touch = (event: Event) => {
      const side = (event.target as Element | null)
        ?.closest?.('[data-side-panel]')
        ?.getAttribute('data-side-panel');

      if (side === 'left' || side === 'right') {
        lastUsed.current[side] = performance.now();
      }
    };

    document.addEventListener('pointerdown', touch, true);
    document.addEventListener('focusin', touch, true);

    return () => {
      document.removeEventListener('pointerdown', touch, true);
      document.removeEventListener('focusin', touch, true);
    };
  }, []);

  useEffect(() => {
    const main = mainRef.current;
    if (!main || !docked || !sideBarLocked || !activePanel) return;

    const check = () => {
      if (main.getBoundingClientRect().width >= MIN_MAIN_WIDTH) return;

      if (lastUsed.current.left <= lastUsed.current.right) {
        setSideBarLocked(false);
      } else {
        setPanelOpen(activePanel, false);
      }
    };

    const observer = new ResizeObserver(check);
    observer.observe(main);
    check();

    return () => observer.disconnect();
  }, [
    mainRef,
    docked,
    sideBarLocked,
    activePanel,
    setSideBarLocked,
    setPanelOpen,
  ]);
}
