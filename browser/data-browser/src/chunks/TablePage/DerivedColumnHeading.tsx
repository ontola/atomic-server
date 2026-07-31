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
import { DerivedColumnDialog } from './DerivedColumnDialog';
import {
  DERIVED_COLUMN_GENERATORS,
  type DerivedColumnSpec,
} from './derivedColumns';

const Trigger = buildDefaultTrigger(
  <FaEllipsisVertical />,
  'Edit computed column',
);

/**
 * Heading of a computed column: its label plus the menu that edits or removes
 * it. There is no property behind it, so nothing here sorts, filters or drags —
 * what it offers is the configuration that produced the column.
 */
export function DerivedColumnHeading({
  spec,
  readOnly,
  dragListeners,
  dragAttributes,
}: {
  spec: DerivedColumnSpec;
  readOnly: boolean;
  dragListeners?: SyntheticListenerMap;
  dragAttributes?: DraggableAttributes;
}): JSX.Element {
  const { classProperties, updateDerivedColumn, removeDerivedColumn } =
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
      {/* Same handle as a stored column: where a computed column sits is part
       *  of the view's configuration too. */}
      <DragIconButton
        {...dragListeners}
        {...dragAttributes}
        title='Drag column'
        aria-label='Drag column'
      >
        <FaGripVertical />
      </DragIconButton>
      <Label title={DERIVED_COLUMN_GENERATORS[spec.kind]?.title}>
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
      <DerivedColumnDialog
        open={showEdit}
        bindShow={setShowEdit}
        classProperties={classProperties}
        editing={spec}
        onSave={updateDerivedColumn}
      />
      <ConfirmationDialog
        title='Remove computed column'
        confirmLabel='Remove'
        show={showRemove}
        bindShow={setShowRemove}
        theme={ConfirmationDialogTheme.Alert}
        onConfirm={() => removeDerivedColumn(spec.id)}
      >
        <p>
          Remove the {spec.label} column from this view. It is computed, so no
          data is deleted — add it back any time.
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
