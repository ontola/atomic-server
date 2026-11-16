// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  TableRowSelectCheckbox,
  TableRowSelectionActions,
} from './RowSelection.js';

afterEach(cleanup);

it('revokes deletion without preventing the user from clearing selection', () => {
  const onDelete = vi.fn();
  const onClear = vi.fn();
  const { rerender } = render(
    <TableRowSelectionActions
      count={2}
      onDelete={onDelete}
      onClear={onClear}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Delete selected rows' }));
  expect(onDelete).toHaveBeenCalledTimes(1);

  rerender(
    <TableRowSelectionActions
      count={2}
      deleteUnavailable='This table is read-only.'
      onClear={onClear}
    />,
  );
  const deleteButton = screen.getByRole('button', {
    name: 'Delete selected rows',
  });
  expect((deleteButton as HTMLButtonElement).disabled).toBe(true);
  expect(deleteButton.title).toBe('This table is read-only.');
  fireEvent.click(deleteButton);
  expect(onDelete).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
  expect(onClear).toHaveBeenCalledTimes(1);
});

it('blocks both selection actions while locked and restores them when unlocked', () => {
  const onDelete = vi.fn();
  const onClear = vi.fn();
  const { rerender } = render(
    <TableRowSelectionActions
      count={2}
      disabled
      onDelete={onDelete}
      onClear={onClear}
    />,
  );
  for (const button of screen.getAllByRole('button')) fireEvent.click(button);
  expect(onDelete).not.toHaveBeenCalled();
  expect(onClear).not.toHaveBeenCalled();
  rerender(
    <TableRowSelectionActions
      count={2}
      onDelete={onDelete}
      onClear={onClear}
    />,
  );
  for (const button of screen.getAllByRole('button')) fireEvent.click(button);
  expect(onDelete).toHaveBeenCalledTimes(1);
  expect(onClear).toHaveBeenCalledTimes(1);
});

it('selects a row without activating its surrounding grid cell and respects disabling', () => {
  const onToggle = vi.fn();
  const onCellMouseDown = vi.fn();
  const onCellClick = vi.fn();
  const view = (disabled: boolean) => (
    <div
      role='gridcell'
      tabIndex={0}
      onKeyDown={() => undefined}
      onMouseDown={onCellMouseDown}
      onClick={onCellClick}
    >
      <TableRowSelectCheckbox
        checked={false}
        selectionActive={false}
        label='Select row one'
        disabled={disabled}
        onToggle={onToggle}
      />
    </div>
  );
  const { rerender } = render(view(false));
  const checkbox = screen.getByRole('checkbox', { name: 'Select row one' });
  fireEvent.mouseDown(checkbox);
  fireEvent.click(checkbox);
  expect(onToggle).toHaveBeenCalledTimes(1);
  expect(onCellMouseDown).not.toHaveBeenCalled();
  expect(onCellClick).not.toHaveBeenCalled();
  rerender(view(true));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select row one' }));
  expect(onToggle).toHaveBeenCalledTimes(1);
});
