import { useMemo } from 'react';
import { styled } from 'styled-components';
import { useResourcePresence } from '@tomic/react';
import { PresenceAvatarMenu } from './PresenceAvatarMenu';
import { useFollow } from './FollowContext';

const MAX_AVATARS = 4;

/**
 * Announces that this session is viewing `subject` on the drive's
 * presence channel, and shows who else is viewing it right now
 * (issue #1229). Renders nothing when alone.
 */
export function ResourcePresenceRow({
  subject,
}: {
  subject: string;
}): React.JSX.Element | null {
  const { presence } = useResourcePresence(subject);
  const { followedAgent, followers } = useFollow();

  // One avatar per agent, even when they have multiple tabs open. Agents
  // already shown in the follow badges next to this row — the one we
  // follow, and the ones following us — are skipped: no duplicates.
  const agents = useMemo(() => {
    const inBadges = new Set(followers.map(item => item.agent));

    if (followedAgent) {
      inBadges.add(followedAgent);
    }

    return Array.from(new Set(presence.map(item => item.agent))).filter(
      agent => !inBadges.has(agent),
    );
  }, [presence, followedAgent, followers]);

  if (agents.length === 0) {
    return null;
  }

  return (
    <AvatarRow aria-label='Also viewing this resource'>
      {agents.slice(0, MAX_AVATARS).map(agent => (
        <PresenceAvatarMenu key={agent} agentSubject={agent} />
      ))}
      {agents.length > MAX_AVATARS && (
        <Overflow>+{agents.length - MAX_AVATARS}</Overflow>
      )}
    </AvatarRow>
  );
}

const AvatarRow = styled.div`
  display: flex;
  align-items: center;

  /* Overlap like a facepile */
  & > *:not(:first-child) {
    margin-left: -0.4rem;
  }
`;

const Overflow = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 1.6rem;
  height: 1.6rem;
  border-radius: 50%;
  background-color: ${p => p.theme.colors.bg2};
  border: 2px solid ${p => p.theme.colors.bg};
  color: ${p => p.theme.colors.textLight};
  font-size: 0.7rem;
  user-select: none;
`;
