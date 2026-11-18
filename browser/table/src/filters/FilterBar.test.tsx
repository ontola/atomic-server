// @vitest-environment jsdom
import { afterEach, beforeAll, afterAll, it, expect, vi } from 'vitest';
import { cleanup, render, fireEvent, screen } from '@testing-library/react';
import { TableFilterBar, type TableFilterTarget } from './FilterBar.js';
beforeAll(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
);
afterAll(() => vi.unstubAllGlobals());
afterEach(cleanup);
const target = (
  key: string,
  label: string,
  addable = true,
): TableFilterTarget => ({
  key,
  addable,
  chip: {
    label,
    operatorLabel: () => 'is',
    operators: [{ value: 'eq', label: 'is' }],
    valueInputProps: { kind: 'text' },
  },
});
const base = {
  onAdd: vi.fn(),
  onValueChange: vi.fn(),
  onOperatorChange: vi.fn(),
  onRemove: vi.fn(),
};
it('hides the active row when empty', () => {
  render(
    <TableFilterBar
      {...base}
      filters={[]}
      targets={[target('title', 'Title')]}
    />,
  );
  expect(screen.queryByRole('toolbar')).toBeNull();
});
it('retains hidden-column chips and offers only untaken visible and computed targets', () => {
  const add = vi.fn();
  render(
    <TableFilterBar
      {...base}
      onAdd={add}
      filters={[
        { property: 'hidden', operator: 'eq', value: 'x' },
        { property: 'title', operator: 'eq', value: 'a' },
      ]}
      targets={[
        target('hidden', 'Hidden', false),
        target('title', 'Title'),
        target('other-hidden', 'Other hidden', false),
        target('derived:hours', 'Hours'),
      ]}
    />,
  );
  expect(screen.getAllByTestId('filter-chip')).toHaveLength(2);
  fireEvent.click(screen.getByText('Add filter'));
  expect(screen.queryByRole('button', { name: 'Other hidden' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Title' })).toBeNull();
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: 'absent' },
  });
  expect(screen.getByRole('status').textContent).toBe('No column matches');
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: 'hours' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Hours' }));
  expect(add).toHaveBeenCalledExactlyOnceWith('derived:hours');
});
it('dispatches edits and removal by stable identity and keeps missing targets recoverable', async () => {
  const change = vi.fn(),
    remove = vi.fn();
  render(
    <TableFilterBar
      {...base}
      onValueChange={change}
      onRemove={remove}
      filters={[
        { property: 'title', operator: 'eq', value: '' },
        { derived: 'removed', operator: 'eq', value: '2' },
      ]}
      targets={[target('title', 'Title')]}
    />,
  );
  fireEvent.change(
    await screen.findByRole('textbox', { name: 'Filter value' }),
    { target: { value: 'edited' } },
  );
  expect(change).toHaveBeenCalledExactlyOnceWith('title', 'edited');
  fireEvent.click(screen.getByRole('button', { name: 'Remove filter' }));
  expect(remove).toHaveBeenCalledWith('title');
  fireEvent.click(screen.getAllByTestId('filter-chip')[1]);
  await screen.findByText('This column is unavailable.');
  fireEvent.click(screen.getByRole('button', { name: 'Remove filter' }));
  expect(remove).toHaveBeenLastCalledWith('derived:removed');
});
