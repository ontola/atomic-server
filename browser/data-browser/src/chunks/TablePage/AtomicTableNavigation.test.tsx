// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TableNavigationProvider, useTableNavigation } from '@tomic/table';
import { AtomicTableNavigation } from './AtomicTableNavigation';

const router = vi.hoisted(() => ({
  search: { view: 'first', editColumn: 'name' },
  navigate: vi.fn(),
  read: vi.fn(),
}));
vi.mock('../../routes/ShowRoute', () => ({
  ShowRoute: {
    useSearch: () => {
      router.read();

      return router.search;
    },
    useNavigate: () => router.navigate,
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function Consumer() {
  const { location, navigate } = useTableNavigation();

  return (
    <>
      <output>
        {location.view}:{location.editColumn ?? 'closed'}
      </output>
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

it('patches the latest route search and preserves unrelated host fields', () => {
  const { rerender } = render(
    <AtomicTableNavigation>
      <Consumer />
    </AtomicTableNavigation>,
  );
  fireEvent.click(screen.getByText('Close'));
  const command = router.navigate.mock.calls[0][0];
  expect(command.replace).toBe(true);
  expect(command.to).toBe('.');
  expect(
    command.search({
      view: 'newer',
      editColumn: 'name',
      subject: 'table',
      other: 'kept',
    }),
  ).toEqual({
    view: 'newer',
    editColumn: undefined,
    subject: 'table',
    other: 'kept',
  });
  router.search = { view: 'back', editColumn: 'quantity' };
  rerender(
    <AtomicTableNavigation>
      <Consumer />
    </AtomicTableNavigation>,
  );
  expect(screen.getByRole('status').textContent).toBe('back:quantity');
});

it('preserves an embedding host and never reads the Atomic router', () => {
  const navigate = vi.fn();
  render(
    <TableNavigationProvider
      value={{ location: { view: 'embedded' }, navigate }}
    >
      <AtomicTableNavigation>
        <AtomicTableNavigation>
          <Consumer />
        </AtomicTableNavigation>
      </AtomicTableNavigation>
    </TableNavigationProvider>,
  );
  expect(router.read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Close'));
  expect(navigate).toHaveBeenCalledWith(
    { editColumn: undefined },
    { replace: true },
  );
  expect(router.navigate).not.toHaveBeenCalled();
});
