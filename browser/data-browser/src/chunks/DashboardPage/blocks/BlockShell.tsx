import type { JSX, ReactNode } from 'react';
import { styled } from 'styled-components';
import type { Resource } from '@tomic/react';
import { CARD_CONTAINER } from '../../../helpers/containers';

interface Props {
  block: Resource;
  label: string;
  /** Shown to the right of the heading — a block's own controls. */
  actions?: ReactNode;
  /** True when the block manages its own scrolling (an embedded table). */
  fill?: boolean;
  /**
   * Centre the content vertically. Right for a single number, wrong for
   * anything list-shaped: centred bars leave a gap under the heading that reads
   * as a rendering bug.
   */
  center?: boolean;
  children: ReactNode;
}

/**
 * The frame every block shares: a card, a heading, and the room its content
 * gets. Keeping it in one place is what makes a dashboard read as a dashboard
 * rather than as four unrelated widgets.
 */
export function BlockShell({
  label,
  actions,
  fill,
  center,
  children,
}: Props): JSX.Element {
  return (
    <Card>
      {(label || actions) && (
        <Header>
          <Heading title={label}>{label}</Heading>
          {actions}
        </Header>
      )}
      <Body $fill={fill} $center={center}>
        {children}
      </Body>
    </Card>
  );
}

const Card = styled.div`
  container-type: inline-size;
  container-name: ${CARD_CONTAINER};
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: ${p => p.theme.size(2)};
  gap: ${p => p.theme.size(1)};
  background-color: ${p => p.theme.colors.bg1};
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${p => p.theme.size(1)};
  min-width: 0;
`;

const Heading = styled.h2`
  margin: 0;
  font-size: 0.9rem;
  font-weight: bold;
  color: ${p => p.theme.colors.textLight};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const Body = styled.div<{ $fill?: boolean; $center?: boolean }>`
  display: flex;
  flex-direction: column;
  justify-content: ${p => (p.$center ? 'center' : 'flex-start')};
  min-width: 0;
  min-height: 0;
  flex: 1;
  ${p => p.$fill && 'overflow: hidden;'}
`;
