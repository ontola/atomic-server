import { Resource } from '@tomic/react';

const DefaultView = async ({ resource }: { resource: Resource }) => {
  return <p>No supported view for {resource.title}.</p>;
};

export default DefaultView;
