import { JSONValue, Property } from '@tomic/react';
import { useState, type JSX } from 'react';
import { styled } from 'styled-components';
import { FaPen, FaTrash, FaXmark } from 'react-icons/fa6';
import { Button } from '@components/Button';
import {
  ConfirmationDialog,
  ConfirmationDialogTheme,
} from '@components/ConfirmationDialog';
import { TableSetPropertyDialog } from './TableSetPropertyDialog';

interface TableBulkActionsBarProps {
  count: number;
  /** Properties (columns) that can be bulk-set. */
  properties: Property[];
  onSetProperty: (
    propertySubject: string,
    value: JSONValue | undefined,
  ) => void;
  onDelete: () => void;
  onClear: () => void;
}

/**
 * Appears above the grid whenever one or more rows are selected. Offers the
 * bulk actions — set a property on every selected row, or delete them all —
 * plus a way to clear the selection.
 */
export function TableBulkActionsBar({
  count,
  properties,
  onSetProperty,
  onDelete,
  onClear,
}: TableBulkActionsBarProps): JSX.Element | null {
  const [showSetProperty, setShowSetProperty] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  if (count === 0) {
    return null;
  }

  return (
    <Bar role='toolbar' aria-label='Bulk actions' data-testid='table-bulk-actions'>
      <Count data-testid='bulk-selected-count'>
        {count} {count === 1 ? 'row' : 'rows'} selected
      </Count>
      <Button
        subtle
        onClick={() => setShowSetProperty(true)}
        disabled={properties.length === 0}
        data-testid='bulk-set-property-button'
        title={
          properties.length === 0
            ? 'No columns available to set'
            : 'Set a property on all selected rows'
        }
      >
        <FaPen /> Set property
      </Button>
      <Button
        alert
        onClick={() => setShowDeleteConfirm(true)}
        data-testid='bulk-delete-button'
        title='Delete all selected rows'
      >
        <FaTrash /> Delete
      </Button>
      <Spacer />
      <Button
        subtle
        onClick={onClear}
        data-testid='bulk-clear-button'
        title='Clear selection'
      >
        <FaXmark /> Clear
      </Button>

      <TableSetPropertyDialog
        properties={properties}
        count={count}
        show={showSetProperty}
        bindShow={setShowSetProperty}
        onApply={onSetProperty}
      />
      <ConfirmationDialog
        title={`Delete ${count} ${count === 1 ? 'row' : 'rows'}?`}
        confirmLabel='Delete'
        theme={ConfirmationDialogTheme.Alert}
        show={showDeleteConfirm}
        bindShow={setShowDeleteConfirm}
        onConfirm={onDelete}
      >
        <p>
          This permanently deletes the {count} selected{' '}
          {count === 1 ? 'row' : 'rows'}. This cannot be undone from here.
        </p>
      </ConfirmationDialog>
    </Bar>
  );
}

const Bar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.5rem;
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg1};
  border: 1px solid ${p => p.theme.colors.bg2};
`;

const Count = styled.span`
  font-weight: bold;
  margin-right: 0.5rem;
`;

const Spacer = styled.span`
  flex: 1;
`;
