import type { Metadata } from 'next';
import 'modern-css-reset/dist/reset.min.css';
import '@/app/globals.css';
import { CMS_REVALIDATE_SECONDS } from '@/atomic/feeds';

export const revalidate = CMS_REVALIDATE_SECONDS;

export const metadata: Metadata = {
  title: 'Next.js Atomic',
  description: 'A Next.js template for Atomic Server',
  alternates: {
    types: {
      'application/rss+xml': '/rss.xml',
    },
  },
};

/**
 * Pass-through root layout so `[[...slug]]/layout.tsx` can own `<html lang>`.
 * That puts the correct language on the first HTML byte of each prerendered
 * path (`/nl/...` is `lang="nl"`), which a CDN can cache as a static file.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
