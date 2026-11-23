// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  TableRowSelectCheckbox,
  TableRowSelectionActions,
} from './RowSelection.js';

afterEach(cleanup);

it('toggles without triggering the grid mouse handlers or becoming its input editor', () => {
  const toggle = vi.fn();
  const gridMouse = vi.fn();
  const gridClick = vi.fn();
  const { container, rerender } = render(
    <div
      role='grid'
      onMouseDown={gridMouse}
      onClick={gridClick}
      onKeyDown={vi.fn()}
    >
      <TableRowSelectCheckbox
        checked={false}
        selectionActive={false}
        label='Select row 1'
        onToggle={toggle}
      />
    </div>,
  );
  const checkbox = screen.getByRole('checkbox', { name: 'Select row 1' });
  fireEvent.mouseDown(checkbox);
  fireEvent.click(checkbox);
  expect(toggle).toHaveBeenCalledOnce();
  expect(gridMouse).not.toHaveBeenCalled();
  expect(gridClick).not.toHaveBeenCalled();
  expect(container.querySelector('input')).toBeNull();
  expect(checkbox.getAttribute('aria-checked')).toBe('false');
  rerender(
    <TableRowSelectCheckbox
      checked
      selectionActive
      label='Select row 1'
      onToggle={toggle}
    />,
  );
  expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe(
    'true',
  );
  expect(
    container.querySelector('[data-row-select]')?.getAttribute('data-active'),
  ).toBe('true');
});

it('keeps the supplied host button, translated labels and explicit actions', () => {
  const onDelete = vi.fn();
  const onClear = vi.fn();
  render(
    <TableRowSelectionActions
      count={2}
      onDelete={onDelete}
      onClear={onClear}
      Button={props => <button {...props} data-host-button />}
      messages={{
        label: 'Geselecteerde rijen',
        count: '2 geselecteerd',
        delete: 'Verwijderen',
        clear: 'Wissen',
      }}
    />,
  );
  expect(
    screen.getByRole('toolbar', { name: 'Geselecteerde rijen' }).textContent,
  ).toContain('2 geselecteerd');
  const deleteButton = screen.getByTitle('Verwijderen');
  expect(deleteButton.hasAttribute('data-host-button')).toBe(true);
  fireEvent.click(deleteButton);
  fireEvent.click(screen.getByTitle('Wissen'));
  expect(onDelete).toHaveBeenCalledOnce();
  expect(onClear).toHaveBeenCalledOnce();
});

it('does not render selection actions without selected rows', () => {
  render(
    <TableRowSelectionActions
      count={0}
      onDelete={vi.fn()}
      onClear={vi.fn()}
      Button={props => <button {...props} />}
    />,
  );
  expect(screen.queryByRole('toolbar')).toBeNull();
});

it('provides canonical buttons when a host does not override them', () => {
  const onDelete = vi.fn();
  const onClear = vi.fn();
  render(
    <TableRowSelectionActions
      count={1}
      onDelete={onDelete}
      onClear={onClear}
    />,
  );
  fireEvent.click(screen.getByTitle('Delete selected rows'));
  fireEvent.click(screen.getByTitle('Clear selection'));
  expect(onDelete).toHaveBeenCalledOnce();
  expect(onClear).toHaveBeenCalledOnce();
});
