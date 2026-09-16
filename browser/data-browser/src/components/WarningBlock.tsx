import type { PropsWithChildren } from 'react';
import { styled } from 'styled-components';

export function WarningBlock({
  children,
}: PropsWithChildren): React.JSX.Element {
  return <Wrapper>{children}</Wrapper>;
}

const Wrapper = styled.div`
  border: 2px solid var(--color-warning);
  border-radius: var(--radius-md);
  padding: 1rem;
`;

WarningBlock.Title = styled.p`
  font-weight: bold;
  margin-bottom: 0px;
`;
