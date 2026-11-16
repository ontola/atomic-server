import type { ButtonHTMLAttributes, ComponentType, ReactNode } from 'react';
import { styled } from 'styled-components';
import { FaCheck, FaTrash, FaXmark } from 'react-icons/fa6';
import { tableTheme } from './theme.js';

export interface TableRowSelectCheckboxProps {
  checked: boolean;
  selectionActive: boolean;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
}
/** A button keeps the grid's first-input editor lookup intact. */
export function TableRowSelectCheckbox({
  checked,
  selectionActive,
  label,
  disabled,
  onToggle,
}: TableRowSelectCheckboxProps) {
  return (
    <span data-row-select data-active={selectionActive}>
      <Box
        type='button'
        role='checkbox'
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onMouseDown={event => event.stopPropagation()}
        onClick={event => {
          event.stopPropagation();
          if (!disabled) onToggle();
        }}
      >
        <FaCheck />
      </Box>
    </span>
  );
}
export interface TableRowSelectionActionsProps {
  count: number;
  disabled?: boolean;
  onDelete?: () => void;
  deleteUnavailable?: string;
  onClear: () => void;
  Button?: ComponentType<ButtonHTMLAttributes<HTMLButtonElement>>;
  messages?: Partial<{
    label: string;
    count: ReactNode;
    delete: string;
    clear: string;
  }>;
}
/** Selection counts describe exactly the identities selected by the host. */
export function TableRowSelectionActions({
  count,
  disabled,
  onDelete,
  deleteUnavailable,
  onClear,
  Button = DefaultButton,
  messages,
}: TableRowSelectionActionsProps) {
  if (count === 0) return null;
  const text = {
    label: 'Selected rows',
    count: `${count} selected`,
    delete: 'Delete selected rows',
    clear: 'Clear selection',
    ...messages,
  };

  return (
    <SelectionBar role='toolbar' aria-label={text.label}>
      <SelectionCount>{text.count}</SelectionCount>
      <Button
        type='button'
        title={deleteUnavailable ?? text.delete}
        aria-label={text.delete}
        disabled={disabled || !onDelete || !!deleteUnavailable}
        onClick={() => {
          if (!disabled && !deleteUnavailable) onDelete?.();
        }}
      >
        <FaTrash />
      </Button>
      <Button
        type='button'
        title={text.clear}
        aria-label={text.clear}
        disabled={disabled}
        onClick={() => {
          if (!disabled) onClear();
        }}
      >
        <FaXmark />
      </Button>
    </SelectionBar>
  );
}

const SelectionBar = styled.div`
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding-right: 0.5rem;
  margin-right: 0.25rem;
  border-right: 1px solid ${p => tableTheme(p.theme).colors.bg2};
`;
const SelectionCount = styled.span`
  white-space: nowrap;
  font-size: 0.9em;
  color: ${p => tableTheme(p.theme).colors.textLight};
`;
const DefaultButton = styled.button`
  display: grid;
  place-items: center;
  background: transparent;
  padding: 0.35rem;
  border: 0;
  border-radius: ${p => tableTheme(p.theme).radius};
  color: inherit;
  cursor: pointer;
  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;
const Box = styled.button`
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 1rem;
  height: 1rem;
  padding: 0;
  border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
  border-radius: 3px;
  background-color: ${p => tableTheme(p.theme).colors.bg};
  color: transparent;
  font-size: 0.6rem;
  cursor: pointer;

  &[aria-checked='true'] {
    border-color: ${p => tableTheme(p.theme).colors.main};
    background-color: ${p => tableTheme(p.theme).colors.main};
    color: ${p => tableTheme(p.theme).colors.bg};
  }

  &:hover:not([aria-checked='true']) {
    border-color: ${p => tableTheme(p.theme).colors.main};
  }
`;
