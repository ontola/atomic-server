// @vitest-environment jsdom
// @wc-ignore-file
import { Datatype, type Property } from '@tomic/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TableFilterValueInput } from './TableFilterValueInput.js';

vi.mock('./RowActionDialog.js', () => ({
  TagOption: ({ subject }: { subject: string }) => (
    <option value={subject}>{subject}</option>
  ),
}));
vi.mock('@tomic/resource-ui/components/forms/ResourceSelector/index', () => ({
  ResourceSelector: ({
    value,
    disabled,
    setSubject,
  }: {
    value?: string;
    disabled?: boolean;
    setSubject: (subject: string) => void;
  }) => (
    <input
      aria-label='Reference'
      value={value ?? ''}
      disabled={disabled}
      onChange={event => setSubject(event.target.value)}
    />
  ),
}));

afterEach(cleanup);
const property = (datatype: Datatype, allowsOnly?: string[]) =>
  ({ datatype, allowsOnly }) as Property;

it('retains incomplete numeric drafts, whitespace and exact large integers', () => {
  const change = vi.fn();
  const props = {
    property: property(Datatype.INTEGER),
    onChange: change,
    normalizeNumbers: true,
  };
  const view = render(<TableFilterValueInput {...props} value='1e' />);
  const input = screen.getByRole('textbox', {
    name: 'Filter value',
  }) as HTMLInputElement;
  expect(input.value).toBe('1e');
  expect(input.inputMode).toBe('decimal');
  fireEvent.blur(input);
  expect(change).not.toHaveBeenCalled();
  view.rerender(<TableFilterValueInput {...props} value='9007199254740993' />);
  fireEvent.blur(input);
  expect(input.value).toBe('9007199254740993');
  expect(change).not.toHaveBeenCalled();
  view.rerender(<TableFilterValueInput {...props} value='   ' />);
  fireEvent.blur(input);
  expect(change).not.toHaveBeenCalled();
});

it('normalizes complete numeric strings only under the explicit Atomic policy', () => {
  const change = vi.fn();
  const props = {
    property: property(Datatype.FLOAT),
    onChange: change,
    value: '0.00002500',
  };
  const view = render(<TableFilterValueInput {...props} />);
  const input = screen.getByRole('textbox', { name: 'Filter value' });
  fireEvent.blur(input);
  expect(change).not.toHaveBeenCalled();
  view.rerender(<TableFilterValueInput {...props} normalizeNumbers />);
  fireEvent.blur(input);
  expect(change).toHaveBeenCalledExactlyOnceWith('0.000025');
});

it('keeps unavailable stored choices and false/zero values visible', () => {
  const change = vi.fn();
  const props = {
    property: property(Datatype.STRING, ['available']),
    onChange: change,
  };
  const view = render(<TableFilterValueInput {...props} value='removed' />);
  const select = screen.getByRole('combobox', {
    name: 'Filter value',
  }) as HTMLSelectElement;
  expect(select.value).toBe('removed');
  expect(
    (screen.getByRole('option', { name: 'removed' }) as HTMLOptionElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(select, { target: { value: 'available' } });
  expect(change).toHaveBeenCalledExactlyOnceWith('available');
  view.rerender(
    <TableFilterValueInput
      property={property(Datatype.BOOLEAN)}
      value='false'
      onChange={change}
    />,
  );
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(
    'false',
  );
  view.rerender(
    <TableFilterValueInput
      property={property(Datatype.INTEGER)}
      value='0'
      onChange={change}
    />,
  );
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('0');
});

it('preserves incomplete JSON and canonicalizes complete JSON on blur', () => {
  const change = vi.fn();
  const props = { property: property(Datatype.JSON), onChange: change };
  const view = render(<TableFilterValueInput {...props} value='{"b":' />);
  const input = screen.getByRole('textbox');
  fireEvent.blur(input);
  expect(change).not.toHaveBeenCalled();
  view.rerender(<TableFilterValueInput {...props} value='{"b":2,"a":1}' />);
  fireEvent.blur(input);
  expect(change).toHaveBeenCalledExactlyOnceWith('{"a":1,"b":2}');
});

it('guards disabled values, normalization and resource-picker callbacks', () => {
  const change = vi.fn();
  const props = {
    value: '2.00',
    onChange: change,
    disabled: true,
    normalizeNumbers: true,
  };
  const view = render(
    <TableFilterValueInput {...props} property={property(Datatype.FLOAT)} />,
  );
  const input = screen.getByRole('textbox') as HTMLInputElement;
  expect(input.disabled).toBe(true);
  fireEvent.change(input, { target: { value: '3' } });
  fireEvent.blur(input);
  expect(change).not.toHaveBeenCalled();
  view.rerender(
    <TableFilterValueInput
      {...props}
      property={property(Datatype.ATOMIC_URL)}
    />,
  );
  const reference = screen.getByRole('textbox', {
    name: 'Reference',
  }) as HTMLInputElement;
  expect(reference.disabled).toBe(true);
  fireEvent.change(reference, { target: { value: 'other' } });
  expect(change).not.toHaveBeenCalled();
});
