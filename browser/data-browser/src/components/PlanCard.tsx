import type { ReactNode } from 'react';
import { styled } from 'styled-components';
import { FaCheck } from 'react-icons/fa6';
import {
  ServiceIcon,
  ServiceTitle,
  ServiceDescription,
} from '@tomic/service-ui';
import '@tomic/service-ui/styles.css';
import { CARD_SUB_FONT, CARD_TITLE_FONT } from './cardSurface';

/**
 * How a plan relates to the workspace in view.
 *
 * - `current`: the plan this workspace is on.
 * - `included`: not the plan itself, but part of the current one (Cloud Vault
 *   comes with Cloud Server).
 * - `null`: on offer, or unknown because nobody is signed in.
 */
export type PlanStanding = 'current' | 'included' | null;

/**
 * One Atomic Place plan, shown side by side with the others on the Sync page.
 *
 * The top half is the same for everyone: what the plan is, what it costs and
 * what you get. The bottom half (`children`) is this workspace's state and the
 * one action that makes sense for it — turn on, set up, manage. Keeping the
 * pitch and the state in fixed places is what lets two cards be compared at a
 * glance, which a list of rows with different wording could not.
 */
export function PlanCard({
  kind,
  title,
  standing,
  price,
  tagline,
  features,
  children,
  ...props
}: {
  kind: 'vault' | 'server';
  title: string;
  standing: PlanStanding;
  price: ReactNode;
  tagline: ReactNode;
  features: string[];
  children?: ReactNode;
  'data-testid'?: string;
}) {
  return (
    <Card
      {...props}
      $current={standing === 'current'}
      data-plan-standing={standing ?? 'none'}
      aria-current={standing === 'current' ? 'true' : undefined}
    >
      <Header>
        <ServiceIcon kind={kind} active={standing !== null} />
        <Heading>
          <Title>{title}</Title>
          <Price>{price}</Price>
        </Heading>
        {standing === 'current' && (
          <Badge $current data-testid='plan-current-badge'>
            Current plan
          </Badge>
        )}
        {standing === 'included' && <Badge>Included</Badge>}
      </Header>
      <Tagline>{tagline}</Tagline>
      <Features>
        {features.map(feature => (
          <li key={feature}>
            <FaCheck aria-hidden />
            <span>{feature}</span>
          </li>
        ))}
      </Features>
      {children && <State>{children}</State>}
    </Card>
  );
}

/**
 * Two columns when there is room, one when there is not. Sized on the width
 * the grid actually gets rather than a viewport breakpoint: the Sync page sits
 * in a narrow column, which with a sidebar open is much smaller than the
 * window.
 */
export const PlanGrid = styled.div`
  /* Map @tomic/service-ui's glyph colours onto the app theme. */
  --service-accent: ${p => p.theme.colors.main};
  --service-muted: ${p => p.theme.colors.textLight};
  --service-text: ${p => p.theme.colors.text};
  --service-neutral: ${p => p.theme.colors.bg2};
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: 0.75rem;
  align-items: stretch;
`;

const Card = styled.section<{ $current: boolean }>`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
  padding: 1rem;
  border-radius: ${p => p.theme.radius};
  border: ${p =>
    p.$current
      ? `2px solid ${p.theme.colors.main}`
      : `1px solid ${p.theme.colors.bg2}`};
  /* Same outer size either way, so the current card does not shift. */
  margin: ${p => (p.$current ? '0' : '1px')};
  background: ${p =>
    p.$current ? `${p.theme.colors.main}0a` : p.theme.colors.bg};
`;

const Header = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
`;

const Heading = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
`;

const Title = styled(ServiceTitle)`
  margin: 0;
  font-size: ${CARD_TITLE_FONT};
  font-weight: 600;
`;

const Price = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: ${CARD_SUB_FONT};
`;

const Badge = styled.span<{ $current?: boolean }>`
  flex-shrink: 0;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
  color: ${p => (p.$current ? 'white' : p.theme.colors.main)};
  background: ${p => (p.$current ? p.theme.colors.main : 'transparent')};
  border: 1px solid ${p => p.theme.colors.main};
`;

const Tagline = styled(ServiceDescription)`
  margin: 0;
  color: ${p => p.theme.colors.text};
  font-size: ${CARD_SUB_FONT};
`;

const Features = styled.ul`
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: ${CARD_SUB_FONT};
  color: ${p => p.theme.colors.textLight};

  li {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  svg {
    flex-shrink: 0;
    font-size: 0.7rem;
    color: ${p => p.theme.colors.main};
  }
`;

const State = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: auto;
  padding-top: 0.75rem;
  border-top: 1px solid ${p => p.theme.colors.bg2};
`;
