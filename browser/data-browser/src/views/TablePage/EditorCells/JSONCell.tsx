import { JSONValue, useProperty } from '@tomic/react';

import { CellContainer, DisplayCellProps, EditCellProps } from './Type';

import { useMemo, type JSX } from 'react';
import styled from 'styled-components';
import { IconButton } from '../../../components/IconButton/IconButton';
import { FaPencil } from 'react-icons/fa6';
import { Dialog, useDialog } from '../../../components/Dialog';
import {
  KeyboardInteraction,
  useCellOptions,
} from '../../../components/TableEditor';
import { addIf } from '../../../helpers/addIf';
import { useTableEditorContext } from '../../../components/TableEditor/TableEditorContext';
import { InputJSON } from '../../../components/forms/InputJSON';

function JSONCellEdit({
  value,
  property,
  resource,
}: EditCellProps<JSONValue>): JSX.Element {
  const [dialogProps, show, close, isOpen] = useDialog({
    onSuccess: () => {
      tableRef.current?.focus();
    },
    onCancel: () => {
      tableRef.current?.focus();
    },
  });
  const prop = useProperty(property);

  const { tableRef } = useTableEditorContext();

  const options = useMemo(
    () => ({
      disabledKeyboardInteractions: new Set([
        ...addIf(
          isOpen,
          KeyboardInteraction.ExitEditMode,
          KeyboardInteraction.EditNextRow,
        ),
      ]),
    }),
    [isOpen],
  );

  useCellOptions(options);

  const displayValue = JSON.stringify(value);

  return (
    <>
      <IconButton title='Open edit dialog' onClick={show} autoFocus>
        <FaPencil />
      </IconButton>
      <div>{displayValue}</div>
      <Dialog {...dialogProps} width='70ch'>
        {isOpen && (
          <>
            <Dialog.Title>
              <h1>Edit {prop.shortname}</h1>
            </Dialog.Title>
            <StyledDialogContent
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  close(true);
                }
              }}
            >
              <InputJSON commit autoFocus resource={resource} property={prop} />
            </StyledDialogContent>
          </>
        )}
      </Dialog>
    </>
  );
}

function JSONCellDisplay({ value }: DisplayCellProps<JSONValue>): JSX.Element {
  const displayValue = JSON.stringify(value);

  return <>{displayValue}</>;
}

export const JSONCell: CellContainer<JSONValue> = {
  Edit: JSONCellEdit,
  Display: JSONCellDisplay,
};

const StyledDialogContent = styled(Dialog.Content)`
  padding-top: 2px;
`;
