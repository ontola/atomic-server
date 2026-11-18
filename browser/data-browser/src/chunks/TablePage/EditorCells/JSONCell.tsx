import {
  JSONValue,
  server,
  useProperty,
  useResource,
  useValue,
} from '@tomic/react';

import { CellContainer, DisplayCellProps, EditCellProps } from './Type';

import { useMemo, type JSX } from 'react';
import styled from 'styled-components';
import { IconButton } from '@components/IconButton/IconButton';
import { FaPencil } from 'react-icons/fa6';
import { Dialog, useDialog } from '@components/Dialog';
import { KeyboardInteraction, useCellOptions } from '@chunks/TableEditor';
import { addIf } from '@helpers/addIf';
import { useTableEditorContext } from '@chunks/TableEditor/TableEditorContext';
import { useColumnLabel } from '../helpers/useColumnLabel';
import { InputJSON } from '@components/forms/InputJSON';
import { schemaJSONPreview } from './schemaJSONPreview';

function JSONPreview({
  value,
  property,
}: {
  value: JSONValue;
  property: string;
}) {
  const propertyResource = useResource(property);
  const [schema] = useValue(propertyResource, server.properties.jsonSchema);
  const preview = schemaJSONPreview(value, schema);
  const shortenedMessage =
    'Preview shortened. Open edit dialog for complete JSON.';

  return (
    <Preview
      title={
        preview.truncated
          ? `${preview.text}\n${shortenedMessage}`
          : preview.text
      }
    >
      {preview.text}
      {preview.truncated && <small> {shortenedMessage}</small>}
    </Preview>
  );
}

function JSONCellEdit({
  value,
  property,
  resource,
}: EditCellProps<JSONValue>): JSX.Element {
  const [dialogProps, show, close, isOpen] = useDialog({
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
      <JSONPreview value={value} property={property} />
      <Dialog {...dialogProps} width='70ch'>
        {isOpen && (
          <>
            <Dialog.Title>
              <h1>Edit {label}</h1>
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

function JSONCellDisplay({
  value,
  property,
}: DisplayCellProps<JSONValue>): JSX.Element {
  return <JSONPreview value={value} property={property} />;
}

export const JSONCell: CellContainer<JSONValue> = {
  Edit: JSONCellEdit,
  Display: JSONCellDisplay,
};

const StyledDialogContent = styled(Dialog.Content)`
  padding-top: 2px;
`;

const Preview = styled.div`
  flex: 1;
  min-width: 0;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;

  small {
    opacity: 0.7;
  }
`;
