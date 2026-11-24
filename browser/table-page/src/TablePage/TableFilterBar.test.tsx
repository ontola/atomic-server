// @vitest-environment jsdom
// @wc-ignore-file
import type { Property } from '@tomic/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DropdownItem } from '@tomic/resource-ui/components/Dropdown/index';
import { TableFilterBar } from './TableFilterBar.js';
import {
  TablePageContext,
  type TablePageContextType,
} from './tablePageContext.js';
import type { TableFilter } from './tableFiltering.js';

const menu = vi.hoisted(() => ({ items: [] as DropdownItem[] }));
vi.mock('./ColumnFilterDropdown.js', () => ({
  ColumnFilterDropdown: ({ items }: { items: DropdownItem[] }) => {
    menu.items = items;

    return (
      <div>
        {items.map(item => (
          <button key={item.id} onClick={() => item.onClick?.()}>
            {item.label}
          </button>
        ))}
      </div>
    );
  },
}));
vi.mock('./helpers/usePropertyTitles.js', () => ({
  usePropertyTitles: (columns: Property[]) =>
    new Map(columns.map(column => [column.subject, column.shortname])),
}));
vi.mock('./TableFilterChip.js', () => ({
  TableFilterChip: ({
    filter,
    column,
    derived,
    disabled,
  }: {
    filter: TableFilter;
    column?: Property;
    derived?: { label: string };
    disabled?: boolean;
  }) => (
    <span
      data-testid={`chip-${filter.property ?? filter.derived}`}
      aria-disabled={disabled}
    >
      {column?.shortname ?? derived?.label ?? 'Unavailable column'}
    </span>
  ),
}));

afterEach(cleanup);
const column = (subject: string) =>
  ({ subject, shortname: subject }) as Property;

function harness(
  filters: TableFilter[],
  addFilter: (key: string) => void,
  disabled = false,
) {
  return (
    <TablePageContext.Provider
      value={{ filters, addFilter } as TablePageContextType}
    >
      <TableFilterBar
        columns={[column('Title'), column('Amount'), column('Amount')]}
        allColumns={[column('Title'), column('Amount'), column('Hidden')]}
        derivedColumns={[]}
        disabled={disabled}
      />
    </TablePageContext.Provider>
  );
}

it('keeps hidden and missing active filters while offering untaken columns once', () => {
  const add = vi.fn();
  render(
    harness(
      [
        { property: 'Hidden', operator: 'eq', value: 'x' },
        { property: 'Removed', operator: 'eq', value: 'x' },
        { property: 'Title', operator: 'eq', value: 'x' },
      ],
      add,
    ),
  );
  expect(screen.getByTestId('chip-Hidden').textContent).toBe('Hidden');
  expect(screen.getByTestId('chip-Removed').textContent).toBe(
    'Unavailable column',
  );
  expect(screen.queryByRole('button', { name: 'Title' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Hidden' })).toBeNull();
  const choices = screen.getAllByRole('button', { name: 'Amount' });
  expect(choices).toHaveLength(1);
  fireEvent.click(choices[0]);
  expect(add).toHaveBeenCalledExactlyOnceWith('Amount');
});

it('blocks an old add-menu callback after the host becomes busy', () => {
  const add = vi.fn();
  const filters: TableFilter[] = [
    { property: 'Title', operator: 'eq', value: 'x' },
  ];
  const view = render(harness(filters, add));
  const oldChoice = menu.items.find(item => item.id === 'Amount')!;
  view.rerender(harness(filters, add, true));
  expect(screen.queryByRole('button', { name: 'Amount' })).toBeNull();
  expect(screen.getByTestId('chip-Title').getAttribute('aria-disabled')).toBe(
    'true',
  );
  oldChoice.onClick?.();
  expect(add).not.toHaveBeenCalled();
});
