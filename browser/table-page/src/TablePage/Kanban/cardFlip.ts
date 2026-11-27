import { createContext, useContext, useLayoutEffect, useRef } from 'react';

/** A card's position at the last commit, in two frames of reference:
 *  viewport coords for cross-column moves, and column-list-content
 *  coords (scroll-immune) for shifts within a column. */
export interface CardFlipRecord {
  columnId: string;
  viewport: { x: number; y: number };
  inList: { x: number; y: number };
}

/** Shared per-board registry of card positions (subject → last rect).
 *  A ref, not state: measuring must never cause renders. */
export const KanbanFlipContext = createContext<React.RefObject<
  Map<string, CardFlipRecord>
> | null>(null);

const FLIP_MS = 240;

/**
 * FLIP animation for a kanban card: after every commit, compare the
 * card's position with where it was last commit and play a transform
 * from the old slot to the new one. Makes moves legible — your own
 * drop glides from the source column, a remote session's drag lands
 * visibly instead of teleporting, and cards shuffling up after a
 * departure slide instead of jumping.
 *
 * Within a column the comparison uses list-content coordinates, so
 * scrolling between commits doesn't read as movement; across columns
 * it uses viewport coordinates from the previous commit.
 */
export function useCardFlip(
  subject: string,
  columnId: string | undefined,
  /** Suppress while this card is the local drag source (it stays put;
   *  the DragOverlay is the moving visual). */
  dragging: boolean,
): React.RefObject<HTMLDivElement | null> {
  const nodeRef = useRef<HTMLDivElement>(null);
  const registry = useContext(KanbanFlipContext);
  const runningRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const node = nodeRef.current;

    if (!node || !registry || !columnId) return;

    // A commit can land while a previous flip is mid-flight (presence
    // updates ride the same renders), and getBoundingClientRect reads
    // the animation's transform as if the card had moved again — which
    // would chain a phantom second animation. While our flip runs, the
    // stored record (the true layout position) stays authoritative.
    if (runningRef.current?.playState === 'running') return;

    const rect = node.getBoundingClientRect();
    const list = node.parentElement;
    const listRect = list?.getBoundingClientRect();
    const record: CardFlipRecord = {
      columnId,
      viewport: { x: rect.left, y: rect.top },
      inList: listRect
        ? {
            x: rect.left - listRect.left + (list?.scrollLeft ?? 0),
            y: rect.top - listRect.top + (list?.scrollTop ?? 0),
          }
        : { x: rect.left, y: rect.top },
    };

    const prev = registry.current.get(subject);
    registry.current.set(subject, record);

    if (!prev || dragging) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const dx =
      prev.columnId === columnId
        ? prev.inList.x - record.inList.x
        : prev.viewport.x - record.viewport.x;
    const dy =
      prev.columnId === columnId
        ? prev.inList.y - record.inList.y
        : prev.viewport.y - record.viewport.y;

    // Sub-pixel jitter isn't movement.
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;

    runningRef.current = node.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: FLIP_MS, easing: 'cubic-bezier(0.2, 0, 0.2, 1)' },
    );
  });

  return nodeRef;
}
