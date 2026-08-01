import {
  Collection,
  unknownSubject,
  useMemberFromCollection,
} from '@tomic/react';
import { type JSX } from 'react';
import { Checkbox } from '@components/forms/Checkbox';

interface RowSelectCheckboxProps {
  collection: Collection;
  index: number;
  isSelected: (subject: string) => boolean;
  onToggle: (subject: string) => void;
}

/**
 * The per-row selection checkbox shown in the index column. Resolves its own
 * subject from the collection (indices are all the grid hands down) so the
 * checkbox reflects and toggles selection by stable subject.
 */
export function RowSelectCheckbox({
  collection,
  index,
  isSelected,
  onToggle,
}: RowSelectCheckboxProps): JSX.Element | null {
  const resource = useMemberFromCollection(collection, index);
  const subject = resource.subject;

  // Until the row's subject resolves there's nothing to select.
  if (subject === unknownSubject) {
    return null;
  }

  return (
    <Checkbox
      title='Select row'
      aria-label='Select row'
      data-testid='row-select-checkbox'
      checked={isSelected(subject)}
      onChange={() => onToggle(subject)}
      // Keep the click from reaching the cell, which would otherwise start a
      // cell selection / active-cell move.
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    />
  );
}
