import type { Metadata } from 'next';
import 'modern-css-reset/dist/reset.min.css';
import '@/app/globals.css';
import ProviderWrapper from '@/components/ProviderWrapper';
import VStack from '@/components/Layout/VStack';
import Navbar from '@/components/Navbar';
import styles from './layout.module.css';
import Footer from '@/components/Footer';

export const metadata: Metadata = {
  title: 'Next.js Atomic',
  description: 'A Next.js template for Atomic Server',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang='en'>
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
