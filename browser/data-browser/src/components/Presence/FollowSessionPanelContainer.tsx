import { useMemo, useState } from 'react';
import { useCurrentAgent, useDrivePresence, useResource } from '@tomic/react';
import { styled } from 'styled-components';
import { RightPanel } from '../RightPanel/RightPanel';
import { useRightPanel } from '../RightPanel/RightPanelContext';
import { useFollow } from './FollowContext';
import { PresenceAvatarMenu } from './PresenceAvatarMenu';
import { ChatRoomView } from '../../views/ChatRoom/ChatRoomView';
import { EditableTitle } from '../EditableTitle';
import { Column, Row } from '../Row';
import { AtomicLink } from '../AtomicLink';

/**
 * Right-side panel with the live meeting: who's here, the trail of
 * resources the leader visits, plus chat. Shows the meeting you've
 * joined (following its leader) or the one you're leading.
 */
export const FollowSessionPanelContainer: React.FC = () => {
  const { activePanel } = useRightPanel();
  const isOpen = activePanel === 'followSession';

  return (
    <RightPanel isOpen={isOpen} testId='follow-session-panel'>
      {isOpen && <FollowSessionPanel />}
    </RightPanel>
  );
};

function FollowSessionPanel() {
  const { followedSession, activeMeeting } = useFollow();
  const { selectedMeeting } = useRightPanel();
  const liveSubject = followedSession ?? activeMeeting;
  const chatroomSubject = selectedMeeting ?? liveSubject;

  if (!chatroomSubject) {
    return null;
  }

  return <FollowSessionChat subject={chatroomSubject} />;
}

function FollowSessionChat({ subject }: { subject: string }) {
  const chatroom = useResource(subject);
  const { followedAgent, unfollow, activeMeeting, endMeeting } = useFollow();
  const { setPanelOpen } = useRightPanel();
  const presence = useDrivePresence();
  const [agent] = useCurrentAgent();
  const [ending, setEnding] = useState(false);

  // The panel header's action: the leader ends the meeting; a joined
  // attendee leaves it.
  const leading = activeMeeting === subject;
  const label = leading ? 'End' : 'Leave';

  // Who else is in the meeting: the leader (whoever announces this
  // meeting as their `session`) plus everyone following that leader,
  // plus me when I'm taking part.
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

  async function handleAction() {
    if (leading) {
      setEnding(true);
      await endMeeting();
      setEnding(false);

      return;
    }

    unfollow();
    setPanelOpen('followSession', false);
  }

  // Only leader / joined attendee gets the End / Leave action.
  const showAction = leading || followedAgent === leaderAgent;

  return (
    <PanelWrapper>
      <PanelHeader center justify='space-between'>
        <Row center gap='0.5rem'>
          <PanelTitle resource={chatroom} />
          {participants.length > 0 && (
            <Facepile title={`${participants.length} here`}>
              {participants.slice(0, 5).map(subj => (
                <PresenceAvatarMenu
                  key={subj}
                  agentSubject={subj}
                  size='1.5rem'
                />
              ))}
              {participants.length > 5 && (
                <Overflow>+{participants.length - 5}</Overflow>
              )}
            </Facepile>
          )}
        </Row>
        <Row center gap='0.5rem'>
          <AtomicLink subject={subject}>Open notes</AtomicLink>
          {showAction && (
            <LeaveButton type='button' onClick={handleAction} disabled={ending}>
              {ending ? 'Ending…' : label}
            </LeaveButton>
          )}
        </Row>
      </PanelHeader>
      <ChatRoomView resource={chatroom} noContainerPadding />
    </PanelWrapper>
  );
}

const PanelWrapper = styled(Column)`
  height: 100%;
  gap: 0;
`;

const PanelHeader = styled(Row)`
  padding-block: ${p => p.theme.size(2)};
`;

/** The meeting name, click-to-edit. */
const PanelTitle = styled(EditableTitle)`
  font-size: 1rem;
  margin: 0;
`;

const LeaveButton = styled.button`
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  padding: 0.15rem 0.7rem;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 600;
  background: ${p => p.theme.colors.bg1};
  color: ${p => p.theme.colors.text};

  &:hover,
  &:focus-visible {
    background: ${p => p.theme.colors.main};
    color: white;
    border-color: ${p => p.theme.colors.main};
  }
`;

const Facepile = styled.span`
  display: inline-flex;
  align-items: center;

  & > *:not(:first-child) {
    margin-left: -0.4rem;
  }
`;

const Overflow = styled.span`
  margin-left: 0.15rem;
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;
