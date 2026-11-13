// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PropertyPrecisionField } from './PropertyPrecisionField.js';
import { PropertyDateFormatField } from './PropertyDateFormatField.js';
afterEach(cleanup);

it('retains invalid precision text without truncation, coercion or commit', () => {
  const change = vi.fn(),
    invalid = vi.fn();
  render(
    <PropertyPrecisionField
      value={2}
      onChange={change}
      onValidationError={invalid}
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Decimal Places' });

  for (const text of ['1.5', '1e', '-1', '21', 'Infinity']) {
    fireEvent.change(input, { target: { value: text } });
    expect((input as HTMLInputElement).value).toBe(text);
    expect(screen.getByRole('alert').textContent).toContain('whole number');
  }

  expect(change).not.toHaveBeenCalled();
  expect(invalid).toHaveBeenLastCalledWith(expect.any(String));
  fireEvent.change(input, { target: { value: '0' } });
  expect(change).toHaveBeenLastCalledWith(0);
  fireEvent.change(input, { target: { value: '20' } });
  expect(change).toHaveBeenLastCalledWith(20);
  fireEvent.change(input, { target: { value: '' } });
  expect(change).toHaveBeenLastCalledWith(undefined);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(invalid).toHaveBeenLastCalledWith(undefined);
});
it('locks precision editing and resets raw text only for a different mounted draft', () => {
  const change = vi.fn();
  const { rerender } = render(
    <PropertyPrecisionField key='first' value={2} onChange={change} />,
  );
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '-' } });
  rerender(
    <PropertyPrecisionField key='first' value={2} disabled onChange={change} />,
  );
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('-');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '4' } });
  expect(change).not.toHaveBeenCalled();
  rerender(<PropertyPrecisionField key='second' value={5} onChange={change} />);
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('5');
});
const options = [
  { value: 'numeric', label: 'Numeric', example: '13/11/2026' },
  { value: 'long', label: 'Long', example: '13 November 2026' },
  {
    value: 'relative',
    label: 'Relative',
    example: 'yesterday',
    disabled: true,
  },
];
it('keeps unknown date formats visible and only commits an enabled explicit choice', () => {
  const change = vi.fn();
  render(
    <PropertyDateFormatField
      value='retired'
      options={options}
      onChange={change}
    />,
  );
  const retired = screen.getByRole('radio', { name: 'retired' });
  expect((retired as HTMLInputElement).checked).toBe(true);
  expect((retired as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: 'Relative' }));
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('radio', { name: 'Long' }));
  expect(change).toHaveBeenCalledWith('long');
  expect(screen.getByText('13 November 2026')).toBeDefined();
});
it('isolates date-format radio groups across property drafts and respects read-only state', () => {
  const change = vi.fn();
  render(
    <>
      <PropertyDateFormatField
        label='First'
        value='numeric'
        options={options}
        onChange={change}
      />
      <PropertyDateFormatField
        label='Second'
        value='long'
        disabled
        options={options}
        onChange={change}
      />
    </>,
  );
  const radios = screen.getAllByRole('radio');
  expect((radios[0] as HTMLInputElement).name).not.toBe(
    (radios[3] as HTMLInputElement).name,
  );
  fireEvent.click(radios[3]);
  expect(change).not.toHaveBeenCalled();
});
