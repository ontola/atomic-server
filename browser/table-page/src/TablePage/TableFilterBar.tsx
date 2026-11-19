import { Property } from '@tomic/react';
import { useContext, type JSX } from 'react';
import { FaPlus } from 'react-icons/fa6';
import {
  TableFilterBar as SharedFilterBar,
  derivedFilterKey,
  type TableFilterAddMenuProps,
} from '@tomic/table';
import { buildDefaultTrigger } from '@tomic/resource-ui/components/Dropdown/DefaultTrigger';
import { TablePageContext } from './tablePageContext.js';
import { atomicFilterTarget } from './TableFilterChip.js';
import type { DerivedColumnSpec } from './derivedColumns.js';
import { usePropertyTitles } from './helpers/usePropertyTitles.js';
import { ColumnFilterDropdown } from './ColumnFilterDropdown.js';
import { operatorLabel } from './tableFiltering.js';

interface TableFilterBarProps {
  columns: Property[];
  /** Hidden columns retain their active chips. */
  allColumns?: Property[];
  derivedColumns: DerivedColumnSpec[];
}
const AddFilterTrigger = buildDefaultTrigger(<FaPlus />, 'Add filter');

function AtomicAddMenu({ items }: TableFilterAddMenuProps) {
  return (
    <ColumnFilterDropdown
      Trigger={AddFilterTrigger}
      items={items.map(item => ({
        id: item.key,
        label: item.label,
        onClick: item.onSelect,
      }))}
    />
  );
}

/** Atomic metadata adapter for the shared active-filter row. */
export function TableFilterBar({
  columns,
  allColumns = columns,
  derivedColumns,
}: TableFilterBarProps): JSX.Element {
  const {
    filters,
    addFilter,
    setFilterValue,
    setFilterOperator,
    removeFilter,
    viewKind,
  } = useContext(TablePageContext);
  const titles = usePropertyTitles(allColumns);
  const visible = new Set(columns.map(column => column.subject));
  const targets = [
    ...allColumns.map(column => ({
      ...atomicFilterTarget(
        column.subject,
        titles.get(column.subject)!,
        viewKind,
        column,
      ),
      addable: visible.has(column.subject),
    })),
    ...derivedColumns.map(spec =>
      atomicFilterTarget(
        derivedFilterKey(spec.id),
        spec.label,
        viewKind,
        undefined,
        spec,
      ),
    ),
  ];

  return (
    <SharedFilterBar
      filters={filters}
      targets={targets}
      onAdd={addFilter}
      onValueChange={setFilterValue}
      onOperatorChange={setFilterOperator}
      onRemove={removeFilter}
      operatorLabel={operatorLabel}
      AddMenu={AtomicAddMenu}
      messages={{
        toolbar: 'Table filters',
        add: 'Add filter',
        search: 'Find a column to filter by',
        noMatch: 'No column matches',
        unavailable: 'Unavailable column',
        unavailableHint: 'This column is unavailable.',
        remove: 'Remove filter',
      }}
    />
  );
}
