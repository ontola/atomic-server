import { transparentize } from 'polished';
import { useEffect, useId, useRef, useState } from 'react';
import { styled } from 'styled-components';

interface UseResizeResult {
  size: string;
  dragAreaRef: React.RefObject<HTMLDivElement | null>;
  dragAreaListeners: Pick<
    React.DOMAttributes<HTMLElement>,
    'onPointerDown' | 'onClickCapture'
  >;
  isDragging: boolean;
}

const dragRule = (cursor: string) => `
 * {
  cursor: ${cursor};
  user-select: none;
 }
`;

function createStyleElement(id: string) {
  const existingNode = document.getElementById(id);

  if (existingNode) {
    return existingNode;
  }

  const node = document.createElement('style');
  node.setAttribute('id', id);
  document.head.appendChild(node);

  return node;
}

function cleanup(id: string) {
  const node = document.getElementById(id);
  if (!node) return;

  if (document.head.contains(node)) {
    document.head.removeChild(node);
  }
}

function setDragStyling(id: string, cursor: string) {
  const node = createStyleElement(id);
  node.textContent = dragRule(cursor);
}

/**
 * A width default that adapts to the screen. Laptop-class displays
 * (≤ ~15", logical width under this breakpoint) get the narrower value
 * so drawers don't swallow the content area; large / external monitors
 * keep the roomier one. Read once at mount (the panels are resizable,
 * so this is only the starting width).
 */
export function responsiveWidth(opts: {
  large: number;
  laptop: number;
}): number {
  // 1728 = a 16" MacBook's logical width; 13–15" laptops sit below it
  // and get the laptop size, desktop monitors get the large size.
  if (typeof window === 'undefined' || window.innerWidth >= 1728) {
    return opts.large;
  }

  return opts.laptop;
}

export type ResizeEdge = 'left' | 'right' | 'top' | 'bottom';

const isVertical = (edge: ResizeEdge) => edge === 'top' || edge === 'bottom';

export type UseResizableProps<E extends HTMLElement> = {
  initialSize: number;
  onResize?: (size: number) => void;
  minSize?: number;
  maxSize?: number;
  targetRef: React.RefObject<E | null>;
  /** Which edge of the target element the size is measured from. `top` /
   * `bottom` resize the height instead of the width. Default `left`. */
  edge?: ResizeEdge;
  /** Delta mode lets a header resize from anywhere without jumping to the pointer. */
  mode?: 'edge' | 'delta';
  /** Movement before a press becomes a drag, preserving taps on header buttons. */
  threshold?: number;
};

export function useResizable<E extends HTMLElement>({
  initialSize,
  onResize,
  minSize = 0,
  maxSize = Infinity,
  targetRef,
  edge = 'left',
  mode = 'edge',
  threshold = 0,
}: UseResizableProps<E>): UseResizeResult {
  const dragAreaRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState(`${initialSize}px`);
  const styleId = useId();
  const stopDragRef = useRef<(() => void) | undefined>(undefined);
  const suppressClick = useRef(false);
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(
    () => () => {
      stopDragRef.current?.();
      cleanup(styleId);
    },
    [styleId],
  );

  const onPointerDown: React.PointerEventHandler<HTMLElement> = event => {
    if (event.button !== 0 || event.isPrimary === false || !targetRef.current)
      return;
    event.stopPropagation();
    stopDragRef.current?.();
    suppressClick.current = false;
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const vertical = isVertical(edge);
    const start = vertical ? event.clientY : event.clientX;
    const rect = targetRef.current.getBoundingClientRect();
    const startSize = vertical ? rect.height : rect.width;
    const direction = edge === 'right' || edge === 'bottom' ? -1 : 1;
    let started = false;

    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const position = vertical ? e.clientY : e.clientX;
      const delta = position - start;
      if (!started && Math.abs(delta) < threshold) return;

      if (!started) {
        started = true;
        handle.setPointerCapture?.(pointerId);
        suppressClick.current = true;
        setDragging(true);
        setDragStyling(styleId, vertical ? 'row-resize' : 'col-resize');
      }

      const targetRect = targetRef.current?.getBoundingClientRect();
      if (!targetRect) return;
      const origin =
        edge === 'right'
          ? targetRect.right
          : edge === 'bottom'
            ? targetRect.bottom
            : edge === 'top'
              ? targetRect.top
              : targetRect.left;
      const requested =
        mode === 'delta'
          ? startSize + direction * delta
          : direction * (position - origin);
      const newSize = Math.min(maxSize, Math.max(minSize, requested));
      setSize(`${newSize}px`);
      onResizeRef.current?.(newSize);
    };

    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', stop);
      handle.removeEventListener('lostpointercapture', lostCapture);
      if (started && handle.hasPointerCapture?.(pointerId))
        handle.releasePointerCapture(pointerId);
      cleanup(styleId);
      setDragging(false);
      stopDragRef.current = undefined;
    };

    const finish = (e: PointerEvent) => {
      if (e.pointerId === pointerId) stop();
    };

    const lostCapture = (e: PointerEvent) => {
      // Transferring a touch's implicit capture from a title span to its
      // header also bubbles this event. Only losing our own capture ends it.
      if (e.target === handle) finish(e);
    };

    stopDragRef.current = stop;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', stop);
    handle.addEventListener('lostpointercapture', lostCapture);
  };

  return {
    size,
    dragAreaRef,
    isDragging: dragging,
    dragAreaListeners: {
      onPointerDown,
      onClickCapture: event => {
        if (suppressClick.current && event.detail !== 0) {
          event.preventDefault();
          event.stopPropagation();
        }

        suppressClick.current = false;
      },
    },
  };
}

interface DragAreaBaseProps {
  isDragging: boolean;
}

export const DragAreaBase = styled.div<DragAreaBaseProps>`
  --drag-color: ${p => transparentize(0.7, p.theme.colors.main)};
  position: absolute;
  cursor: col-resize;
  touch-action: none;

  background-color: ${({ isDragging }) =>
    isDragging ? 'var(--drag-color)' : 'transparent'};

  backdrop-filter: ${({ isDragging }) => (isDragging ? 'blur(5px)' : 'none')};

  &:hover {
    transition: background-color 0.2s;
    background-color: var(--drag-color);
    backdrop-filter: blur(5px);
  }

  border-radius: ${({ theme }) => theme.radius};
`;
