import { css, keyframes, styled } from 'styled-components';
import { toAnchorId } from '../../helpers/toAnchorId';
import { Card } from '../../components/Card';

import ResourceCard from '../Card/ResourceCard';

type TargetableCardProps = {
  subject: string;
  className?: string;
  testId?: string;
};

export const TargetableCard = ({
  subject,
  className,
  testId,
  children,
}: React.PropsWithChildren<TargetableCardProps>) => {
  return (
    <StyledCard
      id={toAnchorId(subject ?? '')}
      about={subject}
      className={className}
      data-testid={testId}
    >
      {children}
    </StyledCard>
  );
};

export const TargetableResourceCard = ({ subject }: TargetableCardProps) => {
  return (
    <StyledResourceCard subject={subject} id={toAnchorId(subject ?? '')} />
  );
};

const targetHighlight = keyframes`
  from {
    box-shadow: var(--target-animation-base-shadow), 0 0 0 2px var(--target-animation-color);
  }
  to {
    box-shadow: var(--target-animation-base-shadow);
  }
`;

const styles = css`
  --target-animation-color: ${p => p.theme.colors.main};
  --target-animation-base-shadow: ${p => p.theme.boxShadow};
  padding-bottom: ${p => p.theme.size()};

  &:target {
    box-shadow:
      var(--target-animation-base-shadow),
      0 0 0 2px var(--target-animation-color);
    animation: 500ms ease-out 1.5s forwards ${targetHighlight};
  }
`;
const StyledCard = styled(Card)`
  ${styles}
`;
const StyledResourceCard = styled(ResourceCard)`
  ${styles}
`;
