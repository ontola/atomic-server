// @vitest-environment jsdom
// @wc-ignore-file
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { urls } from '@tomic/react';
import { afterEach, expect, it, vi } from 'vitest';
import { buildTheme, ThemeProvider } from '../../../../test/providers.js';
import { DateFormatPicker } from './DateFormatPicker.js';

afterEach(cleanup);

it('shows a previously stored format until the user selects a replacement', () => {
  const onChange = vi.fn();
  render(
    <ThemeProvider theme={buildTheme()}>
      <DateFormatPicker value='legacy-format' onChange={onChange} />
    </ThemeProvider>,
  );
  const saved = screen.getByRole<HTMLInputElement>('radio', {
    name: 'Saved format',
  });
  expect(saved.checked).toBe(true);
  expect(saved.value).toBe('legacy-format');
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('radio', { name: 'Long' }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith(
    urls.instances.dateFormats.localLong,
  );
});
