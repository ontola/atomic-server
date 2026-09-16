import type { PropsWithChildren } from 'react';
import { styled } from 'styled-components';

export function WarningBlock({
  children,
}: PropsWithChildren): React.JSX.Element {
  return <Wrapper>{children}</Wrapper>;
}

const Wrapper = styled.div`
  border: 2px solid ${p => p.theme.colors.warning};
  border-radius: ${p => p.theme.radius};
  padding: 1rem;
`;

WarningBlock.Title = styled.p`
  font-weight: bold;
  margin-bottom: 0px;
`;
