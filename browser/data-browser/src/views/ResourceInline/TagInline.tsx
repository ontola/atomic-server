import type { ResourceInlineInstanceProps } from './ResourceInline';
import { Tag } from '../../components/Tag';
import { styled } from 'styled-components';

import type { JSX } from 'react';

export function TagInline({
  subject,
}: ResourceInlineInstanceProps): JSX.Element {
  return (
    <TagWrapper>
      <Tag subject={subject} />
    </TagWrapper>
  );
}

const TagWrapper = styled.span`
  display: inline-block;
  padding-block: 2px;

  &:hover,
  &:focus-visible {
    filter: brightness(1.05);
  }
`;
