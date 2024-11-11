'use client';

import { Image as AtomicImage, type ImageProps } from '@tomic/react';
import NoSSR from './NoSSR';

export const Image = ({ subject, alt, ...props }: ImageProps) => {
  return (
    <NoSSR>
      <AtomicImage subject={subject} alt={alt} {...props} />
    </NoSSR>
  );
};
