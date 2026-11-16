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
