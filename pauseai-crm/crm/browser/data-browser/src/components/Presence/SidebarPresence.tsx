import { useMemo } from 'react';
import { styled } from 'styled-components';
import { useResourcePresence } from '@tomic/react';
import { PresenceAvatarMenu } from './PresenceAvatarMenu';

const MAX_AVATARS = 3;

/**
 * Compact strip of avatars of agents currently viewing `subject`, for
 * sidebar rows. Read-only: never announces (the NavBar's
 * `ResourcePresenceRow` does that for the current resource). Renders
 * nothing when nobody is there.
 */
export function SidebarPresence({
  subject,
}: {
  subject: string;
}): React.JSX.Element | null {
  const { presence } = useResourcePresence(subject, { announce: false });

  const agents = useMemo(
    () => Array.from(new Set(presence.map(item => item.agent))),
    [presence],
  );

  if (agents.length === 0) {
    return null;
  }

  return (
    <Strip aria-label='Currently here'>
      {agents.slice(0, MAX_AVATARS).map(agent => (
        <PresenceAvatarMenu key={agent} agentSubject={agent} size='1.1rem' />
      ))}
      {agents.length > MAX_AVATARS && (
        <More>+{agents.length - MAX_AVATARS}</More>
      )}
    </Strip>
  );
}

const Strip = styled.span`
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  margin-left: auto;

  & > *:not(:first-child) {
    margin-left: -0.3rem;
  }
`;

const More = styled.span`
  flex-shrink: 0;
  font-size: 0.65rem;
  color: ${p => p.theme.colors.textLight};
  margin-left: 0.1rem;
`;
