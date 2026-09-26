// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../../../styling';
import { TruncatedText } from './TruncatedText';

const LONG =
  'Tuesdays 19:30 New York, which is 01:30 Wednesday in Amsterdam. Ten times.';

// jsdom has no layout: say how wide the text is and how wide its cell is.
let textWidth = 0;
const cellWidth = 120;
const descriptors = {
  scrollWidth: Object.getOwnPropertyDescriptor(
    Element.prototype,
    'scrollWidth',
  ),
  clientWidth: Object.getOwnPropertyDescriptor(
    Element.prototype,
    'clientWidth',
  ),
};

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollWidth', {
    configurable: true,
    get: () => textWidth,
  });
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get: () => cellWidth,
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(
    Element.prototype,
    'scrollWidth',
    descriptors.scrollWidth!,
  );
  Object.defineProperty(
    Element.prototype,
    'clientWidth',
    descriptors.clientWidth!,
  );
});

function renderCell(value: string) {
  return render(
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <div role='gridcell' tabIndex={0} data-testid='cell'>
        <TruncatedText value={value} />
      </div>
    </ThemeProvider>,
  );
}

it('adds nothing when the text fits', () => {
  textWidth = 80;
  const { getByText, queryByTestId } = renderCell('Bring laptops');

  expect(getByText('Bring laptops').getAttribute('title')).toBeNull();
  expect(queryByTestId('cell-full-text')).toBeNull();
});

it('shows cut-off text in full on hover and while the cell is selected', () => {
  textWidth = 600;
  const { getByTestId, getAllByText } = renderCell(LONG);
  const [clipped] = getAllByText(LONG);
  const full = getByTestId('cell-full-text');

  // Hover: a tooltip with the whole note.
  expect(clipped.getAttribute('title')).toBe(LONG);
  // Screen readers get the cell's own text once, not twice.
  expect(full.getAttribute('aria-hidden')).toBe('true');
  expect(full.textContent).toBe(LONG);

  // The panel only unfolds while the cell has focus (the selected cell).
  // jsdom's computed style ignores :focus, so check the rule that shows the
  // panel, and that its selector matches only once the cell is focused.
  const showRule = shownWhen(full);
  expect(showRule).toMatch(/gridcell/);
  expect(full.matches(showRule)).toBe(false);
  act(() => getByTestId('cell').focus());
  expect(full.matches(showRule)).toBe(true);
});

/** The selector of the style rule that sets `display: block` on `el`'s class. */
function shownWhen(el: HTMLElement): string {
  const rules = [...document.styleSheets].flatMap(sheet => [
    ...sheet.cssRules,
  ]) as CSSStyleRule[];
  const rule = rules.find(
    r =>
      r.style?.display === 'block' &&
      [...el.classList].some(c => r.selectorText?.includes(`.${c}`)),
  );

  return rule?.selectorText ?? '';
}
