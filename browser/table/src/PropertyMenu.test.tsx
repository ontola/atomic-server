// @vitest-environment jsdom
import { createRef, type MouseEvent } from 'react';
import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  render,
  fireEvent,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  TablePropertyMenu,
  type TablePropertyMenuHandle,
} from './PropertyMenu.js';
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
it('shares property commands and closes after a supported action', async () => {
  const filter = vi.fn(),
    hide = vi.fn();
  render(
    <TablePropertyMenu
      actions={{ filter: { run: filter }, hide: { run: hide, disabled: true } }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit column' }));
  await screen.findByRole('menu');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide in this view' }));
  expect(hide).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Filter' }));
  expect(filter).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
});
it('opens the same command set from a heading context handle', async () => {
  const ref = createRef<TablePropertyMenuHandle>(),
    preventDefault = vi.fn();
  render(<TablePropertyMenu ref={ref} actions={{ view: { run: vi.fn() } }} />);
  act(() =>
    ref.current!.openAt({
      clientX: 30,
      clientY: 20,
      preventDefault,
    } as unknown as MouseEvent),
  );
  await screen.findByRole('menu');
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(
    (
      screen.getByRole('menuitem', {
        name: 'Edit unavailable',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
it('navigates enabled commands by keyboard without sending grid hotkeys', async () => {
  const gridKey = vi.fn();
  render(
    <div role='grid' onKeyDown={gridKey}>
      <TablePropertyMenu
        actions={{ view: { run: vi.fn() }, filter: { run: vi.fn() } }}
      />
    </div>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit column' }));
  const menu = await screen.findByRole('menu');
  const view = screen.getByRole('menuitem', { name: 'View' });
  menu.focus();
  fireEvent.keyDown(menu, { key: 'ArrowUp' });
  expect(document.activeElement).toBe(
    screen.getByRole('menuitem', { name: 'Filter' }),
  );
  view.focus();
  fireEvent.keyDown(menu, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(
    screen.getByRole('menuitem', { name: 'Filter' }),
  );
  expect(gridKey).not.toHaveBeenCalled();
  fireEvent.keyDown(menu, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
});
it('guards unavailable actions even through a custom menu and disables an empty capability set', () => {
  const remove = vi.fn();
  const view = render(
    <TablePropertyMenu
      actions={{ remove: { run: remove, disabled: true } }}
      Menu={({ items }) => (
        <button onClick={items.find(item => item.key === 'remove')!.run}>
          Host remove
        </button>
      )}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Host remove' }));
  expect(remove).not.toHaveBeenCalled();
  view.rerender(<TablePropertyMenu actions={{}} />);
  expect(
    (screen.getByRole('button', { name: 'Edit column' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
