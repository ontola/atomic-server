import type { CalendarOccurrence } from '@tomic/lib';
import { useEffect, useRef, type JSX } from 'react';
import { styled } from 'styled-components';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@components/Dialog';
import { CalendarEvent } from './CalendarDay';
import { longDayLabel } from './calendarDayLabel';

interface CalendarDayListProps {
  /** The day to list, or undefined while closed. */
  dayKey: string | undefined;
  open: boolean;
  bindOpen: (open: boolean) => void;
  eventSubjects: string[];
  occurrences: CalendarOccurrence[];
  allDaySubjects: ReadonlySet<string>;
  /** Opens a row on top of this list; closing it comes back here. */
  onOpenItem: (subject: string) => void;
}

/** Every event of one day, untruncated: what "+N more" and a day click open. */
export function CalendarDayList({
  dayKey,
  open,
  bindOpen,
  eventSubjects,
  occurrences,
  allDaySubjects,
  onOpenItem,
}: CalendarDayListProps): JSX.Element {
  // Focus goes back to what opened the list ("+N more" or the day number),
  // so a keyboard user continues from the same day.
  const triggerRef = useRef<HTMLElement | null>(null);
  const [dialogProps, show] = useDialog({ bindShow: bindOpen, triggerRef });

  useEffect(() => {
    if (open) {
      const active = document.activeElement;
      triggerRef.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
      show();
    }
  }, [open, show]);

  const empty = eventSubjects.length === 0 && occurrences.length === 0;

  return (
    <Dialog {...dialogProps} width='52ch'>
      <DialogTitle>
        <h1 data-testid='calendar-day-list-title'>
          {dayKey ? longDayLabel(dayKey) : ''}
        </h1>
      </DialogTitle>
      <DialogContent>
        {empty ? (
          <Empty>Nothing on this day.</Empty>
        ) : (
          <List data-testid='calendar-day-list'>
            {eventSubjects.map(subject => (
              <li key={subject}>
                <CalendarEvent
                  wrap
                  subject={subject}
                  allDay={allDaySubjects.has(subject)}
                  onOpen={onOpenItem}
                />
              </li>
            ))}
            {occurrences.map(occurrence => (
              <li key={occurrence.key}>
                <CalendarEvent
                  wrap
                  subject={occurrence.subject}
                  allDay={occurrence.allDay}
                  recurring={occurrence.recurring}
                  onOpen={onOpenItem}
                />
              </li>
            ))}
          </List>
        )}
      </DialogContent>
    </Dialog>
  );
}

const List = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;

  /* The global \`ul li\` style adds bullets and an indent. */
  && > li {
    list-style-type: none;
    margin: 0;
  }

  & button {
    width: 100%;
    font-size: 0.95em;
    padding: 0.4rem 0.6rem;
  }
`;

const Empty = styled.p`
  margin: 0;
  color: ${p => p.theme.colors.textLight};
`;
