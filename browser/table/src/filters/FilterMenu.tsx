import { useState, type ComponentType } from 'react';
import { filterKey, type TableFilter } from '../views/configuration.js';

export interface TableFilterAddMenuProps {
  items: readonly { key: string; label: string; onSelect: () => void }[];
  label: string;
  searchLabel: string;
  noMatch: string;
  disabled?: boolean;
  description?: string;
}

export interface TableFilterCandidate {
  key: string;
  addable?: boolean;
}
export function availableTableFilterTargets<T extends TableFilterCandidate>(
  filters: readonly TableFilter[],
  targets: readonly T[],
): T[] {
  const taken = new Set(filters.map(filterKey));

  return [
    ...new Map(targets.map(target => [target.key, target])).values(),
  ].filter(target => target.addable !== false && !taken.has(target.key));
}
export interface TableFilterMenuProps {
  filters: readonly TableFilter[];
  targets: readonly (TableFilterCandidate & { label: string })[];
  onAdd: (key: string) => void;
  disabled?: boolean;
  Menu?: ComponentType<TableFilterAddMenuProps>;
  messages?: Partial<{
    label: string;
    search: string;
    noMatch: string;
    description: string;
  }>;
}
/** Initial and subsequent filter selection use the same stable target policy
 * as the active bar. The default menu needs no backend UI implementation. */
export function TableFilterMenu({
  filters,
  targets,
  onAdd,
  disabled,
  Menu = DefaultTableFilterMenu,
  messages,
}: TableFilterMenuProps) {
  const text = {
    label: 'Filter',
    search: 'Find a column to filter by',
    noMatch: 'No column matches',
    description: 'Filter rows by a column',
    ...messages,
  };
  const items = availableTableFilterTargets(filters, targets).map(target => ({
    key: target.key,
    label: target.label,
    onSelect: () => {
      if (!disabled) onAdd(target.key);
    },
  }));

  return (
    <Menu
      items={items}
      label={text.label}
      searchLabel={text.search}
      noMatch={text.noMatch}
      description={text.description}
      disabled={disabled || !items.length}
    />
  );
}

export function DefaultTableFilterMenu({
  items,
  label,
  searchLabel,
  noMatch,
  disabled,
  description,
}: TableFilterAddMenuProps) {
  const [search, setSearch] = useState('');
  const matches = items.filter(item =>
    item.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );

  if (disabled || !items.length)
    return (
      <button type='button' disabled>
        {label}
      </button>
    );

  return (
    <details
      onToggle={event => {
        if (!event.currentTarget.open) setSearch('');
      }}
    >
      <summary>{label}</summary>
      {description && <p>{description}</p>}
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
