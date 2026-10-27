import { useMemo } from 'react';
import { useCurrentAgent, useDrivePresence } from '@tomic/react';
import { useFollow } from './FollowContext';

/**
 * Who is in the meeting `subject`: the leader (whoever announces it as their
 * `session`), everyone following that leader, and me when I take part.
 */
export function useMeetingParticipants(subject: string): {
  participants: string[];
  leaderAgent: string | undefined;
  leading: boolean;
} {
  const { followedAgent, activeMeeting } = useFollow();
  const presence = useDrivePresence();
  const [agent] = useCurrentAgent();
  const leading = activeMeeting === subject;
  const leaderAgent = leading
    ? agent?.subject
    : presence.find(item => item.session === subject)?.agent;

  const participants = useMemo(() => {
    const set = new Set<string>();

    if (leaderAgent) set.add(leaderAgent);

    for (const item of presence) {
      if (item.session === subject) set.add(item.agent);
      if (leaderAgent && item.following === leaderAgent) set.add(item.agent);
    }

    if (
      agent?.subject &&
      (leading || (!!leaderAgent && followedAgent === leaderAgent))
    ) {
      set.add(agent.subject);
    }

    return [...set];
  }, [presence, subject, leaderAgent, agent, leading, followedAgent]);

  return { participants, leaderAgent, leading };
}
