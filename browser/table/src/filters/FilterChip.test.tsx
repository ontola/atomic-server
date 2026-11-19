// @vitest-environment jsdom
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TableFilterChip, type TableFilterChipProps } from './FilterChip.js';

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(cleanup);
afterAll(() => vi.unstubAllGlobals());
const props: TableFilterChipProps = {
  filter: { property: 'amount', operator: 'gte', value: '' },
  label: 'Amount',
  operatorLabel: 'at least',
  operators: [
    { value: 'eq', label: 'is' },
    { value: 'gte', label: 'at least' },
  ],
  onValueChange: () => {},
  onOperatorChange: () => {},
  onRemove: () => {},
  renderValueInput: state => (
    <input
      aria-label='Host value'
      value={state.value}
      onChange={event => state.onChange(event.target.value)}
    />
  ),
  renderValueSummary: value => value,
};

describe('existing filter-chip interactions', () => {
  it('opens an empty filter and delegates stored-value editing to the host', () => {
    const onValueChange = vi.fn();
    const onOperatorChange = vi.fn();
    const onRemove = vi.fn();
    render(
      <TableFilterChip
        {...props}
        onValueChange={onValueChange}
        onOperatorChange={onOperatorChange}
        onRemove={onRemove}
        messages={{ remove: 'Verwijder filter' }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Host value'), {
      target: { value: '12' },
    });
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('12');
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Filter operator' }),
      { target: { value: 'eq' } },
    );
    expect(onOperatorChange).toHaveBeenCalledExactlyOnceWith('eq');
    fireEvent.click(screen.getByRole('button', { name: 'Verwijder filter' }));
    expect(onRemove).toHaveBeenCalledExactlyOnceWith();
  });

  it('retains the existing numeric browser-input policy for derived filters', () => {
    const onValueChange = vi.fn();
    render(
      <TableFilterChip
        {...props}
        filter={{ derived: 'duration', operator: 'gte', value: '' }}
        derivedUnit={{ suffix: 'hours', allowsNow: false }}
        onValueChange={onValueChange}
      />,
    );
    const input = screen.getByTestId(
      'derived-filter-value',
    ) as HTMLInputElement;
    expect(input.type).toBe('number');
    expect(input.step).toBe('any');
    fireEvent.change(input, { target: { value: '1.5' } });
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('1.5');
    expect(screen.queryByLabelText('Host value')).toBeNull();
  });

  it('retains now/date transitions without converting the host value', () => {
    const onValueChange = vi.fn();
    const filter = { derived: 'due', operator: 'gte' as const, value: 'now' };
    const view = render(
      <TableFilterChip
        {...props}
        filter={filter}
        derivedUnit={{ suffix: '', allowsNow: true }}
        onValueChange={onValueChange}
      />,
    );
    fireEvent.click(screen.getByTestId('filter-chip'));
    expect(screen.queryByTestId('derived-filter-value')).toBeNull();
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Compare against' }),
      { target: { value: 'date' } },
    );
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('');
    view.rerender(
      <TableFilterChip
        {...props}
        filter={{ ...filter, value: '' }}
        derivedUnit={{ suffix: '', allowsNow: true }}
        onValueChange={onValueChange}
      />,
    );
    expect(
      (screen.getByTestId('derived-filter-value') as HTMLInputElement).type,
    ).toBe('date');
  });
});

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
it('locks an already-open popup during a backend operation', async () => {
  const remove = vi.fn(),
    change = vi.fn();
  const lockedProps = {
    ...base,
    filter: { property: 'amount', operator: 'eq' as const, value: '' },
    onRemove: remove,
    onValueChange: change,
  };
  const view = render(
    <TableFilterChip {...lockedProps} valueInputProps={{ kind: 'number' }} />,
  );
  await screen.findByRole('dialog');
  view.rerender(
    <TableFilterChip
      {...lockedProps}
      disabled
      valueInputProps={{ kind: 'number' }}
    />,
  );
  expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove filter' }));
  expect(remove).not.toHaveBeenCalled();
});
