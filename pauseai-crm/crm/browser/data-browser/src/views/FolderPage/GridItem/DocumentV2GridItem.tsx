import { GridItemDescription, InnerWrapper } from './components';
import { GridItemViewProps } from './GridItemViewProps';

import type { JSX } from 'react';
import { useDocumentText } from '@hooks/useDocumentText';

export function DocumentV2GridItem({
  resource,
}: GridItemViewProps): JSX.Element {
  const text = useDocumentText(resource, 100);

  return (
    <InnerWrapper>
      <GridItemDescription>
        <div>{text}</div>
      </GridItemDescription>
    </InnerWrapper>
  );
}
