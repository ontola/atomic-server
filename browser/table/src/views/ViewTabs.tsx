import {
  forwardRef,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { css, styled } from 'styled-components';
import { tableTheme } from '../theme.js';

export interface ViewTabProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'name'
> {
  name: string;
  icon?: ReactNode;
  active: boolean;
  editing?: boolean;
  renameLabel?: string;
  onRename: (name: string) => void;
  onEditingChange: (editing: boolean) => void;
}

/** Shared tab presentation and rename interaction. The host owns identity,
 * navigation, permissions, menus, reordering and persistence. */
export const ViewTab = forwardRef<HTMLButtonElement, ViewTabProps>(
  function ViewTab(
    {
      name,
      icon,
      active,
      editing,
      renameLabel = 'Rename view',
      onRename,
      onEditingChange,
      ...buttonProps
    },
    ref,
  ) {
    if (editing)
      return (
        <RenameInput
          name={name}
          label={renameLabel}
          onRename={onRename}
          onClose={() => onEditingChange(false)}
        />
      );

    return (
      <Tab
        {...buttonProps}
        ref={ref}
        type='button'
        role='tab'
        aria-selected={active}
        $active={active}
      >
        {icon}
        {name}
      </Tab>
    );
  },
);

function RenameInput({
  name,
  label,
  onRename,
  onClose,
}: {
  name: string;
  label: string;
  onRename: (name: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const finished = useRef(false);

  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const trimmed = draft.trim();
    if (save && trimmed && trimmed !== name) onRename(trimmed);
    onClose();
  };

  return (
    <TabInput
      autoFocus
      aria-label={label}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(e.key === 'Enter');
        }
      }}
    />
  );
}

export const ViewTabsBar = styled.div`
  min-width: 0;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding-block: 0.25rem;
`;

export const ViewTabList = styled.div.attrs({ role: 'tablist' })`
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
  > * {
    flex-shrink: 0;
  }
  display: flex;
  align-items: center;
  gap: 0.25rem;
`;

export const ViewTabActions = styled.div`
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 0.25rem;
`;

const Tab = styled.button<{ $active: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  border: none;
  background-color: transparent;
  padding: 0.3rem 0.5rem;
  border-radius: ${p => tableTheme(p.theme).radius};
  color: ${p => tableTheme(p.theme).colors.textLight};
  height: 1.85rem;
  white-space: nowrap;
  font-size: inherit;
  cursor: pointer;
  transition:
    background-color 0.1s,
    color 0.1s;
  &:hover:not([disabled]),
  &:focus-visible:not([disabled]) {
    background-color: ${p => tableTheme(p.theme).colors.bg1};
    color: ${p => tableTheme(p.theme).colors.text};
  }
  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
  ${p =>
    p.$active &&
    css`
      background-color: ${tableTheme(p.theme).colors.bg1};
      color: ${tableTheme(p.theme).colors.text};
      font-weight: bold;
    `}
`;

const TabInput = styled.input`
  box-sizing: border-box;
  height: 1.85rem;
  width: 10rem;
  padding: 0.3rem 0.5rem;
  border: 1px solid ${p => tableTheme(p.theme).colors.main};
  border-radius: ${p => tableTheme(p.theme).radius};
  color: ${p => tableTheme(p.theme).colors.text};
  background-color: ${p => tableTheme(p.theme).colors.bg};
  font: inherit;
  font-weight: bold;
`;
