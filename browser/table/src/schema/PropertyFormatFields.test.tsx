// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PropertyDateFormatField } from './PropertyDateFormatField.js';
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
