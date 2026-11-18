// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  parsePropertyRange,
  PropertyRangeField,
} from './PropertyRangeField.js';
afterEach(cleanup);

it('accepts max-only integer bounds and equal inclusive bounds, including zero', () => {
  expect(parsePropertyRange('', '20', true)).toEqual({
    min: undefined,
    max: 20,
    error: undefined,
  });
  expect(parsePropertyRange('0', '0', true)).toEqual({
    min: 0,
    max: 0,
    error: undefined,
  });
});
it('rejects fractional integer bounds rather than silently flooring them', () => {
  expect(parsePropertyRange('1.5', '', true).error).toBeDefined();
  expect(parsePropertyRange('', '2.5', true).error).toBeDefined();
});
it('accepts fractional numeric ranges and rejects malformed/nonfinite input', () => {
  expect(parsePropertyRange('-1.5', '2,5')).toEqual({
    min: -1.5,
    max: 2.5,
    error: undefined,
  });
  for (const text of ['12abc', 'Infinity', '1e999', '-'])
    expect(parsePropertyRange(text, '').error).toBeDefined();
});
it('checks ordering and nonnegative length bounds', () => {
  expect(parsePropertyRange('3', '2').error).toBeDefined();
  expect(parsePropertyRange('-1', '', true, true).error).toBeDefined();
});
it('retains invalid raw input without publishing a coerced schema value', () => {
  const change = vi.fn(),
    error = vi.fn();
  render(
    <PropertyRangeField
      minValue={0}
      integers
      onChange={change}
      onValidationError={error}
    />,
  );
  const min = screen.getByRole('textbox', { name: 'Minimum' });
  fireEvent.change(min, { target: { value: '-' } });
  expect((min as HTMLInputElement).value).toBe('-');
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('whole numbers');
  expect(error).toHaveBeenLastCalledWith(expect.any(String));
  fireEvent.change(min, { target: { value: '2' } });
  expect(change).toHaveBeenLastCalledWith(2, undefined);
  expect(error).toHaveBeenLastCalledWith(undefined);
});
it('clears a bound as undefined and leaves the other bound intact', () => {
  const change = vi.fn();
  render(<PropertyRangeField minValue={0} maxValue={20} onChange={change} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Minimum' }), {
    target: { value: '' },
  });
  expect(change).toHaveBeenLastCalledWith(undefined, 20);
});
