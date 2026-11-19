// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TablePropertyHeading } from './PropertyHeading.js';
afterEach(cleanup);
it('keeps required labels, explicit sort state and backend command leaves in the actual heading', () => {
  const sort = vi.fn();
  render(
    <TablePropertyHeading
      label='Quantity'
      required
      sorted='descending'
      onSort={sort}
      sortDescription='Sort by Quantity'
    >
      <button type='button'>Column commands</button>
    </TablePropertyHeading>,
  );
  const label = screen.getByRole('button', { name: 'Quantity*' });
  expect(label.getAttribute('aria-description')).toBe('Sort by Quantity');
  fireEvent.click(label);
  expect(sort).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Column commands' })).toBeTruthy();
});
it('delegates the whole heading context target and preserves the grid drag activation', () => {
  const context = vi.fn(),
    drag = vi.fn();
  const view = render(
    <TablePropertyHeading
      label='Title'
      onSort={() => {}}
      onContextMenu={context}
      dragListeners={{ onPointerDown: drag }}
    />,
  );
  fireEvent.contextMenu(view.container.firstChild!);
  expect(context).toHaveBeenCalledOnce();
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Drag column' }));
  expect(drag).toHaveBeenCalledOnce();
});
it('does not advertise an unavailable sort as an active command', () => {
  const sort = vi.fn();
  render(
    <TablePropertyHeading
      label='Optional field'
      disabled
      onSort={sort}
      sortUnavailableReason='Ordering optional columns is unavailable.'
    />,
  );
  const button = screen.getByRole('button', { name: 'Optional field' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(button.getAttribute('aria-description')).toBe(
    'Ordering optional columns is unavailable.',
  );
  fireEvent.click(button);
  expect(sort).not.toHaveBeenCalled();
});
