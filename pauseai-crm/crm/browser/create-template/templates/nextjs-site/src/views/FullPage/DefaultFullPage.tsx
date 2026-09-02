import Container from '@/components/Layout/Container';
import { Resource } from '@tomic/lib';

const DefaultFullPage = async ({ resource }: { resource: Resource }) => {
  console.error(
    `Error: Unable to find a valid page view for the specified class: "${resource.getClasses}". Make sure that the class is correctly matched using matchClass. See documentation for details: https://docs.atomicdata.dev/js-lib/resource.html?highlight=matchClass#resourcematchclass`,
  );

  return (
    <Container>
      <h1>{resource.title}</h1>
      <p>No valid page view for class: {resource.getClasses()}.</p>
    </Container>
  );
};

export default DefaultFullPage;
