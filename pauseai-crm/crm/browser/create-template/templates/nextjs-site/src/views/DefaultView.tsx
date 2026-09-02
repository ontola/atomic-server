import { Resource } from '@tomic/react';

const DefaultView = async ({ resource }: { resource: Resource }) => {
  console.error(
    `Error: Unable to find a valid page view for the specified class: "${resource.getClasses}". Make sure that the class is correctly matched using matchClass. See documentation for details: https://docs.atomicdata.dev/js-lib/resource.html#resourcematchclass`,
  );

  return <p>No supported view for {resource.title}.</p>;
};

export default DefaultView;
