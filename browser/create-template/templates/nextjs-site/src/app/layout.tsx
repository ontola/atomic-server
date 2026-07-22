import type { Metadata } from 'next';
import 'modern-css-reset/dist/reset.min.css';
import '@/app/globals.css';
import ProviderWrapper from '@/components/ProviderWrapper';
import VStack from '@/components/Layout/VStack';
import Navbar from '@/components/Navbar';
import styles from './layout.module.css';
import Footer from '@/components/Footer';
import { getLanguageConfig } from '@/atomic/i18n';

export const metadata: Metadata = {
  title: 'Next.js Atomic',
  description: 'A Next.js template for Atomic Server',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The root layout cannot read the catch-all route params, so it cannot know
  // the requested language. We use the website's default language instead.
  const { defaultLanguage } = await getLanguageConfig();

  return (
    <html lang={defaultLanguage}>
      <body>
        <ProviderWrapper>
          <VStack align='stretch' height='100vh'>
            <header>
              <Navbar />
            </header>
            <main className={styles.main}>{children}</main>
            <Footer />
          </VStack>
        </ProviderWrapper>
      </body>
    </html>
  );
}
