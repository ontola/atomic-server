import { dataBrowser, unknownSubject, useSubject } from '@tomic/react';

import { atomicArgu } from '../../../ontologies/atomic-argu';
import { GridItemViewProps } from './GridItemViewProps';
import { Thumbnail } from '../../../components/Thumbnail';

import type { JSX } from 'react';

export function ArticleGridItem({ resource }: GridItemViewProps): JSX.Element {
  const [coverImgSubject] = useSubject(
    resource,
    dataBrowser.properties.coverImage,
  );
  // Old Articles stored their cover under an argu-specific property.
  const [legacyCoverSubject] = useSubject(
    resource,
    atomicArgu.properties.coverImage,
  );

  return (
    <Thumbnail
      subject={coverImgSubject ?? legacyCoverSubject ?? unknownSubject}
    />
  );
}
