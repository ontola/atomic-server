import {
  useImperativeHandle,
  useState,
  useRef,
  useId,
  type Ref,
  type ComponentType,
  type ReactNode,
  type MouseEvent,
  type KeyboardEvent,
} from 'react';
import * as Popover from '@radix-ui/react-popover';
import { styled } from 'styled-components';
import {
  FaPencil,
  FaEllipsisVertical,
  FaEye,
  FaEyeSlash,
  FaXmark,
  FaFilter,
} from 'react-icons/fa6';
import { tableTheme } from './theme.js';

export type TablePropertyCommand =
  | 'view'
  | 'filter'
  | 'hide'
  | 'edit'
  | 'remove';
export interface TablePropertyAction {
  run?: () => void;
  disabled?: boolean;
  reason?: string;
}
export interface TablePropertyMenuHandle {
  openAt: (event: MouseEvent) => void;
}
export interface TablePropertyMenuItem {
  key: TablePropertyCommand;
  label: string;
  icon: ReactNode;
  disabled: boolean;
  reason?: string;
  run: () => void;
}
export interface TablePropertyMenuPresentation {
  label: string;
  items: readonly TablePropertyMenuItem[];
  disabled: boolean;
  point?: { x: number; y: number };
  onContextClose: () => void;
}
export interface TablePropertyMenuProps {
  actions: Partial<Record<TablePropertyCommand, TablePropertyAction>>;
  disabled?: boolean;
  ref?: Ref<TablePropertyMenuHandle>;
  Menu?: ComponentType<TablePropertyMenuPresentation>;
  messages?: Partial<{
    label: string;
    view: string;
    filter: string;
    hide: string;
    edit: string;
    editUnavailable: string;
    remove: string;
  }>;
}
const icons: Record<TablePropertyCommand, ReactNode> = {
  view: <FaEye />,
  filter: <FaFilter />,
  hide: <FaEyeSlash />,
  edit: <FaPencil />,
  remove: <FaXmark />,
};
const kinds: TablePropertyCommand[] = [
  'view',
  'filter',
  'hide',
  'edit',
  'remove',
];

/** Actual property actions and context opening. Backend services implement
 * navigation/edit/removal; missing or unavailable actions cannot dispatch. */
export function TablePropertyMenu({
  actions,
  disabled = false,
  ref,
  Menu = DefaultPropertyMenu,
  messages,
}: TablePropertyMenuProps) {
  const [point, setPoint] = useState<{ x: number; y: number }>();
  const text = {
    label: 'Edit column',
    view: 'View',
    filter: 'Filter',
    hide: 'Hide in this view',
    edit: 'Edit',
    editUnavailable: 'Edit unavailable',
    remove: 'Remove',
    ...messages,
  };
  const items = kinds.map(key => {
    const action = actions[key];
    const unavailable = disabled || !action?.run || !!action.disabled;

    return {
      key,
      label: key === 'edit' && unavailable ? text.editUnavailable : text[key],
      icon: icons[key],
      disabled: unavailable,
      reason: action?.reason,
      run: () => {
        if (!unavailable) action?.run?.();
      },
    };
  });
  const unavailable = disabled || items.every(item => item.disabled);
  useImperativeHandle(
    ref,
    () => ({
      openAt: event => {
        if (unavailable) return;
        event.preventDefault();
        setPoint({ x: event.clientX, y: event.clientY });
      },
    }),
    [unavailable],
  );

  return (
    <Wrapper>
      <Menu
        label={text.label}
        items={items}
        disabled={unavailable}
        point={point}
        onContextClose={() => setPoint(undefined)}
      />
    </Wrapper>
  );
}

function DefaultPropertyMenu({
  label,
  items,
  disabled,
  point,
  onContextClose,
}: TablePropertyMenuPresentation) {
  const [open, setOpen] = useState(false);
  const selectedAction = useRef(false);
  const descriptionId = useId();

  const close = () => {
    setOpen(false);
    onContextClose();
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();

    if (event.key === 'Escape') {
      event.preventDefault();
      close();

      return;
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      ),
    ];
    if (!buttons.length) return;
    const current = buttons.findIndex(
      button => button === document.activeElement,
    );
    const index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1) % buttons.length
            : current < 0
              ? buttons.length - 1
              : (current - 1 + buttons.length) % buttons.length;
    buttons[index].focus();
  };

  return (
    <Popover.Root
      open={!disabled && (open || !!point)}
      onOpenChange={next => {
        setOpen(next);
        if (!next) onContextClose();
      }}
    >
      <Popover.Trigger asChild>
        <Trigger
          type='button'
          disabled={disabled}
          title={label}
          aria-label={label}
          aria-haspopup='menu'
        >
          <FaEllipsisVertical />
        </Trigger>
      </Popover.Trigger>
      <Popover.Portal>
        <Content
          role='menu'
          aria-label={label}
          collisionPadding={10}
          onKeyDown={keyDown}
          onCloseAutoFocus={event => {
            if (selectedAction.current) event.preventDefault();
            selectedAction.current = false;
          }}
        >
          {items.map(item => (
            <Item
              key={item.key}
              type='button'
              role='menuitem'
              disabled={item.disabled}
              title={item.reason}
              aria-describedby={
                item.reason ? `${descriptionId}-${item.key}` : undefined
              }
              onClick={event => {
                event.stopPropagation();
                selectedAction.current = true;
                close();
                item.run();
              }}
            >
              <Icon>{item.icon}</Icon>
              {item.label}
              {item.reason && (
                <span hidden id={`${descriptionId}-${item.key}`}>
                  {item.reason}
                </span>
              )}
            </Item>
          ))}
        </Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const Wrapper = styled.div`
  margin-left: auto;
  & > button {
    color: ${p => tableTheme(p.theme).colors.textLight};
  }
`;
const Trigger = styled.button`
  background: none;
  color: inherit;
  border: none;
  cursor: pointer;
  padding: 0.25rem;
  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;
const Content = styled(Popover.Content)`
  display: flex;
  flex-direction: column;
  min-width: 12rem;
  padding: 0.25rem;
  font:
    0.875rem/1.5 system-ui,
    sans-serif;
  background: ${p => tableTheme(p.theme).colors.bg};
  color: ${p => tableTheme(p.theme).colors.text};
  border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
  border-radius: ${p => tableTheme(p.theme).radius};
  box-shadow: ${p => tableTheme(p.theme).boxShadowIntense};
  z-index: 10000000;
`;
const Item = styled.button`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  text-align: left;
  font: inherit;
  color: inherit;
  border: none;
  background: none;
  padding: 0.4rem 0.6rem;
  cursor: pointer;
  &:hover:not(:disabled),
  &:focus-visible {
    background: ${p => tableTheme(p.theme).colors.bg1};
  }
  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;
const Icon = styled.span`
  display: inline-flex;
`;
