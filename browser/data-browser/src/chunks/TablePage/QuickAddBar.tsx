import { useStore, type Property, type Resource } from '@tomic/react';
import type { JSX } from 'react';
import { TableQuickAddBar } from '@tomic/table';
import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import { Button } from '@components/Button';
import { InputStyled } from '@components/forms/InputStyles';
import { createQuickAddRow, type QuickAddSpec } from './quickAdd';

interface Props {
  scope?: string;
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
  scope,
  spec,
  tableSubject,
  tableClass,
  classProperties,
  onRowCreated,
}: Props): JSX.Element {
  const store = useStore();

  return (
    <TableQuickAddBar
      scope={JSON.stringify([scope, tableSubject, tableClass.subject, spec])}
      label={spec.label}
      field={!!spec.field}
      placeholder={spec.placeholder}
      Field={FieldInput}
      Button={Button}
      create={value =>
        createQuickAddRow(store, {
          table: tableSubject,
          rowClass: tableClass.subject,
          spec,
          typed: value,
          properties: classProperties,
        })
      }
      onCreated={onRowCreated}
      onError={error => {
        console.error('Failed to quick-add a row', error);
        toast.error(`Could not add the ${tableClass.title.toLowerCase()}`);
      }}
    />
  );
}

const FieldInput = styled(InputStyled)`
  flex: 1;
  min-width: 12rem;
  max-width: 30rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  padding: 0.4rem 0.6rem;
`;
