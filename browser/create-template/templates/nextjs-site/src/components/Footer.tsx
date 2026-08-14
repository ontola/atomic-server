import Container from './Layout/Container';
import HStack from './Layout/HStack';
import LanguageSwitcher from './LanguageSwitcher';
import { CmsEditLink } from './CmsEditor';
import styles from './Footer.module.css';

const Footer = () => {
  const year = new Date().getFullYear();

  return (
    <footer className={styles.footer}>
      <Container>
        <HStack align='center' justify='space-between' wrap>
          <p>&copy; {year} Your Company</p>
          <HStack align='center' gap='1rem' wrap>
            <a className={styles.link} href='/rss.xml'>
              RSS
            </a>
            <CmsEditLink />
            <LanguageSwitcher />
          </HStack>
        </HStack>
      </Container>
    </footer>
  );
};

export default Footer;
