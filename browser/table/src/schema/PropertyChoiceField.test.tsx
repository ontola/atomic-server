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
it('keeps unsupported saved bindings visible without substituting a default', () => {
  const change = vi.fn();
  render(
    <PropertyChoiceField
      mode='select'
      label='Type'
      value='custom:v2'
      options={options}
      onChange={change}
    />,
  );
  const select = screen.getByRole('combobox', {
    name: 'Type',
  }) as HTMLSelectElement;
  expect(select.value).toBe('custom:v2');
  expect(
    (screen.getByRole('option', { name: 'custom:v2' }) as HTMLOptionElement)
      .disabled,
  ).toBe(true);
  expect(change).not.toHaveBeenCalled();
  fireEvent.change(select, { target: { value: 'rich' } });
  expect(change).toHaveBeenCalledExactlyOnceWith('rich');
});
it('does not mutate through disabled or unknown choices', () => {
  const change = vi.fn();
  render(
    <PropertyChoiceField
      mode='select'
      label='Type'
      value='plain'
      options={[options[0], { ...options[1], disabled: true }]}
      onChange={change}
    />,
  );
  const select = screen.getByRole('combobox');
  fireEvent.change(select, { target: { value: 'rich' } });
  fireEvent.change(select, { target: { value: 'unknown' } });
  expect(change).not.toHaveBeenCalled();
});
it('keeps independent radio groups from changing each other', () => {
  render(
    <>
      <PropertyChoiceField
        label='First'
        value='plain'
        options={options}
        onChange={() => {}}
      />
      <PropertyChoiceField
        label='Second'
        value='plain'
        options={options}
        onChange={() => {}}
      />
    </>,
  );
  const radios = screen.getAllByRole('radio') as HTMLInputElement[];
  expect(radios[0].name).toBe(radios[1].name);
  expect(radios[0].name).not.toBe(radios[2].name);
});
