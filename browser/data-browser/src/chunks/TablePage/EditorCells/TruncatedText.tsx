import type { JSONValue } from '@tomic/react';
import { useLayoutEffect, useRef, useState, type JSX } from 'react';
import { styled } from 'styled-components';

interface TruncatedTextProps {
  value: JSONValue;
}

/**
 * A cell's text on one line, cut off with an ellipsis. When it doesn't fit,
 * the full text shows on hover (a tooltip) and, while the cell is selected,
 * in a read-only panel that unfolds over the rows below — so a long note can
 * be read without entering the editor and scrolling the input.
 */
export function TruncatedText({ value }: TruncatedTextProps): JSX.Element {
  const text =
    typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const ref = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;

    if (!el) {
      return;
    }

    const measure = () => setTruncated(el.scrollWidth > el.clientWidth + 1);
    measure();

    // Resizing the column changes whether it fits.
    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(measure);
    observer.observe(el);

    return () => observer.disconnect();
  }, [text]);

  return (
    <>
      <Clip ref={ref} title={truncated ? text : undefined}>
        {text}
      </Clip>
      {truncated && (
        // The cell's own text already carries the value for screen readers.
        <FullText aria-hidden data-full-text data-testid='cell-full-text'>
          {text}
        </FullText>
      )}
    </>
  );
}

const Clip = styled.span`
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const FullText = styled.span`
  display: none;
  position: absolute;
  inset-block-start: -1px;
  inset-inline-start: -1px;
  z-index: 2;
  box-sizing: border-box;
  min-width: calc(100% + 2px);
  /* Covers the cell, and with it the active-cell outline it replaces. */
  min-height: calc(100% + 2px);
  width: max-content;
  max-width: max(calc(100% + 2px), min(40ch, 80vw));
  padding-block: 0.4rem;
  padding-inline: var(--table-inner-padding);
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.4;
  background-color: ${p => p.theme.colors.bg};
  border: 2px solid ${p => p.theme.colors.main};
  border-radius: ${p => p.theme.radius};
  box-shadow: ${p => p.theme.boxShadowSoft};
  /* Clicks fall through to the cell, so a double-click still edits it. */
  pointer-events: none;

  [role='gridcell']:focus > & {
    display: block;
  }
`;
