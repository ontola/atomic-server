import Container from '@/components/Layout/Container';

export default function NotFound() {
  return (
    <Container>
      <h1>Page not found</h1>
      <p>This page is not on the public site.</p>
      <p>
        <a href='/'>Home</a>
      </p>
    </Container>
  );
}
