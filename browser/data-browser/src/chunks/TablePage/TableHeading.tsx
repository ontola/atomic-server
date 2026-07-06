import {
  Core,
  Datatype,
  Property,
  Resource,
  useResource,
  useTitle,
} from '@tomic/react';

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

export const TableHeading: TableHeadingComponent<Property> = ({
  column,
  dragListeners,
  dragAttributes,
}): JSX.Element => {
  const [hoverOrFocus, setHoverOrFocus] = useState(false);
  const menuRef = useRef<TableHeadingMenuHandle>(null);

  const propResource = useResource(column.subject);
  const [title] = useTitle(propResource);
  const { setSortBy, sorting, tableClassSubject } =
    useContext(TablePageContext);
  const tableClass = useResource<Core.Class>(tableClassSubject);

  const isRequired = (tableClass.props.requires ?? []).includes(column.subject);

  const Icon = getIcon(propResource, sorting, hoverOrFocus, column.datatype);
  const isSorted = sorting.prop === propResource.subject;

  const text = `${title || column.shortname}${isRequired ? '*' : ''}`;

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
          aria-label={`Sort by ${text}`}
        >
          <span aria-hidden>{text}</span>
        </NameButton>
        <TableHeadingMenu ref={menuRef} resource={propResource} />
      </Wrapper>
    </>
  );
};

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
