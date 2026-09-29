import {
  anchorOf,
  buildRecurrence,
  nativeCalendarPayload,
  parseRecurrence,
  type RepeatParse,
} from '@tomic/lib';
import { JSONValue, Resource, useCanWrite, useResource } from '@tomic/react';
import { useState, type JSX } from 'react';
import toast from 'react-hot-toast';
import { styled } from 'styled-components';
import { ValueForm } from '@components/forms/ValueForm';
import {
  calendarRowTime,
  isNativePayload,
  readRecurrencePayload,
  rowRecord,
  type CalendarColumns,
  type RecurrencePayload,
} from './calendarRows';
import { RepeatField } from './RepeatField';

/** What the row dialog needs to show a calendar row's own fields. */
export interface CalendarRowContext extends CalendarColumns {
  ensureRecurrenceProp: () => Promise<string>;
}

/** The calendar fields of a row in its dialog: for now, how it repeats. */
export function CalendarRowFields({
  subject,
  calendar,
}: {
  subject: string;
  calendar: CalendarRowContext;
}): JSX.Element | null {
  const resource = useResource(subject);
  const canWrite = useCanWrite(resource);
  const [saving, setSaving] = useState(false);
  const { recurrenceProp } = calendar;

  const get = (prop: string) => resource.get(prop);
  const { payload, time, anchor, parsed } = readRowRepeat(
    subject,
    get,
    calendar,
  );

  if (!anchor) {
    // Without a day there is nothing to repeat from.
    return null;
  }

  const save = (next: RepeatParse) => {
    if (next.kind === 'custom') return;
    setSaving(true);
    void saveRepeat(
      resource,
      calendar,
      nextPayload(subject, next, payload, time),
    )
      .catch(error =>
        toast.error(
          `Could not save the repeat: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .then(() => setSaving(false));
  };

  return (
    <Section>
      <RepeatField
        parsed={parsed}
        anchor={anchor}
        disabled={!canWrite || saving}
        onChange={save}
        json={
          recurrenceProp && (
            <ValueForm
              resource={resource}
              propertyURL={recurrenceProp.subject}
            />
          )
        }
      />
    </Section>
  );
}

/** The row's series as the Repeat field shows it. An imported series repeats
 * from its own start; a native one from the row's day. Without an `anchor`
 * the row has nothing to repeat from, and no Repeat field. */
export function readRowRepeat(
  subject: string,
  get: (prop: string) => unknown,
  calendar: CalendarRowContext,
) {
  const { recurrenceProp } = calendar;
  const value = recurrenceProp ? get(recurrenceProp.subject) : undefined;
  const payload = readRecurrencePayload(value);
  const time = calendarRowTime(get, calendar);

  try {
    // A native series as the view expands it: moved along with its row.
    const event =
      payload && time && isNativePayload(payload)
        ? rowRecord(subject, payload, time).event
        : payload?.event;
    const start =
      payload && !isNativePayload(payload) ? event?.start : time?.start;
    const anchor = start && anchorOf(start);
    const parsed: RepeatParse =
      event && anchor
        ? parseRecurrence(event.recurrence, anchor)
        : value !== undefined
          ? { kind: 'custom' }
          : { kind: 'none' };

    return { payload, time, anchor, parsed };
  } catch {
    return {
      payload,
      time,
      anchor: time && anchorOf(time.start),
      parsed: { kind: 'custom' } as RepeatParse,
    };
  }
}

async function saveRepeat(
  resource: Resource,
  calendar: CalendarRowContext,
  value: RecurrencePayload | undefined,
) {
  const property = await calendar.ensureRecurrenceProp();

  // `set` validates, and undefined is not a JSON value.
  if (value === undefined) {
    resource.remove(property);
  } else {
    await resource.set(property, value as JSONValue);
  }

  await resource.save();
}

/** The value to store for a new Repeat setting. A native series is written
 * whole; an imported one keeps its payload and only gets new rule lines.
 * "Does not repeat" clears a native series and ends an imported one's rule. */
function nextPayload(
  subject: string,
  next: Exclude<RepeatParse, { kind: 'custom' }>,
  payload: RecurrencePayload | undefined,
  time: ReturnType<typeof calendarRowTime>,
): RecurrencePayload | undefined {
  if (payload && !isNativePayload(payload)) {
    const { recurrence: _, ...event } = payload.event;

    return next.kind === 'none'
      ? { ...payload, event }
      : {
          ...payload,
          event: {
            ...event,
            recurrence: buildRecurrence(next.rule, anchorOf(event.start!)),
          },
        };
  }

  if (next.kind === 'none' || !time) return undefined;

  return nativeCalendarPayload(subject, next.rule, time);
}

const Section = styled.div`
  padding: 0.5rem;
  margin-bottom: 1rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
`;
