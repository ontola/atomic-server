import type { MenuItem } from '@/ontologies/website';
import MenuItemLink from './MenuItemLink';
import styles from './MenuItem.module.css';
import { store } from '@/store';
import { useId } from 'react';
import { currentSubject } from '@/app/[[...slug]]/page'; // BAD 👎

const MenuItem = async ({ subject }: { subject: string }) => {
  const id = useId();
  const anchorName = `--menuItem-${id}`;

  const menuItem = await store.getResource<MenuItem>(subject);

  return menuItem.props.subItems && menuItem.props.subItems.length > 0 ? (
    <>
      <button
        className={styles.button}
        popoverTarget={id}
        popoverTargetAction='toggle'
        style={{ '--anchor-name': anchorName } as React.CSSProperties}
      >
        {menuItem.title}
      </button>

      <div
        id={id}
        className={styles.submenu}
        popover='manual'
        style={
          {
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
