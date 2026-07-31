import { useStore, type Property, type Resource } from '@tomic/react';
import { useState, type JSX } from 'react';
import { styled } from 'styled-components';
import { FaPlus } from 'react-icons/fa6';
import toast from 'react-hot-toast';
import { Button } from '@components/Button';
import { InputStyled } from '@components/forms/InputStyles';
import { createQuickAddRow, type QuickAddSpec } from './quickAdd';

interface Props {
  spec: QuickAddSpec;
  tableSubject: string;
  tableClass: Resource;
  /** The row class's properties, so a preset knows the datatype it writes. */
  classProperties: Property[];
  /**
   * Tells the grid its member count grew. The grid freezes that count at first
   * load and renders anything past it as a session draft, so a new row stays
   * invisible until this fires.
   */
  onRowCreated: () => void;
}

/**
 * The one button a personal app is mostly used through: "Log a feed", "Add item",
 * "Log set". Everything else about the row is edited in the table itself, so this
 * stays a single field rather than becoming a second form.
 */
export function QuickAddBar({
  spec,
  tableSubject,
  tableClass,
  classProperties,
  onRowCreated,
}: Props): JSX.Element {
  const store = useStore();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  // A spec with a field is asking for a value; creating a blank row instead
  // would be a worse guess than doing nothing.
  const ready = !spec.field || typed.trim() !== '';

  const create = () => {
    if (!ready || busy) {
      return;
    }

    const value = typed.trim();
    // Cleared up front, not after the save: anything typed while the save is in
    // flight would otherwise be wiped when the reset landed.
    setTyped('');
    setBusy(true);

    void createQuickAddRow(store, {
      table: tableSubject,
      rowClass: tableClass.subject,
      spec,
      typed: value,
      properties: classProperties,
    })
      .then(() => onRowCreated())
      .catch(error => {
        // Never silent: a swallowed failure here looks exactly like "the button
        // does nothing".
        console.error('Failed to quick-add a row', error);
        toast.error(`Could not add the ${tableClass.title.toLowerCase()}`);
      })
      .finally(() => setBusy(false));
  };

  return (
    <Bar>
      {spec.field && (
        <FieldInput
          placeholder={spec.placeholder ?? spec.label}
          data-testid='quick-add-input'
          value={typed}
          onChange={e => setTyped(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              create();
            }
          }}
        />
      )}
      <Button
        data-testid='quick-add-button'
        disabled={!ready || busy}
        onClick={create}
      >
        <FaPlus /> {spec.label}
      </Button>
    </Bar>
  );
}

const Bar = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-block: 0.5rem;
  flex-wrap: wrap;
`;

const FieldInput = styled(InputStyled)`
  flex: 1;
  min-width: 12rem;
  max-width: 30rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  padding: 0.4rem 0.6rem;
`;
