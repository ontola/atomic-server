import { useEffect, useRef } from 'react';
import { styled } from 'styled-components';
import { useCombineRefs } from '@hooks/useCombineRefs';
import type { DropdownTriggerComponent } from './DropdownTrigger';

/**
 * A dropdown trigger that opens its menu immediately on mount, without a
 * visible button. Used for context menus that are opened programmatically at a
 * cursor point (right-click, or clicking an already-selected tab) rather than
 * by clicking a trigger. Pair it with `DropdownMenu`'s `anchorPoint` prop so the
 * menu positions at the cursor instead of at this (invisible) element.
 *
 * The button stays mounted (visually hidden, not `display: none`) so
 * `DropdownMenu`'s focus management on close still works.
 */
export const AutoOpenTrigger: DropdownTriggerComponent = ({
  onClick,
  menuId,
  isActive,
  ref,
  id,
}) => {
  const innerRef = useRef<HTMLButtonElement>(null);
  const combinedRef = useCombineRefs([ref, innerRef]);

  useEffect(() => {
    // Open on the next frame so the mounting click/contextmenu event that
    // rendered us has fully settled first. Scheduling here (and cancelling in
    // cleanup) is StrictMode-safe: the simulated unmount cancels the first
    // frame, and the real mount re-schedules it. (A ref guard is NOT safe —
    // refs survive the remount, so it would suppress the re-schedule.)
    const raf = requestAnimationFrame(() => {
      innerRef.current?.click();
    });

    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <HiddenButton
      id={id}
      ref={combinedRef}
      aria-controls={menuId}
      aria-expanded={isActive}
      aria-haspopup='menu'
      type='button'
      onClick={onClick}
    />
  );
};

const HiddenButton = styled.button`
  position: fixed;
  width: 0;
  height: 0;
  padding: 0;
  border: none;
  opacity: 0;
  pointer-events: none;
`;
