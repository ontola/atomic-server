'use client';

import { Image as AtomicImage } from '@tomic/react';
import NoSSR from './NoSSR';

export const Image = ({
  subject,
  alt,
  ...props
}: {
  subject: string;
  alt: string;
  [key: string]: unknown;
}) => {
  return (
    <NoSSR>
      <AtomicImage subject={subject} alt={alt} {...props} />
    </NoSSR>
  );
};
