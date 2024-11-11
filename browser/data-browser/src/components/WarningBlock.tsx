import type { PropsWithChildren } from 'react';
import { styled } from 'styled-components';
import { lighten } from 'polished';

export function WarningBlock({
  children,
}: PropsWithChildren): React.JSX.Element {
  return <Wrapper>{children}</Wrapper>;
}

const Wrapper = styled.div`
  border: 2px solid ${p => lighten(0.2, p.theme.colors.warning)};
  border-radius: ${p => p.theme.radius};
  padding: 1rem;
`;

WarningBlock.Title = styled.p`
  font-weight: bold;
  margin-bottom: 0px;
`;
