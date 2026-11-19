// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { IntegerCell } from './IntegerCell.js';
import { DateCell } from './DateCell.js';

afterEach(cleanup);

it('retains unfinished integer text across host rerenders without committing it', () => {
  const commit = vi.fn();
  const draftChanged = vi.fn();
  const { rerender } = render(
    <IntegerCell.Edit
      property='count'
      value={1}
      seed='9'
      onChange={commit}
      textDraft={{ text: '-', change: draftChanged }}
    />,
  );
  const input = screen.getByRole<HTMLInputElement>('textbox');
  expect(input.value).toBe('-');
  expect(draftChanged).not.toHaveBeenCalled();

  fireEvent.change(input, { target: { value: '2e' } });
  expect(draftChanged).toHaveBeenCalledExactlyOnceWith('2e');
  expect(commit).not.toHaveBeenCalled();

  rerender(
    <IntegerCell.Edit
      property='count'
      value={4}
      seed='8'
      onChange={commit}
      textDraft={{ text: '5', change: draftChanged }}
    />,
  );
  expect(input.value).toBe('2e');
  fireEvent.keyDown(input, { key: 'Tab' });
  expect(commit).not.toHaveBeenCalled();

  fireEvent.change(input, { target: { value: '-12' } });
  expect(draftChanged).toHaveBeenLastCalledWith('-12');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(commit).toHaveBeenCalledExactlyOnceWith(-12);
});

it('reports incomplete date text to the host without saving a date', () => {
  const commit = vi.fn();
  const draftChanged = vi.fn();
  render(
    <DateCell.Edit
      property='date'
      value='2026-01-01'
      onChange={commit}
      textDraft={{ text: '2026-11', change: draftChanged }}
    />,
  );
  const input = screen.getByRole<HTMLInputElement>('textbox');
  expect(input.value).toBe('2026-11');
  fireEvent.change(input, { target: { value: '2026-' } });
  expect(draftChanged).toHaveBeenCalledExactlyOnceWith('2026-');
  fireEvent.keyDown(input, { key: 'Tab' });
  expect(commit).not.toHaveBeenCalled();
});
