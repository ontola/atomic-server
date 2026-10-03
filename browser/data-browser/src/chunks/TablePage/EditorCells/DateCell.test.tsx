// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import type { Resource } from '@tomic/react';
import { buildTheme } from '../../../styling';
import { DateCell } from './DateCell';

afterEach(cleanup);

function renderEditor(value?: string) {
  const onChange = vi.fn();
  const utils = render(
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <DateCell.Edit
        value={value}
        onChange={onChange}
        property='https://example.com/day'
        resource={{} as Resource}
      />
    </ThemeProvider>,
  );

  return { ...utils, onChange, input: utils.getByRole('textbox') };
}

/** Types like a person: one change event per character. */
function type(input: HTMLElement, text: string) {
  for (let i = 1; i <= text.length; i++) {
    fireEvent.change(input, { target: { value: text.slice(0, i) } });
  }
}

it('accepts an unpadded day and stores it once, on Enter', () => {
  const { input, onChange } = renderEditor();

  type(input, '2026-10-2');
  // Nothing half-typed reaches the store (0002-…, 0020-…, 0202-…).
  expect(onChange).not.toHaveBeenCalled();

  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith('2026-10-02');
});

// Escape is the one close that stores nothing; TableCell.test.tsx covers it.
it('stores the date when the cell closes another way (click away)', async () => {
  const { input, onChange, unmount } = renderEditor('2026-09-25');

  fireEvent.change(input, { target: { value: '2026-10-2' } });
  expect(onChange).not.toHaveBeenCalled();

  unmount();
  // The close stores after a microtask, once StrictMode could have remounted.
  await Promise.resolve();
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith('2026-10-02');
});

it('does not store Enter and then store again when the cell closes', async () => {
  const { input, onChange, unmount } = renderEditor();

  fireEvent.change(input, { target: { value: '2026-10-2' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  unmount();
  await Promise.resolve();

  expect(onChange).toHaveBeenCalledTimes(1);
});

it('keeps the stored date when the text is not a date', async () => {
  const { input, onChange, unmount } = renderEditor('2026-09-25');

  fireEvent.change(input, { target: { value: '2026-10-' } });
  expect(input.getAttribute('aria-invalid')).toBe('true');

  unmount();
  await Promise.resolve();
  expect(onChange).not.toHaveBeenCalled();
});

it('stores nothing when the date was left as it was', async () => {
  const { input, onChange, unmount } = renderEditor('2026-09-25');

  // It opens with the stored date, written the way the locale writes it.
  expect((input as HTMLInputElement).value).toMatch(/25.*2026/);
  unmount();
  await Promise.resolve();
  expect(onChange).not.toHaveBeenCalled();
});
