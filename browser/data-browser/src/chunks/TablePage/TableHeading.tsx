import {
  Core,
  Datatype,
  core,
  unknownSubject,
  useCanWrite,
  useResource,
  useString,
} from '@tomic/react';
import type { TableColumn } from './useTableColumns';
import { ColumnLanguageChip } from './ColumnLanguageChip';
import { DerivedColumnHeading } from './DerivedColumnHeading';
import { RowActionHeading } from './RowActionHeading';

import { FaAtom, FaGripVertical } from 'react-icons/fa6';
import { TablePropertyHeading } from '@tomic/table';
import { styled } from 'styled-components';
import { columnLabel } from './helpers/columnLabel';
import { TableHeadingMenu, TableHeadingMenuHandle } from './TableHeadingMenu';
import { TablePageContext } from './tablePageContext';
import { useContext, useRef, type JSX } from 'react';
import { TableHeadingComponent } from '@chunks/TableEditor/TableHeader';
import { dataTypeIconMap } from '../../helpers/iconMap';

export const TableHeading: TableHeadingComponent<TableColumn> = ({
  column,
  dragListeners,
  dragAttributes,
}): JSX.Element => {
  const menuRef = useRef<TableHeadingMenuHandle>(null);

  // Virtual columns have no property behind them, so `unknownSubject` keeps
  // the hooks unconditional; the render bails out below.
  const propResource = useResource(column.property?.subject ?? unknownSubject);
  // The property's own name, not its title: a title falls back to the shortname
  // on its own, which is exactly the case `columnLabel` has to tell apart.
  const [name] = useString(propResource, core.properties.name);
  const { setSortBy, sorting, tableClassSubject } =
    useContext(TablePageContext);
  const tableClass = useResource<Core.Class>(tableClassSubject);
  const canWriteClass = useCanWrite(tableClass);

  const property = column.property;

  const isRequired =
    !!property && (tableClass.props.requires ?? []).includes(property.subject);

  const Icon =
    dataTypeIconMap.get(property?.datatype ?? Datatype.STRING) ?? FaAtom;
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

  const text = `${columnLabel(name, property.shortname)}${isRequired ? '*' : ''}`;

  return (
    <>
      <TablePropertyHeading
        label={columnLabel(name, property.shortname)}
        required={isRequired}
        sorted={
          isSorted ? (sorting.sortDesc ? 'descending' : 'ascending') : undefined
        }
        onSort={() => setSortBy(propResource.subject)}
        sortDescription={`Sort by ${text}`}
        dragLabel='Drag column'
        icon={<Icon />}
        dragListeners={dragListeners}
        dragAttributes={dragAttributes}
        onContextMenu={event => menuRef.current?.openAt(event)}
      >
        {property.datatype === Datatype.LOCALIZEDTEXT && (
          <ColumnLanguageChip
            propertySubject={property.subject}
            languageTag={column.languageTag}
          />
        )}
        <TableHeadingMenu ref={menuRef} resource={propResource} />
      </TablePropertyHeading>
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
