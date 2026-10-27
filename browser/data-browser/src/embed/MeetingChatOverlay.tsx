import { useEffect, useRef, useState } from 'react';
import { dataBrowser, unknownSubject, useResource } from '@tomic/react';
import { styled } from 'styled-components';
import { FaXmark } from 'react-icons/fa6';
import { useRightPanel } from '../components/RightPanel/RightPanelContext';
import { useContextualPanel } from '../components/RightPanel/useContextualPanel';
import { useFollow } from '../components/Presence/FollowContext';
import { ChatRoomView } from '../views/ChatRoom/ChatRoomView';
import { EditableTitle } from '../components/EditableTitle';
import { IconButton } from '../components/IconButton/IconButton';
import { FollowSessionChat } from '../components/Presence/FollowSessionPanelContainer';
import { onHostNavigate, registerOverlay } from './overlayBack';
import { openNative } from './hostActions';

/**
 * The chat panel in the embed, over the whole page. For a meeting it is the
 * web app's meeting panel (title, who is here, chat, Leave), full screen; the
 * video call and Notes buttons are left out (no microphone or camera in the
 * app's web view, and the page is the meeting). Closed with the button or the
 * host's Back.
 *
 * A plain chat room has a native screen in the app: it is asked to open that
 * first (`openNative`), and this overlay is the fallback for when it does not.
 * A meeting is never sent to the native screen.
 */
export function MeetingChatOverlay(): React.JSX.Element | null {
  const { selectedMeeting, closePanel, activePanel } = useRightPanel();
  const { followedSession, activeMeeting } = useFollow();
  const subject = selectedMeeting ?? followedSession ?? activeMeeting;
  const isOpen = useContextualPanel('followSession', subject);
  const resource = useResource(subject ?? unknownSubject);
  const title = resource.title;
  // Not known to be a meeting until the resource has loaded.
  const isMeeting = resource.hasClasses(dataBrowser.classes.meeting);
  const settled = !resource.loading;

  const closeAny = () => {
    if (activePanel) closePanel(activePanel);
  };

  // The meeting the app declined to show natively: the overlay is for that.
  const [declined, setDeclined] = useState<string>();
  // Kept out of the effect's dependencies: a changing identity of either must
  // not ask the app a second time (a second screen).
  const latest = useRef({ closePanel, title, closeAny });

  latest.current = { closePanel, title, closeAny };

  // The host moved the page to another resource: nothing stays open.
  useEffect(
    () =>
      onHostNavigate(() => {
        latest.current.closeAny();
        setDeclined(undefined);
      }),
    [],
  );

  useEffect(() => {
    if (!isOpen || !subject || declined === subject) return;
    if (isMeeting || !settled) return;
    let cancelled = false;

    void openNative(
      dataBrowser.classes.chatroom,
      subject,
      latest.current.title,
    ).then(handled => {
      if (cancelled) return;

      if (handled) {
        latest.current.closePanel('followSession');
      } else {
        setDeclined(subject);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, subject, declined, isMeeting, settled]);

  const showOverlay =
    isOpen && !!subject && (isMeeting || declined === subject);

  useEffect(() => {
    if (!showOverlay) return;

    return registerOverlay(() => closePanel('followSession'));
  }, [showOverlay, closePanel]);

  if (!showOverlay || !subject) return null;

  return (
    <Overlay
      subject={subject}
      meeting={isMeeting}
      onClose={() => closePanel('followSession')}
    />
  );
}

function Overlay({
  subject,
  meeting,
  onClose,
}: {
  subject: string;
  meeting: boolean;
  onClose: () => void;
}) {
  const chatroom = useResource(subject);

  if (meeting) {
    return (
      <Screen
        data-testid='meeting-chat-overlay'
        role='dialog'
        aria-modal='true'
      >
        <FollowSessionChat
          subject={subject}
          embedded
          trailing={
            <IconButton title='Close chat' onClick={onClose} size='1.25em'>
              <FaXmark />
            </IconButton>
          }
        />
      </Screen>
    );
  }

  return (
    <Screen data-testid='meeting-chat-overlay' role='dialog' aria-modal='true'>
      <Header>
        <Title resource={chatroom} />
        <IconButton title='Close chat' onClick={onClose} size='1.25em'>
          <FaXmark />
        </IconButton>
      </Header>
      <ChatRoomView resource={chatroom} noContainerPadding />
    </Screen>
  );
}

const Screen = styled.div`
  position: fixed;
  inset: 0 0 auto 0;
  height: min(
    calc(100dvh - var(--keyboard-inset, 0px)),
    var(--visible-viewport-height, 100dvh)
  );
  z-index: ${p => p.theme.zIndex.dialog};
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 0.25rem;
  background: ${p => p.theme.colors.bgBody};
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: ${p => p.theme.size(2)};
`;

const Title = styled(EditableTitle)`
  font-size: 1rem;
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;
