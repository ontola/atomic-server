import { styled } from 'styled-components';
import { AllPropsSimple } from '../../../components/AllPropsSimple';
import { GridItemViewProps } from './GridItemViewProps';

import type { JSX } from 'react';

export function DefaultGridItem({ resource }: GridItemViewProps): JSX.Element {
  return (
    <DefaultGridWrapper>
      <AllPropsSimple resource={resource} />
    </DefaultGridWrapper>
  );
}

const DefaultGridWrapper = styled.div`
  padding: var(--space-3);
  pointer-events: none;
`;
