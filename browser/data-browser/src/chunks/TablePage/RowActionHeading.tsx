import { useContext, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import {
  FaEllipsisVertical,
  FaGripVertical,
  FaPencil,
  FaXmark,
} from 'react-icons/fa6';
import { DropdownMenu, type DropdownItem } from '@components/Dropdown';
import { buildDefaultTrigger } from '@components/Dropdown/DefaultTrigger';
import { AutoOpenTrigger } from '@components/Dropdown/AutoOpenTrigger';
import {
  ConfirmationDialog,
  ConfirmationDialogTheme,
} from '@components/ConfirmationDialog';
import type { DraggableAttributes } from '@dnd-kit/core';
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import { TablePageContext } from './tablePageContext';
import { RowActionDialog } from './RowActionDialog';
import { ROW_ACTION_GENERATORS, type RowActionSpec } from './rowActions';

const Trigger = buildDefaultTrigger(<FaEllipsisVertical />, 'Edit action');

/**
 * Heading of an action column: its label plus the menu that edits or removes it.
 * Nothing here sorts or filters — the column holds buttons, not values — but it
 * drags like any other, because where it sits is the view's column order.
 */
export function RowActionHeading({
  spec,
  readOnly,
  dragListeners,
  dragAttributes,
}: {
  spec: RowActionSpec;
  readOnly: boolean;
  dragListeners?: SyntheticListenerMap;
  dragAttributes?: DraggableAttributes;
}): JSX.Element {
  const { classProperties, updateRowAction, removeRowAction } =
    useContext(TablePageContext);
  const [showEdit, setShowEdit] = useState(false);
  const [showRemove, setShowRemove] = useState(false);
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number }>();

  const items: DropdownItem[] = [
    {
      id: 'edit',
      label: 'Edit',
      icon: <FaPencil />,
      onClick: () => setShowEdit(true),
    },
    {
      id: 'remove',
      label: 'Remove',
      icon: <FaXmark />,
      onClick: () => setShowRemove(true),
    },
  ];

  if (readOnly) {
    return <Wrapper>{spec.label}</Wrapper>;
  }

  return (
    <Wrapper
      onContextMenu={e => {
        e.preventDefault();
        setMenuPoint({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* Same handle as a stored column: where the button sits in the row is
       *  part of the view's configuration too. */}
      <DragIconButton
        {...dragListeners}
        {...dragAttributes}
        title='Drag column'
        aria-label='Drag column'
      >
        <FaGripVertical />
      </DragIconButton>
      <Label title={ROW_ACTION_GENERATORS[spec.kind]?.title}>
        {spec.label}
      </Label>
      <MenuWrapper>
        <DropdownMenu Trigger={Trigger} items={items} />
      </MenuWrapper>
      {menuPoint && (
        <DropdownMenu
          Trigger={AutoOpenTrigger}
          items={items}
          anchorPoint={menuPoint}
          bindActive={active => !active && setMenuPoint(undefined)}
        />
      )}
      {/* Mounted only while open. A table with three action columns would
       *  otherwise keep three closed dialogs in the DOM, whose fields answer to
       *  the same test ids and the same labels as the open one. */}
      {showEdit && (
        <RowActionDialog
          open
          bindShow={setShowEdit}
          classProperties={classProperties}
          editing={spec}
          onSave={updateRowAction}
        />
      )}
      <ConfirmationDialog
        title='Remove action'
        confirmLabel='Remove'
        show={showRemove}
        bindShow={setShowRemove}
        theme={ConfirmationDialogTheme.Alert}
        onConfirm={() => removeRowAction(spec.id)}
      >
        <p>
          Remove the {spec.label} button from this view. Nothing already
          recorded by pressing it is affected — add it back any time.
        </p>
      </ConfirmationDialog>
    </Wrapper>
  );
}

const Wrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  align-self: stretch;
  color: ${p => p.theme.colors.textLight};
  /* Matches a property heading: the header cell is bold, its name button is not. */
  font-weight: normal;
  /* The menu button must survive a narrow column — it's the only way to edit
   * or remove this column. */
  min-width: 0;
`;

const DragIconButton = styled.button`
  background: none;
  color: currentColor;
  display: flex;
  align-items: center;
  border: none;
  height: 1rem;
  padding: 0;
  cursor: grab;
  flex-shrink: 0;

  &:active {
    cursor: grabbing;
  }

  svg {
    color: currentColor;
    max-width: 1rem;
    min-width: 1rem;
  }
`;

const Label = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const MenuWrapper = styled.div`
  margin-left: auto;
  flex-shrink: 0;

  & > button {
    color: ${p => p.theme.colors.textLight};
  }
`;
