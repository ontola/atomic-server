'use client';

import type { MenuItem } from '@/ontologies/website';
import MenuItemLink from './MenuItemLink';
import styles from './MenuItem.module.css';
import { useResource, useStore } from '@tomic/react';
import { useCurrentSubject } from '@/app/context/CurrentSubjectContext';
import { useId, useRef, useState } from 'react';
import { store } from '@/store';

const MenuItem = ({ subject }: { subject: string }) => {
  const menuItem = useResource<MenuItem>(subject);
  const { currentSubject } = useCurrentSubject();
  const id = useId();
  const anchorName = `--menuItem-${id}`;
  const popover = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [submenuPosition, setSubmenuPosition] = useState({
    top: '0px',
    left: '0px',
  });

  const calcPopoverPosition = () => {
    if (!button.current || !popover.current) return;

    if (CSS.supports('anchor-name', '--something')) {
      return;
    }

    const rect = button.current.getBoundingClientRect();

    const newSubmenuPosition = { ...submenuPosition };

    newSubmenuPosition.top = `calc(${rect.top}px + 2rem)`;
    newSubmenuPosition.left = `calc(${rect.left}px - (var(--menu-width) / 2 - ${
      rect.width / 2
    }px))`;

    setSubmenuPosition(newSubmenuPosition);
  };

  const closePopover = () => {
    popover.current?.hidePopover();
  };

  const onFocusOut = (event: React.FocusEvent<HTMLDivElement>) => {
    if (
      !event.relatedTarget ||
      !event.currentTarget.contains(event.relatedTarget)
    ) {
      closePopover();
    }
  };

  return menuItem.props.subItems && menuItem.props.subItems.length > 0 ? (
    <>
      <button
        className={styles.button}
        popoverTarget={id}
        popoverTargetAction='toggle'
        onClick={calcPopoverPosition}
        ref={button}
        style={{ '--anchor-name': anchorName } as React.CSSProperties}
      >
        {menuItem.title}
      </button>

      <div
        id={id}
        className={styles.submenu}
        popover='manual'
        ref={popover}
        onBlur={onFocusOut}
        style={
          {
            '--top': submenuPosition.top,
            '--left': submenuPosition.left,
            '--anchor-name': anchorName,
          } as React.CSSProperties
        }
      >
        <ul className={styles.ul}>
          {menuItem.props.subItems?.map((subItem: string, index: number) => (
            <li key={index}>
              <MenuItem subject={subItem} />
            </li>
          ))}
        </ul>
      </div>
    </>
  ) : (
    <MenuItemLink
      resource={menuItem}
      active={menuItem.props.linksTo === currentSubject}
    />
  );
};

export default MenuItem;
