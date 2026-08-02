import {
  Core,
  Datatype,
  Resource,
  unknownSubject,
  useCanWrite,
  useResource,
  useTitle,
} from '@tomic/react';
import type { TableColumn } from './useTableColumns';
import { ColumnLanguageChip } from './ColumnLanguageChip';
import { DerivedColumnHeading } from './DerivedColumnHeading';
import { RowActionHeading } from './RowActionHeading';

import {
  FaAngleDown,
  FaAngleUp,
  FaAtom,
  FaGripVertical,
} from 'react-icons/fa6';
import { styled } from 'styled-components';
import { TableHeadingMenu, TableHeadingMenuHandle } from './TableHeadingMenu';
import { TablePageContext } from './tablePageContext';
import { IconType } from 'react-icons';
import { TableSorting } from './tableSorting';
import { useContext, useRef, useState, type JSX } from 'react';
import { TableHeadingComponent } from '@chunks/TableEditor/TableHeader';
import { dataTypeIconMap } from '../../helpers/iconMap';

function getIcon(
  propResource: Resource,
  sorting: TableSorting,
  hoverOrFocus: boolean,
  dataType: Datatype,
): IconType {
  if (sorting.prop === propResource.subject) {
    return sorting.sortDesc ? FaAngleDown : FaAngleUp;
  }

  if (hoverOrFocus) {
    return FaGripVertical;
  }

  return dataTypeIconMap.get(dataType) ?? FaAtom;
}

export const TableHeading: TableHeadingComponent<TableColumn> = ({
  column,
  dragListeners,
  dragAttributes,
}): JSX.Element => {
  const [hoverOrFocus, setHoverOrFocus] = useState(false);
  const menuRef = useRef<TableHeadingMenuHandle>(null);

  // Virtual columns have no property behind them, so `unknownSubject` keeps
  // the hooks unconditional; the render bails out below.
  const propResource = useResource(column.property?.subject ?? unknownSubject);
  const [title] = useTitle(propResource);
  const { setSortBy, sorting, tableClassSubject } =
    useContext(TablePageContext);
  const tableClass = useResource<Core.Class>(tableClassSubject);
  const canWriteClass = useCanWrite(tableClass);

  const property = column.property;

  const isRequired =
    !!property && (tableClass.props.requires ?? []).includes(property.subject);

  const Icon = getIcon(
    propResource,
    sorting,
    hoverOrFocus,
    property?.datatype ?? Datatype.STRING,
  );
  const isSorted = sorting.prop === propResource.subject;

  // A configured computed column — its label plus a menu to edit or remove the
  // configuration behind it.
  if (!property && column.derived) {
    return (
      <DerivedColumnHeading
        spec={column.derived}
        readOnly={!canWriteClass}
        dragListeners={dragListeners}
        dragAttributes={dragAttributes}
      />
    );
  }

  // A configured row action — its label plus a menu to edit or remove it.
  if (!property && column.rowAction) {
    return (
      <RowActionHeading
        spec={column.rowAction}
        readOnly={!canWriteClass}
        dragListeners={dragListeners}
        dragAttributes={dragAttributes}
      />
    );
  }

  // A column the view owns (a timer's Start/Stop button) — a plain label. There
  // is no property to sort by or drag, and nothing to configure: it exists
  // because the view kind renders it, so it carries no menu. The tooltip says
  // so, since every other heading here has one.
  if (!property) {
    return (
      <VirtualWrapper>
        {/* Draggable even though it isn't configurable: where it sits in the row
         *  is the view's column order, which everything can take part in. */}
        <DragIconButton
          {...dragListeners}
          {...dragAttributes}
          title='Drag column'
          aria-label='Drag column'
        >
          <FaGripVertical />
        </DragIconButton>
        <VirtualLabel title={`${column.virtual?.label} — part of this view`}>
          {column.virtual?.label}
        </VirtualLabel>
      </VirtualWrapper>
    );
  }

  const text = `${title || property.shortname}${isRequired ? '*' : ''}`;

  return (
    <>
      <Wrapper
        onMouseEnter={() => setHoverOrFocus(true)}
        onMouseLeave={() => setHoverOrFocus(false)}
        onFocus={() => setHoverOrFocus(true)}
        onBlur={() => setHoverOrFocus(false)}
        onContextMenu={e => menuRef.current?.openAt(e)}
      >
        <DragIconButton {...dragListeners} {...dragAttributes}>
          <Icon title='Drag column' />
        </DragIconButton>
        <NameButton
          onClick={() => setSortBy(propResource.subject)}
          bold={isSorted}
          title={text}
          aria-description={`Sort by ${text}`}
        >
          {text}
        </NameButton>
        {property.datatype === Datatype.LOCALIZEDTEXT && (
          <ColumnLanguageChip
            propertySubject={property.subject}
            languageTag={column.languageTag}
          />
        )}
        <TableHeadingMenu ref={menuRef} resource={propResource} />
      </Wrapper>
    </>
  );
};

const VirtualWrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  align-self: stretch;
  color: ${p => p.theme.colors.textLight};
  /* The header cell is bold; a property's heading renders its name in a button
   * that isn't, so match that rather than standing out as the odd column. */
  font-weight: normal;
  min-width: 0;
`;

const VirtualLabel = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Wrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  /* Fill the full header-cell height so a right-click anywhere on the header
   * (not just the vertically-centred text) opens the column menu — the cell is
   * taller than this content, leaving dead strips above/below otherwise. */
  align-self: stretch;
`;

interface NameButtonProps {
  bold?: boolean;
}

const NameButton = styled.button<NameButtonProps>`
  background: none;
  border: none;
  color: currentColor;
  cursor: pointer;
  font-weight: ${p => (p.bold ? 'bold' : 'normal')};
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0;
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

  &:active {
    cursor: grabbing;
  }
  svg {
    color: currentColor;
    max-width: 1rem;
    min-width: 1rem;
    flex: 1;
  }
`;
