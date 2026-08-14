import Container from './Layout/Container';
import HStack from './Layout/HStack';
import { env } from '@/env';
import {
  website,
  type Website,
  type MenuItem as MenuItemResource,
} from '@/ontologies/website';
import MenuItem, { type MenuItemSnapshot } from '@/views/MenuItem/MenuItem';
import styles from './Navbar.module.css';
import { store } from '@/store';
import LocalizedLink from './LocalizedLink';

async function snapshotMenu(subject: string): Promise<MenuItemSnapshot> {
  const item = await store.getResource<MenuItemResource>(subject);
  const linked = item.props.linksTo
    ? await store.getResource(item.props.linksTo)
    : undefined;

  return {
    subject,
    title: item.title,
    href:
      (linked?.get(website.properties.href) as string) ??
      item.props.externalLink ??
      '#',
    linksTo: item.props.linksTo,
    subItems: await Promise.all((item.props.subItems ?? []).map(snapshotMenu)),
  };
}

const Navbar = async () => {
  const site = await store.getResource<Website>(
    env.NEXT_PUBLIC_WEBSITE_RESOURCE,
  );

  // Client components must hydrate from the same menu data as the server,
  // even when the browser's resource store starts empty.
  const menu = await Promise.all(
    (site.props.menuItems ?? []).map(snapshotMenu),
  );

  return (
    <Container>
      <nav className={styles.nav}>
        <HStack align='center' justify='space-between' wrap>
          <LocalizedLink href='/' className={styles.title}>
            {site.title}
          </LocalizedLink>
          <ul className={styles.ul}>
            {menu.map(menuItem => (
              <li key={menuItem.subject}>
                <MenuItem subject={menuItem.subject} initial={menuItem} />
              </li>
            ))}
          </ul>
        </HStack>
      </nav>
    </Container>
  );
};

export default Navbar;
