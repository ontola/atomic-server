// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FloatCell } from './FloatCell.js';
vi.mock('../../TableEditor/TableEditorContext.js', async importOriginal => ({
  ...(await importOriginal<
    typeof import('../../TableEditor/TableEditorContext.js')
  >()),
  useTableEditorContext: () => ({ registerEventListener: () => () => {} }),
}));
afterEach(cleanup);
it.each([
  ['1.23456789', 1.23456789],
  ['1e-3', 0.001],
  ['1,5', 1.5],
] as const)(
  'commits complete Float input %s only when confirmed',
  (text, expected) => {
    const change = vi.fn();
    render(<FloatCell.Edit value={0} onChange={change} property='number' />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: text } });
    expect(change).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(change).toHaveBeenCalledExactlyOnceWith(expected);
  },
);
