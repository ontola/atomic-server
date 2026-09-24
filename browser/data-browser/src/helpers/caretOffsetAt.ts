/**
 * Character index in the rendered title under a pointer position, so the
 * editor can open with its caret there. Falls back to the end of the text
 * when the point is not over the title text (the icon, the gap) or the
 * browser has neither caret-from-point API.
 */
export function caretOffsetAt(
  title: HTMLElement,
  x: number,
  y: number,
): number | 'end' {
  const textEl = title.querySelector<HTMLElement>('[data-title-text]');

  if (!textEl) {
    return 'end';
  }

  let node: Node | null = null;
  let offset = 0;

  if ('caretPositionFromPoint' in document) {
    const pos = document.caretPositionFromPoint(x, y);
    node = pos?.offsetNode ?? null;
    offset = pos?.offset ?? 0;
  } else if ('caretRangeFromPoint' in document) {
    const range = (
      document as Document & {
        caretRangeFromPoint(x: number, y: number): Range | null;
      }
    ).caretRangeFromPoint(x, y);
    node = range?.startContainer ?? null;
    offset = range?.startOffset ?? 0;
  }

  // Only the title's own text node counts: a hit on the unsaved indicator
  // or outside the span has no meaningful character index.
  if (node?.nodeType !== Node.TEXT_NODE || node.parentNode !== textEl) {
    return 'end';
  }

  return offset;
}
