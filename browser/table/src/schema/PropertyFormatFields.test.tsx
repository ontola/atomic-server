// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PropertyDateFormatField } from './PropertyDateFormatField.js';
import { PropertyPrecisionField } from './PropertyPrecisionField.js';
afterEach(cleanup);
it('shows the existing format examples and delegates a radio selection', () => {
  const change = vi.fn();
  render(
    <PropertyDateFormatField
      value='numeric'
      options={[
        { value: 'numeric', label: 'Numeric', example: '13/11/2026' },
        { value: 'long', label: 'Long', example: '13 November 2026' },
      ]}
      onChange={change}
    />,
  );
  expect(
    (screen.getByRole('radio', { name: 'Numeric' }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(screen.getByText('13 November 2026')).toBeDefined();
  fireEvent.click(screen.getByRole('radio', { name: 'Long' }));
  expect(change).toHaveBeenCalledExactlyOnceWith('long');
});

it('keeps precision uncontrolled and delegates host validation and blur', () => {
  const change = vi.fn(),
    blur = vi.fn();
  const props = { label: 'Decimal Places', onChange: change, onBlur: blur };
  const result = render(<PropertyPrecisionField {...props} value={2} />);
  const input = screen.getByRole('spinbutton', {
    name: 'Decimal Places',
  }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: '3' } });
  expect(change).toHaveBeenCalledOnce();
  fireEvent.blur(input);
  expect(blur).toHaveBeenCalledOnce();
  result.rerender(
    <PropertyPrecisionField {...props} value={7} error='Invalid precision' />,
  );
  expect(input.value).toBe('3');
  expect(input.min).toBe('0');
  expect(input.max).toBe('20');
  expect(screen.getByText('Invalid precision')).toBeDefined();
});

it('isolates concurrent date formats into separate radio groups', () => {
  const options = [
    { value: 'numeric', label: 'Numeric', example: '13/11/2026' },
    { value: 'long', label: 'Long', example: '13 November 2026' },
  ];
  render(
    <>
      <PropertyDateFormatField
        value='numeric'
        options={options}
        onChange={vi.fn()}
      />
      <PropertyDateFormatField
        value='long'
        options={options}
        onChange={vi.fn()}
      />
    </>,
  );
  const [first, second] = screen.getAllByRole<HTMLInputElement>('radio', {
    name: 'Numeric',
  });
  expect(first.name).not.toBe(second.name);
  expect(first.checked).toBe(true);
});
