import { Property } from '@tomic/react';
import { useContext, type JSX } from 'react';
import { FaPlus } from 'react-icons/fa6';
import {
  TableFilterBar as SharedFilterBar,
  derivedFilterKey,
  filterKey,
  type TableFilterAddMenuProps,
} from '@tomic/table';
import { buildDefaultTrigger } from '@components/Dropdown/DefaultTrigger';
import { TablePageContext } from './tablePageContext';
import { atomicFilterTarget } from './TableFilterChip';
import type { DerivedColumnSpec } from './derivedColumns';
import { usePropertyTitles } from './helpers/usePropertyTitles';
import { ColumnFilterDropdown } from './ColumnFilterDropdown';
import { operatorLabel } from './tableFiltering';

interface TableFilterBarProps {
  columns: Property[];
  /** Hidden columns retain their active chips. */
  allColumns?: Property[];
  derivedColumns: DerivedColumnSpec[];
}
const addFilterLabel = 'Add filter';
const AddFilterTrigger = buildDefaultTrigger(<FaPlus />, addFilterLabel);

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

  // Existing missing chips keep Atomic's popover, labels and value adapters.
  const available = new Set(targets.map(target => target.key));

  for (const filter of filters) {
    const key = filterKey(filter);

    if (!available.has(key)) {
      targets.push({
        ...atomicFilterTarget(key, 'Unavailable column', viewKind),
        addable: false,
      });
      available.add(key);
    }
  }

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
        add: addFilterLabel,
        unavailable: 'Unavailable column',
        unavailableHint: 'This column is unavailable.',
        remove: 'Remove filter',
      }}
    />
  );
}
