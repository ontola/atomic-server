// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TableFilterMenu } from './FilterMenu.js';
afterEach(cleanup);
it('adds the first filter without an active bar or backend menu', () => {
  const add = vi.fn();
  render(
    <TableFilterMenu
      filters={[]}
      targets={[{ key: 'title', label: 'Title' }]}
      onAdd={add}
    />,
  );
  fireEvent.click(screen.getByText('Filter', { selector: 'summary' }));
  expect(screen.getByText('Filter rows by a column')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Title' }));
  expect(add).toHaveBeenCalledExactlyOnceWith('title');
});
it('disables an empty or exhausted selector instead of opening a broken empty menu', () => {
  const props = {
    filters: [{ property: 'title', operator: 'eq' as const, value: 'a' }],
    targets: [
      { key: 'title', label: 'Title' },
      { key: 'hidden', label: 'Hidden', addable: false },
    ],
    onAdd: vi.fn(),
  };
  const view = render(<TableFilterMenu {...props} />);
  expect(
    (screen.getByRole('button', { name: 'Filter' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  view.rerender(
    <TableFilterMenu filters={[]} targets={[]} onAdd={props.onAdd} />,
  );
  expect(
    (screen.getByRole('button', { name: 'Filter' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it('guards selection callbacks while disabled even with a host menu adapter', () => {
  const add = vi.fn();
  render(
    <TableFilterMenu
      disabled
      filters={[]}
      targets={[{ key: 'title', label: 'Title' }]}
      onAdd={add}
      Menu={({ items }) => (
        <button onClick={items[0].onSelect}>Host action</button>
      )}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Host action' }));
  expect(add).not.toHaveBeenCalled();
});
