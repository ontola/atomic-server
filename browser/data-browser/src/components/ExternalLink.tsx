import { styled } from 'styled-components';
import { FaArrowUpRightFromSquare } from 'react-icons/fa6';

import type { JSX } from 'react';

export enum ExternalLinkVariant {
  Plain,
  Button,
}

export interface ExternalLinkProps {
  to: string;
  variant?: ExternalLinkVariant;
}

export function ExternalLink({
  to,
  children,
  variant = ExternalLinkVariant.Plain,
}: React.PropsWithChildren<ExternalLinkProps>): JSX.Element {
  const Comp =
    variant === ExternalLinkVariant.Button
      ? ExternalLinkButton
      : ExternalLinkPlain;

  return (
    <Comp href={to} target='_blank' rel='noreferrer'>
      {children}
      <FaArrowUpRightFromSquare />
    </Comp>
  );
}

const ExternalLinkPlain = styled.a`
  display: inline-flex;
  align-items: center;
  gap: 0.6ch;
  color: var(--color-accent);
  text-decoration: none;
`;

const ExternalLinkButton = styled.a`
  padding-inline: 0.8rem;
  padding-block: 0.4rem;
  width: fit-content;
  background-color: var(--color-bg);
  border: 1.5px solid var(--color-accent);
  border-radius: var(--radius-md);
  text-decoration: none;
  gap: 1ch;
  display: flex;
  align-items: center;
  font-weight: 600;
  justify-content: center;
  color: var(--color-accent);
  white-space: nowrap;
  transition:
    0.1s transform,
    0.1s background-color,
    0.1s box-shadow,
    0.1s color;

  &:hover,
  &:focus-within {
    background-color: var(--color-accent);
    color: white;
  }
`;
