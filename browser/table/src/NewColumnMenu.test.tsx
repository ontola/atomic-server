// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  TableNewColumnMenu,
  type TableNewColumnMenuPresentation,
} from './NewColumnMenu.js';
afterEach(cleanup);

function Probe({ items, disabled }: TableNewColumnMenuPresentation) {
  return (
    <div data-testid='menu' data-disabled={disabled}>
      {items.map(item => (
        <button key={item.key} title={item.reason} onClick={item.run}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

it('guards missing, disabled and globally disabled actions even in custom presentations', () => {
  const text = vi.fn(),
    number = vi.fn();
  const { rerender } = render(
    <TableNewColumnMenu
      Menu={Probe}
      actions={{
        text: { run: text },
        number: { run: number, disabled: true, reason: 'Migration required' },
      }}
    />,
  );
  expect(screen.getAllByRole('button')).toHaveLength(12);
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  fireEvent.click(screen.getByRole('button', { name: 'Number' }));
  fireEvent.click(screen.getByRole('button', { name: 'Date' }));
  expect(text).toHaveBeenCalledOnce();
  expect(number).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Number' }).title).toBe(
    'Migration required',
  );
  rerender(
    <TableNewColumnMenu
      Menu={Probe}
      disabled
      actions={{ text: { run: text } }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  expect(text).toHaveBeenCalledOnce();
  expect(screen.getByTestId('menu').dataset.disabled).toBe('true');
});
it('dispatches the current owner callback after rerender', () => {
  const oldOwner = vi.fn(),
    currentOwner = vi.fn();
  const { rerender } = render(
    <TableNewColumnMenu Menu={Probe} actions={{ text: { run: oldOwner } }} />,
  );
  rerender(
    <TableNewColumnMenu
      Menu={Probe}
      actions={{ text: { run: currentOwner } }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  expect(oldOwner).not.toHaveBeenCalled();
  expect(currentOwner).toHaveBeenCalledOnce();
});
