import { PropsWithChildren, type JSX } from 'react';
import { Row } from './Row';
import { styled } from 'styled-components';
import { CurrentBackgroundColor } from '../globalCssVars';
import clsx from 'clsx';

interface OutlinedSectionProps {
  title: string;
  extraPadding?: boolean;
  className?: string;
}

export function OutlinedSection({
  title,
  extraPadding,
  className,
  children,
}: PropsWithChildren<OutlinedSectionProps>): JSX.Element {
  const classes = clsx({
    [className ?? '']: className,
    'extra-padding': extraPadding,
  });

  return (
    <SectionWrapper className={classes}>
      <Heading>{title}</Heading>
      <Row wrapItems>{children}</Row>
    </SectionWrapper>
  );
}

const Heading = styled.h2`
  display: flex;
  align-items: center;
  font-size: 1rem;
  gap: 1ch;
  width: fit-content;
  color: var(--color-text-subtle);
  font-weight: normal;
  padding-inline: var(--space-2);
  margin-inline-start: var(--space-2);
  background-color: ${CurrentBackgroundColor.var()};
  position: absolute;
  top: -0.5rem;
  left: 0;
`;

const SectionWrapper = styled.div`
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  position: relative;
  // Because the heading sticks out of the section we need some extra margin to make it look visually consistent.
  margin-block-start: 0.5rem;

  &.extra-padding {
    padding: var(--space-6);

    ${Heading} {
      margin: 0;
      padding-inline: var(--space-3);
      left: var(--space-3);
    }
  }
`;
