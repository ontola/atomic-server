import { properties, useArray, useResource, useString } from '@tomic/react';

import Markdown from '@tomic/resource-ui/components/datatypes/Markdown';
import {
  GridItemDescription,
  InnerWrapper,
} from '@tomic/resource-ui/views/FolderPage/GridItem/components';
import { GridItemViewProps } from './GridItemViewProps';

import type { JSX } from 'react';

export function DocumentGridItem({ resource }: GridItemViewProps): JSX.Element {
  const [elements] = useArray(resource, properties.document.elements);
  const firstElementResource = useResource(elements[0]);
  const [text] = useString(firstElementResource, properties.description);

  return (
    <InnerWrapper>
      <GridItemDescription>
        <Markdown text={text ?? ''} />
      </GridItemDescription>
    </InnerWrapper>
  );
}
