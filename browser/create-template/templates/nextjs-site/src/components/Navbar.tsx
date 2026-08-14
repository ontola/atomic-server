import Container from './Layout/Container';
import HStack from './Layout/HStack';
import { env } from '@/env';
import type { Website } from '@/ontologies/website';
import MenuItem from '@/views/MenuItem/MenuItem';
import styles from './Navbar.module.css';
import { store } from '@/store';
import LocalizedLink from './LocalizedLink';

const Navbar = async () => {
  const site = await store.getResource<Website>(
    env.NEXT_PUBLIC_WEBSITE_RESOURCE,
  );

  return (
    <Container>
      <nav className={styles.nav}>
        <HStack align='center' justify='space-between' wrap>
          <LocalizedLink href='/' className={styles.title}>
            {site.title}
          </LocalizedLink>
          <ul className={styles.ul}>
            {site.props.menuItems?.map(menuItem => (
              <li key={menuItem}>
                <MenuItem subject={menuItem} />
              </li>
            ))}
          </ul>
        </HStack>
      </nav>
    </Container>
  );
};

export default Navbar;
