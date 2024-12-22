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

export const DIVIDER = 'divider' as const;

export type MenuItemMinimial = {
  onClick: () => unknown;
  label: string;
  helper?: string;
  id: string;
  icon?: ReactNode;
  disabled?: boolean;
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
}: DropdownMenuProps): JSX.Element {
  const menuId = useId();
  const triggerId = useId();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const [isActive, _setIsActive] = useState(false);

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

      const triggerRect = triggerRef.current.getBoundingClientRect();
      const menuRect = dropdownRef.current.getBoundingClientRect();
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

      dropdownRef.current.style.visibility = 'visible';
    });
  }, [isActive, setIsActive]);

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
  // Click / open the item
  useHotkeys(
    'enter',
    e => {
      e.preventDefault();
      (normalizedItems[selectedIndex] as MenuItemMinimial).onClick();
      handleClose();
    },
    { enabled: isActive },
    [selectedIndex, normalizedItems],
  );
  // Move up (or to bottom if at top)
  useHotkeys(
    'up',
    e => {
      e.preventDefault();
      e.stopPropagation();
      setUseKeys(true);
      setSelectedIndex(prev => getNewIndex(prev, -1));
    },
    { enabled: isActive },
    [getNewIndex],
  );
  // Move down (or to top if at bottom)
  useHotkeys(
    'down',
    e => {
      e.preventDefault();
      e.stopPropagation();
      setUseKeys(true);
      setSelectedIndex(prev => getNewIndex(prev, 1));

      return false;
    },
    { enabled: isActive },
    [getNewIndex],
  );

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
            id={menuId}
            onMouseOver={handleMouseOverMenu}
            onBlur={handleBlur}
            aria-labelledby={triggerId}
            role='menu'
          >
            {normalizedItems.map((props, i) => {
              if (!isItem(props)) {
                return <ItemDivider key={i} />;
              }

              const { label, onClick, helper, id, disabled, shortcut, icon } =
                props;

              return (
                <MenuItem
                  onClick={() => {
                    handleClose();
                    onClick();
                  }}
                  id={id}
                  data-test={`menu-item-${id}`}
                  disabled={disabled}
                  key={id}
                  helper={shortcut ? `${helper} (${shortcut})` : helper}
                  label={label}
                  selected={useKeys && selectedIndex === i}
                  icon={icon}
                  shortcut={shortcut}
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

interface MenuProps {
  isActive: boolean;
}

export interface MenuItemSidebarProps extends MenuItemMinimial {
  handleClickItem?: () => unknown;
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
  ...props
}: MenuItemPropsExtended): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (selected && document.activeElement !== ref.current) {
      ref.current?.focus();
    }
  }, [selected]);

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

const Menu = styled.div<MenuProps>`
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
  position: fixed;
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
