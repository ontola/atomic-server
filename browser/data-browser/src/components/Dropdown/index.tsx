import {
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  useCallback,
  PropsWithChildren,
  ReactNode,
  useEffect,
  type JSX,
} from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { styled } from 'styled-components';
import { useClickAwayListener } from '../../hooks/useClickAwayListener';
import { Button } from '../Button';
import { DropdownTriggerComponent as DropdownTriggerComponent } from './DropdownTrigger';
import { shortcuts } from '../HotKeyWrapper';
import { Shortcut } from '../Shortcut';
import { transition } from '../../helpers/transition';
import { createPortal } from 'react-dom';
import { DropdownPortalContext } from './dropdownContext';
import { loopingIndex } from '../../helpers/loopingIndex';
import { useControlLock } from '../../hooks/useControlLock';
import { useDialogTreeInfo } from '../Dialog/dialogContext';

export const DIVIDER = 'divider' as const;

export type MenuItemMinimial = {
  onClick: () => unknown;
  label: string;
  helper?: string;
  id: string;
  icon?: ReactNode;
  disabled?: boolean;
  header?: boolean;
  /** Keyboard shortcut helper */
  shortcut?: string;
};

export type DropdownItem = typeof DIVIDER | MenuItemMinimial;

interface DropdownMenuProps {
  /** The list of menu items */
  items: DropdownItem[];
  Trigger: DropdownTriggerComponent;
  /** Enables the keyboard shortcut */
  isMainMenu?: boolean;
  bindActive?: (active: boolean) => void;
  /**
   * When set, positions the menu at this viewport point (a right-click / context
   * menu) instead of anchoring it to the trigger element. Pair with
   * `AutoOpenTrigger` to open it programmatically at the cursor.
   */
  anchorPoint?: { x: number; y: number };
}

export const isItem = (
  item: MenuItemMinimial | string | undefined,
): item is MenuItemMinimial =>
  typeof item !== 'string' && typeof item?.label === 'string';

const shouldSkip = (item?: DropdownItem) => !isItem(item) || item.disabled;

const getAdditionalOffest = (increment: number) =>
  increment === 0 ? 1 : Math.sign(increment);

/**
 * Returns a function that finds the next available index, it skips disabled
 * items and dividers and loops around when at the start or end of the list.
 * Returns 0 when no suitable index is found.
 */
const createIndexOffset =
  (items: DropdownItem[]) => (startingPoint: number, offset: number) => {
    const findNextAvailable = (
      scopedStartingPoint: number,
      scopedOffset: number,
    ) => {
      const newIndex = loopingIndex(
        scopedStartingPoint + scopedOffset,
        items.length,
      );

      const additionalIncrement = getAdditionalOffest(offset);

      if (shouldSkip(items[newIndex])) {
        return findNextAvailable(newIndex, additionalIncrement);
      }

      return newIndex;
    };

    return findNextAvailable(startingPoint, offset);
  };

function normalizeItems(items: DropdownItem[]) {
  return items.reduce((acc: DropdownItem[], current, i) => {
    // If the item is a divider at the start or end of the list, remove it.
    if ((i === 0 || i === items.length - 1) && !isItem(current)) {
      return acc;
    }

    // If the current and previous item are dividers, remove the current one.
    if (!isItem(current) && !isItem(acc[i - 1])) {
      return acc;
    }

    return [...acc, current];
  }, []);
}

/**
 * Menu that opens on click and shows a bunch of items. Closes on Escape and on
 * clicking outside. Use arrow keys to select items, and open items on Enter.
 * Renders the Dropdown on a place where there is room on screen.
 */
export function DropdownMenu({
  items,
  Trigger,
  isMainMenu,
  bindActive = () => undefined,
  anchorPoint,
}: DropdownMenuProps): JSX.Element {
  const menuId = useId();
  const triggerId = useId();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const [isActive, _setIsActive] = useState(false);
  const { inDialog } = useDialogTreeInfo();

  useControlLock(isActive);

  const setIsActive = useCallback(
    (active: boolean) => {
      _setIsActive(active);
      bindActive(active);
    },
    [bindActive],
  );

  const handleClose = useCallback(() => {
    triggerRef.current?.focus();
    setIsActive(false);
  }, [setIsActive]);

  useClickAwayListener([triggerRef, dropdownRef], handleClose, isActive, [
    'click',
  ]);

  const normalizedItems = useMemo(() => normalizeItems(items), [items]);

  const getNewIndex = createIndexOffset(normalizedItems);
  const [selectedIndex, setSelectedIndex] = useState<number>(getNewIndex(0, 0));
  // if the keyboard is used to navigate the menu items
  const [useKeys, setUseKeys] = useState(true);

  const handleToggle = useCallback(() => {
    if (isActive) {
      handleClose();

      return;
    }

    setIsActive(true);

    requestAnimationFrame(() => {
      if (!triggerRef.current || !dropdownRef.current) {
        return;
      }

      const menuRect = dropdownRef.current.getBoundingClientRect();

      // A right-click / context menu: position at the cursor point with the
      // usual convention (below-right, flipping left/up when it would overflow
      // the viewport, clamped to stay on-screen).
      if (anchorPoint) {
        const left =
          anchorPoint.x + menuRect.width > window.innerWidth
            ? anchorPoint.x - menuRect.width
            : anchorPoint.x;
        const top =
          anchorPoint.y + menuRect.height > window.innerHeight
            ? anchorPoint.y - menuRect.height
            : anchorPoint.y;

        dropdownRef.current.style.left = `${Math.max(0, left)}px`;
        dropdownRef.current.style.top = `${Math.max(0, top)}px`;
        dropdownRef.current.style.visibility = 'visible';

        return;
      }

      const triggerRect = triggerRef.current.getBoundingClientRect();

      // Check if we're inside a dialog
      const dialog = dropdownRef.current.closest('dialog');

      // TODO: Use CSS anchor positioning instead.
      if (dialog) {
        // For dialogs, use absolute positioning relative to the dialog
        const dialogRect = dialog.getBoundingClientRect();
        const relativeTop = triggerRect.y - dialogRect.y;
        const relativeLeft = triggerRect.x - dialogRect.x;

        const topPos = relativeTop - menuRect.height;

        // If the top is outside of the dialog, render it below
        if (topPos < 0) {
          dropdownRef.current.style.top = `${relativeTop + triggerRect.height}px`;
        } else {
          dropdownRef.current.style.top = `${topPos}px`;
        }

        const leftPos = relativeLeft - menuRect.width;

        // If the left is outside of the dialog, render it to the right
        if (leftPos < 0) {
          dropdownRef.current.style.left = `${relativeLeft}px`;
        } else {
          dropdownRef.current.style.left = `${relativeLeft - menuRect.width + triggerRect.width}px`;
        }
      } else {
        // Original logic for non-dialog contexts
        const topPos = triggerRect.y - menuRect.height;

        // If the top is outside of the screen, render it below
        if (topPos < 0) {
          dropdownRef.current.style.top = `${triggerRect.y + triggerRect.height / 2}px`;
        } else {
          dropdownRef.current.style.top = `${topPos + triggerRect.height / 2}px`;
        }

        const leftPos = triggerRect.x - menuRect.width;

        // If the left is outside of the screen, render it to the right
        if (leftPos < 0) {
          dropdownRef.current.style.left = `${triggerRect.x}px`;
        } else {
          dropdownRef.current.style.left = `${triggerRect.x - menuRect.width + triggerRect.width}px`;
        }
      }

      dropdownRef.current.style.visibility = 'visible';
    });
  }, [isActive, setIsActive, anchorPoint]);

  const handleMouseOverMenu = useCallback(() => {
    setUseKeys(false);
  }, []);

  const handleTriggerActivate = useCallback(() => {
    setUseKeys(true);
    setSelectedIndex(getNewIndex(0, 0));
    handleToggle();
  }, [handleToggle]);

  // Close the menu
  useHotkeys('esc', handleClose, { enabled: isActive });
  useHotkeys(
    'tab',
    e => {
      e.preventDefault();
      handleClose();
    },
    { enabled: isActive },
  );

  // Toggle menu
  useHotkeys(
    shortcuts.menu,
    e => {
      e.preventDefault();
      handleToggle();
      setUseKeys(true);
    },
    { enabled: !!isMainMenu },
    [isActive],
  );
  // Arrow navigation + Enter/Escape are handled on the menu element itself
  // (not via the global `useHotkeys` above): the menu renders in a portal, and
  // react-hotkeys-hook's document listener does NOT fire for keys dispatched
  // while focus is inside that portal — so after the first keypress moved focus
  // into the menu, arrows stopped working. Handling `onKeyDown` on the menu (to
  // which keydowns from the focused item bubble) is reliable.
  const handleMenuKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setUseKeys(true);
        setSelectedIndex(prev => getNewIndex(prev, 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setUseKeys(true);
        setSelectedIndex(prev => getNewIndex(prev, -1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = normalizedItems[selectedIndex];

        if (isItem(item)) {
          item.onClick();
        }

        handleClose();
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        handleClose();
      }
    },
    [getNewIndex, normalizedItems, selectedIndex, handleClose],
  );

  // Focus the menu on open so keyboard navigation works even when it opened at
  // the cursor with no highlighted item (context menus). Only when focus isn't
  // already inside it — a normal dropdown highlights + focuses its first item.
  useEffect(() => {
    if (!isActive) {
      return;
    }

    const raf = requestAnimationFrame(() => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(document.activeElement)
      ) {
        dropdownRef.current.focus();
      }
    });

    return () => cancelAnimationFrame(raf);
  }, [isActive]);

  const handleBlur = useCallback(() => {
    // Doesn't work without delay, maybe the browser sets document.activeElement after firering the blur event?
    requestAnimationFrame(() => {
      if (!dropdownRef.current) return;

      if (!dropdownRef.current.contains(document.activeElement)) {
        handleClose();
      }
    });
  }, [handleClose]);

  return (
    <>
      <Trigger
        id={triggerId}
        ref={triggerRef}
        onClick={handleTriggerActivate}
        isActive={isActive}
        menuId={menuId}
      />
      {isActive && (
        <DropdownPortal>
          <Menu
            ref={dropdownRef}
            isActive={isActive}
            position={inDialog ? 'absolute' : 'fixed'}
            id={menuId}
            tabIndex={-1}
            onKeyDown={handleMenuKeyDown}
            onMouseOver={handleMouseOverMenu}
            onBlur={handleBlur}
            aria-labelledby={triggerId}
            role='menu'
          >
            {normalizedItems.map((props, i) => {
              if (!isItem(props)) {
                return <ItemDivider key={i} />;
              }

              const {
                label,
                onClick,
                helper,
                id,
                disabled,
                shortcut,
                icon,
                header,
              } = props;

              return (
                <MenuItem
                  onClick={() => {
                    handleClose();
                    onClick();
                  }}
                  id={id}
                  data-testid={`menu-item-${id}`}
                  disabled={disabled}
                  key={id}
                  helper={shortcut ? `${helper} (${shortcut})` : helper}
                  label={label}
                  selected={useKeys && selectedIndex === i}
                  icon={icon}
                  shortcut={shortcut}
                  header={header}
                />
              );
            })}
          </Menu>
        </DropdownPortal>
      )}
    </>
  );
}

const DropdownPortal = ({ children }: PropsWithChildren) => {
  const portalRef = useContext(DropdownPortalContext);

  if (!portalRef.current) {
    return null;
  }

  return createPortal(children, portalRef.current);
};

export interface MenuItemSidebarProps extends MenuItemMinimial {
  handleClickItem?: () => unknown;
  header?: boolean;
}

interface MenuItemPropsExtended extends MenuItemSidebarProps {
  selected: boolean;
}

export function MenuItem({
  onClick,
  selected,
  helper,
  disabled,
  shortcut,
  icon,
  label,
  header,
  ...props
}: MenuItemPropsExtended): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (selected && document.activeElement !== ref.current) {
      ref.current?.focus();
    }
  }, [selected]);

  if (header) {
    return (
      <MenuItemHeader id={props.id}>
        {icon}
        <StyledLabel>{label}</StyledLabel>
      </MenuItemHeader>
    );
  }

  return (
    <MenuItemStyled
      clean
      ref={ref}
      onClick={onClick}
      selected={selected}
      title={helper}
      disabled={disabled}
      role='menuitem'
      tabIndex={-1}
      {...props}
    >
      {icon}
      <StyledLabel>{label}</StyledLabel>
      {shortcut && <StyledShortcut shortcut={shortcut} />}
    </MenuItemStyled>
  );
}

const StyledShortcut = styled(Shortcut)`
  margin-left: 0.3rem;
  color: ${p => p.theme.colors.textLight};
`;

const StyledLabel = styled.span`
  flex: 1;
`;

const MenuItemHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 1rem 0.2rem 1rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  font-weight: bold;
  letter-spacing: 0.05rem;
  color: ${p => p.theme.colors.main};
  opacity: 0.8;

  & svg {
    color: ${p => p.theme.colors.main};
  }
`;

interface MenuItemStyledProps {
  selected: boolean;
}

const MenuItemStyled = styled(Button)<MenuItemStyledProps>`
  --menu-item-bg: ${p =>
    p.selected ? p.theme.colors.mainSelectedBg : p.theme.colors.bg};
  --menu-item-fg: ${p =>
    p.selected ? p.theme.colors.mainSelectedFg : p.theme.colors.text};
  align-items: center;
  display: flex;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  color: var(--menu-item-fg);
  padding: 0.4rem 1rem;
  height: auto;
  background-color: var(--menu-item-bg);
  outline: none;

  & svg {
    color: var(--menu-item-fg);
  }

  &:hover {
    --menu-item-bg: ${p => p.theme.colors.mainSelectedBg};
    --menu-item-fg: ${p => p.theme.colors.mainSelectedFg};

    @media (prefers-contrast: more) {
      --menu-item-bg: ${p => (p.theme.darkMode ? 'white' : 'black')};
      --menu-item-fg: ${p => (p.theme.darkMode ? 'black' : 'white')};
    }
  }
  &:active {
    filter: brightness(0.9);
  }
  &:disabled {
    color: ${p => p.theme.colors.textLight2};
    cursor: default;
    background-color: ${p => p.theme.colors.bg};

    & svg {
      color: ${p => p.theme.colors.textLight2};
    }
  }
`;

const ItemDivider = styled.div`
  width: 100%;
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
`;

const Menu = styled.div<{
  isActive: boolean;
  position?: 'fixed' | 'absolute';
}>`
  visibility: hidden;
  font-size: 0.9rem;
  overflow: auto;
  max-height: 80vh;
  background: ${p => p.theme.colors.bg};
  border: ${p =>
    p.theme.darkMode ? `solid 1px ${p.theme.colors.bg2}` : 'none'};
  padding-top: 0.4rem;
  padding-bottom: 0.4rem;
  border-radius: 8px;
  /* Focused programmatically on open for keyboard nav; items show selection. */
  outline: none;
  position: ${p => p.position || 'fixed'};
  z-index: ${p => p.theme.zIndex.dropdown};
  width: auto;
  box-shadow: ${p => p.theme.boxShadowSoft};
  opacity: ${p => (p.isActive ? 1 : 0)};
  ${transition('opacity')};

  @starting-style {
    opacity: 0;
  }

  @media (prefers-contrast: more) {
    border: solid 1px ${p => p.theme.colors.bg2};
  }
`;
