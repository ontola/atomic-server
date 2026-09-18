'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentProps } from 'react';
import { localizeHrefForPath } from '@/atomic/i18n';
import { useLanguageConfig } from '@/atomic/languageConfig';

/** Internal links keep the current language prefix (`/nl/blog` → Home is `/nl`). */
export default function LocalizedLink({
  href,
  ...props
}: ComponentProps<typeof Link> & { href: string }) {
  const pathname = usePathname();
  const config = useLanguageConfig();

  return (
    <Link href={localizeHrefForPath(href, pathname, config)} {...props} />
  );
}
