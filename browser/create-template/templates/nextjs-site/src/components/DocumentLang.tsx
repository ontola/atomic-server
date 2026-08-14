'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { useLanguageConfig } from '@/atomic/languageConfig';

/**
 * The root layout cannot read the catch-all slug, so `<html lang>` starts as
 * the website default. This keeps it in sync with the URL prefix on navigation.
 */
export function DocumentLang() {
  const pathname = usePathname();
  const { defaultLanguage, languages } = useLanguageConfig();

  useEffect(() => {
    const first = pathname.split('/').filter(Boolean)[0];
    document.documentElement.lang =
      first && languages.includes(first) ? first : defaultLanguage;
  }, [pathname, defaultLanguage, languages]);

  return null;
}
