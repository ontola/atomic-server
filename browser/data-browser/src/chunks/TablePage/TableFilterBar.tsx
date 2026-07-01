import { Property } from '@tomic/react';
import { useContext, useMemo, type JSX } from 'react';
import { styled } from 'styled-components';
import { FaPlus } from 'react-icons/fa6';
import { DropdownMenu, DropdownItem } from '@components/Dropdown';
import { buildDefaultTrigger } from '@components/Dropdown/DefaultTrigger';
import { TablePageContext } from './tablePageContext';
import { TableFilterChip } from './TableFilterChip';

interface TableFilterBarProps {
  columns: Property[];
}

const AddFilterTrigger = buildDefaultTrigger(<FaPlus />, 'Add filter');

/**
 * The row of active filter chips shown above the table columns. Hidden when no
 * filters are set; filters are added either from a column's `…` menu or the
 * `+ Filter` button here.
 */
export function TableFilterBar({
  columns,
}: TableFilterBarProps): JSX.Element | null {
  const { filters, addFilter } = useContext(TablePageContext);

  const columnBySubject = useMemo(
    () => new Map(columns.map(c => [c.subject, c])),
    [columns],
  );

  const addItems = useMemo(
    (): DropdownItem[] =>
      columns
        .filter(c => !filters.some(f => f.property === c.subject))
        .map(c => ({
          id: c.subject,
          label: c.shortname,
          onClick: () => addFilter(c.subject),
        })),
    [columns, filters, addFilter],
  );

  if (filters.length === 0) {
    return null;
  }

  return (
    <Bar role='toolbar' aria-label='Table filters'>
      {filters.map(filter => {
        const column = columnBySubject.get(filter.property);

        if (!column) {
          return null;
        }

        return (
          <TableFilterChip
            key={filter.property}
            filter={filter}
            column={column}
          />
        );
      })}
      {addItems.length > 0 && (
        <DropdownMenu Trigger={AddFilterTrigger} items={addItems} />
      )}
    </Bar>
  );
}

const Bar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding-block: 0.5rem;
`;
