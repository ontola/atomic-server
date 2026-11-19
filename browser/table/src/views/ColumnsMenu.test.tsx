// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TableColumnsMenu } from './ColumnsMenu.js';
afterEach(cleanup);
it('resolves renderer locks as shown and dispatches visibility by stable identity', () => {
  const change = vi.fn();
  render(
    <TableColumnsMenu
      columns={[
        { key: 'title', label: 'Title', shown: true },
        {
          key: 'date',
          label: 'Date',
          shown: false,
          locked: true,
          lockReason: 'Required by calendar',
        },
      ]}
      onChange={change}
    />,
  );
  fireEvent.click(
    screen.getByText('Toggle properties', { selector: 'summary' }),
  );
  const date = screen.getByRole('checkbox', {
    name: 'Show Date',
  }) as HTMLInputElement;
  expect(date.checked).toBe(true);
  expect(date.disabled).toBe(true);
  fireEvent.click(date);
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show Title' }));
  expect(change).toHaveBeenCalledExactlyOnceWith('title', false);
});
it('protects the host minimum while allowing another column to become visible', () => {
  const change = vi.fn();
  render(
    <TableColumnsMenu
      minVisible={1}
      onChange={change}
      columns={[
        { key: 'title', label: 'Title', shown: true },
        { key: 'note', label: 'Note', shown: false },
      ]}
    />,
  );
  fireEvent.click(
    screen.getByText('Toggle properties', { selector: 'summary' }),
  );
  expect(
    (screen.getByRole('checkbox', { name: 'Show Title' }) as HTMLInputElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show Note' }));
  expect(change).toHaveBeenCalledExactlyOnceWith('note', true);
});
it('guards locked and busy actions even when a host menu invokes their callbacks', () => {
  const change = vi.fn();
  const columns = [{ key: 'title', label: 'Title', shown: true, locked: true }];
  const Menu = ({
    items,
  }: import('./ColumnsMenu.js').TableColumnsMenuPresentation) => (
    <button onClick={items[0].toggle}>Host action</button>
  );
  const view = render(
    <TableColumnsMenu columns={columns} onChange={change} Menu={Menu} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Host action' }));
  view.rerender(
    <TableColumnsMenu
      disabled
      columns={[{ ...columns[0], locked: false }]}
      onChange={change}
      Menu={Menu}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Host action' }));
  expect(change).not.toHaveBeenCalled();
});
