import { useResource } from '@tomic/react';
import { styled } from 'styled-components';
import { RightPanel } from '../RightPanel/RightPanel';
import { useRightPanel } from '../RightPanel/RightPanelContext';
import { useFollow } from './FollowContext';
import { ChatRoomView } from '../../views/ChatRoom/ChatRoomView';
import { Column } from '../Row';

/**
 * Right-side panel with the follow-session ChatRoom: the trail of resources
 * the followed person visits, plus regular chat. Shows the session of the
 * agent we follow, or our own when we're the one being followed.
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
  const { followedSession, sessionChatroom } = useFollow();
  const chatroomSubject = followedSession ?? sessionChatroom;

  if (!chatroomSubject) {
    return (
      <EmptyState>
        No follow session yet. Follow someone — or be followed — to start
        one.
      </EmptyState>
    );
  }

  return <FollowSessionChat subject={chatroomSubject} />;
}

function FollowSessionChat({ subject }: { subject: string }) {
  const chatroom = useResource(subject);

  return (
    <PanelWrapper>
      <PanelTitle>Follow session</PanelTitle>
      <ChatRoomView resource={chatroom} noContainerPadding />
    </PanelWrapper>
  );
}

const PanelWrapper = styled(Column)`
  height: 100%;
  gap: 0;
`;

const PanelTitle = styled.h2`
  font-size: 1rem;
  margin: 0;
  padding-block: ${p => p.theme.size(2)};
`;

const EmptyState = styled.p`
  color: ${p => p.theme.colors.textLight};
  padding: ${p => p.theme.size(4)};
`;
