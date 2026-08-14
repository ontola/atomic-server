import type { Metadata } from 'next';
import 'modern-css-reset/dist/reset.min.css';
import '@/app/globals.css';
import ProviderWrapper from '@/components/ProviderWrapper';
import VStack from '@/components/Layout/VStack';
import Navbar from '@/components/Navbar';
import styles from './layout.module.css';
import Footer from '@/components/Footer';
import { DocumentLang } from '@/components/DocumentLang';
import { LanguageConfigProvider } from '@/atomic/languageConfig';
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
  // The root layout cannot read the catch-all route params, so `<html lang>`
  // starts as the website default. DocumentLang updates it from the URL prefix.
  const languageConfig = await getLanguageConfig();

  return (
    <html lang={languageConfig.defaultLanguage}>
      <body>
        <LanguageConfigProvider value={languageConfig}>
          <DocumentLang />
          <ProviderWrapper>
            <VStack align='stretch' height='100vh'>
              <header>
                <Navbar />
              </header>
              <main className={styles.main}>{children}</main>
              <Footer />
            </VStack>
          </ProviderWrapper>
        </LanguageConfigProvider>
      </body>
    </html>
  );
}
