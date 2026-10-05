// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { buildTheme } from '../../../styling';
import { EventTimeFields } from './EventTimeFields';

afterEach(cleanup);

function renderFields(props: Partial<Parameters<typeof EventTimeFields>[0]>) {
  const onChange = vi.fn();
  const utils = render(
    <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
      <EventTimeFields allDay onChange={onChange} {...props} />
    </ThemeProvider>,
  );

  return { ...utils, onChange };
}

it('reveals start and end times when All day is unchecked', () => {
  const { getByLabelText, queryByLabelText, onChange } = renderFields({});
  expect(queryByLabelText('Start time')).toBeNull();

  fireEvent.click(getByLabelText('All day'));
  expect(getByLabelText('Start time')).toBeTruthy();
  expect(getByLabelText('End time')).toBeTruthy();
  // Nothing is stored until a time is given.
  expect(onChange).not.toHaveBeenCalled();

  fireEvent.change(getByLabelText('Start time'), {
    target: { value: '09:30' },
  });
  fireEvent.blur(getByLabelText('Start time'));
  expect(onChange).toHaveBeenLastCalledWith({ start: '09:30', end: undefined });

  fireEvent.change(getByLabelText('End time'), { target: { value: '10:15' } });
  fireEvent.blur(getByLabelText('End time'));
  expect(onChange).toHaveBeenLastCalledWith({ start: '09:30', end: '10:15' });
});

it('shows the times of a timed row, and checking All day clears them', () => {
  const { getByLabelText, queryByLabelText, onChange } = renderFields({
    allDay: false,
    start: '09:30',
    end: '10:15',
  });
  expect((getByLabelText('All day') as HTMLInputElement).checked).toBe(false);
  expect((getByLabelText('Start time') as HTMLInputElement).value).toBe(
    '09:30',
  );
  expect((getByLabelText('End time') as HTMLInputElement).value).toBe('10:15');

  fireEvent.click(getByLabelText('All day'));
  expect(onChange).toHaveBeenLastCalledWith('all-day');
  expect(queryByLabelText('Start time')).toBeNull();
});
