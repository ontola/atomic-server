import { useState, type ComponentType } from 'react';
import { styled } from 'styled-components';
import { filterKey, type TableFilter } from '../views/configuration.js';
import { TableFilterChip, type TableFilterChipProps } from './FilterChip.js';

export interface TableFilterTarget {
  /** Same stable identity used by filterKey, including derived: for expressions. */
  key: string;
  chip: Omit<
    TableFilterChipProps,
    | 'filter'
    | 'operatorLabel'
    | 'onValueChange'
    | 'onOperatorChange'
    | 'onRemove'
  > & {
    operatorLabel: (operator: TableFilter['operator']) => string;
  };
  /** Hidden columns still resolve existing chips without appearing in Add. */
  addable?: boolean;
}
export interface TableFilterAddMenuProps {
  items: readonly { key: string; label: string; onSelect: () => void }[];
  label: string;
  searchLabel: string;
  noMatch: string;
}
export interface TableFilterBarProps {
  filters: readonly TableFilter[];
  targets: readonly TableFilterTarget[];
  onAdd: (key: string) => void;
  onValueChange: (key: string, value: string) => void;
  onOperatorChange: (key: string, operator: TableFilter['operator']) => void;
  onRemove: (key: string) => void;
  /** Label for operators on targets that no longer exist. */
  operatorLabel?: (operator: TableFilter['operator']) => string;
  /** Menu primitive adapter; the bar owns candidate exclusion and dispatch. */
  AddMenu?: ComponentType<TableFilterAddMenuProps>;
  messages?: Partial<{
    toolbar: string;
    add: string;
    search: string;
    noMatch: string;
    unavailable: string;
    unavailableHint: string;
    remove: string;
  }>;
}

/** The actual active-filter row. Backend descriptors supply labels/types and
 * reference leaves; chip editing, missing targets and Add candidates stay here. */
export function TableFilterBar({
  filters,
  targets,
  onAdd,
  onValueChange,
  onOperatorChange,
  onRemove,
  operatorLabel = operator => operator,
  AddMenu = DefaultAddMenu,
  messages,
}: TableFilterBarProps) {
  if (!filters.length) return null;
  const text = {
    toolbar: 'Table filters',
    add: 'Add filter',
    search: 'Find a column to filter by',
    noMatch: 'No column matches',
    unavailable: 'Unavailable column',
    unavailableHint: 'This column is unavailable.',
    remove: 'Remove filter',
    ...messages,
  };
  const byKey = new Map(targets.map(target => [target.key, target]));
  const taken = new Set(filters.map(filterKey));
  const items = [...byKey.values()]
    .filter(target => target.addable !== false && !taken.has(target.key))
    .map(target => ({
      key: target.key,
      label: target.chip.label,
      onSelect: () => onAdd(target.key),
    }));

  return (
    <Bar role='toolbar' aria-label={text.toolbar}>
      {filters.map(filter => {
        const key = filterKey(filter);
        const chip = byKey.get(key)?.chip ?? {
          label: text.unavailable,
          operatorLabel,
          operators: [],
          unavailable: true,
          messages: { unavailable: text.unavailableHint, remove: text.remove },
        };

        return (
          <TableFilterChip
            {...chip}
            key={key}
            filter={filter}
            operatorLabel={chip.operatorLabel(filter.operator)}
            onValueChange={value => onValueChange(key, value)}
            onOperatorChange={operator => onOperatorChange(key, operator)}
            onRemove={() => onRemove(key)}
          />
        );
      })}
      {!!items.length && (
        <AddMenu
          items={items}
          label={text.add}
          searchLabel={text.search}
          noMatch={text.noMatch}
        />
      )}
    </Bar>
  );
}

function DefaultAddMenu({
  items,
  label,
  searchLabel,
  noMatch,
}: TableFilterAddMenuProps) {
  const [search, setSearch] = useState('');
  const matches = items.filter(item =>
    item.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );

  return (
    <details
      onToggle={event => {
        if (!event.currentTarget.open) setSearch('');
      }}
    >
      <summary>{label}</summary>
      <input
        type='search'
        aria-label={searchLabel}
        value={search}
        onChange={event => setSearch(event.target.value)}
      />
      {!matches.length && <p role='status'>{noMatch}</p>}
      {matches.map(item => (
        <button
          key={item.key}
          type='button'
          onClick={event => {
            item.onSelect();
            const menu = event.currentTarget.closest('details');
            if (menu) menu.open = false;
            setSearch('');
          }}
        >
          {item.label}
        </button>
      ))}
    </details>
  );
}

const Bar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding-block: 0.5rem;
`;
