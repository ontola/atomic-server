'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { useLanguageConfig } from '@/atomic/languageConfig';

/**
 * Keeps `<html lang>` in sync on client-side navigations. The catch-all layout
 * already sets the attribute on the first HTML byte for each prerendered path.
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
