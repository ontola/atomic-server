import { useId, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import { Checkbox } from '@components/forms/Checkbox';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';

export type EventTimeChange = 'all-day' | { start: string; end?: string };

interface EventTimeFieldsProps {
  allDay: boolean;
  /** HH:MM, local. */
  start?: string;
  end?: string;
  disabled?: boolean;
  onChange: (next: EventTimeChange) => void;
}

const TIME = /^\d{2}:\d{2}$/;

/** "All day", and when unchecked, the start and end time of a calendar row.
 * A time is saved when its input loses focus (or on Enter); unchecking All
 * day stores nothing until a start time is given. */
export function EventTimeFields({
  allDay,
  start,
  end,
  disabled,
  onChange,
}: EventTimeFieldsProps): JSX.Element {
  const id = useId();
  const [showTimes, setShowTimes] = useState(!allDay);
  const [draftStart, setDraftStart] = useState(start ?? '');
  const [draftEnd, setDraftEnd] = useState(end ?? '');

  const commit = () => {
    if (!TIME.test(draftStart)) return;
    if (draftStart === start && (draftEnd || undefined) === end) return;
    onChange({
      start: draftStart,
      end: TIME.test(draftEnd) ? draftEnd : undefined,
    });
  };

  return (
    <Wrapper>
      <AllDay>
        <Checkbox
          id={`${id}-all-day`}
          checked={!showTimes}
          disabled={disabled}
          onChange={checked => {
            setShowTimes(!checked);

            if (checked && !allDay) {
              onChange('all-day');
            }
          }}
        />
        <AllDayLabel htmlFor={`${id}-all-day`}>All day</AllDayLabel>
      </AllDay>
      {showTimes && (
        <TimeInputs
          id={id}
          start={draftStart}
          end={draftEnd}
          disabled={disabled}
          setStart={setDraftStart}
          setEnd={setDraftEnd}
          commit={commit}
        />
      )}
    </Wrapper>
  );
}

/** Own component, so the extractor keeps its labels: inside the guard above
 * they can fall out of the catalog. */
function TimeInputs({
  id,
  start,
  end,
  disabled,
  setStart,
  setEnd,
  commit,
}: {
  id: string;
  start: string;
  end: string;
  disabled?: boolean;
  setStart: (value: string) => void;
  setEnd: (value: string) => void;
  commit: () => void;
}): JSX.Element {
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
  };

  return (
    <Times>
      <TimeLabel htmlFor={`${id}-start`}>Start time</TimeLabel>
      <TimeWrapper>
        <InputStyled
          id={`${id}-start`}
          type='time'
          value={start}
          disabled={disabled}
          onChange={e => setStart(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      </TimeWrapper>
      <TimeLabel htmlFor={`${id}-end`}>End time</TimeLabel>
      <TimeWrapper>
        <InputStyled
          id={`${id}-end`}
          type='time'
          value={end}
          disabled={disabled || !TIME.test(start)}
          onChange={e => setEnd(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      </TimeWrapper>
    </Times>
  );
}

const Wrapper = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
`;

const AllDay = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
`;

const AllDayLabel = styled.label`
  font-weight: bold;
  cursor: pointer;
`;

const Times = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
`;

const TimeLabel = styled.label`
  font-weight: bold;
`;

const TimeWrapper = styled(InputWrapper)`
  flex: 0 0 8rem;
`;
