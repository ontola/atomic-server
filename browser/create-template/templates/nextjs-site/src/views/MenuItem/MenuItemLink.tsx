import { website } from '@/ontologies/website';
import { unknownSubject, Resource } from '@tomic/lib';
import styles from './MenuItemLink.module.css';
import clsx from 'clsx';
import { useResource } from '@tomic/react';

const MenuItemLink = ({
  resource,
  active = false,
}: {
  resource: Resource;
  active?: boolean;
}) => {
  const page = useResource(resource.subject ?? unknownSubject);

  const pageHrefValue = useResource(page.get(website.properties.linksTo));

  const href =
    pageHrefValue.get(website.properties.href) ??
    resource.props.externalLink ??
    '#';

  return (
    <a
      href={href}
      className={clsx(styles.link, { [styles.linkActive]: active })}
      aria-current={active ? 'page' : 'false'}
    >
      {resource.loading ? '' : page.title}
    </a>
  );
};

export default MenuItemLink;
