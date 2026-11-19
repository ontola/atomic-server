// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TableNavigationProvider, useTableNavigation } from './navigation.js';

afterEach(cleanup);

function Consumer() {
  const { location, navigate } = useTableNavigation();

  return (
    <>
      <output>
        {location.view ?? 'default'}:{location.editColumn ?? 'closed'}
      </output>
      <button onClick={() => void navigate({ view: 'second' })}>Select</button>
      <button
        onClick={() =>
          void navigate({ editColumn: undefined }, { replace: true })
        }
      >
        Close
      </button>
    </>
  );
}

it('follows host history snapshots and delegates patches without owning a router', () => {
  const navigate = vi.fn();
  const { rerender } = render(
    <TableNavigationProvider
      value={{ location: { view: 'first', editColumn: 'name' }, navigate }}
    >
      <Consumer />
    </TableNavigationProvider>,
  );
  fireEvent.click(screen.getByText('Select'));
  expect(navigate).toHaveBeenLastCalledWith({ view: 'second' });
  // Navigation is host-owned: a command does not optimistically mutate location.
  expect(screen.getByRole('status').textContent).toBe('first:name');
  rerender(
    <TableNavigationProvider
      value={{ location: { view: 'second', editColumn: 'name' }, navigate }}
    >
      <Consumer />
    </TableNavigationProvider>,
  );
  expect(screen.getByRole('status').textContent).toBe('second:name');
  fireEvent.click(screen.getByText('Close'));
  expect(navigate).toHaveBeenLastCalledWith(
    { editColumn: undefined },
    { replace: true },
  );
  // A host Back operation restores the prior view without remounting the table.
  rerender(
    <TableNavigationProvider value={{ location: { view: 'first' }, navigate }}>
      <Consumer />
    </TableNavigationProvider>,
  );
  expect(screen.getByRole('status').textContent).toBe('first:closed');
});
