// @vitest-environment jsdom
import { afterEach, beforeAll, afterAll, it, expect, vi } from 'vitest';
import { cleanup, render, fireEvent, screen } from '@testing-library/react';
import {
  TableFilterBar,
  type TableFilterTarget,
  type TableFilterAddMenuProps,
} from './FilterBar.js';

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

function Menu({ items }: TableFilterAddMenuProps) {
  return (
    <div data-testid='candidate-list'>
      {items.map(item => (
        <button
          key={`${item.key}/${item.label}`}
          type='button'
          onClick={item.onSelect}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

const callbacks = {
  onAdd: vi.fn(),
  onValueChange: vi.fn(),
  onOperatorChange: vi.fn(),
  onRemove: vi.fn(),
  AddMenu: Menu,
};

it('hides an empty active bar', () => {
  render(
    <TableFilterBar
      {...callbacks}
      filters={[]}
      targets={[target('name', 'Name')]}
    />,
  );
  expect(screen.queryByRole('toolbar')).toBeNull();
});
it('retains hidden chips and original untaken candidate order without new deduplication', () => {
  const add = vi.fn();
  render(
    <TableFilterBar
      {...callbacks}
      onAdd={add}
      filters={[{ property: 'hidden', operator: 'eq', value: 'x' }]}
      targets={[
        target('hidden', 'Hidden', false),
        target('omitted', 'Other hidden', false),
        target('name', 'Name'),
        target('name', 'Second name'),
        target('derived:hours', 'Hours'),
      ]}
    />,
  );
  expect(screen.getAllByTestId('filter-chip')).toHaveLength(1);
  expect(screen.getByTestId('candidate-list').textContent).toBe(
    'NameSecond nameHours',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Hours', exact: true }));
  expect(add).toHaveBeenCalledExactlyOnceWith('derived:hours');
});
it('preserves stable edit/removal dispatch and inherited missing-target recovery', async () => {
  const change = vi.fn(),
    remove = vi.fn();
  render(
    <TableFilterBar
      {...callbacks}
      onValueChange={change}
      onRemove={remove}
      filters={[
        { property: 'name', operator: 'eq', value: '' },
        { derived: 'gone', operator: 'eq', value: '2' },
      ]}
      targets={[target('name', 'Name')]}
    />,
  );
  fireEvent.change(
    await screen.findByRole('textbox', { name: 'Filter value' }),
    { target: { value: 'edited' } },
  );
  expect(change).toHaveBeenCalledExactlyOnceWith('name', 'edited');
  fireEvent.click(screen.getByRole('button', { name: 'Remove filter' }));
  expect(remove).toHaveBeenCalledWith('name');
  fireEvent.click(screen.getAllByTestId('filter-chip')[1]);
  await screen.findByText('This column is unavailable.');
  fireEvent.click(screen.getByRole('button', { name: 'Remove filter' }));
  expect(remove).toHaveBeenLastCalledWith('derived:gone');
});
