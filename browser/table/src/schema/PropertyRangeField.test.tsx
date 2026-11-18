// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { InputHTMLAttributes, PropsWithChildren } from 'react';
import {
  PropertyRangeField,
  validatePropertyRange,
} from './PropertyRangeField.js';

afterEach(cleanup);

function Input({
  $invalid: _invalid,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { $invalid?: boolean }) {
  return <input {...props} />;
}

function Container({ children }: PropsWithChildren) {
  return <div>{children}</div>;
}

it('preserves baseline floor conversion while leaving the uncontrolled draft visible', () => {
  const change = vi.fn();
  const { rerender } = render(
    <PropertyRangeField
      Input={Input}
      Container={Container}
      minValue={2}
      maxValue={8}
      round
      onChange={change}
    />,
  );
  const minimum = screen.getByPlaceholderText('min') as HTMLInputElement;
  fireEvent.change(minimum, { target: { value: '1.8' } });
  expect(change).toHaveBeenLastCalledWith(1, 8);
  rerender(
    <PropertyRangeField
      Input={Input}
      Container={Container}
      minValue={1}
      maxValue={8}
      round
      onChange={change}
    />,
  );
  expect(minimum.value).toBe('1.8');
});

it('keeps opposite bounds, clears empty input and delegates blur unchanged', () => {
  const change = vi.fn(),
    blur = vi.fn();
  render(
    <PropertyRangeField
      Input={Input}
      Container={Container}
      minValue={2}
      maxValue={8}
      round
      onChange={change}
      onBlur={blur}
    />,
  );
  const maximum = screen.getByPlaceholderText('max');
  fireEvent.change(maximum, { target: { value: '' } });
  fireEvent.blur(maximum);
  expect(change).toHaveBeenLastCalledWith(2, undefined);
  expect(blur).toHaveBeenCalledOnce();
});

it('retains baseline max-only and equal-limit validation quirks for separate review', () => {
  expect(validatePropertyRange(undefined, 4, true)).toBe(
    'Value should be a round number.',
  );
  expect(validatePropertyRange(4, 4, true)).toBe('Min must be a less than max');
  expect(validatePropertyRange(1, 4, true)).toBeUndefined();
  expect(
    validatePropertyRange(4, 4, true, { rounded: 'integer', order: 'order' }),
  ).toBe('order');
});
