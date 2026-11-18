import { JSONValue, useProperty } from '@tomic/react';

import { CellContainer, DisplayCellProps, EditCellProps } from './Type.js';
import { TruncatedText } from './TruncatedText.js';

import { useMemo, type JSX } from 'react';
import { styled } from 'styled-components';
import { IconButton } from '@tomic/ui/components/IconButton/IconButton';
import { FaPencil } from 'react-icons/fa6';
import { Dialog, useDialog } from '@tomic/resource-ui/components/Dialog/index';
import {
  KeyboardInteraction,
  useCellOptions,
} from '@tomic/resource-ui/chunks/TableEditor/index';
import { addIf } from '@tomic/resource-ui/helpers/addIf';
import InputMarkdown from '@tomic/resource-ui/components/forms/InputMarkdown';
import { useTableEditorContext } from '@tomic/table';
import { useColumnLabel } from '../helpers/useColumnLabel.js';

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
  const label = useColumnLabel(prop);

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
              <h1>Edit {label}</h1>
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
  return <TruncatedText value={value} />;
}

export const MarkdownCell: CellContainer<JSONValue> = {
  Edit: MarkdownCellEdit,
  Display: MarkdownCellDisplay,
};

const StyledDialogContent = styled(Dialog.Content)`
  padding-top: 2px;
`;
