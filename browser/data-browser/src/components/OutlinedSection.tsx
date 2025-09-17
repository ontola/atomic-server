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
  color: ${p => p.theme.colors.textLight};
  font-weight: normal;
  padding-inline: ${p => p.theme.size(2)};
  margin-inline-start: ${p => p.theme.size(2)};
  background-color: ${CurrentBackgroundColor.var()};
  position: absolute;
  top: -0.5rem;
  left: 0;
`;

const SectionWrapper = styled.div`
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  padding: ${p => p.theme.size()};
  position: relative;
  // Because the heading sticks out of the section we need some extra margin to make it look visually consistent.
  margin-block-start: 0.5rem;

  &.extra-padding {
    padding: ${p => p.theme.size(6)};

    ${Heading} {
      margin: 0;
      padding-inline: ${p => p.theme.size()};
      left: ${p => p.theme.size()};
    }
  }
`;
