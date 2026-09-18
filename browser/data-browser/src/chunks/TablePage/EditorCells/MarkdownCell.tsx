import { JSONValue, useProperty } from '@tomic/react';

import { CellContainer, DisplayCellProps, EditCellProps } from './Type';

import { useMemo, type JSX } from 'react';
import styled from 'styled-components';
import { IconButton } from '@components/IconButton/IconButton';
import { FaPencil } from 'react-icons/fa6';
import { Dialog, useDialog } from '@components/Dialog';
import { KeyboardInteraction, useCellOptions } from '@chunks/TableEditor';
import { addIf } from '@helpers/addIf';
import InputMarkdown from '@components/forms/InputMarkdown';
import { useTableEditorContext } from '@chunks/TableEditor/TableEditorContext';

function MarkdownCellEdit({
  value,
  property,
  resource,
}: EditCellProps<JSONValue>): JSX.Element {
  const [dialogProps, show, _close, isOpen] = useDialog({
    // Closing the dialog — confirmed or cancelled — ends edit mode. That
    // both restores focus to the grid (TableEditor's Edit -> Visual layout
    // effect) and makes the arrow keys work again on the first Escape.
    onSuccess: () => {
      exitEditMode();
    },
    onCancel: () => {
      exitEditMode();
    },
  });
  const prop = useProperty(property);

  const { exitEditMode } = useTableEditorContext();

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

  return (
    <>
      <IconButton title='Open edit dialog' onClick={show} autoFocus>
        <FaPencil />
      </IconButton>
      <div>{value as string}</div>
      <Dialog {...dialogProps} width='70ch'>
        {isOpen && (
          <>
            <Dialog.Title>
              <h1>Edit {prop.shortname}</h1>
            </Dialog.Title>
            <StyledDialogContent>
              <InputMarkdown
                autoFocus
                commit
                resource={resource}
                property={prop}
              />
            </StyledDialogContent>
          </>
        )}
      </Dialog>
    </>
  );
}

function MarkdownCellDisplay({
  value,
}: DisplayCellProps<JSONValue>): JSX.Element {
  return <>{value}</>;
}

export const MarkdownCell: CellContainer<JSONValue> = {
  Edit: MarkdownCellEdit,
  Display: MarkdownCellDisplay,
};

const StyledDialogContent = styled(Dialog.Content)`
  padding-top: 2px;
`;
