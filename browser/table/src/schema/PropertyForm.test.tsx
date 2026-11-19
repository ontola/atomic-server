// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import {
  TablePropertyForm,
  TablePropertyFields,
  type TablePropertyFieldsModel,
  type TablePropertyCheckboxProps,
} from './PropertyForm.js';
afterEach(cleanup);
const choices = [
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency' },
];
it('guards submission with the current validation and disabled state, including Enter/form dispatch', () => {
  const submit = vi.fn(),
    change = vi.fn();
  const name = { value: 'Count', label: 'Column name', onChange: change };
  const { container, rerender } = render(
    <TablePropertyForm name={name} valid={false} onSubmit={submit}>
      <span>Category fields</span>
    </TablePropertyForm>,
  );
  fireEvent.submit(container.querySelector('form')!);
  expect(submit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Total' } });
  expect(change).toHaveBeenCalledWith('Total');
  rerender(<TablePropertyForm name={name} onSubmit={submit} />);
  fireEvent.submit(container.querySelector('form')!);
  expect(submit).toHaveBeenCalledOnce();
  rerender(<TablePropertyForm name={name} disabled onSubmit={submit} />);
  fireEvent.submit(container.querySelector('form')!);
  expect(submit).toHaveBeenCalledOnce();
  expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
});
it('selects number precision versus currency by the current format, independent of backend class timing', () => {
  const model: TablePropertyFieldsModel = {
    kind: 'number',
    format: {
      label: 'Number format',
      value: 'currency',
      options: choices,
      onChange: vi.fn(),
    },
    currencyFormat: 'currency',
    currency: <span>Currency selector</span>,
    precision: <span>Precision editor</span>,
    range: <span>Range editor</span>,
  };
  const { rerender } = render(<TablePropertyFields model={model} />);
  expect(screen.getByText('Currency selector')).toBeDefined();
  expect(screen.queryByText('Precision editor')).toBeNull();
  rerender(
    <TablePropertyFields
      model={{ ...model, format: { ...model.format, value: 'number' } }}
    />,
  );
  expect(screen.getByText('Precision editor')).toBeDefined();
  expect(screen.queryByText('Currency selector')).toBeNull();
  expect(screen.getByText('Range editor')).toBeDefined();
});

function UnlockedCheckbox({ checked, onChange }: TablePropertyCheckboxProps) {
  return (
    <button
      type='button'
      role='checkbox'
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      Toggle
    </button>
  );
}

it('shares date/relation toggles and blocks callbacks even when a backend primitive ignores disabled', () => {
  const change = vi.fn();
  const { rerender } = render(
    <TablePropertyFields
      model={{
        kind: 'date',
        includeTime: false,
        onIncludeTimeChange: change,
        Checkbox: UnlockedCheckbox,
        formats: <span>Date formats</span>,
      }}
    />,
  );
  fireEvent.click(screen.getByRole('checkbox'));
  expect(change).toHaveBeenCalledWith(true);
  change.mockClear();
  rerender(
    <TablePropertyFields
      disabled
      model={{
        kind: 'relation',
        multiple: false,
        onMultipleChange: change,
        Checkbox: UnlockedCheckbox,
        selector: <span>Class selector</span>,
      }}
    />,
  );
  fireEvent.click(screen.getByRole('checkbox'));
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByText('Class selector')).toBeDefined();
});
it('renders text choices/ranges, select option leaves and explicit unknown categories', () => {
  const change = vi.fn();
  const { rerender } = render(
    <TablePropertyFields
      model={{
        kind: 'text',
        format: {
          label: 'Text format',
          value: 'number',
          options: choices,
          onChange: change,
        },
        range: <span>Length editor</span>,
      }}
    />,
  );
  fireEvent.click(screen.getByRole('radio', { name: 'Currency' }));
  expect(change).toHaveBeenCalledWith('currency');
  expect(screen.getByText('Length editor')).toBeDefined();
  rerender(
    <TablePropertyFields
      model={{
        kind: 'select',
        options: [<span key='tag'>Stored tag</span>],
        createOption: <span>Create tag</span>,
      }}
    />,
  );
  expect(screen.getByText('Stored tag')).toBeDefined();
  expect(screen.getByText('Create tag')).toBeDefined();
  rerender(<TablePropertyFields model={{ kind: 'unknown' }} />);
  expect(screen.getByText('No Type selected')).toBeDefined();
  rerender(<TablePropertyFields model={{ kind: 'none' }} />);
  expect(screen.queryByText('No Type selected')).toBeNull();
});
