// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import type { RepeatParse } from '@tomic/lib';
import { buildTheme } from '../../../styling';
import { RepeatField } from './RepeatField';

afterEach(cleanup);

// Thursday 1 October 2026.
const anchor = { date: '2026-10-01' };

function renderField(parsed: RepeatParse, onChange = vi.fn()) {
  const utils = render(
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <RepeatField
        parsed={parsed}
        anchor={anchor}
        onChange={onChange}
        json={<pre data-testid='json'>{'{}'}</pre>}
      />
    </ThemeProvider>,
  );

  return { ...utils, onChange };
}

it('makes a row repeat weekly on its own weekday', () => {
  const { getByLabelText, onChange } = renderField({ kind: 'none' });
  fireEvent.change(getByLabelText('Repeat'), { target: { value: 'weekly' } });
  expect(onChange).toHaveBeenCalledWith({
    kind: 'rule',
    rule: {
      frequency: 'weekly',
      interval: 1,
      weekdays: ['TH'],
      monthlyBy: 'date',
      end: { type: 'never' },
    },
  });
});

it('shows a rule it cannot represent as Custom, with its JSON a click away', () => {
  const { getByLabelText, getByTestId, getByRole, queryByTestId } = renderField(
    { kind: 'custom' },
  );
  expect((getByLabelText('Repeat') as HTMLSelectElement).value).toBe('custom');
  expect(getByTestId('repeat-summary').textContent).toBe('Custom');
  expect(queryByTestId('json')).toBeNull();
  fireEvent.click(getByRole('button', { name: 'Show JSON' }));
  expect(getByTestId('json')).toBeTruthy();
});
