import { expect, it } from 'vitest';
import { validateCalendarEvent, type CalendarEvent } from './index.js';

it('preserves calendar validation through the public library entry point', () => {
  const valid: CalendarEvent = {
    id: 'invented-event',
    start: { dateTime: '2026-11-02T09:00:00Z' },
    end: { dateTime: '2026-11-02T10:00:00Z' },
  };
  expect(() => validateCalendarEvent(valid)).not.toThrow();
  expect(() => validateCalendarEvent({ ...valid, end: valid.start })).toThrow(
    'Event end must be after its start',
  );
});
