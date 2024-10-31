'use client';

import { useResource } from '@tomic/react';

const DefaultView = ({ subject }: { subject: string }) => {
  const resource = useResource(subject);

  return <p>No supported view for {resource.title}.</p>;
};

export default DefaultView;
