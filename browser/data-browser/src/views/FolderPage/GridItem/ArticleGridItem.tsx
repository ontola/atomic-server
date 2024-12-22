import { unknownSubject, useSubject } from '@tomic/react';

import { atomicArgu } from '../../../ontologies/atomic-argu';
import { GridItemViewProps } from './GridItemViewProps';
import { Thumbnail } from '../../../components/Thumbnail';

import type { JSX } from 'react';

export function ArticleGridItem({ resource }: GridItemViewProps): JSX.Element {
  const [coverImgSubject] = useSubject(
    resource,
    atomicArgu.properties.coverImage,
  );

  return <Thumbnail subject={coverImgSubject ?? unknownSubject} />;
}
