import { useId } from 'react';
import { useResource } from '@tomic/react';
import { styled } from 'styled-components';
import { Card } from './Card';
import { Checkbox } from './forms/Checkbox';

/** The person's drives, each with a checkbox. Used when they let an app in. */
export function ConnectDrivePicker({
  subjects,
  unavailable = [],
  selected,
  onToggle,
  onToggleAll,
}: {
  subjects: string[];
  /** Listed but not selectable, and left out of "All drives". */
  unavailable?: string[];
  selected: string[];
  onToggle: (subject: string, on: boolean) => void;
  /** Shown above the list when there is more than one drive. */
  onToggleAll?: (on: boolean) => void;
}) {
  const allId = useId();
  const available = subjects.filter(s => !unavailable.includes(s));

  return (
    <Card>
      <List>
        {onToggleAll && available.length > 1 && (
          <Option>
            <Checkbox
              id={allId}
              checked={available.every(s => selected.includes(s))}
              onChange={onToggleAll}
            />
            <label htmlFor={allId}>All drives</label>
          </Option>
        )}
        {subjects.map(subject => (
          <DriveOption
            key={subject}
            subject={subject}
            checked={selected.includes(subject)}
            unavailable={unavailable.includes(subject)}
            onChange={on => onToggle(subject, on)}
          />
        ))}
      </List>
    </Card>
  );
}

function DriveOption({
  subject,
  checked,
  unavailable,
  onChange,
}: {
  subject: string;
  unavailable: boolean;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const resource = useResource(subject);
  const id = useId();

  return (
    <Option>
      <Checkbox
        id={id}
        checked={checked && !unavailable}
        disabled={unavailable}
        onChange={onChange}
      />
      <label htmlFor={id}>{resource.loading ? '…' : resource.title}</label>
      {unavailable && <Note>Only on your devices</Note>}
    </Option>
  );
}

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
`;

const Note = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.85rem;
`;

const Option = styled.div`
  display: flex;
  align-items: center;
  gap: 0.75rem;

  label {
    cursor: pointer;
  }
`;
