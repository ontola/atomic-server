'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useCurrentSubject } from '@/app/context/CurrentSubjectProvider';
import { getLanguageLinks, type LanguageLink } from '@/atomic/i18n';
import styles from './LanguageSwitcher.module.css';

/**
 * Links to the current page in each of the website's declared languages.
 * Renders nothing when the website has fewer than two languages.
 */
const LanguageSwitcher = () => {
  const { currentSubject } = useCurrentSubject();
  const [links, setLinks] = useState<LanguageLink[]>([]);

  useEffect(() => {
    if (!currentSubject) {
      return;
    }

    let cancelled = false;

    getLanguageLinks(currentSubject).then(languageLinks => {
      if (!cancelled) {
        setLinks(languageLinks);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [currentSubject]);

  if (links.length < 2) {
    return null;
  }

  return (
    <ul className={styles.list}>
      {links.map(link => (
        <li key={link.lang}>
          <Link href={link.href} hrefLang={link.lang} className={styles.link}>
            {link.lang}
          </Link>
        </li>
      ))}
    </ul>
  );
};

export default LanguageSwitcher;
