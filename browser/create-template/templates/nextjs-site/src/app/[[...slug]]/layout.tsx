import ProviderWrapper from '@/components/ProviderWrapper';
import VStack from '@/components/Layout/VStack';
import Navbar from '@/components/Navbar';
import styles from '../layout.module.css';
import Footer from '@/components/Footer';
import { DocumentLang } from '@/components/DocumentLang';
import { LanguageConfigProvider } from '@/atomic/languageConfig';
import { getLanguageConfig, parseLocalizedPath } from '@/atomic/i18n';

export const revalidate = 60;
export const dynamicParams = true;

type Params = {
  slug?: string[];
};

export default async function SiteLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<Params>;
}) {
  const { slug } = await params;
  const pathname = slug?.length ? `/${slug.join('/')}` : '/';
  const languageConfig = await getLanguageConfig();
  const { lang } = await parseLocalizedPath(pathname);

  return (
    <html lang={lang}>
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
