import { resourceTheme } from '../../theme.js';
import { Resource } from '@tomic/react';
import AllProps from '../AllProps.js';
import { styled } from 'styled-components';

import type { JSX } from 'react';

type Props = {
  resource: Resource;
};

/** Renders a Date value */
function Nestedresource({ resource }: Props): JSX.Element {
  return (
    <NestedWrapper>
      <AllProps resource={resource} />
    </NestedWrapper>
  );
}

const NestedWrapper = styled.div`
  margin-left: ${p => resourceTheme(p.theme).margin}rem;
`;

export default Nestedresource;
