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
    expect(screen.queryByLabelText('Host value')).toBeNull();
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

it('repairs an unsupported stored operator on an equality-only backend', () => {
  const onOperatorChange = vi.fn();
  render(
    <TableFilterChip
      {...props}
      filter={{ property: 'name', operator: 'contains', value: '' }}
      operators={[{ value: 'eq', label: 'is' }]}
      operatorLabel='contains'
      onOperatorChange={onOperatorChange}
    />,
  );
  const select = screen.getByRole('combobox', {
    name: 'Filter operator',
  }) as HTMLSelectElement;
  expect(select.value).toBe('contains');
  expect(
    (screen.getByRole('option', { name: 'contains' }) as HTMLOptionElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(select, { target: { value: 'eq' } });
  expect(onOperatorChange).toHaveBeenCalledExactlyOnceWith('eq');
});

it('keeps a malformed stored numeric derived value editable as text', () => {
  const onValueChange = vi.fn();
  render(
    <TableFilterChip
      {...props}
      filter={{ derived: 'duration', operator: 'gte', value: '1e' }}
      derivedUnit={{ suffix: 'hours', allowsNow: false }}
      onValueChange={onValueChange}
    />,
  );
  fireEvent.click(screen.getByTestId('filter-chip'));
  const input = screen.getByTestId('derived-filter-value') as HTMLInputElement;
  expect(input.type).toBe('text');
  expect(input.value).toBe('1e');
  fireEvent.change(input, { target: { value: '1e2' } });
  expect(onValueChange).toHaveBeenCalledExactlyOnceWith('1e2');
});

it('locks an already-open filter and guards callbacks while busy', () => {
  const onValueChange = vi.fn(),
    onOperatorChange = vi.fn(),
    onRemove = vi.fn();
  const renderValueInput: TableFilterChipProps['renderValueInput'] = state => (
    <input
      aria-label='Guarded host value'
      value={state.value}
      disabled={state.disabled}
      onChange={event => state.onChange(event.target.value)}
    />
  );
  const callbacks = {
    onValueChange,
    onOperatorChange,
    onRemove,
    renderValueInput,
  };
  const view = render(<TableFilterChip {...props} {...callbacks} />);
  view.rerender(<TableFilterChip {...props} {...callbacks} disabled />);
  const input = screen.getByRole('textbox', {
    name: 'Guarded host value',
  }) as HTMLInputElement;
  expect(input.disabled).toBe(true);
  const operator = screen.getByRole('combobox', {
    name: 'Filter operator',
  }) as HTMLSelectElement;
  expect(operator.disabled).toBe(true);
  fireEvent.change(input, { target: { value: '12' } });
  fireEvent.change(operator, { target: { value: 'eq' } });
  fireEvent.click(screen.getByRole('button', { name: 'Remove filter' }));
  expect(onValueChange).not.toHaveBeenCalled();
  expect(onOperatorChange).not.toHaveBeenCalled();
  expect(onRemove).not.toHaveBeenCalled();
});

it('retains unavailable columns as removable filters without evaluating their editor', () => {
  const onRemove = vi.fn(),
    renderValueInput = vi.fn();
  render(
    <TableFilterChip
      {...props}
      unavailable
      onRemove={onRemove}
      renderValueInput={renderValueInput}
    />,
  );
  expect(screen.getByText('This column is unavailable.')).toBeTruthy();
  expect(renderValueInput).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove filter' }));
  expect(onRemove).toHaveBeenCalledExactlyOnceWith();
});

it.each(['disabled', 'unavailable'] as const)(
  'guards a retained host callback when the filter becomes %s',
  lock => {
    const onValueChange = vi.fn();
    let retainedChange!: (value: string) => void;

    const renderValueInput: TableFilterChipProps['renderValueInput'] =
      state => {
        retainedChange ??= state.onChange;

        return (
          <input
            aria-label='Retained editor'
            value={state.value}
            onChange={event => state.onChange(event.target.value)}
          />
        );
      };

    const callbacks = { onValueChange, renderValueInput };
    const view = render(<TableFilterChip {...props} {...callbacks} />);
    const originalChange = retainedChange;
    view.rerender(
      <TableFilterChip {...props} {...callbacks} {...{ [lock]: true }} />,
    );
    originalChange('stale value');
    expect(onValueChange).not.toHaveBeenCalled();
  },
);
