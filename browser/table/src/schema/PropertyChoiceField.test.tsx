// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PropertyChoiceField } from './PropertyChoiceField.js';
afterEach(cleanup);
const options = [
  { value: 'plain', label: 'Plain text' },
  { value: 'rich', label: 'Rich text' },
];

it('selects by stable value and delegates one enabled radio choice', () => {
  const change = vi.fn();
  render(
    <PropertyChoiceField
      label='Format'
      value='plain'
      options={options}
      onChange={change}
    />,
  );
  expect(
    (screen.getByRole('radio', { name: 'Plain text' }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: 'Rich text' }));
  expect(change).toHaveBeenCalledExactlyOnceWith('rich');
});
