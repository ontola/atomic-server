import Container from '@/components/Layout/Container';
import LocalizedLink from '@/components/LocalizedLink';

export default function NotFound() {
  return (
    <Container>
      <h1>Page not found</h1>
      <p>This page is not on the public site.</p>
      <p>
        <LocalizedLink href='/'>Home</LocalizedLink>
      </p>
    </Container>
  );
}
