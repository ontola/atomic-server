import { useResource, useTitle } from '@tomic/react';
import { styled } from 'styled-components';
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { FaPlus } from 'react-icons/fa6';
import { IconButton } from '@components/IconButton/IconButton';
import { InputStyled } from '@components/forms/InputStyles';
import { useResourceContextMenu } from '@components/ResourceContextMenu/ResourceContextMenuContext';
import { longDayLabel, shortDayLabel } from './calendarDayLabel';
import type { CalendarDayOccurrence } from './calendarOccurrences';

interface CalendarDayProps {
  /** Local YYYY-MM-DD key of this day. */
  dayKey: string;
  dayNumber: number;
  /** Whether the day belongs to the displayed month (leading/trailing days dim). */
  inMonth: boolean;
  isToday: boolean;
  /** Row subjects whose date value falls on this day. */
  eventSubjects: string[];
  occurrences: CalendarDayOccurrence[];
  allDaySubjects: ReadonlySet<string>;
  readOnly: boolean;
  /** Create a row with its date preset to this day. */
  onAddItem: (dayKey: string, name: string) => void | Promise<void>;
  /** Open a row in the expanded (modal) view. */
  onOpenItem: (subject: string) => void;
  /** Open the list of every event on this day. */
  onOpenDay: (dayKey: string) => void;
}

/** One day cell of the month grid: day number, its rows, and a hover `+`. */
export function CalendarDay({
  dayKey,
  dayNumber,
  inMonth,
  isToday,
  eventSubjects,
  occurrences,
  allDaySubjects,
  readOnly,
  onAddItem,
  onOpenItem,
  onOpenDay,
}: CalendarDayProps): JSX.Element {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const total = eventSubjects.length + occurrences.length;
  const visibleCount = useFittingCount(listRef, total, adding, inputRef);
  const hiddenCount = total - visibleCount;
  const label = longDayLabel(dayKey);

  const submit = useCallback(() => {
    const trimmed = draft.trim();

    if (trimmed) {
      void onAddItem(dayKey, trimmed);
    }

    setDraft('');
    setAdding(false);
  }, [draft, dayKey, onAddItem]);

  const openAdder = useCallback(() => {
    setAdding(true);
    // Focus after the input mounts.
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  return (
    // Clicking the day's empty space is a mouse shortcut to the day list; the
    // day number is the same action as a real, focusable button.
    <Cell
      $inMonth={inMonth}
      $today={isToday}
      data-testid='calendar-day'
      data-date={dayKey}
      data-outside-month={inMonth ? undefined : true}
      onClick={e => {
        if (!(e.target as HTMLElement).closest('button, input')) {
          onOpenDay(dayKey);
        }
      }}
    >
      <CellHeader>
        <DayNumber
          type='button'
          $today={isToday}
          aria-current={isToday ? 'date' : undefined}
          aria-label={`Show all events on ${label}`}
          title={`Show all events on ${label}`}
          data-testid='calendar-day-open'
          onClick={() => onOpenDay(dayKey)}
        >
          {dayNumber}
        </DayNumber>
        {!readOnly && (
          <AddIcon
            title='Add item'
            type='button'
            data-testid='calendar-day-add'
            onClick={openAdder}
          >
            <FaPlus />
          </AddIcon>
        )}
      </CellHeader>
      <EventList ref={listRef}>
        {eventSubjects.map((subject, i) => (
          <CalendarEvent
            key={subject}
            subject={subject}
            allDay={allDaySubjects.has(subject)}
            overflow={i >= visibleCount}
            onOpen={onOpenItem}
          />
        ))}
        {occurrences.map((occurrence, i) => (
          <CalendarEvent
            key={occurrenceKey(occurrence)}
            subject={occurrence.subject}
            allDay={occurrence.allDay}
            recurring={occurrence.recurring}
            movedFrom={occurrence.movedFrom}
            movedTo={occurrence.movedTo}
            overflow={eventSubjects.length + i >= visibleCount}
            onOpen={onOpenItem}
          />
        ))}
        {adding && (
          <AddInput
            ref={inputRef}
            placeholder='New item…'
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') {
                setDraft('');
                setAdding(false);
              }
            }}
            onBlur={submit}
          />
        )}
        {hiddenCount > 0 && (
          <MoreButton
            type='button'
            data-testid='calendar-day-more'
            aria-label={`Show all ${total} events on ${label}`}
            title={`Show all ${total} events on ${label}`}
            onClick={() => onOpenDay(dayKey)}
          >
            +{hiddenCount}
            <MoreWord> more</MoreWord>
          </MoreButton>
        )}
      </EventList>
    </Cell>
  );
}

/**
 * How many event chips fit in the list without clipping. When some don't, the
 * space of the last ones goes to the "+N more" button instead.
 *
 * Every chip stays rendered, the overflowing ones invisible and ordered after
 * "+N more", so each can be measured: a moved meeting's chip has a second line
 * and is taller than the others.
 */
function useFittingCount(
  listRef: React.RefObject<HTMLDivElement | null>,
  total: number,
  adding: boolean,
  inputRef: React.RefObject<HTMLInputElement | null>,
): number {
  const [fitting, setFitting] = useState(total);

  useLayoutEffect(() => {
    const list = listRef.current;

    if (!list) {
      return;
    }

    const measure = () => {
      const heights = Array.from(
        list.querySelectorAll<HTMLElement>(':scope > [data-chip]'),
        chip => chip.offsetHeight,
      );

      if (!heights.length || !heights[0]) {
        setFitting(total);

        return;
      }

      const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
      const input = adding ? inputRef.current : null;
      const room = list.clientHeight - (input ? input.offsetHeight + gap : 0);
      const used = (count: number) =>
        heights.slice(0, count).reduce((sum, h) => sum + h + gap, 0);

      if (used(heights.length) - gap <= room) {
        setFitting(total);

        return;
      }

      // "+N more" is one line, as high as the lowest chip.
      const moreHeight = Math.min(...heights);
      let count = 0;

      while (count < heights.length && used(count + 1) + moreHeight <= room) {
        count++;
      }

      setFitting(count);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);

    return () => observer.disconnect();
  }, [listRef, inputRef, total, adding]);

  return Math.min(fitting, total);
}

/** React key of an occurrence. A moved instance and its placeholder share the
 * original instance's key, and a spanning event can put both on one day. */
export function occurrenceKey(occurrence: CalendarDayOccurrence): string {
  return occurrence.movedTo ? `${occurrence.key}:moved-to` : occurrence.key;
}

/** A row rendered as a small chip on its day; click opens, RMB = resource menu. */
export function CalendarEvent({
  subject,
  onOpen,
  allDay,
  recurring = false,
  movedFrom,
  movedTo,
  overflow = false,
  wrap = false,
}: {
  subject: string;
  allDay: boolean;
  recurring?: boolean;
  /** This instance was moved here from that day (YYYY-MM-DD). */
  movedFrom?: string;
  /** A faint placeholder on the original day of an instance moved to that
   * day (YYYY-MM-DD); it opens the moved instance. */
  movedTo?: string;
  /** Doesn't fit in the cell: laid out after "+N more", invisible. */
  overflow?: boolean;
  /** Show the whole title (the day list) instead of truncating it. */
  wrap?: boolean;
  onOpen: (subject: string) => void;
}): JSX.Element {
  const resource = useResource(subject);
  const [title] = useTitle(resource);
  const { openResourceMenu } = useResourceContextMenu();

  const name = title || subject;

  if (movedTo) {
    return (
      <EventChip
        type='button'
        data-testid='calendar-event-moved-away'
        data-chip
        data-moved-to={movedTo}
        aria-hidden={overflow || undefined}
        title={`${name} · Moved to ${longDayLabel(movedTo)} (opens the moved meeting)`}
        $wrap={wrap}
        $placeholder
        $overflow={overflow}
        onClick={() => onOpen(subject)}
        onContextMenu={e => openResourceMenu(subject, e)}
      >
        <span aria-hidden>↷ </span>
        {name}
        <MovedToNote day={movedTo} />
      </EventChip>
    );
  }

  return (
    <EventChip
      type='button'
      data-testid='calendar-event'
      data-chip
      aria-hidden={overflow || undefined}
      title={
        movedFrom
          ? `${name} · Moved from ${longDayLabel(movedFrom)}`
          : recurring
            ? `${name} · Recurring meeting (opens its series or exception)`
            : name
      }
      data-all-day={allDay || undefined}
      data-recurring={recurring || undefined}
      data-moved-from={movedFrom}
      $wrap={wrap}
      $overflow={overflow}
      onClick={() => onOpen(subject)}
      onContextMenu={e => openResourceMenu(subject, e)}
    >
      {recurring && <span aria-label='Recurring meeting'>↻ </span>}
      {allDay && <AllDayLabel>All day</AllDayLabel>}
      {name}
      {movedFrom && <MovedFromNote day={movedFrom} />}
    </EventChip>
  );
}

// Own components, so each note is extracted as one message with its date
// placeholder; inside the guarded JSX above, the date fell out of it.
function MovedFromNote({ day }: { day: string }): JSX.Element {
  return <MovedNote>Moved from {shortDayLabel(day)}</MovedNote>;
}

function MovedToNote({ day }: { day: string }): JSX.Element {
  return <MovedNote>Moved to {shortDayLabel(day)}</MovedNote>;
}

const Cell = styled.div<{ $inMonth: boolean; $today: boolean }>`
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.3rem;
  min-height: 0;
  /* A long title truncates inside its column instead of widening it (#1792). */
  min-width: 0;
  overflow: hidden;
  /* Days outside the month keep the normal cell background and only dim
   * their contents. A filled cell read as "selected" and was mistaken for
   * today (#1805). */
  background-color: ${p =>
    p.$today ? p.theme.colors.mainSelectedBg : p.theme.colors.bg};

  & > * {
    opacity: ${p => (p.$inMonth ? 1 : 0.45)};
  }

  /* Today: a tinted cell with an accent outline, not just the number. */
  ${p =>
    p.$today &&
    `
    &::after {
      content: '';
      position: absolute;
      inset: 0;
      border: 2px solid ${p.theme.colors.main};
      pointer-events: none;
    }
  `}
`;

const CellHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* At phone width a column is narrower than the day number plus the add
   * button; wrap the button under the number rather than clip it. */
  flex-wrap: wrap;
  flex-shrink: 0;
`;

const DayNumber = styled.button<{ $today: boolean }>`
  display: inline-flex;
  border: none;
  cursor: pointer;
  font-family: inherit;
  align-items: center;
  justify-content: center;
  min-width: 1.5rem;
  height: 1.5rem;
  padding-inline: 0.2rem;
  border-radius: 50%;
  font-size: 0.85em;
  font-weight: ${p => (p.$today ? 'bold' : 'normal')};
  background-color: ${p => (p.$today ? p.theme.colors.main : 'transparent')};
  color: ${p => (p.$today ? 'white' : p.theme.colors.textLight)};

  &:hover {
    background-color: ${p =>
      p.$today ? p.theme.colors.main : p.theme.colors.bg1};
  }

  &:focus-visible {
    outline: 2px solid ${p => p.theme.colors.main};
    outline-offset: 1px;
  }
`;

const AddIcon = styled(IconButton)`
  height: 1.5rem;
  width: 1.5rem;
  opacity: 0;
  transition: opacity 0.1s ease-in-out;

  ${Cell}:hover &,
  &:focus-visible {
    opacity: 1;
  }
`;

const EventList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  flex: 1;
  min-height: 0;
  /* useFittingCount keeps what's shown inside; the rest is behind "+N more". */
  overflow: hidden;
  container-type: inline-size;
`;

/** Dropped at phone width, where a column only has room for "+3". */
const MoreWord = styled.span`
  @container (max-width: 4.5rem) {
    display: none;
  }
`;

const EventChip = styled.button<{
  $wrap: boolean;
  $placeholder?: boolean;
  $overflow?: boolean;
}>`
  border: none;
  text-align: start;
  padding: 0.15rem 0.4rem;
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg1};
  color: ${p => p.theme.colors.text};
  font-size: 0.8em;
  cursor: pointer;
  min-width: 0;
  white-space: ${p => (p.$wrap ? 'normal' : 'nowrap')};
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;

  &:hover {
    background-color: ${p => p.theme.colors.bg2};
  }

  &:focus-visible {
    outline: 2px solid ${p => p.theme.colors.main};
  }

  ${p =>
    p.$overflow &&
    `
    order: 2;
    visibility: hidden;
  `}

  /* Where a moved instance used to be: faint, so the day reads as "moved",
   * not "cancelled", without competing with the real events (#1804). */
  ${p =>
    p.$placeholder &&
    `
    background-color: transparent;
    outline: 1px dashed ${p.theme.colors.bg2};
    outline-offset: -1px;
    color: ${p.theme.colors.textLight};
    font-style: italic;

    &:hover {
      background-color: ${p.theme.colors.bg1};
    }

    &:focus-visible {
      outline: 2px solid ${p.theme.colors.main};
    }
  `}
`;

/** "Moved from Wed 14 Oct", on its own line under the title, so a narrow
 * column truncates the title rather than the news that it moved. */
const MovedNote = styled.span`
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  color: ${p => p.theme.colors.textLight};
  font-size: 0.9em;
  font-style: italic;
`;

const MoreButton = styled.button`
  order: 1;
  border: none;
  background: none;
  text-align: start;
  padding: 0.15rem 0.4rem;
  border-radius: ${p => p.theme.radius};
  color: ${p => p.theme.colors.textLight};
  font-size: 0.8em;
  font-weight: bold;
  cursor: pointer;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;

  &:hover {
    background-color: ${p => p.theme.colors.bg1};
    color: ${p => p.theme.colors.text};
  }

  &:focus-visible {
    outline: 2px solid ${p => p.theme.colors.main};
  }
`;

const AddInput = styled(InputStyled)`
  order: 1;
  flex: 0 0 auto;
  min-width: 0;
  width: 100%;
  height: auto;
  min-height: 1.6rem;
  padding: 0.15rem 0.4rem;
  font-size: 0.8em;
  border: 1px solid ${p => p.theme.colors.main};
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg};
`;

const AllDayLabel = styled.span`
  font-size: 0.8em;
  margin-inline-end: 0.4em;
  opacity: 0.7;
`;
