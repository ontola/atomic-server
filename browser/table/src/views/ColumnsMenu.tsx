import type { ComponentType, ReactNode } from 'react';
import { styled } from 'styled-components';
import { FaCheck } from 'react-icons/fa6';

export interface TableColumnVisibility {
  key: string;
  label: string;
  shown: boolean;
  /** Renderer-required columns read as shown regardless of stored visibility. */
  locked?: boolean;
  lockReason?: string;
}
export interface TableColumnsMenuItem {
  key: string;
  label: string;
  shown: boolean;
  icon: ReactNode;
  helper: string;
  disabled: boolean;
  toggle: () => void;
}
export interface TableColumnsMenuPresentation {
  label: string;
  items: readonly TableColumnsMenuItem[];
  disabled: boolean;
  className?: string;
  columnLabel: (label: string) => string;
}
export interface TableColumnsMenuProps {
  columns: readonly TableColumnVisibility[];
  onChange: (key: string, shown: boolean) => void;
  disabled?: boolean;
  /** Host policy: Atomic permits zero; the native grid retains one column. */
  minVisible?: number;
  className?: string;
  columnLabel?: (label: string) => string;
  Menu?: ComponentType<TableColumnsMenuPresentation>;
  messages?: Partial<{
    label: string;
    show: string;
    hide: string;
    keepOne: string;
  }>;
}
const defaultColumnLabel = (label: string) => `Show ${label}`;

/** The actual visibility selector: check marks, renderer locks, last-column
 * policy and guarded stable-key dispatch are shared with the TablePage. */
export function TableColumnsMenu({
  columns,
  onChange,
  disabled = false,
  minVisible = 0,
  className,
  columnLabel = defaultColumnLabel,
  Menu = DefaultColumnsMenu,
  messages,
}: TableColumnsMenuProps) {
  const text = {
    label: 'Toggle properties',
    show: 'Show this property',
    hide: 'Hide this property',
    keepOne: 'Keep at least one column visible.',
    ...messages,
  };
  const unique = [
    ...new Map(columns.map(column => [column.key, column])).values(),
  ];
  const visible = unique.filter(column => column.locked || column.shown).length;
  const items = unique.map(column => {
    const shown = !!column.locked || column.shown;
    const last = shown && visible <= minVisible;
    const locked = !!column.locked || last;

    return {
      key: column.key,
      label: column.label,
      shown,
      icon: shown ? <FaCheck /> : <CheckPlaceholder />,
      disabled: disabled || locked,
      helper: column.locked
        ? (column.lockReason ?? '')
        : last
          ? text.keepOne
          : shown
            ? text.hide
            : text.show,
      toggle: () => {
        if (!disabled && !locked) onChange(column.key, !shown);
      },
    };
  });

  return (
    <Menu
      label={text.label}
      items={items}
      disabled={disabled || !items.length}
      className={className}
      columnLabel={columnLabel}
    />
  );
}

function DefaultColumnsMenu({
  label,
  items,
  disabled,
  className,
  columnLabel,
}: TableColumnsMenuPresentation) {
  if (disabled)
    return (
      <button type='button' disabled>
        {label}
      </button>
    );

  return (
    <details className={className}>
      <summary>{label}</summary>
      {items.map(item => (
        <label key={item.key} title={item.helper}>
          <input
            type='checkbox'
            aria-label={columnLabel(item.label)}
            checked={item.shown}
            disabled={item.disabled}
            onChange={item.toggle}
          />{' '}
          {item.label}
        </label>
      ))}
    </details>
  );
}

const CheckPlaceholder = styled.span`
  display: inline-block;
  width: 1em;
`;
