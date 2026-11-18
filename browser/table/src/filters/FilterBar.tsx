import type { ComponentType } from 'react';
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
  AddMenu: ComponentType<TableFilterAddMenuProps>;
  messages?: Partial<{
    toolbar: string;
    add: string;
    unavailable: string;
    unavailableHint: string;
    remove: string;
  }>;
}

const defaultOperatorLabel = (operator: TableFilter['operator']) => operator;

/** Existing active-filter layout and dispatch. Host menu and metadata leaves
 * keep their existing behavior; hidden fields retain their active chips. */
export function TableFilterBar({
  filters,
  targets,
  onAdd,
  onValueChange,
  onOperatorChange,
  onRemove,
  operatorLabel = defaultOperatorLabel,
  AddMenu,
  messages,
}: TableFilterBarProps) {
  if (!filters.length) return null;
  const text = {
    toolbar: 'Table filters',
    add: 'Add filter',
    unavailable: 'Unavailable column',
    unavailableHint: 'This column is unavailable.',
    remove: 'Remove filter',
    ...messages,
  };
  const byKey = new Map(targets.map(target => [target.key, target]));
  const taken = new Set(filters.map(filterKey));
  const items = targets
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
      {!!items.length && <AddMenu items={items} label={text.add} />}
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
