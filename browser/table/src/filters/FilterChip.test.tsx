// @vitest-environment jsdom
import { afterEach, beforeAll, afterAll, it, expect, vi } from 'vitest';
import { cleanup, render, fireEvent, screen } from '@testing-library/react';
import { TableFilterChip } from './FilterChip.js';
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
const base = {
  label: 'Amount',
  operatorLabel: 'at least',
  operators: [
    { value: 'gte' as const, label: 'at least' },
    { value: 'eq' as const, label: 'is' },
  ],
  onValueChange: vi.fn(),
  onOperatorChange: vi.fn(),
  onRemove: vi.fn(),
};
it('opens an empty filter, retains invalid numeric text and delegates only a declared operator', async () => {
  const value = vi.fn(),
    operator = vi.fn();
  render(
    <TableFilterChip
      {...base}
      filter={{ property: 'amount', operator: 'gte', value: '' }}
      valueInputProps={{ kind: 'number' }}
      messages={{ value: 'Amount filter' }}
      onValueChange={value}
      onOperatorChange={operator}
    />,
  );
  await screen.findByRole('dialog', { name: 'Amount' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Amount filter' }), {
    target: { value: '1e' },
  });
  expect(value).toHaveBeenCalledExactlyOnceWith('1e');
  fireEvent.change(screen.getByRole('combobox', { name: 'Filter operator' }), {
    target: { value: 'eq' },
  });
  expect(operator).toHaveBeenCalledExactlyOnceWith('eq');
});
it('keeps unavailable filter targets removable and closes the popup before removal', async () => {
  const remove = vi.fn(),
    open = vi.fn();
  render(
    <TableFilterChip
      {...base}
      label='Unavailable column'
      unavailable
      onOpenChange={open}
      onRemove={remove}
      filter={{ derived: 'removed', operator: 'eq', value: 'retained' }}
    />,
  );
  fireEvent.click(screen.getByTestId('filter-chip'));
  await screen.findByText('This column is unavailable.');
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Remove filter' }));
  expect(open).toHaveBeenLastCalledWith(false);
  expect(remove).toHaveBeenCalledOnce();
});
it('preserves an unsupported computed operator and keeps an invalid now literal editable for numeric units', async () => {
  const view = render(
    <TableFilterChip
      {...base}
      operatorLabel='contains'
      filter={{ derived: 'duration', operator: 'contains', value: 'now' }}
      derivedUnit={{ suffix: 'hours', allowsNow: false }}
    />,
  );
  fireEvent.click(screen.getByTestId('filter-chip'));
  const select = await screen.findByRole('combobox', {
    name: 'Filter operator',
  });
  expect((select as HTMLSelectElement).value).toBe('contains');
  expect(
    (screen.getByRole('textbox', { name: 'Filter value' }) as HTMLInputElement)
      .value,
  ).toBe('now');
  view.unmount();
});
it('requests a fixed-date value when switching from now', async () => {
  const change = vi.fn();
  render(
    <TableFilterChip
      {...base}
      filter={{ derived: 'due', operator: 'eq', value: 'now' }}
      derivedUnit={{ suffix: '', allowsNow: true }}
      onValueChange={change}
    />,
  );
  fireEvent.click(screen.getByTestId('filter-chip'));
  const mode = await screen.findByRole('combobox', { name: 'Compare against' });
  fireEvent.change(mode, { target: { value: 'date' } });
  expect(change).toHaveBeenCalledExactlyOnceWith('');
});
it('allows repairing a stored unsupported operator even when the backend supports only equality', async () => {
  const change = vi.fn();
  render(
    <TableFilterChip
      {...base}
      operators={[{ value: 'eq', label: 'is' }]}
      filter={{ property: 'title', operator: 'contains', value: 'a' }}
      operatorLabel='contains'
      onOperatorChange={change}
    />,
  );
  fireEvent.click(screen.getByTestId('filter-chip'));
  const select = await screen.findByRole('combobox', {
    name: 'Filter operator',
  });
  expect((select as HTMLSelectElement).value).toBe('contains');
  fireEvent.change(select, { target: { value: 'eq' } });
  expect(change).toHaveBeenCalledExactlyOnceWith('eq');
});
